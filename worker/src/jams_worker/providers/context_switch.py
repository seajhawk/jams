"""Context-switch detection provider."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import cv2
import numpy as np
from azure.core.exceptions import ResourceExistsError
from scenedetect import SceneManager, StatsManager, open_video
from scenedetect.detectors import AdaptiveDetector

from jams_worker.errors import PipelineError
from jams_worker.ffmpeg import MEDIA_TIMEOUT_SECONDS, ffmpeg_path, run_media_command
from jams_worker.pipeline import PipelineContext
from jams_worker.providers.probe import DERIVED_CONTAINER
from jams_worker.providers.proxy_motion import (
    PROXY_FPS,
    MotionArtifact,
    _frame_delta,
    ensure_proxy_motion,
)

DetectorImpl = Literal["adaptive", "dhash"]

THUMB_WIDTH = 640
THUMB_OFFSET_SECONDS = 0.5


@dataclass(frozen=True, slots=True)
class ContextSwitchParams:
    """Tuning-set parameters from docs/design/f3b-patent-core-providers.md §1.

    The phase-correlation thresholds and borderline multiplier are first-pass
    tuning-set parameters per Claude's 2026-07-17 review amendment. They should
    move only through the fixture tuning workflow described in §3c.
    """

    adaptive_threshold: float = 4.0
    min_scene_len_frames: int = 10
    window_width: int = 3
    min_content_val: float = 12.0
    phase_response_threshold: float = 0.25
    phase_shift_px_threshold: float = 2.5
    low_boundary_response_exemption: float = 0.1
    borderline_post_count: int = 1
    drop_post_count: int = 2
    borderline_multiplier: float = 0.6
    confidence_floor: float = 0.35
    low_response_candidate_floor_factor: float = 0.8
    dhash_enter: int = 18
    dhash_exit: int = 10
    min_gap_seconds: float = 2.0


@dataclass(frozen=True, slots=True)
class PhaseCorrelation:
    response: float
    shift_x: float
    shift_y: float

    @property
    def shift_distance(self) -> float:
        return math.hypot(self.shift_x, self.shift_y)


@dataclass(frozen=True, slots=True)
class PostFilterDecision:
    keep: bool
    post_factor: float
    reason: str
    boundary: PhaseCorrelation | None
    post: tuple[PhaseCorrelation, ...]


@dataclass(frozen=True, slots=True)
class DetectorCut:
    frame_index: int
    t_start_ms: int
    confidence: float
    content_val: float | None
    trigger: float | None
    post_factor: float
    payload: dict[str, Any]


def ms_from_seconds(seconds: float) -> int:
    return math.floor(seconds * 1000 + 0.5)


def confidence_from_content_val(
    *,
    content_val: float,
    trigger: float,
    post_factor: float,
) -> float:
    ratio = max(1.0, content_val / trigger)
    base = min(1.0, 0.5 + 0.25 * math.log(ratio))
    return round(base * post_factor, 4)


def translation_like(phase: PhaseCorrelation, params: ContextSwitchParams) -> bool:
    return (
        phase.response >= params.phase_response_threshold
        and phase.shift_distance >= params.phase_shift_px_threshold
    )


def decide_post_filter(
    *,
    boundary: PhaseCorrelation | None,
    post: tuple[PhaseCorrelation, ...],
    params: ContextSwitchParams,
) -> PostFilterDecision:
    if boundary is not None and translation_like(boundary, params):
        return PostFilterDecision(False, 0.0, "boundary_translation", boundary, post)

    if boundary is not None and boundary.response < params.low_boundary_response_exemption:
        return PostFilterDecision(True, 1.0, "low_boundary_response_exemption", boundary, post)

    translation_count = sum(1 for phase in post if translation_like(phase, params))
    if translation_count >= params.drop_post_count:
        return PostFilterDecision(False, 0.0, "post_translation", boundary, post)
    if translation_count == params.borderline_post_count:
        return PostFilterDecision(
            True,
            params.borderline_multiplier,
            "borderline_post_translation",
            boundary,
            post,
        )
    return PostFilterDecision(True, 1.0, "no_translation", boundary, post)


def _phase_to_payload(phase: PhaseCorrelation | None) -> dict[str, float] | None:
    if phase is None:
        return None
    return {
        "response": round(phase.response, 4),
        "shift_x": round(phase.shift_x, 4),
        "shift_y": round(phase.shift_y, 4),
        "shift_px": round(phase.shift_distance, 4),
    }


def _run_ffmpeg(args: list[str], error_code: str = "transient") -> None:
    completed = run_media_command(args, timeout_seconds=MEDIA_TIMEOUT_SECONDS)
    if completed.returncode != 0:
        raise PipelineError(error_code, completed.stderr.strip() or "ffmpeg failed")


def extract_thumbnail(source: Path, target: Path, cut_ms: int) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    _run_ffmpeg(
        [
            ffmpeg_path(),
            "-y",
            "-ss",
            f"{cut_ms / 1000 + THUMB_OFFSET_SECONDS:.3f}",
            "-i",
            str(source),
            "-frames:v",
            "1",
            "-vf",
            f"scale={THUMB_WIDTH}:-2",
            "-q:v",
            "4",
            str(target),
        ]
    )


def phase_correlate(before: np.ndarray, after: np.ndarray) -> PhaseCorrelation:
    shift, response = cv2.phaseCorrelate(
        np.float32(before),
        np.float32(after),
    )
    return PhaseCorrelation(
        response=float(response),
        shift_x=float(shift[0]),
        shift_y=float(shift[1]),
    )


def _phase_from_motion(motion: MotionArtifact, frame_index: int) -> PhaseCorrelation | None:
    if frame_index <= 0 or frame_index >= len(motion.frame_ms):
        return None
    return PhaseCorrelation(
        response=float(motion.resp_full[frame_index]),
        shift_x=float(motion.dx_full[frame_index]),
        shift_y=float(motion.dy_full[frame_index]),
    )


def post_filter_for_frame(
    frames: list[np.ndarray],
    frame_index: int,
    params: ContextSwitchParams,
) -> PostFilterDecision:
    boundary = None
    if frame_index > 0 and frame_index < len(frames):
        boundary = phase_correlate(frames[frame_index - 1], frames[frame_index])

    post: list[PhaseCorrelation] = []
    for offset in range(4):
        left = frame_index + offset
        right = left + 1
        if right < len(frames):
            post.append(phase_correlate(frames[left], frames[right]))

    return decide_post_filter(boundary=boundary, post=tuple(post), params=params)


def post_filter_for_motion(
    motion: MotionArtifact,
    frame_index: int,
    params: ContextSwitchParams,
) -> PostFilterDecision:
    boundary = _phase_from_motion(motion, frame_index)
    post = [
        phase
        for offset in range(4)
        if (phase := _phase_from_motion(motion, frame_index + offset + 1)) is not None
    ]
    return decide_post_filter(boundary=boundary, post=tuple(post), params=params)


def _content_trigger(
    content_vals: list[float],
    frame_index: int,
    params: ContextSwitchParams,
) -> float:
    start = max(0, frame_index - params.window_width)
    trailing = content_vals[start:frame_index]
    mean_trailing = sum(trailing) / len(trailing) if trailing else 0.0
    return max(params.min_content_val, params.adaptive_threshold * mean_trailing)


def _candidate_frames_from_content(
    content_vals: list[float],
    params: ContextSwitchParams,
) -> list[int]:
    candidates: list[int] = []
    for frame_index in range(1, len(content_vals)):
        trigger = _content_trigger(content_vals, frame_index, params)
        relaxed_trigger = min(
            trigger,
            params.min_content_val * params.low_response_candidate_floor_factor,
        )
        if content_vals[frame_index] < relaxed_trigger:
            continue
        candidates.append(frame_index)
    return candidates


def _normalize_cut_frame(frame_index: int, frame_count: int) -> int:
    return max(0, min(frame_count - 1, frame_index))


def detect_adaptive(
    motion: MotionArtifact,
    params: ContextSwitchParams,
) -> list[DetectorCut]:
    frames = motion.frames
    if frames is None:
        raise PipelineError("unknown", "context-switch adaptive detector requires frames")
    stats = StatsManager()
    scene_manager = SceneManager(stats)
    scene_manager.add_detector(
        AdaptiveDetector(
            adaptive_threshold=params.adaptive_threshold,
            min_scene_len=params.min_scene_len_frames,
            window_width=params.window_width,
            min_content_val=params.min_content_val,
            luma_only=True,
        )
    )
    video = open_video(str(motion.proxy_path), framerate=PROXY_FPS)
    scene_manager.detect_scenes(video=video, show_progress=False)
    raw_cuts = scene_manager.get_cut_list(show_warning=False)

    stats_content_vals = [
        float((stats.get_metrics(index, ["content_val"])[0] or 0.0))
        for index in range(len(frames))
    ]
    ui_content_vals = [float(value) for value in motion.content_val]
    content_vals = [
        max(stats_value, ui_value)
        for stats_value, ui_value in zip(stats_content_vals, ui_content_vals, strict=True)
    ]
    candidate_frames = {
        _normalize_cut_frame(int(cut.get_frames()), len(frames)) for cut in raw_cuts
    }
    candidate_frames.update(_candidate_frames_from_content(content_vals, params))

    cuts: list[DetectorCut] = []
    last_kept_frame = -math.inf
    min_gap_frames = math.ceil(params.min_gap_seconds * PROXY_FPS)
    for frame_index in sorted(candidate_frames):
        if frame_index - last_kept_frame < min_gap_frames:
            continue
        decision = post_filter_for_motion(motion, frame_index, params)
        if not decision.keep:
            continue

        content_val = content_vals[frame_index]
        trigger = _content_trigger(content_vals, frame_index, params)
        if content_val < params.min_content_val * params.low_response_candidate_floor_factor:
            continue
        if (
            decision.reason == "low_boundary_response_exemption"
            and ui_content_vals[frame_index]
            < params.min_content_val * params.low_response_candidate_floor_factor
        ):
            continue
        confidence = confidence_from_content_val(
            content_val=content_val,
            trigger=trigger,
            post_factor=decision.post_factor,
        )
        if confidence < params.confidence_floor:
            continue

        cuts.append(
            DetectorCut(
                frame_index=frame_index,
                t_start_ms=ms_from_seconds(frame_index / PROXY_FPS),
                confidence=confidence,
                content_val=round(content_val, 4),
                trigger=round(trigger, 4),
                post_factor=decision.post_factor,
                payload={
                    "detector": "adaptive",
                    "frame_index": frame_index,
                    "proxy_fps": PROXY_FPS,
                    "content_val": round(content_val, 4),
                    "stats_content_val": round(stats_content_vals[frame_index], 4),
                    "ui_content_val": round(ui_content_vals[frame_index], 4),
                    "trigger": round(trigger, 4),
                    "post_factor": decision.post_factor,
                    "post_filter": decision.reason,
                    "phase_boundary": _phase_to_payload(decision.boundary),
                    "phase_post": [_phase_to_payload(phase) for phase in decision.post],
                },
            )
        )
        last_kept_frame = frame_index
    return sorted(cuts, key=lambda cut: cut.t_start_ms)


def _dhash(frame: np.ndarray) -> int:
    small = cv2.resize(frame, (9, 8), interpolation=cv2.INTER_LINEAR)
    bits = small[:, :-1] > small[:, 1:]
    value = 0
    for bit in bits.flatten():
        value = (value << 1) | int(bit)
    return value


def _hamming(left: int, right: int) -> int:
    return (left ^ right).bit_count()


def _visual_hash_distance(
    anchor_hash: int,
    frame_hash: int,
    anchor_frame: np.ndarray,
    frame: np.ndarray,
) -> int:
    return max(
        _hamming(anchor_hash, frame_hash),
        round(min(64.0, _frame_delta(anchor_frame, frame) * 2.0)),
    )


def _dhash_confidence(distance: int) -> float:
    return round(min(1.0, max(0.05, (distance - 10) / 22)), 4)


def detect_dhash(motion: MotionArtifact, params: ContextSwitchParams) -> list[DetectorCut]:
    frames = motion.frames
    if frames is None:
        raise PipelineError("unknown", "context-switch dHash detector requires frames")
    hashes = [_dhash(frame) for frame in frames]
    content_vals = [float(value) for value in motion.content_val]
    if len(hashes) < 2:
        return []

    cuts: list[DetectorCut] = []
    state = "stable"
    anchor = hashes[0]
    anchor_index = 0
    start = 0
    streak = 0
    last_cut_t = -math.inf
    index = 1
    while index < len(hashes):
        distance = _visual_hash_distance(anchor, hashes[index], frames[anchor_index], frames[index])
        if state == "stable":
            if distance >= params.dhash_enter:
                state = "suspect"
                start = index
                streak = 1
            elif distance <= params.dhash_exit:
                anchor = hashes[index]
                anchor_index = index
        else:
            if distance >= params.dhash_exit:
                streak += 1
            else:
                state = "stable"
                streak = 0
            if streak >= 2:
                cut_t = start / PROXY_FPS
                if cut_t - last_cut_t >= params.min_gap_seconds:
                    frame_index = _normalize_cut_frame(start, len(frames))
                    decision = post_filter_for_motion(motion, frame_index, params)
                    candidate_distance = _visual_hash_distance(
                        anchor, hashes[start], frames[anchor_index], frames[start]
                    )
                    confidence = _dhash_confidence(candidate_distance)
                    confidence = round(confidence * decision.post_factor, 4)
                    if decision.keep and confidence >= params.confidence_floor:
                        cuts.append(
                            DetectorCut(
                                frame_index=frame_index,
                                t_start_ms=ms_from_seconds(frame_index / PROXY_FPS),
                                confidence=confidence,
                                content_val=None,
                                trigger=None,
                                post_factor=decision.post_factor,
                                payload={
                                    "detector": "dhash",
                                    "frame_index": frame_index,
                                    "proxy_fps": PROXY_FPS,
                                    "dhash_distance": _hamming(anchor, hashes[start]),
                                    "visual_distance": candidate_distance,
                                    "ui_content_val": round(content_vals[start], 4),
                                    "post_factor": decision.post_factor,
                                    "post_filter": decision.reason,
                                    "phase_boundary": _phase_to_payload(decision.boundary),
                                    "phase_post": [
                                        _phase_to_payload(phase) for phase in decision.post
                                    ],
                                },
                            )
                        )
                    last_cut_t = cut_t
                settled = min(start + 2, len(hashes) - 1)
                anchor = hashes[settled]
                anchor_index = settled
                index = settled
                state = "stable"
                streak = 0
        index += 1

    return sorted(cuts, key=lambda cut: cut.t_start_ms)


def detect_context_switches(
    video: Path,
    workdir: Path,
    *,
    detector_impl: DetectorImpl = "adaptive",
    params: ContextSwitchParams | None = None,
) -> list[DetectorCut]:
    params = params or ContextSwitchParams()
    motion = ensure_proxy_motion(video, workdir, include_frames=True)
    if detector_impl == "adaptive":
        return detect_adaptive(motion, params)
    if detector_impl == "dhash":
        return detect_dhash(motion, params)
    raise ValueError(f"Unsupported detector_impl: {detector_impl}")


def _config_detector(context: PipelineContext, default: DetectorImpl) -> DetectorImpl:
    config = context.run.get("config")
    detector = default
    if isinstance(config, dict):
        context_config = config.get("context_switch")
        if isinstance(context_config, dict) and isinstance(
            context_config.get("detector_impl"), str
        ):
            detector = context_config["detector_impl"]  # type: ignore[assignment]
        elif isinstance(config.get("detector_impl"), str):
            detector = config["detector_impl"]  # type: ignore[assignment]
    if detector not in ("adaptive", "dhash"):
        raise PipelineError("unknown", f"Unsupported context_switch detector_impl: {detector}")
    return detector


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
    with target.open("wb") as file:
        blob.download_blob().readinto(file)


def _artifact_blob_path(context: PipelineContext) -> str | None:
    row = context.db_conn.execute(
        """
        select blob_path
        from analysis_artifacts
        where run_id = %s
          and kind in ('video_normalized', 'normalized_video')
        order by case when kind = 'video_normalized' then 0 else 1 end, created_at desc
        limit 1
        """,
        (context.run_id,),
    ).fetchone()
    if row is None:
        return None
    return str(row[0])


class ContextSwitchProvider:
    def __init__(
        self,
        *,
        detector_impl: DetectorImpl = "adaptive",
        params: ContextSwitchParams | None = None,
    ) -> None:
        self._detector_impl = detector_impl
        self._params = params or ContextSwitchParams()

    @property
    def id(self) -> str:
        return "context_switch"

    @property
    def version(self) -> str:
        return "1.0.0"

    @property
    def requires(self) -> list[str]:
        return ["artifact:video_normalized"]

    @property
    def provides(self) -> list[str]:
        return ["measure:context_switch", "artifact:thumbnail"]

    def _normalized_video(self, context: PipelineContext) -> Path:
        local = context.workdir / "normalized.mp4"
        if local.exists():
            return local

        blob_path = _artifact_blob_path(context)
        if blob_path is None:
            raise PipelineError("unknown", "normalized video artifact not found")
        _download_derived(context, blob_path, local)
        return local

    def run(self, context: PipelineContext) -> list[dict[str, Any]]:
        detector_impl = _config_detector(context, self._detector_impl)
        source = self._normalized_video(context)
        fallback_reason: str | None = None

        context.heartbeat(self.id, 10, "Building context-switch proxy")
        try:
            cuts = detect_context_switches(
                source,
                context.workdir,
                detector_impl=detector_impl,
                params=self._params,
            )
        except Exception:
            if detector_impl == "adaptive":
                context.heartbeat(self.id, 35, "Adaptive detector failed; retrying with dHash")
                cuts = detect_context_switches(
                    source,
                    context.workdir,
                    detector_impl="dhash",
                    params=self._params,
                )
                detector_impl = "dhash"
                fallback_reason = "adaptive_detector_unavailable"
            else:
                raise

        measures: list[dict[str, Any]] = []
        total = max(1, len(cuts))
        for index, cut in enumerate(cuts, start=1):
            context.heartbeat(
                self.id,
                80 + round((index / total) * 15),
                f"Extracting thumbnail {index}/{len(cuts)}",
            )
            thumb = context.workdir / "context_switch_thumbs" / f"{cut.t_start_ms}.jpg"
            extract_thumbnail(source, thumb, cut.t_start_ms)
            blob_path = (
                f"runs/{context.run_id}/attempts/{context.attempt}/"
                f"context_switch/{cut.t_start_ms}.jpg"
            )
            _upload_derived(context, thumb, blob_path)
            artifact_id = context.register_artifact("thumbnail", blob_path)

            payload = {
                **cut.payload,
                "thumbnail_artifact_id": artifact_id,
                "thumbnail_blob_path": blob_path,
                "from": None,
                "to": None,
            }
            if fallback_reason is not None:
                payload["fallback_reason"] = fallback_reason

            measures.append(
                {
                    "kind": "context_switch",
                    "category": "cognitive",
                    "t_start_ms": cut.t_start_ms,
                    "t_end_ms": None,
                    "value_num": 1,
                    "value_text": None,
                    "unit": "switch",
                    "confidence": cut.confidence,
                    "source": "video_analysis",
                    "payload": payload,
                }
            )

        context.heartbeat(self.id, 95, f"Detected {len(measures)} context switches")
        return sorted(measures, key=lambda row: (int(row["t_start_ms"]), str(row["kind"])))
