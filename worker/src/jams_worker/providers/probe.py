"""Probe and normalize the original upload into timestamp-stable artifacts."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from azure.core.exceptions import ResourceExistsError
from static_ffmpeg import run as static_ffmpeg_run

from jams_worker.errors import PipelineError
from jams_worker.pipeline import PipelineContext

VIDEOS_CONTAINER = "videos"
DERIVED_CONTAINER = "derived"
MAX_DURATION_SECONDS = 20 * 60


@dataclass(frozen=True, slots=True)
class ProbeResult:
    container: str
    video_codec: str
    width: int
    height: int
    fps: float | None
    duration_ms: int
    has_audio: bool
    audio_codec: str | None


@lru_cache(maxsize=1)
def ffmpeg_paths() -> tuple[str, str]:
    return static_ffmpeg_run.get_or_fetch_platform_executables_else_raise()


def _run_json(args: list[str]) -> dict[str, Any]:
    completed = subprocess.run(args, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise PipelineError(
            "corrupt_file",
            completed.stderr.strip() or "ffprobe could not read the video",
        )
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise PipelineError("corrupt_file", "ffprobe returned invalid JSON") from exc


def _fps(value: str | None) -> float | None:
    if not value or value == "0/0":
        return None
    if "/" not in value:
        try:
            return float(value)
        except ValueError:
            return None
    numerator, denominator = value.split("/", 1)
    try:
        den = float(denominator)
        return float(numerator) / den if den else None
    except ValueError:
        return None


def probe_file(path: Path) -> ProbeResult:
    _ffmpeg, ffprobe = ffmpeg_paths()
    data = _run_json(
        [
            ffprobe,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ]
    )
    streams = data.get("streams")
    if not isinstance(streams, list):
        raise PipelineError("corrupt_file", "ffprobe found no streams")

    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not isinstance(video_stream, dict):
        raise PipelineError("corrupt_file", "No video stream found")

    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format") if isinstance(data.get("format"), dict) else {}
    duration = video_stream.get("duration") or fmt.get("duration")
    try:
        duration_seconds = float(duration)
    except (TypeError, ValueError) as exc:
        raise PipelineError("corrupt_file", "Video duration is missing") from exc

    if duration_seconds > MAX_DURATION_SECONDS:
        raise PipelineError("too_long", "Video exceeds the 20 minute limit")

    try:
        width = int(video_stream["width"])
        height = int(video_stream["height"])
    except (KeyError, TypeError, ValueError) as exc:
        raise PipelineError("corrupt_file", "Video dimensions are missing") from exc

    return ProbeResult(
        container=str(fmt.get("format_name") or "unknown"),
        video_codec=str(video_stream.get("codec_name") or "unknown"),
        width=width,
        height=height,
        fps=_fps(str(video_stream.get("avg_frame_rate") or "")),
        duration_ms=round(duration_seconds * 1000),
        has_audio=isinstance(audio_stream, dict),
        audio_codec=str(audio_stream.get("codec_name")) if isinstance(audio_stream, dict) else None,
    )


def _download_blob(context: PipelineContext, target: Path) -> None:
    container = context.blob_service_client.get_container_client(VIDEOS_CONTAINER)
    blob = container.get_blob_client(str(context.run["blob_path"]))
    with target.open("wb") as file:
        stream = blob.download_blob()
        stream.readinto(file)


def _upload_blob(context: PipelineContext, source: Path, blob_path: str) -> None:
    container = context.blob_service_client.get_container_client(DERIVED_CONTAINER)
    try:
        container.create_container()
    except ResourceExistsError:
        pass
    with source.open("rb") as file:
        container.upload_blob(blob_path, file, overwrite=True)


def _run_ffmpeg_with_progress(
    args: list[str],
    *,
    duration_ms: int,
    context: PipelineContext,
    progress_start: int,
    progress_end: int,
) -> None:
    process = subprocess.Popen(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    assert process.stdout is not None
    for line in process.stdout:
        key, _, value = line.strip().partition("=")
        if key == "out_time_ms":
            try:
                out_ms = int(value) / 1000
            except ValueError:
                continue
            span = max(1, progress_end - progress_start)
            pct = progress_start + min(span, round((out_ms / max(1, duration_ms)) * span))
            context.heartbeat("normalize", pct, f"Normalizing... {pct}%")
    process.communicate()
    if process.returncode != 0:
        raise PipelineError("corrupt_file", "ffmpeg failed")


def _run_ffmpeg(args: list[str]) -> None:
    completed = subprocess.run(args, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise PipelineError("corrupt_file", completed.stderr.strip() or "ffmpeg failed")


class ProbeProvider:
    @property
    def id(self) -> str:
        return "probe"

    @property
    def version(self) -> str:
        return "1.0.0"

    @property
    def requires(self) -> list[str]:
        return ["original_video"]

    @property
    def provides(self) -> list[str]:
        return ["normalized_video", "audio_wav", "poster"]

    def run(self, context: PipelineContext) -> list[dict[str, Any]]:
        ffmpeg, _ffprobe = ffmpeg_paths()
        context.heartbeat("probe", 5, "Downloading original")
        original = context.workdir / "original"
        normalized = context.workdir / "normalized.mp4"
        audio = context.workdir / "audio.wav"
        poster = context.workdir / "poster.jpg"

        _download_blob(context, original)
        context.heartbeat("probe", 10, "Validating container")
        result = probe_file(original)

        context.db_conn.execute(
            """
            update videos
            set duration_ms = %s,
                width = %s,
                height = %s,
                fps = %s,
                has_audio = %s
            where id = %s and org_id = %s
            """,
            (
                result.duration_ms,
                result.width,
                result.height,
                result.fps,
                result.has_audio,
                context.video_id,
                context.org_id,
            ),
        )
        context.db_conn.commit()

        normalize_args = [
            ffmpeg,
            "-y",
            "-i",
            str(original),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-fps_mode",
            "cfr",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:1",
            "-nostats",
            str(normalized),
        ]
        _run_ffmpeg_with_progress(
            normalize_args,
            duration_ms=result.duration_ms,
            context=context,
            progress_start=20,
            progress_end=70,
        )

        normalized_path = f"{context.org_id}/{context.video_id}/normalized.mp4"
        _upload_blob(context, normalized, normalized_path)
        context.register_artifact("normalized_video", normalized_path)

        if result.has_audio:
            context.heartbeat("probe", 75, "Extracting audio")
            _run_ffmpeg(
                [
                    ffmpeg,
                    "-y",
                    "-i",
                    str(original),
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "pcm_s16le",
                    str(audio),
                ]
            )
            audio_path = f"{context.org_id}/{context.video_id}/audio.wav"
            _upload_blob(context, audio, audio_path)
            context.register_artifact("audio_wav", audio_path)
        else:
            context.heartbeat("probe", 80, "No audio stream detected")

        if not context.run.get("poster_blob_path"):
            context.heartbeat("probe", 85, "Extracting poster frame")
            _run_ffmpeg(
                [
                    ffmpeg,
                    "-y",
                    "-ss",
                    "0.5",
                    "-i",
                    str(original),
                    "-frames:v",
                    "1",
                    "-q:v",
                    "3",
                    str(poster),
                ]
            )
            poster_path = f"{context.org_id}/{context.video_id}/poster.jpg"
            _upload_blob(context, poster, poster_path)
            context.register_artifact("poster", poster_path)

        context.heartbeat("probe", 95, "Probe complete")
        return []
