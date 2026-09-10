"""Deterministic regression tests for media timebase contract and metadata (Findings 1 & 9).

Covers:
1. Delayed audio: audio starting later than video start is padded so speech/tones align to T=0.
2. Deliberately wrong client duration: probe corrects duration and downstream providers use it.
3. VFR and nonzero starts: non-zero stream start times and spans are preserved and normalized.
4. Discontinuity handling: audio gaps/jumps are padded with silence to preserve timestamp sync.
5. End-of-recording bounds: seek points, thumbnails, cuts, utterances do not exceed duration.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import wave
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from jams_worker.ffmpeg import ffmpeg_path, ffprobe_path
from jams_worker.media import MediaMetadata, get_authoritative_duration_ms
from jams_worker.pipeline import PipelineContext
from jams_worker.providers.context_switch import ContextSwitchProvider, extract_thumbnail
from jams_worker.providers.probe import ProbeProvider, probe_file
from jams_worker.providers.segmentation import UtteranceCue, build_segments
from jams_worker.providers.transcription import (
    RawSegment,
    Utterance,
    WordTiming,
    build_utterances,
    measures_from_utterances,
)


def _create_synthetic_av(
    path: Path,
    *,
    video_duration: float = 6.0,
    audio_offset: float = 0.0,
    audio_duration: float = 2.0,
    frequency: int = 1000,
    v_offset: float = 0.0,
) -> None:
    """Create a synthetic MP4 with precisely controlled video and audio offsets."""
    cmd = [ffmpeg_path(), "-v", "error", "-y"]
    if v_offset > 0:
        cmd.extend(["-itsoffset", str(v_offset)])
    cmd.extend(
        [
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size=160x90:rate=30:duration={video_duration}",
        ]
    )
    if audio_offset > 0:
        cmd.extend(["-itsoffset", str(audio_offset)])
    cmd.extend(
        [
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={frequency}:sample_rate=16000:duration={audio_duration}",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            str(path),
        ]
    )
    subprocess.run(cmd, check=True, timeout=60)


def _first_tone_onset_seconds(wav_path: Path, threshold: int = 1000) -> float | None:
    with wave.open(str(wav_path), "rb") as wav:
        rate = wav.getframerate()
        raw = wav.readframes(wav.getnframes())
        samples = [
            int.from_bytes(raw[i : i + 2], "little", signed=True)
            for i in range(0, len(raw), 2)
        ]
        for index, sample in enumerate(samples):
            if abs(sample) > threshold:
                return index / rate
    return None


class _MockBlobClient:
    def __init__(self, data: bytes = b"") -> None:
        self.data = data

    def download_blob(self) -> _MockBlobClient:
        return self

    def readinto(self, target: Any) -> None:
        target.write(self.data)


class _MockContainerClient:
    def __init__(self) -> None:
        self.blobs: dict[str, bytes] = {}

    def create_container(self) -> None:
        pass

    def get_blob_client(self, name: str) -> _MockBlobClient:
        return _MockBlobClient(self.blobs.get(name, b""))

    def upload_blob(self, name: str, data: Any, overwrite: bool = True) -> None:
        _ = overwrite
        if hasattr(data, "read"):
            self.blobs[name] = data.read()
        else:
            self.blobs[name] = bytes(data)


class _MockBlobService:
    def __init__(self) -> None:
        self.container = _MockContainerClient()

    def get_container_client(self, _name: str) -> _MockContainerClient:
        return self.container


class _MockDb:
    def __init__(self, video_duration_ms: int = 60_000) -> None:
        self.video_duration_ms = video_duration_ms
        self.queries: list[tuple[str, Any]] = []

    def execute(self, sql: str, params: Any = None) -> Any:
        self.queries.append((sql, params))
        if "select duration_ms from videos" in sql:
            return SimpleNamespace(fetchone=lambda: (self.video_duration_ms,))
        if "select" in sql and "measures" in sql:
            return SimpleNamespace(fetchall=lambda: [])
        return SimpleNamespace(fetchone=lambda: None, fetchall=lambda: [])

    def commit(self) -> None:
        pass

    def cursor(self, row_factory: Any = None) -> Any:
        return SimpleNamespace(
            __enter__=lambda: SimpleNamespace(
                execute=lambda *_: None,
                fetchall=lambda: [],
                fetchone=lambda: None,
            ),
            __exit__=lambda *_: None,
        )

    def transaction(self) -> Any:
        return SimpleNamespace(__enter__=lambda: None, __exit__=lambda *_: None)


def _make_context(
    tmp_path: Path,
    *,
    client_duration_ms: int = 1_000,
    db_duration_ms: int = 60_000,
) -> PipelineContext:
    blob_service = _MockBlobService()
    db = _MockDb(video_duration_ms=db_duration_ms)
    return PipelineContext(
        run={
            "id": "test-run-123",
            "video_id": "test-video-456",
            "duration_ms": client_duration_ms,
            "blob_path": "test-video-456/original.mp4",
            "poster_blob_path": "exists",
            "config": {},
        },
        org_id="test-org-789",
        blob_service_client=blob_service,  # type: ignore[arg-type]
        db_conn=db,  # type: ignore[arg-type]
        workdir=tmp_path,
        register_artifact=lambda kind, path: f"art-{kind}",
        heartbeat=lambda *_: None,
    )


# ==============================================================================
# Finding 1: Delayed Audio Regression Tests
# ==============================================================================


def test_transport_mux_origin_does_not_delay_video_relative_to_audio(tmp_path: Path) -> None:
    source = tmp_path / "transport.ts"
    subprocess.run(
        [
            ffmpeg_path(), "-v", "error", "-y", "-f", "lavfi", "-i",
            "color=c=white:s=160x90:r=30:d=3", "-f", "lavfi", "-i",
            "sine=frequency=1000:sample_rate=48000:duration=3",
            "-c:v", "mpeg2video", "-c:a", "mp2", "-f", "mpegts", str(source),
        ],
        check=True, timeout=60,
    )
    metadata = probe_file(source)
    assert metadata.time_origin_seconds > 1
    assert abs(metadata.duration_ms - 3000) < 100
    context = _make_context(tmp_path)
    with (
        patch("jams_worker.providers.probe._download_blob",
              side_effect=lambda c, p: shutil.copyfile(source, p)),
        patch("jams_worker.providers.probe._upload_blob"),
    ):
        ProbeProvider().run(context)
    frames = subprocess.check_output(
        [ffmpeg_path(), "-v", "error", "-i", str(tmp_path / "normalized.mp4"),
         "-vf", "fps=30,scale=1:1,format=gray", "-f", "rawvideo", "-"],
        timeout=60,
    )
    first_bright = next(index / 30 for index, value in enumerate(frames) if value > 200)
    tone = _first_tone_onset_seconds(tmp_path / "audio.wav")
    assert tone is not None
    assert first_bright <= 0.25
    assert abs(first_bright - tone) <= 0.25


def test_word_payload_clamps_both_endpoints_to_duration() -> None:
    utterance = Utterance(
        t0_ms=5050, t1_ms=5150, text="late", words=(WordTiming("late", 5050, 5150),),
        avg_logprob=-0.2, whisper_segment_ids=(0,), deduped=False,
    )
    measures = measures_from_utterances([utterance], video_duration_ms=5000)
    row = next(measure for measure in measures if measure["kind"] == "utterance")
    assert row["payload"]["words"][0] == {"w": "late", "t0": 5000, "t1": 5000}


def test_delayed_audio_probe_and_wav_aligns_to_video_timebase(tmp_path: Path) -> None:
    """A 6s video with audio delayed by 2s must produce audio.wav with tone at 2.0s."""
    source = tmp_path / "delayed_audio.mp4"
    _create_synthetic_av(source, video_duration=6.0, audio_offset=2.0, audio_duration=2.0)

    meta = probe_file(source)
    assert meta.duration_ms == 6000
    assert meta.has_audio is True
    # Audio stream start offset should be approximately 1.936-2.0s
    assert 1900 <= meta.audio_offset_ms <= 2100

    ctx = _make_context(tmp_path, client_duration_ms=1000)
    with (
        patch(
            "jams_worker.providers.probe._download_blob",
            side_effect=lambda c, p: shutil.copyfile(source, p),
        ),
        patch("jams_worker.providers.probe._upload_blob"),
    ):
        ProbeProvider().run(ctx)

    wav_path = tmp_path / "audio.wav"
    assert wav_path.exists()
    onset = _first_tone_onset_seconds(wav_path)
    assert onset is not None
    # Tone must start at 2.0s (within ±50ms), NOT at 0.064s as in the pre-fix bug!
    assert abs(onset - 2.0) < 0.05

    # Extracted audio.wav duration must match video presentation duration (6.0s)
    with wave.open(str(wav_path), "rb") as wav:
        wav_dur = wav.getnframes() / wav.getframerate()
        assert abs(wav_dur - 6.0) < 0.05


def test_normalized_video_preserves_aligned_audio_stream(tmp_path: Path) -> None:
    """Normalized MP4 must have an audio stream starting at 0.0 with CFR video."""
    source = tmp_path / "delayed_audio.mp4"
    _create_synthetic_av(source, video_duration=6.0, audio_offset=2.0, audio_duration=2.0)

    ctx = _make_context(tmp_path)
    with (
        patch(
            "jams_worker.providers.probe._download_blob",
            side_effect=lambda c, p: shutil.copyfile(source, p),
        ),
        patch("jams_worker.providers.probe._upload_blob"),
    ):
        ProbeProvider().run(ctx)

    norm_path = tmp_path / "normalized.mp4"
    assert norm_path.exists()

    streams = json.loads(
        subprocess.check_output(
            [
                ffprobe_path(),
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,start_time,duration",
                "-of",
                "json",
                str(norm_path),
            ]
        )
    )["streams"]
    video_s = next(s for s in streams if s["codec_type"] == "video")
    audio_s = next(s for s in streams if s["codec_type"] == "audio")
    assert float(video_s["start_time"]) == 0.0
    assert float(audio_s["start_time"]) == 0.0


def test_transcription_derived_timestamps_match_video_timeline(tmp_path: Path) -> None:
    """Utterances transcribed from aligned audio fall on the video timeline."""
    raw_segments = [
        RawSegment(
            segment_id=0,
            start_ms=2000,
            end_ms=3500,
            text="delayed speech starts at two seconds",
            avg_logprob=-0.2,
            words=(
                WordTiming("delayed", 2000, 2300),
                WordTiming("speech", 2350, 2700),
                WordTiming("starts", 2750, 3100),
                WordTiming("now", 3150, 3500),
            ),
        )
    ]
    utterances = build_utterances(raw_segments)
    measures = measures_from_utterances(utterances, video_duration_ms=6000)

    speech_measure = next(m for m in measures if m["kind"] == "utterance")
    assert speech_measure["t_start_ms"] == 2000
    assert speech_measure["t_end_ms"] == 3500


# ==============================================================================
# Finding 9: Deliberately Wrong Client Duration Regression Tests
# ==============================================================================


def test_deliberately_wrong_client_duration_corrected_by_probe(tmp_path: Path) -> None:
    """When client uploads duration_ms=1000 for a 6s video, probe corrects it."""
    source = tmp_path / "source.mp4"
    _create_synthetic_av(source, video_duration=6.0, audio_offset=0.0, audio_duration=6.0)

    ctx = _make_context(tmp_path, client_duration_ms=1000)
    assert ctx.run["duration_ms"] == 1000

    with (
        patch(
            "jams_worker.providers.probe._download_blob",
            side_effect=lambda c, p: shutil.copyfile(source, p),
        ),
        patch("jams_worker.providers.probe._upload_blob"),
    ):
        ProbeProvider().run(ctx)

    # Both context.media and context.run must reflect authoritative 6000ms
    assert ctx.media is not None
    assert ctx.media.duration_ms == 6000
    assert ctx.run["duration_ms"] == 6000


def test_downstream_providers_use_authoritative_duration_over_stale_run(tmp_path: Path) -> None:
    """Downstream providers prefer DB/authoritative metadata over stale client duration."""
    ctx = _make_context(tmp_path, client_duration_ms=1000, db_duration_ms=60_000)
    # Stale client duration in run
    assert ctx.run["duration_ms"] == 1000

    # Helper function returns authoritative DB duration (60000)
    assert get_authoritative_duration_ms(ctx) == 60_000

    # Segmentation provider uses 60000ms
    from jams_worker.providers.segmentation import _video_duration_ms as seg_video_duration_ms
    assert seg_video_duration_ms(ctx) == 60_000

    # Transcription provider helper uses 60000ms
    from jams_worker.providers.transcription import _video_duration_ms as tx_video_duration_ms
    assert tx_video_duration_ms(ctx, Path("dummy.mp4")) == 60_000

    # Scoring provider uses 60000ms
    from jams_worker.providers.scoring import _read_video
    assert _read_video(ctx)["duration_ms"] == 60_000

    # When context.media is set, it takes absolute precedence
    ctx.media = MediaMetadata(
        container="mp4",
        video_codec="h264",
        width=1280,
        height=720,
        fps=30.0,
        duration_ms=45_000,
        has_audio=True,
    )
    assert get_authoritative_duration_ms(ctx) == 45_000
    assert seg_video_duration_ms(ctx) == 45_000
    assert tx_video_duration_ms(ctx, Path("dummy.mp4")) == 45_000
    assert _read_video(ctx)["duration_ms"] == 45_000


def test_transcription_does_not_fail_on_wrong_client_duration(tmp_path: Path) -> None:
    """Audio exceeding claimed client duration but within true duration must not fail."""
    ctx = _make_context(tmp_path, client_duration_ms=1000, db_duration_ms=60_000)
    ctx.media = MediaMetadata(
        container="mp4",
        video_codec="h264",
        width=1280,
        height=720,
        fps=30.0,
        duration_ms=60_000,
        has_audio=True,
    )

    # An utterance at 15,000ms is well past client's 1000ms, but within authoritative 60,000ms
    raw_segments = [
        RawSegment(
            segment_id=0,
            start_ms=12_000,
            end_ms=15_000,
            text="speech at fifteen seconds",
            avg_logprob=-0.1,
            words=(
                WordTiming("speech", 12_000, 13_000),
                WordTiming("at", 13_100, 13_500),
                WordTiming("fifteen", 13_600, 14_500),
                WordTiming("seconds", 14_600, 15_000),
            ),
        )
    ]
    utterances = build_utterances(raw_segments)
    from jams_worker.providers.transcription import assert_timestamp_invariants
    # Must succeed against authoritative 60,000ms without PipelineError
    assert_timestamp_invariants(utterances, video_duration_ms=ctx.media.duration_ms)
    measures = measures_from_utterances(utterances, video_duration_ms=ctx.media.duration_ms)
    assert measures[0]["t_start_ms"] == 12_000


# ==============================================================================
# Nonzero Starts & VFR Regression Tests
# ==============================================================================


def test_nonzero_video_start_presentation_duration(tmp_path: Path) -> None:
    """When video stream starts at 1.5s and lasts 4s, total duration is 5.5s."""
    source = tmp_path / "v_delay.mp4"
    _create_synthetic_av(
        source,
        video_duration=4.0,
        audio_offset=0.0,
        audio_duration=4.0,
        v_offset=1.5,
    )

    meta = probe_file(source)
    assert meta.video_start_seconds == 1.5
    # Total presentation span must encompass the 1.5s offset + 4s duration = 5.5s
    assert abs(meta.duration_ms - 5500) <= 50

    ctx = _make_context(tmp_path)
    with (
        patch(
            "jams_worker.providers.probe._download_blob",
            side_effect=lambda c, p: shutil.copyfile(source, p),
        ),
        patch("jams_worker.providers.probe._upload_blob"),
    ):
        ProbeProvider().run(ctx)

    assert ctx.media is not None
    assert abs(ctx.media.duration_ms - 5500) <= 50

    # Presentation duration and stream alignment of normalized.mp4 must match origin T=0
    norm_path = tmp_path / "normalized.mp4"
    assert norm_path.exists()
    norm_probe = json.loads(
        subprocess.check_output(
            [
                ffprobe_path(),
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(norm_path),
            ]
        )
    )
    v_s = next(s for s in norm_probe["streams"] if s["codec_type"] == "video")
    a_s = next(s for s in norm_probe["streams"] if s["codec_type"] == "audio")
    assert float(v_s["start_time"]) == 0.0
    assert float(a_s["start_time"]) == 0.0
    assert abs(float(v_s["duration"]) - 5.5) <= 0.1
    assert abs(float(a_s["duration"]) - 5.5) <= 0.1
    assert abs(float(norm_probe["format"]["duration"]) - 5.5) <= 0.1


def test_nonzero_video_start_visual_event_maps_to_original_playback_within_tolerance(
    tmp_path: Path,
) -> None:
    """A visual cut 1.0s into a video stream starting at 1.5s must map to 2.5s within ±250ms."""
    source = tmp_path / "delayed_cut.mp4"
    # Create video stream with 1s black + 2s white, offset by 1.5s in container.
    # In original playback timeline:
    # 0.0 - 1.5s: before video start (silence / blank)
    # 1.5 - 2.5s: black
    # 2.5 - 4.5s: white (visible scene cut at exactly 2.5s / 2500ms)
    cmd = [
        ffmpeg_path(),
        "-v",
        "error",
        "-y",
        "-itsoffset",
        "1.5",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=160x90:r=30:d=1",
        "-f",
        "lavfi",
        "-i",
        "color=c=white:s=160x90:r=30:d=2",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        str(source),
    ]
    subprocess.run(cmd, check=True, timeout=60)

    meta = probe_file(source)
    assert meta.video_start_seconds == 1.5
    assert meta.video_normalized_aligned is True

    ctx = _make_context(tmp_path)
    with (
        patch(
            "jams_worker.providers.probe._download_blob",
            side_effect=lambda c, p: shutil.copyfile(source, p),
        ),
        patch("jams_worker.providers.probe._upload_blob"),
    ):
        ProbeProvider().run(ctx)

    # Assert normalized presentation duration and alignment
    norm_path = tmp_path / "normalized.mp4"
    assert norm_path.exists()
    norm_probe = json.loads(
        subprocess.check_output(
            [
                ffprobe_path(),
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(norm_path),
            ]
        )
    )
    v_s = next(s for s in norm_probe["streams"] if s["codec_type"] == "video")
    assert float(v_s["start_time"]) == 0.0
    # Expected span is 1.5s padding + 3.0s video = 4.5s
    assert abs(float(v_s["duration"]) - 4.5) <= 0.15
    assert abs(float(norm_probe["format"]["duration"]) - 4.5) <= 0.15

    # Run ContextSwitchProvider on normalized.mp4 and verify timing
    with patch(
        "jams_worker.providers.context_switch._upload_derived",
    ):
        measures = ContextSwitchProvider().run(ctx)

    switches = [m for m in measures if m["kind"] == "context_switch"]
    assert len(switches) >= 1
    cut = switches[0]
    cut_ms = cut["t_start_ms"]

    # Original playback timestamp of cut is 2500ms; must be within ±250ms
    assert abs(cut_ms - 2500) <= 250


def test_get_authoritative_duration_ms_propagates_db_failure(tmp_path: Path) -> None:
    """Database query failures must not be swallowed with broad except; must propagate."""
    class FailingDb:
        def execute(self, *args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("Database connection lost")

    ctx = _make_context(tmp_path, client_duration_ms=1000)
    ctx.db_conn = FailingDb()  # type: ignore[assignment]
    with pytest.raises(RuntimeError, match="Database connection lost"):
        get_authoritative_duration_ms(ctx)


def test_get_authoritative_duration_ms_justified_absence_falls_back(tmp_path: Path) -> None:
    """When video record or duration is missing from DB, falls back to client upload."""
    class EmptyDb:
        def execute(self, *args: Any, **kwargs: Any) -> Any:
            return SimpleNamespace(fetchone=lambda: None)

    ctx = _make_context(tmp_path, client_duration_ms=1000)
    ctx.db_conn = EmptyDb()  # type: ignore[assignment]
    assert get_authoritative_duration_ms(ctx) == 1000


# ==============================================================================
# Discontinuity Handling Regression Tests
# ==============================================================================


def test_discontinuity_handling_preserves_audio_alignment(tmp_path: Path) -> None:
    """Gaps between audio segments must be padded with silence so subsequent tone is aligned."""
    gap_mp4 = tmp_path / "gap.mp4"
    # Audio has 1s tone, then 2s silence gap, then 2s tone starting at 3.0s
    subprocess.run(
        [
            ffmpeg_path(),
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=160x90:rate=30:duration=6",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:sample_rate=16000:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=2000:sample_rate=16000:duration=2",
            "-filter_complex",
            "[2:a]adelay=3000|3000[a2];[1:a][a2]amix=inputs=2:normalize=0:dropout_transition=0[a]",
            "-map",
            "0:v",
            "-map",
            "[a]",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            str(gap_mp4),
        ],
        check=True,
        timeout=60,
    )

    ctx = _make_context(tmp_path)
    with (
        patch(
            "jams_worker.providers.probe._download_blob",
            side_effect=lambda c, p: shutil.copyfile(gap_mp4, p),
        ),
        patch("jams_worker.providers.probe._upload_blob"),
    ):
        ProbeProvider().run(ctx)

    wav_path = tmp_path / "audio.wav"
    assert wav_path.exists()
    with wave.open(str(wav_path), "rb") as w:
        raw = w.readframes(w.getnframes())
        samples = [
            int.from_bytes(raw[i : i + 2], "little", signed=True)
            for i in range(0, len(raw), 2)
        ]
        tones = [round(i / 16000, 3) for i, s in enumerate(samples) if abs(s) > 1000]
        t1_onsets = [t for t in tones if t < 2.0]
        t2_onsets = [t for t in tones if t >= 2.0]

        assert t1_onsets[0] == 0.0
        # Tone 2 must start at 3.0s (NOT at 1.0s where it would be if gap was collapsed!)
        assert abs(t2_onsets[0] - 3.0) < 0.05


# ==============================================================================
# End-of-Recording Seek and Timestamp Bounds Regression Tests
# ==============================================================================


def test_end_of_recording_thumbnail_seek_clamped(tmp_path: Path) -> None:
    """Thumbnail seek near end of video is clamped to video bounds and does not crash."""
    source = tmp_path / "short.mp4"
    _create_synthetic_av(source, video_duration=2.0, audio_offset=0.0, audio_duration=2.0)

    thumb_target = tmp_path / "thumb.jpg"
    # cut_ms = 1950 in a 2000ms video; seek would be 1.95 + 0.5 = 2.45s (beyond 2.0s)
    # With max_duration_ms=2000, it must clamp and successfully generate a frame!
    extract_thumbnail(source, thumb_target, cut_ms=1950, max_duration_ms=2000)
    assert thumb_target.exists()
    assert thumb_target.stat().st_size > 0


def test_end_of_recording_measures_and_segments_bounded() -> None:
    """Measures and segment boundaries cannot exceed video_duration_ms."""
    duration_ms = 5000

    raw_segments = [
        RawSegment(
            segment_id=0,
            start_ms=4500,
            end_ms=5200,  # exceeds video duration
            text="trailing speech",
            avg_logprob=-0.1,
            words=(
                WordTiming("trailing", 4500, 4800),
                WordTiming("speech", 4850, 5100),
            ),
        )
    ]
    utterances = build_utterances(raw_segments)
    measures = measures_from_utterances(utterances, video_duration_ms=duration_ms)

    for m in measures:
        assert m["t_start_ms"] <= duration_ms
        if m.get("t_end_ms") is not None:
            assert m["t_end_ms"] <= duration_ms
        if "words" in m.get("payload", {}):
            for w in m["payload"]["words"]:
                assert w["t0"] <= duration_ms
                assert w["t1"] <= duration_ms

    # Segments test
    segments = build_segments(
        run_id="11111111-1111-4111-8111-111111111111",
        duration_ms=duration_ms,
        utterances=[UtteranceCue(4500, 5200, "Done that is all")],
        switches=[4800],
    )
    for seg in segments:
        assert 0 <= seg.t0_ms <= duration_ms
        assert 0 <= seg.t1_ms <= duration_ms
