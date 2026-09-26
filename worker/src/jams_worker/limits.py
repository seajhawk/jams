"""Media limits the worker enforces before heavy work.

The web app's policy module (apps/web/src/lib/limits.ts) is the primary gate; these are the
worker's defense in depth for anything that reaches the queue anyway (limits lowered after an
upload, legacy rows, a client that lied about its metadata). The knobs share their names with the
web app's so one setting applies to both units.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
DEFAULT_MAX_DURATION_MS = 20 * 60 * 1000
# 8K UHD. Larger frames make the normalization decode disproportionately expensive and are not
# screen recordings anyone produces today.
DEFAULT_MAX_VIDEO_PIXELS = 7680 * 4320


@dataclass(frozen=True, slots=True)
class MediaLimits:
    max_bytes: int = DEFAULT_MAX_UPLOAD_BYTES
    max_duration_ms: int = DEFAULT_MAX_DURATION_MS
    max_video_pixels: int = DEFAULT_MAX_VIDEO_PIXELS


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None:
        return default
    raw = raw.strip()
    if not raw.isdigit() or int(raw) <= 0:
        # A typo must not disable a limit; keep the safe default and say so.
        from jams_worker.pipeline import log_event

        log_event("media_limit_config_invalid", name=name)
        return default
    return int(raw)


def media_limits(env: Mapping[str, str] | None = None) -> MediaLimits:
    source = os.environ if env is None else env
    return MediaLimits(
        max_bytes=_positive_int(source, "JAMS_LIMIT_UPLOAD_MAX_BYTES", DEFAULT_MAX_UPLOAD_BYTES),
        max_duration_ms=_positive_int(
            source, "JAMS_LIMIT_UPLOAD_MAX_DURATION_MS", DEFAULT_MAX_DURATION_MS
        ),
        max_video_pixels=_positive_int(
            source, "JAMS_LIMIT_MAX_VIDEO_PIXELS", DEFAULT_MAX_VIDEO_PIXELS
        ),
    )
