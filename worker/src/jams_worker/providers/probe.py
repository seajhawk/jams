"""Probe and normalize the original upload into timestamp-stable artifacts."""

from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Any

from azure.core.exceptions import ResourceExistsError

from jams_worker import ffmpeg as ffmpeg_tools
from jams_worker.errors import PipelineError
from jams_worker.media import MediaMetadata
from jams_worker.pipeline import PipelineContext, log_event

VIDEOS_CONTAINER = "videos"
DERIVED_CONTAINER = "derived"
MAX_DURATION_SECONDS = 20 * 60

ProbeResult = MediaMetadata

# The normalized video only feeds the click and context-switch providers, which both re-derive a
# 480 px, 5 fps proxy from it, so the encode can be fast and (optionally) smaller without
# changing what they see. See docs/PIPELINE-PERF-2026-09-19.md for the measured comparison.
NORMALIZE_PRESET = "ultrafast"
NORMALIZE_MAX_WIDTH: int | None = 1920


def _run_json(args: list[str]) -> dict[str, Any]:
    completed = ffmpeg_tools.run_media_command(
        args,
        timeout_seconds=ffmpeg_tools.PROBE_TIMEOUT_SECONDS,
    )
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


def probe_file(path: Path) -> MediaMetadata:
    data = _run_json(
        [
            ffmpeg_tools.ffprobe_path(),
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
    container = str(fmt.get("format_name") or "unknown")
    # Transport streams carry a common mux clock offset; it is not leading
    # playback silence. MP4 edit-list delays still belong to its zero timeline.
    origin = 0.0
    if "mpegts" in container.split(","):
        try:
            origin = float(fmt.get("start_time") or 0.0)
        except (TypeError, ValueError) as exc:
            raise PipelineError("corrupt_file", "Invalid transport-stream origin") from exc
        if not math.isfinite(origin):
            raise PipelineError("corrupt_file", "Invalid transport-stream origin")

    try:
        v_start = float(video_stream.get("start_time") or 0.0)
    except (TypeError, ValueError):
        v_start = 0.0

    v_dur_raw = video_stream.get("duration")
    fmt_dur_raw = fmt.get("duration")

    try:
        v_dur = float(v_dur_raw) if v_dur_raw is not None else None
    except (TypeError, ValueError):
        v_dur = None

    try:
        fmt_dur = float(fmt_dur_raw) if fmt_dur_raw is not None else None
    except (TypeError, ValueError):
        fmt_dur = None

    if v_dur is not None and fmt_dur is not None:
        duration_seconds = max(v_start - origin + v_dur, fmt_dur)
    elif v_dur is not None:
        duration_seconds = v_start - origin + v_dur
    elif fmt_dur is not None:
        duration_seconds = fmt_dur
    else:
        raise PipelineError("corrupt_file", "Video duration is missing")

    if duration_seconds > MAX_DURATION_SECONDS:
        raise PipelineError("too_long", "Video exceeds the 20 minute limit")

    try:
        width = int(video_stream["width"])
        height = int(video_stream["height"])
    except (KeyError, TypeError, ValueError) as exc:
        raise PipelineError("corrupt_file", "Video dimensions are missing") from exc

    has_audio = isinstance(audio_stream, dict)
    audio_codec = str(audio_stream.get("codec_name")) if has_audio else None

    a_start: float | None = None
    a_dur: float | None = None
    audio_offset_ms = 0
    if has_audio and isinstance(audio_stream, dict):
        try:
            a_start = float(audio_stream.get("start_time") or 0.0)
        except (TypeError, ValueError):
            a_start = 0.0
        try:
            a_dur = float(audio_stream.get("duration") or 0.0)
        except (TypeError, ValueError):
            a_dur = None
        audio_offset_ms = round((a_start - origin) * 1000)
        if a_start is not None and a_dur is not None:
            duration_seconds = max(duration_seconds, a_start - origin + a_dur)

    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise PipelineError("corrupt_file", "Video duration must be finite and positive")
    if duration_seconds > MAX_DURATION_SECONDS:
        raise PipelineError("too_long", "Video exceeds the 20 minute limit")

    duration_ms = round(duration_seconds * 1000)

    return MediaMetadata(
        container=container,
        video_codec=str(video_stream.get("codec_name") or "unknown"),
        width=width,
        height=height,
        fps=_fps(str(video_stream.get("avg_frame_rate") or "")),
        duration_ms=duration_ms,
        has_audio=has_audio,
        audio_codec=audio_codec,
        time_origin_seconds=origin,
        video_start_seconds=v_start,
        video_duration_seconds=v_dur if v_dur is not None else duration_seconds,
        audio_start_seconds=a_start,
        audio_duration_seconds=a_dur,
        audio_offset_ms=audio_offset_ms,
        audio_normalized_aligned=True,
        video_normalized_aligned=True,
    )


def _download_blob(context: PipelineContext, target: Path) -> None:
    container = context.blob_service_client.get_container_client(VIDEOS_CONTAINER)
    blob = container.get_blob_client(str(context.run["blob_path"]))
    with target.open("wb") as file:
        stream = blob.download_blob()
        stream.readinto(file)


def _upload_blob(context: PipelineContext, source: Path, blob_path: str) -> None:
    with context.artifact_write_guard():
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
    def on_progress(line: str) -> None:
        key, _, value = line.strip().partition("=")
        if key == "out_time_ms":
            try:
                out_ms = int(value) / 1000
            except ValueError:
                return
            span = max(1, progress_end - progress_start)
            pct = progress_start + min(span, round((out_ms / max(1, duration_ms)) * span))
            context.heartbeat("normalize", pct, f"Normalizing... {pct}%")

    completed = ffmpeg_tools.run_media_command_with_progress(
        args,
        timeout_seconds=ffmpeg_tools.MEDIA_TIMEOUT_SECONDS,
        on_stdout_line=on_progress,
    )
    if completed.returncode != 0:
        raise PipelineError("corrupt_file", completed.stderr.strip() or "ffmpeg failed")


def _run_ffmpeg(args: list[str]) -> None:
    completed = ffmpeg_tools.run_media_command(
        args,
        timeout_seconds=ffmpeg_tools.MEDIA_TIMEOUT_SECONDS,
    )
    if completed.returncode != 0:
        raise PipelineError("corrupt_file", completed.stderr.strip() or "ffmpeg failed")


def build_normalize_args(
    ffmpeg: str,
    original: Path,
    normalized: Path,
    result: MediaMetadata,
    *,
    duration_s: float,
    preset: str = "veryfast",
    max_width: int | None = None,
    threads: int | None = None,
    progress: bool = False,
) -> list[str]:
    """The ffmpeg command that turns an upload into the timestamp-stable normalized mp4."""

    args = [
        ffmpeg,
        "-y",
        "-i",
        str(original),
        "-map",
        "0:v:0",
    ]
    filters: list[str] = []
    video_offset = result.video_start_seconds - result.time_origin_seconds
    if video_offset > 0.001:
        filters.append(f"tpad=start_duration={video_offset:.6f}:color=black")
    elif video_offset < -0.001:
        trim_start = abs(video_offset)
        filters.append(f"trim=start={trim_start:.6f},setpts=PTS-STARTPTS")
    if max_width is not None and result.width > max_width:
        # Never upscale; -2 keeps the height even for yuv420p.
        filters.append(f"scale={max_width}:-2")
    if filters:
        args.extend(["-vf", ",".join(filters)])

    if result.has_audio:
        args.extend(
            [
                "-map",
                "0:a:0",
                "-af",
                f"aresample=async=1:first_pts=0,apad=whole_dur={duration_s:.6f}",
                "-c:a",
                "aac",
            ]
        )
    args.extend(["-c:v", "libx264", "-preset", preset])
    if threads is not None:
        args.extend(["-threads", str(threads)])
    args.extend(
        [
            "-pix_fmt",
            "yuv420p",
            "-fps_mode",
            "cfr",
            "-t",
            f"{duration_s:.6f}",
            "-movflags",
            "+faststart",
        ]
    )
    if progress:
        args.extend(["-progress", "pipe:1", "-nostats"])
    args.append(str(normalized))
    return args


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
        ffmpeg = ffmpeg_tools.ffmpeg_path()
        context.heartbeat("probe", 5, "Downloading original")
        original = context.workdir / "original"
        normalized = context.workdir / "normalized.mp4"
        audio = context.workdir / "audio.wav"
        poster = context.workdir / "poster.jpg"

        timings_ms: dict[str, int] = {}
        stage_started = time.perf_counter()

        def stage_done(name: str) -> None:
            nonlocal stage_started
            now = time.perf_counter()
            timings_ms[name] = round((now - stage_started) * 1000)
            stage_started = now

        _download_blob(context, original)
        stage_done("download")
        context.heartbeat("probe", 10, "Validating container")
        result = probe_file(original)
        stage_done("validate")

        # What was processed, so throughput (processing time per minute of video) can be derived
        # from logs alone. Emitted before the slow work so a run that later fails still reports it.
        log_event(
            "media_profile",
            run_id=context.run_id,
            video_id=context.video_id,
            media_duration_ms=result.duration_ms,
            width=result.width,
            height=result.height,
            fps=result.fps,
            has_audio=result.has_audio,
            original_bytes=original.stat().st_size,
        )

        context.media = result
        context.run["duration_ms"] = result.duration_ms
        context.run["width"] = result.width
        context.run["height"] = result.height
        context.run["fps"] = result.fps
        context.run["has_audio"] = result.has_audio

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

        duration_s = max(0.001, result.duration_ms / 1000.0)

        normalize_args = build_normalize_args(
            ffmpeg,
            original,
            normalized,
            result,
            duration_s=duration_s,
            preset=NORMALIZE_PRESET,
            max_width=NORMALIZE_MAX_WIDTH,
            progress=True,
        )
        _run_ffmpeg_with_progress(
            normalize_args,
            duration_ms=result.duration_ms,
            context=context,
            progress_start=20,
            progress_end=70,
        )

        stage_done("normalize")

        normalized_path = f"runs/{context.run_id}/attempts/{context.attempt}/probe/normalized.mp4"
        _upload_blob(context, normalized, normalized_path)
        context.register_artifact("normalized_video", normalized_path)
        stage_done("upload_normalized")

        if result.has_audio:
            context.heartbeat("probe", 75, "Extracting audio")
            audio_filter = f"aresample=async=1:first_pts=0,apad=whole_dur={duration_s:.6f}"
            _run_ffmpeg(
                [
                    ffmpeg,
                    "-y",
                    "-i",
                    str(original),
                    "-vn",
                    "-af",
                    audio_filter,
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "pcm_s16le",
                    "-t",
                    f"{duration_s:.6f}",
                    str(audio),
                ]
            )
            audio_path = f"runs/{context.run_id}/attempts/{context.attempt}/probe/audio.wav"
            _upload_blob(context, audio, audio_path)
            context.register_artifact("audio_wav", audio_path)
            stage_done("audio")
        else:
            context.heartbeat("probe", 80, "No audio stream detected")

        if not context.run.get("poster_blob_path"):
            context.heartbeat("probe", 85, "Extracting poster frame")
            poster_ss = min(0.5, max(0.0, (result.duration_ms / 1000.0) - 0.1))
            _run_ffmpeg(
                [
                    ffmpeg,
                    "-y",
                    "-ss",
                    f"{poster_ss:.3f}",
                    "-i",
                    str(normalized),
                    "-frames:v",
                    "1",
                    "-q:v",
                    "3",
                    str(poster),
                ]
            )
            poster_path = f"runs/{context.run_id}/attempts/{context.attempt}/probe/poster.jpg"
            _upload_blob(context, poster, poster_path)
            context.register_artifact("poster", poster_path)
            stage_done("poster")

        stage_fields = {f"{name}_ms": ms for name, ms in timings_ms.items()}
        log_event("probe_timings", run_id=context.run_id, **stage_fields)
        context.heartbeat("probe", 95, "Probe complete")
        return []
