"""Authoritative media timebase and metadata contracts."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from jams_worker.pipeline import PipelineContext


@dataclass(frozen=True, slots=True)
class MediaMetadata:
    """Authoritative post-probe media metadata object.

    Defines the single authoritative media time origin (playback T=0)
    and provides deterministic mapping between stream presentation timestamps
    and the video playback timeline.
    """

    container: str
    video_codec: str
    width: int
    height: int
    fps: float | None
    duration_ms: int
    has_audio: bool
    audio_codec: str | None = None

    # Authoritative timebase contracts
    time_origin_seconds: float = 0.0  # Playback origin T=0 in container timeline
    video_start_seconds: float = 0.0  # Video stream start_time
    video_duration_seconds: float = 0.0  # Video stream duration
    audio_start_seconds: float | None = None  # Audio stream start_time
    audio_duration_seconds: float | None = None  # Audio stream duration
    audio_offset_ms: int = 0  # Audio stream start offset relative to playback origin (ms)
    audio_normalized_aligned: bool = True  # True if audio.wav extracted with origin alignment
    video_normalized_aligned: bool = True  # True if normalized.mp4 video padded/aligned with origin

    def clamp_timestamp_ms(self, t_ms: int) -> int:
        """Clamp a timestamp in milliseconds to valid playback timeline bounds [0, duration_ms]."""
        return max(0, min(self.duration_ms, t_ms))

    def audio_stream_ms_to_timeline_ms(self, stream_ms: int) -> int:
        """Map raw unpadded audio stream position to playback timeline position.

        If audio was delayed by 1936 ms, stream_ms=0 maps to 1936 ms on playback timeline.
        If audio.wav was extracted with origin alignment, audio sample 0 is ALREADY at 0 ms.
        """
        if self.audio_normalized_aligned:
            return self.clamp_timestamp_ms(stream_ms)
        return self.clamp_timestamp_ms(stream_ms + self.audio_offset_ms)

    def timeline_ms_to_audio_stream_ms(self, timeline_ms: int) -> int:
        """Map playback timeline millisecond position to unpadded audio stream position."""
        if self.audio_normalized_aligned:
            return max(0, timeline_ms)
        return max(0, timeline_ms - self.audio_offset_ms)

    def video_stream_ms_to_timeline_ms(self, stream_ms: int) -> int:
        """Map raw unpadded video stream position to playback timeline position.

        If video was delayed by 1500 ms in the original container, stream_ms=0 maps to 1500 ms.
        If normalized.mp4 was encoded with origin alignment (video_normalized_aligned=True),
        frame 0 is ALREADY at 0 ms.
        """
        if self.video_normalized_aligned:
            return self.clamp_timestamp_ms(stream_ms)
        offset_ms = round(self.video_start_seconds * 1000)
        return self.clamp_timestamp_ms(stream_ms + offset_ms)

    def timeline_ms_to_video_stream_ms(self, timeline_ms: int) -> int:
        """Map playback timeline millisecond position to unpadded video stream position."""
        if self.video_normalized_aligned:
            return max(0, timeline_ms)
        offset_ms = round(self.video_start_seconds * 1000)
        return max(0, timeline_ms - offset_ms)

    def to_dict(self) -> dict[str, Any]:
        return {
            "container": self.container,
            "video_codec": self.video_codec,
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "duration_ms": self.duration_ms,
            "has_audio": self.has_audio,
            "audio_codec": self.audio_codec,
            "time_origin_seconds": self.time_origin_seconds,
            "video_start_seconds": self.video_start_seconds,
            "video_duration_seconds": self.video_duration_seconds,
            "audio_start_seconds": self.audio_start_seconds,
            "audio_duration_seconds": self.audio_duration_seconds,
            "audio_offset_ms": self.audio_offset_ms,
            "audio_normalized_aligned": self.audio_normalized_aligned,
            "video_normalized_aligned": self.video_normalized_aligned,
        }


def get_authoritative_duration_ms(
    context: PipelineContext,
    fallback_path: Path | None = None,
) -> int:
    """Return the authoritative video duration in milliseconds.

    Checks:
    1. context.media (authoritative post-probe object populated by ProbeProvider)
    2. Database videos table (updated by ProbeProvider in Postgres)
    3. fallback_path (probed on disk if provided and exists)
    4. context.run["duration_ms"] (untrusted client upload fallback only if probe hasn't run)
    """
    media = getattr(context, "media", None)
    if media is not None:
        return media.duration_ms

    db_conn = getattr(context, "db_conn", None)
    if db_conn is not None:
        row = db_conn.execute(
            "select duration_ms from videos where id = %s and org_id = %s",
            (context.video_id, context.org_id),
        ).fetchone()
        if row is not None and row[0] is not None:
            return int(row[0])

    if fallback_path is not None and fallback_path.exists():
        from jams_worker.ffmpeg import PROBE_TIMEOUT_SECONDS, ffprobe_path, run_media_command

        result = run_media_command(
            [
                ffprobe_path(),
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                str(fallback_path),
            ],
            timeout_seconds=PROBE_TIMEOUT_SECONDS,
        )
        if result.returncode == 0 and result.stdout.strip():
            try:
                return int(math.floor(float(result.stdout.strip()) * 1000 + 0.5))
            except ValueError:
                pass

    return int(context.run.get("duration_ms") or 0)


def get_authoritative_media(
    context: PipelineContext,
) -> MediaMetadata | None:
    return getattr(context, "media", None)
