"""Tests for build-time runtime asset preparation."""

from __future__ import annotations

from pathlib import Path

import pytest

from jams_worker import ffmpeg
from jams_worker.providers import sentiment_models, transcription
from scripts.prepare_runtime import prepare_runtime


def test_prepare_runtime_prefetches_ffmpeg_and_whisper(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ffmpeg_bin = tmp_path / "ffmpeg"
    ffprobe_bin = tmp_path / "ffprobe"
    ffmpeg_bin.touch()
    ffprobe_bin.touch()
    calls: list[str] = []

    monkeypatch.setattr(ffmpeg, "ffmpeg_paths", lambda: (str(ffmpeg_bin), str(ffprobe_bin)))
    monkeypatch.setattr(
        transcription,
        "load_model",
        lambda model_name: calls.append(model_name) or (object(), "sha"),
    )
    class FakeSentimentModel:
        def prepare(self) -> None:
            calls.append("sentiment:prepare")

    prepared: list[str] = []
    monkeypatch.setattr(
        sentiment_models,
        "get_model",
        lambda model_id: prepared.append(model_id) or FakeSentimentModel(),
    )

    assert prepare_runtime() == (str(ffmpeg_bin), str(ffprobe_bin))
    assert calls == [transcription.MODEL_NAME, "sentiment:prepare"]
    assert prepared == [sentiment_models.DEFAULT_MODEL_ID]


def test_prepare_runtime_can_skip_model_download(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ffmpeg_bin = tmp_path / "ffmpeg"
    ffprobe_bin = tmp_path / "ffprobe"
    ffmpeg_bin.touch()
    ffprobe_bin.touch()
    monkeypatch.setattr(ffmpeg, "ffmpeg_paths", lambda: (str(ffmpeg_bin), str(ffprobe_bin)))
    monkeypatch.setattr(
        transcription,
        "load_model",
        lambda _model_name: (_ for _ in ()).throw(AssertionError("model should not load")),
    )

    assert prepare_runtime(prewarm_models=False) == (str(ffmpeg_bin), str(ffprobe_bin))


def test_prepare_runtime_fails_if_ffmpeg_asset_is_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    ffmpeg_bin = tmp_path / "ffmpeg"
    ffprobe_bin = tmp_path / "ffprobe"
    ffmpeg_bin.touch()
    monkeypatch.setattr(ffmpeg, "ffmpeg_paths", lambda: (str(ffmpeg_bin), str(ffprobe_bin)))

    with pytest.raises(RuntimeError, match="both ffmpeg and ffprobe"):
        prepare_runtime(prewarm_models=False)
