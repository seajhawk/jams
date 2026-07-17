"""Tests for optional LLM segment naming."""

from __future__ import annotations

from typing import Any

import pytest

from jams_worker.pipeline import PipelineContext
from jams_worker.providers.segment_labeling import (
    ExistingSegment,
    LabelingResult,
    SegmentLabelingProvider,
    apply_labeling,
    validate_labeling_response,
)

RUN_ID = "11111111-1111-4111-8111-111111111111"


class _Rows:
    def __init__(self, rows: list[tuple[Any, ...]]) -> None:
        self._rows = rows

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self._rows


class _Tx:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *_args: object) -> None:
        return None


class _Conn:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []
        self.segments = [
            ("seg-1", "Segment 1", 0, 10_000, "scene_boundary"),
            ("seg-2", "Segment 2", 10_000, 20_000, "scene_boundary"),
            ("seg-3", "Segment 3", 20_000, 30_000, "scene_boundary"),
        ]
        self.utterances = [
            (1_000, 3_000, None, {"text": "Open the dashboard and review settings."}),
            (12_000, 14_000, None, {"text": "Now configure notifications."}),
        ]

    def transaction(self) -> _Tx:
        return _Tx()

    def execute(self, sql: str, params: object = None) -> _Rows:
        normalized = " ".join(sql.split())
        self.calls.append((normalized, params))
        if normalized.startswith("select id::text, name"):
            return _Rows(self.segments)
        if normalized.startswith("select t_start_ms, t_end_ms"):
            return _Rows(self.utterances)
        return _Rows([])


def _context(conn: _Conn, config: dict[str, Any] | None = None) -> PipelineContext:
    return PipelineContext(
        run={"id": RUN_ID, "video_id": "video-1", "config": config or {}},
        org_id="org-1",
        blob_service_client=object(),  # type: ignore[arg-type]
        db_conn=conn,  # type: ignore[arg-type]
        workdir=object(),  # type: ignore[arg-type]
        register_artifact=lambda _kind, _path: "artifact-1",
        heartbeat=lambda _stage, _pct, _detail: None,
    )


def _segments() -> list[ExistingSegment]:
    return [
        ExistingSegment("seg-1", "Segment 1", 0, 10_000, "scene_boundary"),
        ExistingSegment("seg-2", "Segment 2", 10_000, 20_000, "scene_boundary"),
        ExistingSegment("seg-3", "Segment 3", 20_000, 30_000, "scene_boundary"),
    ]


def test_happy_rename_marks_segment_source_llm() -> None:
    instructions = validate_labeling_response(
        [{"segment_index": 1, "name": "Configure Alerts"}],
        segment_count=3,
    )
    labeled, merged = apply_labeling(run_id=RUN_ID, segments=_segments(), instructions=instructions)

    assert merged == []
    assert [(segment.name, segment.source) for segment in labeled] == [
        ("Segment 1", "scene_boundary"),
        ("Configure Alerts", "llm"),
        ("Segment 3", "scene_boundary"),
    ]
    assert labeled[1].t0_ms == 10_000
    assert labeled[1].t1_ms == 20_000


def test_merge_application_keeps_outer_boundaries() -> None:
    instructions = validate_labeling_response(
        [{"segment_index": 0, "name": "Dashboard Setup", "merge_with_next": True}],
        segment_count=3,
    )
    labeled, merged = apply_labeling(run_id=RUN_ID, segments=_segments(), instructions=instructions)

    assert len(merged) == 1
    spans = [(segment.name, segment.t0_ms, segment.t1_ms, segment.source) for segment in labeled]
    assert spans == [
        ("Dashboard Setup", 0, 20_000, "llm"),
        ("Segment 3", 20_000, 30_000, "scene_boundary"),
    ]


