"""Physical scroll detection from the shared proxy motion artifact."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np

from jams_worker.errors import PipelineError
from jams_worker.pipeline import PipelineContext
from jams_worker.providers.physical_effort_params import ScrollParams
from jams_worker.providers.proxy_motion import PROXY_FPS, MotionArtifact, ensure_proxy_motion

PROVIDER_ID = "physical.scrolls"
PROVIDER_VERSION = "1.0.0"
ScrollAxis = Literal["vertical", "horizontal"]
ScrollDirection = Literal["up", "down", "left", "right"]


@dataclass(frozen=True, slots=True)
class ScrollFrame:
    index: int
    axis: ScrollAxis
    sign: int
    dx: float
    dy: float
    response: float
    clean: bool


@dataclass(frozen=True, slots=True)
class ScrollEvent:
    t_start_ms: int
    t_end_ms: int
    axis: ScrollAxis
    direction: ScrollDirection
    percent: float
    confidence: float
    frame_count: int
    payload: dict[str, Any]


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


def _download_derived(context: PipelineContext, blob_path: str, target: Path) -> None:
    container = context.blob_service_client.get_container_client("derived")
    blob = container.get_blob_client(blob_path)
    with target.open("wb") as file:
        blob.download_blob().readinto(file)


def _normalized_video(context: PipelineContext) -> Path:
    local = context.workdir / "normalized.mp4"
    if local.exists():
        return local

    blob_path = _artifact_blob_path(context)
    if blob_path is None:
        raise PipelineError("unknown", "normalized video artifact not found")
    _download_derived(context, blob_path, local)
    return local


def _dominant_motion(
    motion: MotionArtifact,
    frame_index: int,
    params: ScrollParams,
) -> ScrollFrame | None:
    dx_values = motion.strip_dx[:, frame_index]
    dy_values = motion.strip_dy[:, frame_index]
    resp_values = motion.strip_resp[:, frame_index]
    response = float(np.median(resp_values))
    if response < params.strip_response_threshold:
        return None

    median_dx = float(np.median(dx_values))
    median_dy = float(np.median(dy_values))
    if max(abs(median_dx), abs(median_dy)) < params.min_shift_px:
        return None

    axis: ScrollAxis = "vertical" if abs(median_dy) >= abs(median_dx) else "horizontal"
    median = median_dy if axis == "vertical" else median_dx
    sign = 1 if median > 0 else -1
    full_shift = (
        float(motion.dy_full[frame_index])
        if axis == "vertical"
        else float(motion.dx_full[frame_index])
    )
    if (
        (1 if full_shift > 0 else -1) != sign
        or abs(full_shift) < params.min_shift_px * params.full_frame_corroboration_factor
    ):
        return None

    values = dy_values if axis == "vertical" else dx_values
    agreeing = [
        value
        for value in values
        if (1 if float(value) > 0 else -1) == sign
        and abs(float(value) - median) <= params.strip_agree_px
    ]
    if len(agreeing) < 2:
        return None

    return ScrollFrame(
        index=frame_index,
        axis=axis,
        sign=sign,
        dx=median_dx,
        dy=median_dy,
        response=response,
        clean=len(agreeing) == 3,
    )


def _content_trigger(content_vals: np.ndarray, frame_index: int, params: ScrollParams) -> float:
    start = max(0, frame_index - params.scene_cut_window_width)
    trailing = content_vals[start:frame_index]
    mean_trailing = float(np.mean(trailing)) if len(trailing) else 0.0
    return max(
        params.scene_cut_min_content_val,
        params.scene_cut_adaptive_threshold * mean_trailing,
    )


def _scene_cut_frames(motion: MotionArtifact, params: ScrollParams) -> set[int]:
    cuts: set[int] = set()
    last_cut = -math.inf
    min_gap_frames = math.ceil(params.scene_cut_min_gap_seconds * PROXY_FPS)
    for frame_index in range(1, len(motion.frame_ms)):
        if frame_index - last_cut < min_gap_frames:
            continue
        content = float(motion.content_val[frame_index])
        if content < _content_trigger(motion.content_val, frame_index, params):
            continue
        shift_px = math.hypot(
            float(motion.dx_full[frame_index]),
            float(motion.dy_full[frame_index]),
        )
        if float(motion.resp_full[frame_index]) >= 0.25 and shift_px >= 2.5:
            continue
        cuts.add(frame_index)
        last_cut = frame_index
    return cuts


def _direction(axis: ScrollAxis, shift_sum: float) -> ScrollDirection:
    if axis == "vertical":
        return "down" if shift_sum < 0 else "up"
    return "right" if shift_sum < 0 else "left"


def _event_from_frames(
    motion: MotionArtifact,
    frames: list[ScrollFrame],
    *,
    had_bridged_gap: bool,
    params: ScrollParams,
) -> ScrollEvent | None:
    if not frames:
        return None
    sum_dx = sum(frame.dx for frame in frames)
    sum_dy = sum(frame.dy for frame in frames)
    abs_dx = sum(abs(frame.dx) for frame in frames)
    abs_dy = sum(abs(frame.dy) for frame in frames)
    axis: ScrollAxis = "vertical" if abs_dy >= abs_dx else "horizontal"
    primary_abs = abs_dy if axis == "vertical" else abs_dx
    secondary_abs = abs_dx if axis == "vertical" else abs_dy
    if len(frames) == 1 and primary_abs < params.single_frame_flick_px:
        return None

    shift_sum = sum_dy if axis == "vertical" else sum_dx
    percent = round((100.0 * primary_abs) / max(1, motion.height), 1)
    clean_dominance = primary_abs >= 2 * secondary_abs
    confidence = 0.85 if len(frames) > 1 and clean_dominance else 0.7
    if had_bridged_gap or any(not frame.clean for frame in frames):
        confidence -= 0.1
    confidence = round(max(0.0, confidence), 4)
    start_index = frames[0].index
    end_index = frames[-1].index

    return ScrollEvent(
        t_start_ms=int(motion.frame_ms[start_index]),
        t_end_ms=int(motion.frame_ms[end_index]) + round(1000 / PROXY_FPS),
        axis=axis,
        direction=_direction(axis, shift_sum),
        percent=percent,
        confidence=confidence,
        frame_count=len(frames),
        payload={
            "type": axis,
            "percent": percent,
            "direction": _direction(axis, shift_sum),
            "lines": None,
            "proxy_fps": PROXY_FPS,
            "frame_start": start_index,
            "frame_end": end_index,
            "frame_count": len(frames),
            "sum_dx": round(sum_dx, 4),
            "sum_dy": round(sum_dy, 4),
        },
    )


def detect_scrolls(
    video: Path,
    workdir: Path,
    *,
    params: ScrollParams | None = None,
) -> list[ScrollEvent]:
    params = params or ScrollParams()
    motion = ensure_proxy_motion(video, workdir, include_frames=False)
    valid: dict[int, ScrollFrame] = {}
    for frame_index in range(1, len(motion.frame_ms)):
        frame = _dominant_motion(motion, frame_index, params)
        if frame is not None:
            valid[frame_index] = frame

    scene_cuts = _scene_cut_frames(motion, params)
    events: list[ScrollEvent] = []
    current: list[ScrollFrame] = []
    invalid_gap = 0
    reversal_gap = 0
    had_bridged_gap = False
    last_valid: ScrollFrame | None = None

    def flush() -> None:
        nonlocal current, invalid_gap, reversal_gap, had_bridged_gap, last_valid
        event = _event_from_frames(motion, current, had_bridged_gap=had_bridged_gap, params=params)
        if event is not None:
            events.append(event)
        current = []
        invalid_gap = 0
        reversal_gap = 0
        had_bridged_gap = False
        last_valid = None

    for frame_index in range(1, len(motion.frame_ms)):
        if frame_index in scene_cuts:
            flush()
            continue
        frame = valid.get(frame_index)
        if frame is None:
            if current:
                invalid_gap += 1
                if invalid_gap >= params.invalid_gap_split_frames:
                    flush()
                elif invalid_gap == 1:
                    had_bridged_gap = True
            continue

        if (
            last_valid is not None
            and (frame.axis != last_valid.axis or frame.sign != last_valid.sign)
        ):
            reversal_gap += 1
            if reversal_gap >= params.sign_reversal_split_frames:
                flush()
            else:
                had_bridged_gap = True
                continue
        else:
            reversal_gap = 0

        invalid_gap = 0
        current.append(frame)
        last_valid = frame

    flush()
    return sorted(events, key=lambda event: (event.t_start_ms, event.t_end_ms))


class ScrollsProvider:
    def __init__(self, *, params: ScrollParams | None = None) -> None:
        self._params = params or ScrollParams()

    @property
    def id(self) -> str:
        return PROVIDER_ID

    @property
    def version(self) -> str:
        return PROVIDER_VERSION

    @property
    def requires(self) -> list[str]:
        return ["artifact:video_normalized", "artifact:proxy_motion_v1"]

    @property
    def provides(self) -> list[str]:
        return ["measure:scrolls"]

    def run(self, context: PipelineContext) -> list[dict[str, Any]]:
        context.heartbeat(self.id, 10, "Detecting scroll motion")
        source = _normalized_video(context)
        events = detect_scrolls(source, context.workdir, params=self._params)
        context.report_provider_summary(
            self.id,
            {
                "status": "ok",
                "measure_count": len(events),
                "total_percent_viewport": round(sum(event.percent for event in events), 1),
            },
        )
        context.heartbeat(self.id, 95, f"Detected {len(events)} scroll events")
        return [
            {
                "kind": "scrolls",
                "category": "physical",
                "t_start_ms": event.t_start_ms,
                "t_end_ms": event.t_end_ms,
                "value_num": event.percent,
                "value_text": None,
                "unit": "percent_viewport",
                "confidence": event.confidence,
                "source": "video_analysis",
                "payload": event.payload,
            }
            for event in events
        ]
