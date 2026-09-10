"""Whisper transcription provider."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import wave
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from azure.core.exceptions import ResourceExistsError

from jams_worker.errors import PipelineError
from jams_worker.ffmpeg import (
    MEDIA_TIMEOUT_SECONDS,
    ffmpeg_path,
    run_media_command,
)
from jams_worker.media import get_authoritative_duration_ms
from jams_worker.pipeline import PipelineContext
from jams_worker.providers.probe import DERIVED_CONTAINER

PROVIDER_ID = "transcription"
PROVIDER_VERSION = "1.0.0"
MODEL_NAME = "distil-small.en"
LANGUAGE = "en"
DEFAULT_MODEL_CACHE = Path.home() / ".cache" / "jams-worker" / "faster-whisper"
SPLIT_GAP_MS = 1200
MERGE_GAP_MS = 700
MAX_UTTERANCE_MS = 45_000
LONG_SPLIT_MIN_GAP_MS = 300


@dataclass(frozen=True, slots=True)
class WordTiming:
    text: str
    t0_ms: int
    t1_ms: int


@dataclass(frozen=True, slots=True)
class RawSegment:
    segment_id: int
    start_ms: int
    end_ms: int
    text: str
    avg_logprob: float
    words: tuple[WordTiming, ...]


@dataclass(frozen=True, slots=True)
class Utterance:
    t0_ms: int
    t1_ms: int
    text: str
    words: tuple[WordTiming, ...]
    avg_logprob: float
    whisper_segment_ids: tuple[int, ...]
    deduped: bool


def ms_from_seconds(seconds: float) -> int:
    return math.floor(seconds * 1000 + 0.5)


def clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def _word_text(value: str) -> str:
    return value.strip()


def _join_words(words: Sequence[WordTiming]) -> str:
    text = " ".join(word.text for word in words if word.text).strip()
    return re.sub(r"\s+([,.;:?!])", r"\1", text)


def _duration_ms(words: Sequence[WordTiming]) -> int:
    if not words:
        return 0
    return max(0, words[-1].t1_ms - words[0].t0_ms)


def _dedupe_repetition(words: tuple[WordTiming, ...]) -> tuple[tuple[WordTiming, ...], bool]:
    result = list(words)
    deduped = False
    n = 8
    while n >= 1:
        index = 0
        while index + (n * 4) <= len(result):
            gram = tuple(word.text.lower() for word in result[index : index + n])
            repeat_count = 1
            while (
                index + (repeat_count + 1) * n <= len(result)
                and tuple(
                    word.text.lower()
                    for word in result[index + repeat_count * n : index + (repeat_count + 1) * n]
                )
                == gram
            ):
                repeat_count += 1
            if repeat_count >= 4:
                del result[index + n : index + repeat_count * n]
                deduped = True
                continue
            index += 1
        n -= 1
    return tuple(result), deduped


def _segment_pieces(segment: RawSegment) -> list[Utterance]:
    words, deduped = _dedupe_repetition(segment.words)
    if not words:
        return []

    pieces: list[tuple[WordTiming, ...]] = []
    current: list[WordTiming] = [words[0]]
    for previous, word in zip(words, words[1:], strict=False):
        if word.t0_ms - previous.t1_ms >= SPLIT_GAP_MS:
            pieces.append(tuple(current))
            current = [word]
        else:
            current.append(word)
    pieces.append(tuple(current))

    return [
        Utterance(
            t0_ms=piece[0].t0_ms,
            t1_ms=piece[-1].t1_ms,
            text=_join_words(piece),
            words=piece,
            avg_logprob=segment.avg_logprob,
            whisper_segment_ids=(segment.segment_id,),
            deduped=deduped,
        )
        for piece in pieces
    ]


def _weighted_logprob(left: Utterance, right: Utterance) -> float:
    left_duration = max(1, left.t1_ms - left.t0_ms)
    right_duration = max(1, right.t1_ms - right.t0_ms)
    return (
        (left.avg_logprob * left_duration) + (right.avg_logprob * right_duration)
    ) / (left_duration + right_duration)


def _merge_pieces(pieces: Sequence[Utterance]) -> list[Utterance]:
    merged: list[Utterance] = []
    for piece in pieces:
        if not merged:
            merged.append(piece)
            continue

        previous = merged[-1]
        gap = piece.t0_ms - previous.t1_ms
        resulting_duration = piece.t1_ms - previous.t0_ms
        if (
            gap <= MERGE_GAP_MS
            and not previous.text.rstrip().endswith((".", "?", "!"))
            and resulting_duration <= MAX_UTTERANCE_MS
        ):
            words = previous.words + piece.words
            merged[-1] = Utterance(
                t0_ms=previous.t0_ms,
                t1_ms=piece.t1_ms,
                text=_join_words(words),
                words=words,
                avg_logprob=_weighted_logprob(previous, piece),
                whisper_segment_ids=previous.whisper_segment_ids + piece.whisper_segment_ids,
                deduped=previous.deduped or piece.deduped,
            )
        else:
            merged.append(piece)
    return merged


def _split_long_utterance(utterance: Utterance) -> list[Utterance]:
    if utterance.t1_ms - utterance.t0_ms <= MAX_UTTERANCE_MS or len(utterance.words) < 2:
        return [utterance]

    gaps = [
        (word.t0_ms - previous.t1_ms, index)
        for index, (previous, word) in enumerate(
            zip(utterance.words, utterance.words[1:], strict=False),
            start=1,
        )
        if word.t0_ms - previous.t1_ms >= LONG_SPLIT_MIN_GAP_MS
    ]
    if not gaps:
        return [utterance]

    _gap, split_index = max(gaps, key=lambda item: (item[0], -item[1]))
    first_words = utterance.words[:split_index]
    second_words = utterance.words[split_index:]
    return [
        Utterance(
            t0_ms=first_words[0].t0_ms,
            t1_ms=first_words[-1].t1_ms,
            text=_join_words(first_words),
            words=first_words,
            avg_logprob=utterance.avg_logprob,
            whisper_segment_ids=utterance.whisper_segment_ids,
            deduped=utterance.deduped,
        ),
        Utterance(
            t0_ms=second_words[0].t0_ms,
            t1_ms=second_words[-1].t1_ms,
            text=_join_words(second_words),
            words=second_words,
            avg_logprob=utterance.avg_logprob,
            whisper_segment_ids=utterance.whisper_segment_ids,
            deduped=utterance.deduped,
        ),
    ]


def build_utterances(segments: Sequence[RawSegment]) -> list[Utterance]:
    pieces: list[Utterance] = []
    for segment in sorted(segments, key=lambda item: (item.start_ms, item.segment_id)):
        pieces.extend(_segment_pieces(segment))

    utterances: list[Utterance] = []
    for utterance in _merge_pieces(pieces):
        utterances.extend(_split_long_utterance(utterance))
    return sorted(utterances, key=lambda item: (item.t0_ms, item.t1_ms))


def assert_timestamp_invariants(utterances: Sequence[Utterance], video_duration_ms: int) -> None:
    previous_end: int | None = None
    for utterance in utterances:
        if previous_end is not None and utterance.t0_ms < previous_end:
            raise PipelineError("unknown", "Transcription invariant I2 failed: overlap")
        previous_end = utterance.t1_ms

        durations: list[int] = []
        previous_word_t0: int | None = None
        for word in utterance.words:
            if previous_word_t0 is not None and word.t0_ms < previous_word_t0:
                raise PipelineError("unknown", "Transcription invariant I1 failed: word order")
            previous_word_t0 = word.t0_ms
            if word.t0_ms < utterance.t0_ms - 50 or word.t1_ms > utterance.t1_ms + 50:
                raise PipelineError("unknown", "Transcription invariant I1 failed: word span")
            durations.append(word.t1_ms - word.t0_ms)

        if durations:
            mean_duration = sum(durations) / len(durations)
            if mean_duration < 60 or mean_duration > 1200:
                raise PipelineError("unknown", "Transcription invariant I1 failed: duration")

        if utterance.t0_ms > video_duration_ms + 250 or utterance.t1_ms > video_duration_ms + 250:
            raise PipelineError("unknown", "Transcription invariant I4 failed: video bounds")


def measures_from_utterances(
    utterances: Sequence[Utterance],
    video_duration_ms: int | None = None,
) -> list[dict[str, Any]]:
    measures: list[dict[str, Any]] = []
    for index, utterance in enumerate(utterances):
        t0 = utterance.t0_ms
        t1 = utterance.t1_ms
        if video_duration_ms is not None and video_duration_ms > 0:
            t0 = max(0, min(video_duration_ms, t0))
            t1 = max(t0, min(video_duration_ms, t1))

        confidence = round(clamp(math.exp(utterance.avg_logprob), 0.0, 1.0), 4)
        words_payload = [
            {
                "w": word.text,
                "t0": max(0, min(video_duration_ms, word.t0_ms))
                if video_duration_ms is not None and video_duration_ms > 0
                else word.t0_ms,
                "t1": max(word.t0_ms, min(video_duration_ms, word.t1_ms))
                if video_duration_ms is not None and video_duration_ms > 0
                else word.t1_ms,
            }
            for word in utterance.words
        ]
        measures.append(
            {
                "kind": "utterance",
                "category": "speech",
                "t_start_ms": t0,
                "t_end_ms": t1,
                "value_num": None,
                "value_text": utterance.text,
                "unit": None,
                "confidence": confidence,
                "source": "video_analysis",
                "payload": {
                    "text": utterance.text,
                    "words": words_payload,
                    "avg_logprob": utterance.avg_logprob,
                    "whisper_segment_ids": list(utterance.whisper_segment_ids),
                    "lang": LANGUAGE,
                    "deduped": utterance.deduped,
                },
            }
        )
        measures.append(
            {
                "kind": "spoken_word",
                "category": "physical",
                "t_start_ms": t0,
                "t_end_ms": t1,
                "value_num": len(utterance.words),
                "value_text": None,
                "unit": "words",
                "confidence": confidence,
                "source": "video_analysis",
                "payload": {"utterance_index": index},
            }
        )
    return sorted(measures, key=lambda row: (int(row["t_start_ms"]), str(row["kind"])))


def wav_duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as wav:
        frames = wav.getnframes()
        rate = wav.getframerate()
    return ms_from_seconds(frames / rate)


def audio_rms_db(path: Path) -> float:
    result = run_media_command(
        [
            ffmpeg_path(),
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "info",
            "-i",
            str(path),
            "-vn",
            "-af",
            "volumedetect",
            "-f",
            "null",
            "-",
        ],
        timeout_seconds=MEDIA_TIMEOUT_SECONDS,
    )
    match = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?) dB", result.stderr)
    if match is None:
        return -100.0
    return float(match.group(1))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256_tree(path: Path) -> str | None:
    if not path.exists():
        return None
    files = sorted(item for item in path.rglob("*") if item.is_file())
    if not files:
        return None
    digest = hashlib.sha256()
    for file in files:
        digest.update(file.relative_to(path).as_posix().encode())
        digest.update(_sha256_file(file).encode())
    return digest.hexdigest()


def model_cache_dir() -> Path:
    raw = os.environ.get("JAMS_WHISPER_MODEL_CACHE")
    return Path(raw).expanduser() if raw else DEFAULT_MODEL_CACHE


def load_model(model_name: str = MODEL_NAME) -> tuple[Any, str | None]:
    from faster_whisper.utils import _MODELS
    from huggingface_hub import snapshot_download

    cache_dir = model_cache_dir()
    cache_dir.mkdir(parents=True, exist_ok=True)
    repo_id = _MODELS.get(model_name, model_name)
    model_path = Path(snapshot_download(repo_id=repo_id, cache_dir=cache_dir))
    model_sha256 = _sha256_tree(model_path)

    from faster_whisper import WhisperModel

    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        cpu_threads=min(4, os.cpu_count() or 1),
        num_workers=1,
        download_root=str(cache_dir),
    )
    return model, model_sha256


def _segments_from_whisper(
    raw_segments: Iterable[Any],
    *,
    progress: Any = None,
    duration_ms: int | None = None,
) -> list[RawSegment]:
    segments: list[RawSegment] = []
    for segment_id, segment in enumerate(raw_segments):
        if progress is not None and duration_ms:
            end_ms = ms_from_seconds(float(getattr(segment, "end", 0.0)))
            progress(min(0.9, max(0.1, end_ms / duration_ms)))
        words = tuple(
            WordTiming(
                text=_word_text(str(getattr(word, "word", ""))),
                t0_ms=ms_from_seconds(float(getattr(word, "start", 0.0))),
                t1_ms=ms_from_seconds(float(getattr(word, "end", 0.0))),
            )
            for word in (getattr(segment, "words", None) or [])
            if _word_text(str(getattr(word, "word", "")))
        )
        if not words:
            continue
        segments.append(
            RawSegment(
                segment_id=segment_id,
                start_ms=ms_from_seconds(float(getattr(segment, "start", 0.0))),
                end_ms=ms_from_seconds(float(getattr(segment, "end", 0.0))),
                text=str(getattr(segment, "text", "")).strip(),
                avg_logprob=float(getattr(segment, "avg_logprob", -1.0)),
                words=words,
            )
        )
    return segments


def _transcribe(
    model: Any,
    audio: Path,
    vad_threshold: float,
    *,
    progress: Any = None,
    duration_ms: int | None = None,
) -> list[RawSegment]:
    segments, _info = model.transcribe(
        str(audio),
        language=LANGUAGE,
        task="transcribe",
        beam_size=1,
        best_of=1,
        temperature=0.0,
        condition_on_previous_text=False,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={
            "threshold": vad_threshold,
            "min_speech_duration_ms": 250,
            "max_speech_duration_s": 30,
            "min_silence_duration_ms": 500,
            "speech_pad_ms": 200,
        },
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
        initial_prompt=None,
    )
    return _segments_from_whisper(segments, progress=progress, duration_ms=duration_ms)


def _upload_derived(context: PipelineContext, source: Path, blob_path: str) -> None:
    container = context.blob_service_client.get_container_client(DERIVED_CONTAINER)
    try:
        container.create_container()
    except ResourceExistsError:
        pass
    with source.open("rb") as file:
        container.upload_blob(blob_path, file, overwrite=True)


def _download_derived(context: PipelineContext, blob_path: str, target: Path) -> None:
    container = context.blob_service_client.get_container_client(DERIVED_CONTAINER)
    blob = container.get_blob_client(blob_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as file:
        blob.download_blob().readinto(file)


def _artifact_blob_path(context: PipelineContext, kinds: tuple[str, ...]) -> str | None:
    placeholders = ", ".join(["%s"] * len(kinds))
    row = context.db_conn.execute(
        f"""
        select blob_path
        from analysis_artifacts
        where run_id = %s
          and kind in ({placeholders})
        order by created_at desc
        limit 1
        """,
        (context.run_id, *kinds),
    ).fetchone()
    if row is None:
        return None
    return str(row[0])


def _video_duration_ms(context: PipelineContext, normalized_video: Path) -> int:
    return get_authoritative_duration_ms(context, normalized_video)


def _write_transcript(
    *,
    path: Path,
    status: str,
    reason: str | None,
    utterances: Sequence[Utterance],
    model_sha256: str | None,
    model_cache: Path,
    wav_duration: int | None,
    video_duration: int,
) -> None:
    payload = {
        "provider_id": PROVIDER_ID,
        "provider_version": PROVIDER_VERSION,
        "status": status,
        "reason": reason,
        "model": MODEL_NAME,
        "model_sha256": model_sha256,
        "model_cache": str(model_cache),
        "language": LANGUAGE,
        "wav_duration_ms": wav_duration,
        "video_duration_ms": video_duration,
        "text": " ".join(utterance.text for utterance in utterances).strip(),
        "utterances": [
            {
                "index": index,
                "t0": utterance.t0_ms,
                "t1": utterance.t1_ms,
                "text": utterance.text,
                "avg_logprob": utterance.avg_logprob,
                "whisper_segment_ids": list(utterance.whisper_segment_ids),
                "deduped": utterance.deduped,
                "words": [
                    {"w": word.text, "t0": word.t0_ms, "t1": word.t1_ms}
                    for word in utterance.words
                ],
            }
            for index, utterance in enumerate(utterances)
        ],
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


class TranscriptionProvider:
    @property
    def id(self) -> str:
        return PROVIDER_ID

    @property
    def version(self) -> str:
        return PROVIDER_VERSION

    @property
    def requires(self) -> list[str]:
        return ["artifact:video_normalized"]

    @property
    def provides(self) -> list[str]:
        return ["measure:utterance", "measure:spoken_word", "artifact:transcript_json"]

    def _normalized_video(self, context: PipelineContext) -> Path:
        local = context.workdir / "normalized.mp4"
        if local.exists():
            return local

        blob_path = _artifact_blob_path(context, ("video_normalized", "normalized_video"))
        if blob_path is None:
            raise PipelineError("unknown", "normalized video artifact not found")
        _download_derived(context, blob_path, local)
        return local

    def _audio(self, context: PipelineContext) -> Path | None:
        local = context.workdir / "audio_16k.wav"
        if local.exists():
            return local

        blob_path = _artifact_blob_path(context, ("audio_wav_16k", "audio_wav"))
        if blob_path is None:
            return None
        _download_derived(context, blob_path, local)
        return local

    def run(self, context: PipelineContext) -> list[dict[str, Any]]:
        context.heartbeat(self.id, 5, "Preparing transcription inputs")
        normalized_video = self._normalized_video(context)
        video_duration = _video_duration_ms(context, normalized_video)
        audio = self._audio(context)
        transcript_path = context.workdir / "transcript.json"
        model_sha256: str | None = None
        utterances: list[Utterance] = []
        measures: list[dict[str, Any]] = []
        status = "ok"
        reason: str | None = None
        wav_duration: int | None = None

        if audio is None:
            status = "skipped_no_audio"
            reason = "audio_wav_16k artifact absent"
            context.report_provider_summary(self.id, {"status": status, "reason": reason})
            _write_transcript(
                path=transcript_path,
                status=status,
                reason=reason,
                utterances=[],
                model_sha256=None,
                model_cache=model_cache_dir(),
                wav_duration=None,
                video_duration=video_duration,
            )
        else:
            wav_duration = wav_duration_ms(audio)
            if wav_duration + 500 < video_duration:
                status = "partial"
                reason = "audio_truncated"
            elif wav_duration > video_duration + 500:
                raise PipelineError("corrupt_file", "audio duration exceeds video duration")

            context.heartbeat(self.id, 10, "Loading Whisper model")
            model, model_sha256 = load_model()
            context.heartbeat(self.id, 15, "Transcribing audio")
            segments = _transcribe(
                model,
                audio,
                vad_threshold=0.5,
                progress=lambda fraction: context.heartbeat(
                    self.id,
                    10 + round(fraction * 80),
                    "Transcribing audio",
                ),
                duration_ms=wav_duration,
            )
            coverage_ms = sum(max(0, segment.end_ms - segment.start_ms) for segment in segments)
            if coverage_ms < wav_duration * 0.02 and audio_rms_db(audio) > -45:
                context.heartbeat(self.id, 50, "Retrying transcription with quiet-speech VAD")
                segments = _transcribe(
                    model,
                    audio,
                    vad_threshold=0.35,
                    progress=lambda fraction: context.heartbeat(
                        self.id,
                        10 + round(fraction * 80),
                        "Transcribing quiet speech",
                    ),
                    duration_ms=wav_duration,
                )

            context.heartbeat(self.id, 90, "Building transcript measures")
            utterances = build_utterances(segments)
            if not utterances:
                status = "partial"
                reason = "no_speech_detected"

            media = getattr(context, "media", None)
            if (
                media is not None
                and not media.audio_normalized_aligned
                and media.audio_offset_ms != 0
            ):
                offset_ms = media.audio_offset_ms
                utterances = [
                    Utterance(
                        t0_ms=media.clamp_timestamp_ms(u.t0_ms + offset_ms),
                        t1_ms=media.clamp_timestamp_ms(u.t1_ms + offset_ms),
                        text=u.text,
                        words=tuple(
                            WordTiming(
                                w.text,
                                media.clamp_timestamp_ms(w.t0_ms + offset_ms),
                                media.clamp_timestamp_ms(w.t1_ms + offset_ms),
                            )
                            for w in u.words
                        ),
                        avg_logprob=u.avg_logprob,
                        whisper_segment_ids=u.whisper_segment_ids,
                        deduped=u.deduped,
                    )
                    for u in utterances
                ]

            assert_timestamp_invariants(utterances, video_duration)
            measures = measures_from_utterances(utterances, video_duration_ms=video_duration)
            _write_transcript(
                path=transcript_path,
                status=status,
                reason=reason,
                utterances=utterances,
                model_sha256=model_sha256,
                model_cache=model_cache_dir(),
                wav_duration=wav_duration,
                video_duration=video_duration,
            )
            context.report_provider_summary(
                self.id,
                {
                    "status": status,
                    "reason": reason,
                    "utterance_count": len(utterances),
                    "spoken_word_count": sum(len(utterance.words) for utterance in utterances),
                    "model": MODEL_NAME,
                    "model_sha256": model_sha256,
                    "model_cache": str(model_cache_dir()),
                },
            )

        if not context.provider_summaries.get(self.id):
            context.report_provider_summary(self.id, {"status": status, "reason": reason})

        blob_path = (
            f"runs/{context.run_id}/attempts/{context.attempt}/"
            "transcription/transcript.json"
        )
        _upload_derived(context, transcript_path, blob_path)
        artifact_id = context.register_artifact("transcript_json", blob_path)
        for measure in measures:
            payload = dict(measure.get("payload") or {})
            payload["transcript_artifact_id"] = artifact_id
            payload["model"] = MODEL_NAME
            payload["model_sha256"] = model_sha256
            measure["payload"] = payload

        context.heartbeat(self.id, 100, f"Transcribed {len(utterances)} utterances")
        shutil.rmtree(context.workdir / "__pycache__", ignore_errors=True)
        return measures
