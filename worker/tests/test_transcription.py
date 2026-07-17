"""Transcription provider post-processing and status tests."""

from __future__ import annotations

import math
import os
import wave
from pathlib import Path
from typing import Any

import pytest

from jams_worker.pipeline import PipelineContext
from jams_worker.providers import transcription as tx
from jams_worker.providers.transcription import (
    RawSegment,
    TranscriptionProvider,
    WordTiming,
    assert_timestamp_invariants,
    build_utterances,
    measures_from_utterances,
    model_cache_dir,
)


class _NoRows:
    def fetchone(self) -> None:
        return None


class _Conn:
    def execute(self, _sql: str, _params: object = None) -> _NoRows:
        return _NoRows()


class _BlobClient:
    def download_blob(self) -> "_BlobClient":
        return self

    def readinto(self, _file: Any) -> None:
        return None


class _Container:
    def __init__(self) -> None:
        self.uploads: list[tuple[str, bytes]] = []

    def create_container(self) -> None:
        return None

    def get_blob_client(self, _path: str) -> _BlobClient:
        return _BlobClient()

    def upload_blob(self, path: str, file: Any, overwrite: bool = False) -> None:
        _ = overwrite
        self.uploads.append((path, file.read()))


class _BlobService:
    def __init__(self) -> None:
        self.container = _Container()

    def get_container_client(self, _name: str) -> _Container:
        return self.container


def _context(tmp_path: Path) -> tuple[PipelineContext, _BlobService]:
    blob_service = _BlobService()
    artifacts: list[tuple[str, str]] = []
    context = PipelineContext(
        run={"id": "run_1", "video_id": "video_1", "duration_ms": 10_000},
        org_id="org_1",
        blob_service_client=blob_service,  # type: ignore[arg-type]
        db_conn=_Conn(),  # type: ignore[arg-type]
        workdir=tmp_path,
        register_artifact=lambda kind, path: artifacts.append((kind, path)) or "artifact_1",
        heartbeat=lambda _stage, _pct, _detail: None,
    )
    (tmp_path / "normalized.mp4").write_bytes(b"not used when duration_ms is present")
    return context, blob_service


def _write_wav(path: Path, *, seconds: float, tone: bool = False) -> None:
    rate = 16_000
    frame_count = int(seconds * rate)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        frames = bytearray()
        for index in range(frame_count):
            sample = 0
            if tone:
                sample = int(10_000 * math.sin(2 * math.pi * 440 * index / rate))
            frames.extend(sample.to_bytes(2, "little", signed=True))
        wav.writeframes(bytes(frames))


def test_build_utterances_splits_and_merges_by_spec() -> None:
    segments = [
        RawSegment(
            segment_id=0,
            start_ms=0,
            end_ms=2800,
            text="hello world next",
            avg_logprob=-0.2,
            words=(
                WordTiming("hello", 0, 300),
                WordTiming("world", 450, 800),
                WordTiming("next", 2100, 2400),
            ),
        ),
        RawSegment(
            segment_id=1,
            start_ms=2900,
            end_ms=3500,
            text="step",
            avg_logprob=-0.4,
            words=(WordTiming("step", 2900, 3300),),
        ),
    ]

    utterances = build_utterances(segments)

    assert [utterance.text for utterance in utterances] == ["hello world", "next step"]
    assert utterances[1].whisper_segment_ids == (0, 1)


def test_repetition_dedupe_collapses_loop() -> None:
    repeated = tuple(WordTiming("again", index * 100, index * 100 + 80) for index in range(5))
    utterances = build_utterances(
        [
            RawSegment(
                segment_id=0,
                start_ms=0,
                end_ms=500,
                text="again again again again again",
                avg_logprob=-0.1,
                words=repeated,
            )
        ]
    )

    assert utterances[0].text == "again"
    assert utterances[0].deduped is True


def test_measures_match_canonical_shape() -> None:
    utterances = build_utterances(
        [
            RawSegment(
                segment_id=0,
                start_ms=0,
                end_ms=700,
                text="hello world",
                avg_logprob=-0.5,
                words=(WordTiming("hello", 0, 250), WordTiming("world", 300, 650)),
            )
        ]
    )
    assert_timestamp_invariants(utterances, video_duration_ms=1000)

    measures = measures_from_utterances(utterances)

    assert [measure["kind"] for measure in measures] == ["spoken_word", "utterance"]
    utterance = measures[1]
    assert utterance["category"] == "speech"
    assert utterance["value_text"] is None
    assert utterance["payload"]["lang"] == "en"
    assert measures[0]["value_num"] == 2


