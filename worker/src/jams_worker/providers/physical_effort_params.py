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


@dataclass(frozen=True, slots=True)
class AudioOnsetParams:
    """[TUNE] constants from docs/design/f10-physical-effort-providers.md §1a/§5."""

    sample_rate_hz: int = 16_000
    preemphasis: float = 0.97
    stft_window_samples: int = 256
    stft_hop_samples: int = 64
    adaptive_window_ms: int = 1500
    adaptive_mad_multiplier: float = 4.0
    global_mad_multiplier: float = 3.0
    refractory_ms: int = 20
    hf_ratio_min: float = 0.35
    merge_ms: int = 40
    threshold_sample_stride: int = 128
    typing_train_max_gap_ms: int = 600
    typing_min_count: int = 4
    typing_mean_ioi_min_ms: int = 70
    typing_mean_ioi_max_ms: int = 500
    typing_ioi_cv_max: float = 0.55
    typing_spec_selfsim_min: float = 0.70
    click_decay_max_ms: int = 25
    click_centroid_min_hz: float = 3000.0
    speech_pad_ms: int = 120
    in_speech_threshold_multiplier: float = 1.6
    speech_policy: str = "requires_visual"


@dataclass(frozen=True, slots=True)
class KeypressParams:
    """[TUNE] burst/count thresholds from §2."""

    pause_split_ms: int = 800
    pair_ioi_max_ms: int = 90
    pair_ioi_fraction_min: float = 0.40
    pair_spec_sim_min: float = 0.80
    visual_peak_window_ms: int = 250
    visual_peak_share_min: float = 0.50
    spec_selfsim_bonus_min: float = 0.80
    suppress_below: float = 0.35


@dataclass(frozen=True, slots=True)
class ClickParams:
    """[TUNE] fusion and visual-verification thresholds from §1b/§1c."""

    pre_quiet_start_ms: int = 600
    pre_quiet_end_ms: int = 200
    post_window_ms: int = 400
    post_frames: int = 2
    mask_gray_threshold: int = 25
    min_area_fraction: float = 0.002
    max_area_fraction: float = 0.30
    visual_only_max_area_fraction: float = 0.12
    centroid_stability_width_fraction: float = 0.05
    visual_candidate_cap: int = 4000
    visual_proposal_min_gap_ms: int = 180
    suppress_below: float = 0.35
