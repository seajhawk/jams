"""ffprobe parsing and typed error taxonomy."""

from __future__ import annotations

from pathlib import Path

import pytest

from jams_worker.errors import PipelineError
from jams_worker.providers.probe import probe_file


def test_probe_file_reads_tiny_fixture() -> None:
    fixture = Path(__file__).parents[2] / "fixtures" / "e2e-tiny.mp4"
    result = probe_file(fixture)

    assert result.duration_ms > 0
    assert result.width > 0
    assert result.height > 0
    assert result.video_codec != "unknown"


def test_probe_file_maps_corrupt_file(tmp_path: Path) -> None:
    corrupt = tmp_path / "corrupt.mp4"
    corrupt.write_bytes(b"not a video file")

    with pytest.raises(PipelineError) as exc:
        probe_file(corrupt)

    assert exc.value.error_code == "corrupt_file"


def _normalize_args(**overrides):
    import dataclasses

    from jams_worker.providers.probe import build_normalize_args

    fixture = Path(__file__).parents[2] / "fixtures" / "e2e-tiny.mp4"
    metadata = dataclasses.replace(probe_file(fixture), **overrides.pop("metadata", {}))
    return build_normalize_args(
        "ffmpeg", fixture, Path("out.mp4"), metadata, duration_s=1.0, **overrides
    )


def test_normalize_downscales_only_wider_than_the_cap() -> None:
    wide = _normalize_args(metadata={"width": 3840, "height": 2160}, max_width=1920)
    assert wide[wide.index("-vf") + 1] == "scale=1920:-2"

    narrow = _normalize_args(metadata={"width": 1280, "height": 720}, max_width=1920)
    assert "-vf" not in narrow, "never upscale"

    uncapped = _normalize_args(metadata={"width": 3840, "height": 2160})
    assert "-vf" not in uncapped


def test_normalize_uses_the_requested_preset_and_progress_flags() -> None:
    args = _normalize_args(preset="ultrafast", threads=2, progress=True)
    assert args[args.index("-preset") + 1] == "ultrafast"
    assert args[args.index("-threads") + 1] == "2"
    assert "-progress" in args and args[-1] == "out.mp4"

    quiet = _normalize_args()
    assert "-progress" not in quiet
    assert quiet[quiet.index("-preset") + 1] == "veryfast"


def test_production_normalization_is_the_fast_downscaled_one() -> None:
    from jams_worker.providers import probe

    assert probe.NORMALIZE_PRESET == "ultrafast"
    assert probe.NORMALIZE_MAX_WIDTH == 1920
