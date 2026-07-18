"""Optional LLM segment naming provider using OpenRouter."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Protocol

from psycopg.types.json import Jsonb

from jams_worker.pipeline import PipelineContext

PROVIDER_ID = "segment_labeling"
PROVIDER_VERSION = "1.0.1"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
TIMEOUT_SECONDS = 15
MAX_MERGES = 2


@dataclass(frozen=True, slots=True)
class ExistingSegment:
    id: str
    name: str
    t0_ms: int
    t1_ms: int
    source: str


@dataclass(frozen=True, slots=True)
class Utterance:
    t0_ms: int
    t1_ms: int
    text: str


@dataclass(frozen=True, slots=True)
class LabelInstruction:
    segment_index: int
    name: str
    merge_with_next: bool = False


@dataclass(frozen=True, slots=True)
class LabeledSegment:
    id: str
    name: str
    t0_ms: int
    t1_ms: int
    source: str
    original_segment_ids: tuple[str, ...]
    llm_name_applied: bool


@dataclass(frozen=True, slots=True)
class LabelingResult:
    instructions: list[LabelInstruction]
    raw_response: Any
    usage: dict[str, Any]


class LabelingClient(Protocol):
    def __call__(
        self,
        *,
        api_key: str,
        model: str,
        segments: list[ExistingSegment],
        utterances: list[Utterance],
    ) -> LabelingResult:
        ...


def _config_enabled(config: Any) -> bool:
    if not isinstance(config, dict):
        return False
    llm_config = config.get("llm_labeling")
    if not isinstance(llm_config, dict):
        return False
    return llm_config.get("enabled") is True


def _segment_id(run_id: str, segment_ids: tuple[str, ...], t0_ms: int, t1_ms: int) -> str:
    joined_ids = "+".join(segment_ids)
    return str(uuid.uuid5(uuid.UUID(run_id), f"segment_labeling:{joined_ids}:{t0_ms}:{t1_ms}"))


def _read_segments(context: PipelineContext) -> list[ExistingSegment]:
    rows = context.db_conn.execute(
        """
        select id::text, name, t_start_ms, t_end_ms, source
        from segments
        where run_id = %s
        order by t_start_ms, t_end_ms, id
        """,
        (context.run_id,),
    ).fetchall()
    return [
        ExistingSegment(
            id=str(row[0]),
            name=str(row[1]),
            t0_ms=int(row[2]),
            t1_ms=int(row[3]),
            source=str(row[4]),
        )
        for row in rows
    ]


def _read_utterances(context: PipelineContext) -> list[Utterance]:
    rows = context.db_conn.execute(
        """
        select t_start_ms, t_end_ms, value_text, payload
        from measures
        where run_id = %s and kind = 'utterance'
        order by t_start_ms, t_end_ms
        """,
        (context.run_id,),
    ).fetchall()
    utterances: list[Utterance] = []
    for row in rows:
        payload = row[3] if isinstance(row[3], dict) else {}
        text = row[2] if isinstance(row[2], str) else payload.get("text")
        if isinstance(text, str) and row[1] is not None:
            utterances.append(Utterance(int(row[0]), int(row[1]), text.strip()))
    return utterances


def validate_labeling_response(
    response: Any,
    *,
    segment_count: int,
) -> list[LabelInstruction]:
    if not isinstance(response, list):
        raise ValueError("response_not_list")

    instructions: list[LabelInstruction] = []
    seen_indices: set[int] = set()
    merge_starts: list[int] = []
    allowed_keys = {"segment_index", "name", "merge_with_next"}
    boundary_keys = {"t_start_ms", "t_end_ms", "t_start", "t_end", "start", "end", "boundary"}

    for item in response:
        if not isinstance(item, dict):
            raise ValueError("item_not_object")
        if boundary_keys.intersection(item):
            raise ValueError("boundary_change")
        if set(item) - allowed_keys:
            raise ValueError("unexpected_field")

        index = item.get("segment_index")
        if not isinstance(index, int) or isinstance(index, bool):
            raise ValueError("segment_index_not_int")
        if index < 0 or index >= segment_count:
            raise ValueError("segment_index_out_of_range")
        if index in seen_indices:
            raise ValueError("duplicate_segment_index")
        seen_indices.add(index)

        name = item.get("name")
        if not isinstance(name, str):
            raise ValueError("name_not_string")
        if "\n" in name or "\r" in name:
            raise ValueError("name_newline")
        normalized_name = name.strip()
        if len(normalized_name) < 3 or len(normalized_name) > 60:
            raise ValueError("name_length")

        merge = item.get("merge_with_next", False)
        if not isinstance(merge, bool):
            raise ValueError("merge_not_bool")
        if merge:
            if index + 1 >= segment_count:
                raise ValueError("merge_without_next")
            merge_starts.append(index)
        instructions.append(
            LabelInstruction(
                segment_index=index,
                name=normalized_name,
                merge_with_next=merge,
            )
        )

    if len(merge_starts) > MAX_MERGES:
        raise ValueError("too_many_merges")
    for left, right in zip(merge_starts, merge_starts[1:], strict=False):
        if right <= left + 1:
            raise ValueError("merge_overlap")

    return instructions


def _label_array_from_response(response: Any) -> Any:
    if isinstance(response, dict) and set(response) == {"labels"}:
        return response["labels"]
    return response


def apply_labeling(
    *,
    run_id: str,
    segments: list[ExistingSegment],
    instructions: list[LabelInstruction],
) -> tuple[list[LabeledSegment], list[tuple[ExistingSegment, ExistingSegment]]]:
    by_index = {instruction.segment_index: instruction for instruction in instructions}
    merge_starts = {
        instruction.segment_index for instruction in instructions if instruction.merge_with_next
    }
    labeled: list[LabeledSegment] = []
    merged_pairs: list[tuple[ExistingSegment, ExistingSegment]] = []

    index = 0
    while index < len(segments):
        segment = segments[index]
        instruction = by_index.get(index)
        name = instruction.name if instruction is not None else segment.name
        llm_name_applied = instruction is not None and instruction.name != segment.name

        if index in merge_starts:
            next_segment = segments[index + 1]
            original_ids = (segment.id, next_segment.id)
            labeled.append(
                LabeledSegment(
                    id=_segment_id(run_id, original_ids, segment.t0_ms, next_segment.t1_ms),
                    name=name,
                    t0_ms=segment.t0_ms,
                    t1_ms=next_segment.t1_ms,
                    source="llm",
                    original_segment_ids=original_ids,
                    llm_name_applied=True,
                )
            )
            merged_pairs.append((segment, next_segment))
            index += 2
            continue

        source = "llm" if llm_name_applied else segment.source
        labeled.append(
            LabeledSegment(
                id=segment.id,
                name=name,
                t0_ms=segment.t0_ms,
                t1_ms=segment.t1_ms,
                source=source,
                original_segment_ids=(segment.id,),
                llm_name_applied=llm_name_applied,
            )
        )
        index += 1

    return labeled, merged_pairs


def _time_segment_measures(
    segments: list[LabeledSegment],
    merged_pairs: list[tuple[ExistingSegment, ExistingSegment]],
) -> list[dict[str, Any]]:
    merged_ids = {first.id for first, _second in merged_pairs}
    return [
        {
            "kind": "time_segment",
            "category": "time",
            "t_start_ms": segment.t0_ms,
            "t_end_ms": segment.t1_ms,
            "value_num": segment.t1_ms - segment.t0_ms,
            "value_text": None,
            "unit": "ms",
            "confidence": 0.9,
            "source": "video_analysis",
            "payload": {
                "segment_id": segment.id,
                "segment_name": segment.name,
                "segment_source": segment.source,
                "llm_labeling": "accepted",
                "merged_original_segment_ids": list(segment.original_segment_ids),
            },
        }
        for segment in segments
        if segment.original_segment_ids[0] in merged_ids
    ]


def _write_segments_and_delete_merged_measures(
    context: PipelineContext,
    segments: list[LabeledSegment],
    merged_pairs: list[tuple[ExistingSegment, ExistingSegment]],
) -> None:
    with context.db_conn.transaction():
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
            if len(segment.original_segment_ids) == 1 and segment.llm_name_applied:
                context.db_conn.execute(
                    """
                    update measures
                    set payload = payload || %s
                    where run_id = %s
                      and kind = 'time_segment'
                      and provider_id = 'segmentation'
                      and t_start_ms = %s
                      and t_end_ms = %s
                    """,
                    (
                        Jsonb(
                            {
                                "segment_name": segment.name,
                                "segment_source": segment.source,
                                "llm_labeling": "accepted",
                            }
                        ),
                        context.run_id,
                        segment.t0_ms,
                        segment.t1_ms,
                    ),
                )
        for first, second in merged_pairs:
            context.db_conn.execute(
                """
                delete from measures
                where run_id = %s
                  and kind = 'time_segment'
                  and provider_id = 'segmentation'
                  and (
                    (t_start_ms = %s and t_end_ms = %s)
                    or (t_start_ms = %s and t_end_ms = %s)
                  )
                """,
                (context.run_id, first.t0_ms, first.t1_ms, second.t0_ms, second.t1_ms),
            )


def _request_openrouter_labels(
    *,
    api_key: str,
    model: str,
    segments: list[ExistingSegment],
    utterances: list[Utterance],
) -> LabelingResult:
    payload = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Name task segments from deterministic candidates. "
                    "Do not change boundaries. Replace generic/provisional names with "
                    "short concrete task labels from the narration. Return only JSON "
                    "matching the requested schema."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "segment_index_base": 0,
                        "segments": [
                            {
                                "segment_index": index,
                                "name": segment.name,
                                "t_start_ms": segment.t0_ms,
                                "t_end_ms": segment.t1_ms,
                            }
                            for index, segment in enumerate(segments)
                        ],
                        "utterances": [
                            {
                                "t_start_ms": utterance.t0_ms,
                                "t_end_ms": utterance.t1_ms,
                                "text": utterance.text,
                            }
                            for utterance in utterances
                        ],
                        "contract": (
                            "Return an object with a labels array. Each array item is "
                            "{segment_index, name, merge_with_next}. "
                            "Return exactly one item for every segment_index. "
                            "Do not reuse names that look like 'Segment 1' or long "
                            "raw utterance snippets; produce concise verb-noun labels. "
                            "Names must be 3-60 characters. "
                            "merge_with_next may merge only with the immediately next segment."
                        ),
                    },
                    separators=(",", ":"),
                ),
            },
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "segment_labels",
                "strict": True,
                "schema": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["labels"],
                    "properties": {
                        "labels": {
                            "type": "array",
                            "minItems": len(segments),
                            "maxItems": len(segments),
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "required": ["segment_index", "name", "merge_with_next"],
                                "properties": {
                                    "segment_index": {"type": "integer"},
                                    "name": {
                                        "type": "string",
                                        "minLength": 3,
                                        "maxLength": 60,
                                    },
                                    "merge_with_next": {"type": "boolean"},
                                },
                            },
                        },
                    },
                },
            },
        },
    }
    request = urllib.request.Request(
        OPENROUTER_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        body = json.loads(response.read().decode("utf-8"))

    content = body["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    labels = _label_array_from_response(parsed)
    return LabelingResult(
        instructions=validate_labeling_response(labels, segment_count=len(segments)),
        raw_response=labels,
        usage=dict(body.get("usage", {})),
    )


class SegmentLabelingProvider:
    def __init__(self, client: LabelingClient | None = None) -> None:
        self._client = client or _request_openrouter_labels

    @property
    def id(self) -> str:
        return PROVIDER_ID

    @property
    def version(self) -> str:
        return PROVIDER_VERSION

    @property
    def requires(self) -> list[str]:
        return ["segment", "measure:utterance"]

    @property
    def provides(self) -> list[str]:
        return ["segment", "measure:time_segment"]

    def _skip(self, context: PipelineContext, reason: str) -> list[dict[str, Any]]:
        context.report_provider_summary(
            self.id,
            {"status": "skipped", "reason": reason, "skipped_reason": reason},
        )
        return []

    def run(self, context: PipelineContext) -> list[dict[str, Any]]:
        if not _config_enabled(context.run.get("config")):
            return self._skip(context, "disabled")

        api_key = os.environ.get("OPENROUTER_API_KEY")
        if not api_key:
            return self._skip(context, "missing_key")
        if os.environ.get("CI"):
            return self._skip(context, "ci")

        model = os.environ.get("JAMS_LABELING_MODEL")
        if not model:
            return self._skip(context, "missing_model")

        try:
            context.heartbeat(self.id, 15, "Reading segment candidates")
            segments = _read_segments(context)
            if not segments:
                return self._skip(context, "no_segments")
            utterances = _read_utterances(context)

            context.heartbeat(self.id, 35, "Requesting segment labels")
            result = self._client(
                api_key=api_key,
                model=model,
                segments=segments,
                utterances=utterances,
            )
            instructions = validate_labeling_response(
                result.raw_response,
                segment_count=len(segments),
            )
            labeled_segments, merged_pairs = apply_labeling(
                run_id=context.run_id,
                segments=segments,
                instructions=instructions,
            )
            measures = _time_segment_measures(labeled_segments, merged_pairs)
            _write_segments_and_delete_merged_measures(context, labeled_segments, merged_pairs)
        except urllib.error.HTTPError as exc:
            context.report_provider_summary(
                self.id,
                {"status": "error", "reason": f"http_{exc.code}", "llm_labeling": "error"},
            )
            return []
        except (TimeoutError, urllib.error.URLError) as exc:
            context.report_provider_summary(
                self.id,
                {
                    "status": "error",
                    "reason": type(exc).__name__,
                    "llm_labeling": "error",
                },
            )
            return []
        except (KeyError, IndexError, json.JSONDecodeError) as exc:
            context.report_provider_summary(
                self.id,
                {
                    "status": "error",
                    "reason": f"response_shape:{type(exc).__name__}",
                    "llm_labeling": "error",
                },
            )
            return []
        except ValueError as exc:
            reason = str(exc) or "invalid_response"
            context.report_provider_summary(
                self.id,
                {"status": "rejected", "reason": reason, "llm_labeling": f"rejected:{reason}"},
            )
            return []
        except Exception as exc:  # pragma: no cover - provider must never fail a run
            context.report_provider_summary(
                self.id,
                {
                    "status": "error",
                    "reason": type(exc).__name__,
                    "llm_labeling": "error",
                },
            )
            return []

        context.report_provider_summary(
            self.id,
            {
                "status": "ok",
                "llm_labeling": "accepted",
                "renamed_count": sum(1 for segment in labeled_segments if segment.llm_name_applied),
                "merge_count": len(merged_pairs),
                "usage": result.usage,
            },
        )
        context.heartbeat(self.id, 95, "Segment labels accepted")
        return measures
