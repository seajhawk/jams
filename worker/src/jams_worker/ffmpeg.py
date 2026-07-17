"""Pinned ffmpeg/ffprobe executable resolution."""

from __future__ import annotations

from functools import lru_cache

from static_ffmpeg import run as static_ffmpeg_run


@lru_cache(maxsize=1)
def ffmpeg_paths() -> tuple[str, str]:
    """Return the static-ffmpeg managed ffmpeg and ffprobe executable paths."""

    return static_ffmpeg_run.get_or_fetch_platform_executables_else_raise()


def ffmpeg_path() -> str:
    return ffmpeg_paths()[0]


def ffprobe_path() -> str:
    return ffmpeg_paths()[1]
