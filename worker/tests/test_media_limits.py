"""Worker-side media limits: size before download, duration and resolution before normalizing."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from jams_worker.errors import TERMINAL_ERROR_CODES, PipelineError
from jams_worker.limits import (
    DEFAULT_MAX_DURATION_MS,
    DEFAULT_MAX_UPLOAD_BYTES,
    DEFAULT_MAX_VIDEO_PIXELS,
    MediaLimits,
    media_limits,
)
from jams_worker.main import handle_message
from jams_worker.providers.probe import _download_blob, probe_file

FIXTURE = Path(__file__).parents[2] / "fixtures" / "e2e-tiny.mp4"


def test_defaults_match_the_web_policy() -> None:
    assert media_limits({}) == MediaLimits(
        max_bytes=2 * 1024 * 1024 * 1024,
        max_duration_ms=20 * 60 * 1000,
        max_video_pixels=7680 * 4320,
    )


def test_limits_come_from_the_shared_environment_knobs() -> None:
    limits = media_limits(
        {
            "JAMS_LIMIT_UPLOAD_MAX_BYTES": "1000",
            "JAMS_LIMIT_UPLOAD_MAX_DURATION_MS": "60000",
            "JAMS_LIMIT_MAX_VIDEO_PIXELS": "921600",
        }
    )
    assert limits == MediaLimits(max_bytes=1000, max_duration_ms=60_000, max_video_pixels=921_600)


@pytest.mark.parametrize("raw", ["", "0", "-5", "lots", "1.5"])
def test_an_invalid_knob_keeps_the_safe_default(raw: str) -> None:
    limits = media_limits({"JAMS_LIMIT_UPLOAD_MAX_BYTES": raw})
    assert limits.max_bytes == DEFAULT_MAX_UPLOAD_BYTES
    assert limits.max_duration_ms == DEFAULT_MAX_DURATION_MS
    assert limits.max_video_pixels == DEFAULT_MAX_VIDEO_PIXELS


def test_probe_rejects_a_recording_over_the_duration_limit() -> None:
    with pytest.raises(PipelineError) as exc:
        probe_file(FIXTURE, MediaLimits(max_duration_ms=1))
    assert exc.value.error_code == "too_long"
    assert "minute limit" in str(exc.value)


def test_probe_rejects_a_resolution_over_the_pixel_limit() -> None:
    with pytest.raises(PipelineError) as exc:
        probe_file(FIXTURE, MediaLimits(max_video_pixels=100))
    assert exc.value.error_code == "unsupported_media"


def test_probe_accepts_the_fixture_under_default_limits() -> None:
    assert probe_file(FIXTURE, MediaLimits()).duration_ms > 0


class _Blob:
    def __init__(self, size: int) -> None:
        self.size = size
        self.downloaded = False

    def get_blob_properties(self) -> Any:
        return SimpleNamespace(size=self.size)

    def download_blob(self) -> Any:
        self.downloaded = True
        return SimpleNamespace(readinto=lambda file: file.write(b"x" * self.size))


def _context(blob: _Blob) -> Any:
    container = SimpleNamespace(get_blob_client=lambda _path: blob)
    return SimpleNamespace(
        blob_service_client=SimpleNamespace(get_container_client=lambda _name: container),
        run={"blob_path": "org/video/finalized/f/original.mp4"},
    )


def test_download_refuses_an_oversize_blob_before_transferring_it(tmp_path: Path) -> None:
    blob = _Blob(size=11)
    target = tmp_path / "original"
    with pytest.raises(PipelineError) as exc:
        _download_blob(_context(blob), target, MediaLimits(max_bytes=10))
    assert exc.value.error_code == "too_large"
    assert not blob.downloaded
    assert not target.exists()


def test_download_proceeds_at_the_limit(tmp_path: Path) -> None:
    blob = _Blob(size=10)
    target = tmp_path / "original"
    _download_blob(_context(blob), target, MediaLimits(max_bytes=10))
    assert blob.downloaded
    assert target.stat().st_size == 10


class _Queue:
    def __init__(self) -> None:
        self.deleted: list[tuple[str, str]] = []
        self.sent: list[str] = []

    def delete_message(self, message_id: str, pop_receipt: str) -> None:
        self.deleted.append((message_id, pop_receipt))

    def update_message(self, *_args: object, **_kwargs: object) -> None:
        raise AssertionError("a terminal failure must not be scheduled for redelivery")

    def create_queue(self) -> None:
        pass

    def send_message(self, content: str) -> None:
        self.sent.append(content)


class _Conn:
    def __init__(self) -> None:
        self.executed: list[str] = []

    def execute(self, sql: str, params: object = None) -> None:
        self.executed.append(" ".join(sql.split()))

    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass


@pytest.mark.parametrize("code", ["too_large", "unsupported_media", "too_long"])
def test_media_limit_failures_are_terminal_on_the_first_attempt(
    monkeypatch: pytest.MonkeyPatch, code: str
) -> None:
    assert code in TERMINAL_ERROR_CODES
    queue, poison, conn = _Queue(), _Queue(), _Conn()
    failed: list[tuple[str, str]] = []

    def fail(**_kwargs: object) -> str:
        raise PipelineError(code, "over the limit")

    monkeypatch.setattr("jams_worker.main.process_run", fail)
    monkeypatch.setattr(
        "jams_worker.main.RunRepository.fail",
        lambda _self, run_id, error_code, _detail: failed.append((run_id, error_code)),
    )
    message = SimpleNamespace(
        content=json.dumps({"run_id": "run_1"}), dequeue_count=1, id="msg", pop_receipt="r"
    )

    result = handle_message(
        message=message,
        queue=queue,  # type: ignore[arg-type]
        poison_queue=poison,  # type: ignore[arg-type]
        conn=conn,  # type: ignore[arg-type]
        blob_service_client=object(),  # type: ignore[arg-type]
        providers=[],
    )

    assert result.poisoned
    assert failed == [("run_1", code)]
    assert poison.sent == [message.content]
    assert queue.deleted == [("msg", "r")]
