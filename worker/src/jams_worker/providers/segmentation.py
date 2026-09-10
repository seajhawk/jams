"""Rule-based task segmentation provider."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import Any, Literal

from jams_worker.errors import StaleLeaseError
from jams_worker.media import get_authoritative_duration_ms
from jams_worker.pipeline import PipelineContext

PROVIDER_ID = "segmentation"
PROVIDER_VERSION = "1.0.0"
MIN_SEGMENT_MS = 10_000
SNAP_WINDOW_MS = 3_000

SegmentSource = Literal["audio_cue", "scene_boundary", "llm", "manual"]

DEFAULT_CUES = {
    "start": (
        "let's get started",
        "lets get started",
        "get started",
        "to start",
        "first",
        "starting",
    ),
    "next": (
        "okay next",
        "next",
        "moving on",
        "now",
        "then",
        "after that",
    ),
    "done": (
        "done",
        "finished",
        "complete",
        "that's it",
        "that is it",
        "finally",
    ),
}


@dataclass(frozen=True, slots=True)
class UtteranceCue:
    t0_ms: int
    t1_ms: int
    text: str


@dataclass(frozen=True, slots=True)
class Boundary:
    t_ms: int
    source: SegmentSource
    label: str | None
    origin: str


@dataclass(frozen=True, slots=True)
class Segment:
    id: str
    name: str
    t0_ms: int
    t1_ms: int
    source: SegmentSource
    origin: str


def _video_duration_ms(context: PipelineContext) -> int:
    return get_authoritative_duration_ms(context)


def _read_inputs(context: PipelineContext) -> tuple[list[UtteranceCue], list[int]]:
    rows = context.db_conn.execute(
        """
        select kind, t_start_ms, t_end_ms, value_text, payload
        from measures
        where run_id = %s and kind in ('utterance', 'context_switch')
        order by t_start_ms, kind
        """,
        (context.run_id,),
    ).fetchall()
    utterances: list[UtteranceCue] = []
    switches: list[int] = []
    for row in rows:
        kind = str(row[0])
        if kind == "context_switch":
            switches.append(int(row[1]))
            continue
        payload = row[4] if isinstance(row[4], dict) else {}
        text = row[3] if isinstance(row[3], str) else payload.get("text")
        if isinstance(text, str) and row[2] is not None:
            utterances.append(UtteranceCue(int(row[1]), int(row[2]), text.strip()))
    return utterances, sorted(set(switches))


def _cue_lists(config: dict[str, Any] | None) -> dict[str, tuple[str, ...]]:
    cues = {key: tuple(values) for key, values in DEFAULT_CUES.items()}
    segmentation_config = config.get("segmentation") if isinstance(config, dict) else None
    raw_cues = segmentation_config.get("cues") if isinstance(segmentation_config, dict) else None
    if isinstance(raw_cues, dict):
        for key in ("start", "next", "done"):
            value = raw_cues.get(key)
            if isinstance(value, list) and all(isinstance(item, str) for item in value):
                cues[key] = tuple(item.strip() for item in value if item.strip())

    extra_cues = (
        segmentation_config.get("extra_cues") if isinstance(segmentation_config, dict) else None
    )
    if isinstance(extra_cues, list) and all(isinstance(item, str) for item in extra_cues):
        extras = tuple(item.strip() for item in extra_cues if item.strip())
        cues["next"] = tuple(dict.fromkeys(cues["next"] + extras))
    return cues


def _matches_cue(text: str, phrases: tuple[str, ...]) -> str | None:
    normalized = re.sub(r"\s+", " ", text.lower()).strip()
    for phrase in phrases:
        pattern = r"(?:^|\b)" + re.escape(phrase.lower()) + r"(?:\b|$)"
        if re.search(pattern, normalized):
            return phrase
    return None


def cue_boundaries(
    utterances: list[UtteranceCue],
    *,
    cues: dict[str, tuple[str, ...]] | None = None,
) -> list[Boundary]:
    cues = cues or DEFAULT_CUES
    boundaries: list[Boundary] = []
    for utterance in utterances:
        for cue_kind in ("start", "next"):
            phrase = _matches_cue(utterance.text, cues[cue_kind])
            if phrase is not None:
                boundaries.append(
                    Boundary(
                        t_ms=utterance.t0_ms,
                        source="audio_cue",
                        label=_segment_name_from_cue(utterance.text),
                        origin=f"{cue_kind}:{phrase}",
                    )
                )
                break
        done_phrase = _matches_cue(utterance.text, cues["done"])
        if done_phrase is not None:
            boundaries.append(
                Boundary(
                    t_ms=utterance.t1_ms,
                    source="audio_cue",
                    label=_segment_name_from_cue(utterance.text),
                    origin=f"done:{done_phrase}",
                )
            )
    return boundaries


def snap_audio_cues(boundaries: list[Boundary], switches: list[int]) -> list[Boundary]:
    if not switches:
        return boundaries
    snapped: list[Boundary] = []
    for boundary in boundaries:
        if boundary.source != "audio_cue":
            snapped.append(boundary)
            continue
        nearest = min(switches, key=lambda item: abs(item - boundary.t_ms))
        if abs(nearest - boundary.t_ms) <= SNAP_WINDOW_MS:
            snapped.append(
                Boundary(
                    t_ms=nearest,
                    source=boundary.source,
                    label=boundary.label,
                    origin=f"{boundary.origin}:snapped_from:{boundary.t_ms}",
                )
            )
        else:
            snapped.append(boundary)
    return snapped


def _dedupe_boundaries(boundaries: list[Boundary], duration_ms: int) -> list[Boundary]:
    by_time: dict[int, Boundary] = {}
    priority = {"audio_cue": 0, "scene_boundary": 1, "manual": 2, "llm": 3}
    for boundary in boundaries:
        t_ms = max(0, min(duration_ms, boundary.t_ms))
        if t_ms in (0, duration_ms):
            continue
        candidate = Boundary(t_ms, boundary.source, boundary.label, boundary.origin)
        current = by_time.get(t_ms)
        if current is None or priority[candidate.source] < priority[current.source]:
            by_time[t_ms] = candidate
    return [by_time[key] for key in sorted(by_time)]


def _merge_short_boundaries(boundaries: list[Boundary], duration_ms: int) -> list[Boundary]:
    if duration_ms <= 0:
        return []

    merged: list[Boundary] = [Boundary(0, "manual", None, "video_start")]
    for boundary in boundaries:
        if boundary.t_ms - merged[-1].t_ms < MIN_SEGMENT_MS:
            continue
        merged.append(boundary)

    if duration_ms - merged[-1].t_ms < MIN_SEGMENT_MS and len(merged) > 1:
        merged.pop()
    merged.append(Boundary(duration_ms, "manual", None, "video_end"))
    return merged


def _segment_name_from_cue(text: str) -> str:
    trimmed = re.sub(r"\s+", " ", text).strip(" .,:;!?")
    if len(trimmed) <= 48:
        return trimmed
    return trimmed[:45].rstrip() + "..."


def _segment_id(run_id: str, index: int, t0_ms: int, t1_ms: int) -> str:
    return str(uuid.uuid5(uuid.UUID(run_id), f"segment:{index}:{t0_ms}:{t1_ms}"))


def build_segments(
    *,
    run_id: str,
    duration_ms: int,
    utterances: list[UtteranceCue],
    switches: list[int],
    cues: dict[str, tuple[str, ...]] | None = None,
) -> list[Segment]:
    cue_candidates = snap_audio_cues(cue_boundaries(utterances, cues=cues), switches)
    switch_candidates = [
        Boundary(t_ms=switch, source="scene_boundary", label=None, origin="context_switch")
        for switch in switches
    ]
    candidates = _dedupe_boundaries(cue_candidates + switch_candidates, duration_ms)
    boundaries = _merge_short_boundaries(candidates, duration_ms)
    segments: list[Segment] = []
    pairs = zip(boundaries[:-1], boundaries[1:], strict=True)
    for index, (start, end) in enumerate(pairs, start=1):
        if end.t_ms <= start.t_ms:
            continue
        name = start.label or f"Segment {index}"
        source = start.source if start.origin != "video_start" else end.source
        if source == "manual" and (utterances or switches):
            source = "audio_cue" if utterances else "scene_boundary"
        segments.append(
            Segment(
                id=_segment_id(run_id, index, start.t_ms, end.t_ms),
                name=name,
                t0_ms=start.t_ms,
                t1_ms=end.t_ms,
                source=source,
                origin=start.origin,
            )
        )
    return segments


def write_segments(context: PipelineContext, segments: list[Segment]) -> None:
    with context.db_conn.transaction():
        if context.owner_id is not None and context.lease_token is not None:
            cur = context.db_conn.execute(
                """
                select 1 from analysis_runs
                where id = %s
                  and owner_id = %s
                  and lease_token = %s
                  and lease_expires_at > now()
                for update
                """,
                (context.run_id, context.owner_id, context.lease_token),
            )
            if hasattr(cur, "fetchone") and cur.fetchone() is None:
                raise StaleLeaseError(
                    f"Write rejected: worker {context.owner_id} lost lease for run {context.run_id}"
                )

        context.db_conn.execute("delete from segments where run_id = %s", (context.run_id,))
        for segment in segments:
            context.db_conn.execute(
                """
                insert into segments (
                    id, org_id, run_id, parent_segment_id, name,
                    t_start_ms, t_end_ms, source, thumbnail
                )
                values (%s, %s, %s, null, %s, %s, %s, %s, null)
                """,
                (
                    segment.id,
                    context.org_id,
                    context.run_id,
                    segment.name,
                    segment.t0_ms,
                    segment.t1_ms,
                    segment.source,
                ),
            )


def time_segment_measures(segments: list[Segment]) -> list[dict[str, Any]]:
    return [
        {
            "kind": "time_segment",
            "category": "time",
            "t_start_ms": segment.t0_ms,
            "t_end_ms": segment.t1_ms,
            "value_num": segment.t1_ms - segment.t0_ms,
            "value_text": None,
            "unit": "ms",
            "confidence": 0.99 if segment.source == "audio_cue" else 0.85,
            "source": "video_analysis",
            "payload": {
                "segment_id": segment.id,
                "segment_name": segment.name,
                "segment_source": segment.source,
                "origin": segment.origin,
                "min_segment_ms": MIN_SEGMENT_MS,
                "snap_window_ms": SNAP_WINDOW_MS,
            },
        }
        for segment in segments
    ]


class SegmentationProvider:
    @property
    def id(self) -> str:
        return PROVIDER_ID

    @property
    def version(self) -> str:
        return PROVIDER_VERSION

    @property
    def requires(self) -> list[str]:
        return ["measure:utterance", "measure:context_switch"]

    @property
    def provides(self) -> list[str]:
        return ["segment", "measure:time_segment"]

    def run(self, context: PipelineContext) -> list[dict[str, Any]]:
        context.heartbeat(self.id, 10, "Reading segmentation inputs")
        duration_ms = _video_duration_ms(context)
        utterances, switches = _read_inputs(context)
        cues = _cue_lists(context.run.get("config"))
        segments = build_segments(
            run_id=context.run_id,
            duration_ms=duration_ms,
            utterances=utterances,
            switches=switches,
            cues=cues,
        )
        write_segments(context, segments)
        measures = time_segment_measures(segments)
        context.report_provider_summary(
            self.id,
            {
                "status": "ok",
                "segment_count": len(segments),
                "audio_cue_count": sum(1 for item in segments if item.source == "audio_cue"),
                "scene_boundary_count": sum(
                    1 for item in segments if item.source == "scene_boundary"
                ),
            },
        )
        context.heartbeat(self.id, 95, f"Built {len(segments)} segments")
        return measures