@pytest.mark.parametrize(
    ("response", "reason"),
    [
        ({}, "response_not_list"),
        ([None], "item_not_object"),
        ([{"segment_index": 0, "name": "Valid Name", "t_start_ms": 10}], "boundary_change"),
        ([{"segment_index": 0, "name": "Valid Name", "confidence": 0.8}], "unexpected_field"),
        ([{"segment_index": "0", "name": "Valid Name"}], "segment_index_not_int"),
        ([{"segment_index": 3, "name": "Valid Name"}], "segment_index_out_of_range"),
        (
            [
                {"segment_index": 0, "name": "Valid Name"},
                {"segment_index": 0, "name": "Other Name"},
            ],
            "duplicate_segment_index",
        ),
        ([{"segment_index": 0, "name": 42}], "name_not_string"),
        ([{"segment_index": 0, "name": "Bad\nName"}], "name_newline"),
        ([{"segment_index": 0, "name": "No"}], "name_length"),
        ([{"segment_index": 0, "name": "Valid Name", "merge_with_next": "yes"}], "merge_not_bool"),
        (
            [{"segment_index": 2, "name": "Valid Name", "merge_with_next": True}],
            "merge_without_next",
        ),
        (
            [
                {"segment_index": 0, "name": "First Merge", "merge_with_next": True},
                {"segment_index": 1, "name": "Second Merge", "merge_with_next": True},
            ],
            "merge_overlap",
        ),
        (
            [
                {"segment_index": 0, "name": "First Merge", "merge_with_next": True},
                {"segment_index": 2, "name": "Second Merge", "merge_with_next": True},
                {"segment_index": 4, "name": "Third Merge", "merge_with_next": True},
            ],
            "too_many_merges",
        ),
    ],
)
def test_rejection_reasons(response: object, reason: str) -> None:
    segment_count = 6 if reason == "too_many_merges" else 3
    with pytest.raises(ValueError, match=reason):
        validate_labeling_response(response, segment_count=segment_count)


def test_provider_skips_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "key")
    monkeypatch.setenv("JAMS_LABELING_MODEL", "cheap/model")
    context = _context(_Conn(), config={})

    measures = SegmentLabelingProvider().run(context)

    assert measures == []
    assert context.provider_summaries["segment_labeling"]["skipped_reason"] == "disabled"


def test_provider_skips_when_key_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setenv("JAMS_LABELING_MODEL", "cheap/model")
    context = _context(_Conn(), config={"llm_labeling": {"enabled": True}})

    measures = SegmentLabelingProvider().run(context)

    assert measures == []
    assert context.provider_summaries["segment_labeling"]["skipped_reason"] == "missing_key"


def test_provider_skips_in_ci_after_key_check(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "key")
    monkeypatch.setenv("JAMS_LABELING_MODEL", "cheap/model")
    monkeypatch.setenv("CI", "true")
    context = _context(_Conn(), config={"llm_labeling": {"enabled": True}})

    measures = SegmentLabelingProvider().run(context)

    assert measures == []
    assert context.provider_summaries["segment_labeling"]["skipped_reason"] == "ci"


def test_provider_uses_mocked_http_client_for_merge(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "key")
    monkeypatch.setenv("JAMS_LABELING_MODEL", "cheap/model")
    monkeypatch.delenv("CI", raising=False)
    conn = _Conn()
    context = _context(conn, config={"llm_labeling": {"enabled": True}})

    def client(**_kwargs: object) -> LabelingResult:
        raw = [{"segment_index": 0, "name": "Dashboard Setup", "merge_with_next": True}]
        return LabelingResult(
            instructions=validate_labeling_response(raw, segment_count=3),
            raw_response=raw,
            usage={"total_tokens": 19, "total_cost": 0.0001},
        )

    measures = SegmentLabelingProvider(client=client).run(context)

    assert len(measures) == 1
    assert measures[0]["t_start_ms"] == 0
    assert measures[0]["t_end_ms"] == 20_000
    assert measures[0]["payload"]["llm_labeling"] == "accepted"
    assert context.provider_summaries["segment_labeling"]["llm_labeling"] == "accepted"
    assert context.provider_summaries["segment_labeling"]["usage"]["total_tokens"] == 19
    assert any(
        call[0].startswith("delete from measures")
        and call[1] == (RUN_ID, 0, 10_000, 10_000, 20_000)
        for call in conn.calls
    )


def test_provider_rejects_invalid_mocked_response(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "key")
    monkeypatch.setenv("JAMS_LABELING_MODEL", "cheap/model")
    monkeypatch.delenv("CI", raising=False)
    context = _context(_Conn(), config={"llm_labeling": {"enabled": True}})

    def client(**_kwargs: object) -> LabelingResult:
        return LabelingResult(
            instructions=[],
            raw_response=[{"segment_index": 0, "name": "Bad\nName"}],
            usage={},
        )

    measures = SegmentLabelingProvider(client=client).run(context)

    assert measures == []
    assert context.provider_summaries["segment_labeling"]["llm_labeling"] == "rejected:name_newline"
