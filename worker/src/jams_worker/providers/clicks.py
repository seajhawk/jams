"""Physical click provider with audio proposals and visual verification."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from jams_worker.pipeline import PipelineContext
from jams_worker.providers.audio_onsets import AudioOnsetArtifact, ensure_audio_onsets
from jams_worker.providers.keypresses import _audio, _normalized_video, speech_regions_for_context
from jams_worker.providers.physical_effort_params import AudioOnsetParams, ClickParams
from jams_worker.providers.proxy_motion import MotionArtifact, ensure_proxy_motion

PROVIDER_ID = "physical.clicks"
PROVIDER_VERSION = "1.0.0"


@dataclass(frozen=True, slots=True)
class VisualEvidence:
    passed: bool
    response_centroid: dict[str, int] | None
    frame_index: int | None
    area_fraction: float | None


@dataclass(frozen=True, slots=True)
class ClickEvent:
    t_start_ms: int
    confidence: float
    evidence: str
    audio_label: str | None
    in_speech: bool
    visual: VisualEvidence


def _frame_indices_after(motion: MotionArtifact, t_ms: int, params: ClickParams) -> list[int]:
    indices = [
        int(index)
        for index in np.flatnonzero(
            (motion.frame_ms > t_ms) & (motion.frame_ms <= t_ms + params.post_window_ms)
        )
    ]
    return indices[: params.post_frames]


def _pre_quiet(motion: MotionArtifact, t_ms: int, params: ClickParams) -> bool:
    indices = np.flatnonzero(
        (motion.frame_ms >= t_ms - params.pre_quiet_start_ms)
        & (motion.frame_ms <= t_ms - params.pre_quiet_end_ms)
    )
    if len(indices) == 0:
        return True
    quiet_level = float(np.mean(motion.diff_energy[indices]))
    return quiet_level <= max(float(np.percentile(motion.diff_energy, 60)), 0.6)


def _mask_centroid(mask: np.ndarray) -> tuple[float, float] | None:
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    return float(np.mean(xs)), float(np.mean(ys))


def _localized_masks(
    motion: MotionArtifact,
    indices: list[int],
    params: ClickParams,
) -> list[tuple[int, float, tuple[float, float]]]:
    if motion.frames is None:
        return []
    result: list[tuple[int, float, tuple[float, float]]] = []
    frame_area = motion.width * motion.height
    for index in indices:
        if index <= 0 or index >= len(motion.frames):
            continue
        delta = np.abs(
            motion.frames[index].astype(np.int16) - motion.frames[index - 1].astype(np.int16)
        )
        mask = delta > params.mask_gray_threshold
        area = float(np.count_nonzero(mask) / max(1, frame_area))
        if not (params.min_area_fraction <= area <= params.max_area_fraction):
            continue
        centroid = _mask_centroid(mask)
        if centroid is not None:
            result.append((index, area, centroid))
    return result


def verify_visual(
    motion: MotionArtifact,
    t_ms: int,
    *,
    full_width: int | None = None,
    full_height: int | None = None,
    params: ClickParams | None = None,
) -> VisualEvidence:
    params = params or ClickParams()
    if motion.frames is None or not _pre_quiet(motion, t_ms, params):
        return VisualEvidence(False, None, None, None)
    masks = _localized_masks(motion, _frame_indices_after(motion, t_ms, params), params)
    if not masks:
        return VisualEvidence(False, None, None, None)
    if len(masks) >= 2:
        first = masks[0][2]
        second = masks[1][2]
        if abs(first[0] - second[0]) > params.centroid_stability_width_fraction * motion.width:
            return VisualEvidence(False, None, None, None)
    frame_index, area, centroid = masks[0]
    scale_x = (full_width or motion.width) / motion.width
    scale_y = (full_height or motion.height) / motion.height
    return VisualEvidence(
        True,
        {"x": int(round(centroid[0] * scale_x)), "y": int(round(centroid[1] * scale_y))},
        frame_index,
        round(area, 6),
    )


def _audio_confidence(label: str, in_speech: bool, visual: VisualEvidence) -> tuple[float, str]:
    if in_speech:
        return (0.60, "audio_in_speech_visual") if visual.passed else (0.30, "audio_in_speech")
    if label == "click_candidate":
        return (0.90, "audio_click_visual") if visual.passed else (0.70, "audio_click")
    return (0.55, "audio_ambiguous_visual") if visual.passed else (0.40, "audio_ambiguous")


def detect_audio_clicks(
    artifact: AudioOnsetArtifact,
    *,
    motion: MotionArtifact | None = None,
    full_width: int | None = None,
    full_height: int | None = None,
    params: ClickParams | None = None,
) -> list[ClickEvent]:
    params = params or ClickParams()
    events: list[ClickEvent] = []
    candidates = [
        onset
        for onset in artifact.onsets
        if onset.label in {"click_candidate", "ambiguous"} and onset.train_id is None
    ]
    for onset in candidates:
        visual = (
            verify_visual(
                motion,
                onset.t_ms,
                full_width=full_width,
                full_height=full_height,
                params=params,
            )
            if motion is not None
            else VisualEvidence(False, None, None, None)
        )
        confidence, evidence = _audio_confidence(onset.label, onset.in_speech, visual)
        if confidence < params.suppress_below:
            continue
        events.append(
            ClickEvent(
                t_start_ms=onset.t_ms,
                confidence=confidence,
                evidence=evidence,
                audio_label=onset.label,
                in_speech=onset.in_speech,
                visual=visual,
            )
        )
    return sorted(events, key=lambda event: event.t_start_ms)


def detect_visual_clicks(
    motion: MotionArtifact,
    *,
    full_width: int | None = None,
    full_height: int | None = None,
    params: ClickParams | None = None,
) -> list[ClickEvent]:
    params = params or ClickParams()
    events: list[ClickEvent] = []
    previous_t_ms = -10_000
    for frame_index in range(1, len(motion.frame_ms)):
        if len(events) >= params.visual_candidate_cap:
            break
        t_ms = int(motion.frame_ms[frame_index])
        if t_ms - previous_t_ms < params.visual_proposal_min_gap_ms:
            continue
        if not _pre_quiet(motion, t_ms, params):
            continue
        masks = _localized_masks(motion, [frame_index, frame_index + 1], params)
        if not masks or masks[0][0] != frame_index:
            continue
        if masks[0][1] > params.visual_only_max_area_fraction:
            continue
        if len(masks) >= 2:
            first = masks[0][2]
            second = masks[1][2]
            if abs(first[0] - second[0]) > params.centroid_stability_width_fraction * motion.width:
                continue
        _frame_index, area, centroid = masks[0]
        scale_x = (full_width or motion.width) / motion.width
        scale_y = (full_height or motion.height) / motion.height
        visual = VisualEvidence(
            True,
            {"x": int(round(centroid[0] * scale_x)), "y": int(round(centroid[1] * scale_y))},
            frame_index,
            round(area, 6),
        )
        if not visual.passed:
            continue
        events.append(
            ClickEvent(
                t_start_ms=t_ms,
                confidence=0.35,
                evidence="visual_only_no_audio",
                audio_label=None,
                in_speech=False,
                visual=visual,
            )
        )
        previous_t_ms = t_ms
    return events


class ClicksProvider:
    def __init__(
        self,
        *,
        onset_params: AudioOnsetParams | None = None,
        params: ClickParams | None = None,
    ) -> None:
        self._onset_params = onset_params or AudioOnsetParams()
        self._params = params or ClickParams()

    @property
    def id(self) -> str:
        return PROVIDER_ID

    @property
    def version(self) -> str:
        return PROVIDER_VERSION

    @property
    def requires(self) -> list[str]:
        return ["artifact:proxy_motion_v1", "artifact:audio_onsets_v1?"]

    @property
    def provides(self) -> list[str]:
        return ["measure:clicks"]

    def run(self, context: PipelineContext) -> list[dict[str, Any]]:
        context.heartbeat(self.id, 10, "Detecting clicks")
        video = _normalized_video(context)
        motion = (
            ensure_proxy_motion(video, context.workdir, include_frames=True)
            if video is not None
            else None
        )
        audio = _audio(context)
        full_width = int(context.run.get("width") or motion.width) if motion is not None else None
        full_height = (
            int(context.run.get("height") or motion.height) if motion is not None else None
        )

        if audio is None:
            events = (
                detect_visual_clicks(
                    motion,
                    full_width=full_width,
                    full_height=full_height,
                    params=self._params,
                )
                if motion is not None
                else []
            )
            summary = {
                "status": "ok",
                "mode": "visual_only_no_audio",
                "measure_count": len(events),
            }
        else:
            speech_regions = speech_regions_for_context(context)
            artifact = ensure_audio_onsets(
                audio,
                context.workdir,
                speech_regions=speech_regions,
                params=self._onset_params,
            )
            events = detect_audio_clicks(
                artifact,
                motion=motion,
                full_width=full_width,
                full_height=full_height,
                params=self._params,
            )
            summary = {
                "status": "ok",
                "mode": "audio_proposes_visual_verifies",
                "measure_count": len(events),
                "audio_onsets": len(artifact.onsets),
                "confidence_tiers": _confidence_tiers(events),
            }

        context.report_provider_summary(self.id, summary)
        context.heartbeat(self.id, 95, f"Detected {len(events)} click events")
        return [
            {
                "kind": "clicks",
                "category": "physical",
                "t_start_ms": event.t_start_ms,
                "t_end_ms": None,
                "value_num": 1,
                "value_text": None,
                "unit": "click",
                "confidence": event.confidence,
                "source": "video_analysis",
                "payload": {
                    "type": "single",
                    "location": None,
                    "response_centroid": event.visual.response_centroid,
                    "context": None,
                    "evidence": event.evidence,
                    "audio_label": event.audio_label,
                    "in_speech": event.in_speech,
                    "visually_corroborated": event.visual.passed,
                    "visual_frame_index": event.visual.frame_index,
                    "visual_area_fraction": event.visual.area_fraction,
                },
            }
            for event in events
        ]


def _confidence_tiers(events: list[ClickEvent]) -> dict[str, int]:
    tiers: dict[str, int] = {}
    for event in events:
        key = f"{event.confidence:.2f}"
        tiers[key] = tiers.get(key, 0) + 1
    return tiers