def test_no_audio_reports_skipped_no_audio(tmp_path: Path) -> None:
    context, blob_service = _context(tmp_path)

    measures = TranscriptionProvider().run(context)

    assert measures == []
    assert context.provider_summaries["transcription"]["status"] == "skipped_no_audio"
    assert blob_service.container.uploads[0][0] == "runs/run_1/transcription/transcript.json"


@pytest.mark.parametrize(("filename", "tone"), [("silence.wav", False), ("tones.wav", True)])
def test_silence_and_tones_produce_partial_no_speech(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    filename: str,
    tone: bool,
) -> None:
    context, _blob_service = _context(tmp_path)
    audio = tmp_path / "audio_16k.wav"
    _write_wav(audio, seconds=10.0, tone=tone)

    calls: list[float] = []

    monkeypatch.setattr(tx, "load_model", lambda: (object(), "model-sha"))

    def fake_transcribe(
        _model: object,
        _audio: Path,
        vad_threshold: float,
        **_kwargs: object,
    ) -> list[RawSegment]:
        calls.append(vad_threshold)
        return []

    monkeypatch.setattr(tx, "_transcribe", fake_transcribe)

    measures = TranscriptionProvider().run(context)

    assert measures == [], filename
    assert context.provider_summaries["transcription"]["status"] == "partial"
    assert context.provider_summaries["transcription"]["reason"] == "no_speech_detected"
    assert calls[0] == 0.5
    if tone:
        assert calls == [0.5, 0.35]


@pytest.mark.whisper_model
def test_whisper_espeak_wer_gate_if_model_cache_present(tmp_path: Path) -> None:
    if os.environ.get("JAMS_RUN_WHISPER_TESTS") != "1" or not model_cache_dir().exists():
        pytest.skip("set JAMS_RUN_WHISPER_TESTS=1 with cached faster-whisper weights")

    import make_fixtures as mf
    from golden import compute_wer

    registry = mf.generate_all(tmp_path / "fixtures")
    entry = next(item for item in registry["generated"] if item["id"] == "speech_espeak")
    if entry["tts_pending"]:
        pytest.skip("espeak-ng not available")

    audio = tmp_path / "fixtures" / entry["file"]
    model, _sha = tx.load_model()
    utterances = tx.build_utterances(tx._transcribe(model, audio, vad_threshold=0.5))
    hypothesis = " ".join(utterance.text for utterance in utterances)
    assert compute_wer(entry["transcript_text"], hypothesis) < entry["wer_gate"]


@pytest.mark.whisper_model
def test_speech_offsets_if_model_cache_present(tmp_path: Path) -> None:
    if os.environ.get("JAMS_RUN_WHISPER_TESTS") != "1" or not model_cache_dir().exists():
        pytest.skip("set JAMS_RUN_WHISPER_TESTS=1 with cached faster-whisper weights")

    import make_fixtures as mf

    registry = mf.generate_all(tmp_path / "fixtures")
    entry = next(item for item in registry["generated"] if item["id"] == "speech_offsets")
    if entry["tts_pending"]:
        pytest.skip("espeak-ng not available")

    audio = tmp_path / "fixtures" / entry["file"]
    model, _sha = tx.load_model()
    utterances = tx.build_utterances(tx._transcribe(model, audio, vad_threshold=0.5))
    first_word_starts = [utterance.words[0].t0_ms for utterance in utterances]
    assert any(abs(start - 5000) <= 250 for start in first_word_starts)
    assert any(abs(start - 60_000) <= 250 for start in first_word_starts)


@pytest.mark.whisper_model
def test_av_sync_cross_stage_if_model_cache_present(tmp_path: Path) -> None:
    if os.environ.get("JAMS_RUN_WHISPER_TESTS") != "1" or not model_cache_dir().exists():
        pytest.skip("set JAMS_RUN_WHISPER_TESTS=1 with cached faster-whisper weights")

    import golden as g
    import make_fixtures as mf

    from jams_worker.providers.context_switch import detect_context_switches

    registry = mf.generate_all(tmp_path / "fixtures")
    entry = next(item for item in registry["generated"] if item["id"] == "av_sync")
    if entry["tts_pending"]:
        pytest.skip("espeak-ng not available")

    video = tmp_path / "fixtures" / entry["file"]
    cuts = detect_context_switches(video, tmp_path / "context")
    model, _sha = tx.load_model()
    utterances = tx.build_utterances(tx._transcribe(model, video, vad_threshold=0.5))

    g.assert_cross_stage(
        cut_ms=cuts[0].t_start_ms,
        first_word_t0_ms=utterances[0].words[0].t0_ms,
        video_duration_ms=g.ffprobe_duration_ms(video),
    )
