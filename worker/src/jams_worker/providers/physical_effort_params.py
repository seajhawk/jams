"""Tuning constants for physical-effort CV providers."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ScrollParams:
    """First-pass scroll thresholds from docs/design/f10-physical-effort-providers.md §3."""

    strip_agree_px: float = 1.5
    strip_response_threshold: float = 0.15
    min_shift_px: float = 1.5
    full_frame_corroboration_factor: float = 0.5
    invalid_gap_split_frames: int = 3
    sign_reversal_split_frames: int = 2
    single_frame_flick_px: float = 8.0
    scene_cut_min_content_val: float = 12.0
    scene_cut_window_width: int = 3
    scene_cut_adaptive_threshold: float = 4.0
    scene_cut_min_gap_seconds: float = 2.0
