"""Tests for pipeline contracts and idempotent measure writes."""

from __future__ import annotations

import json
from typing import Any

import pytest

from jams_worker.pipeline import (
    MeasureProvider,
    PipelineContext,
    run_pipeline,
    write_provider_measures,
)


class _FakeProvider:
    @property
    def id(self) -> str:
        return "fake"

    @property
    def version(self) -> str:
        return "1.0.0"

    @property
    def requires(self) -> list[str]:
        return []

    @property
    def provides(self) -> list[str]:
        return ["context_switch"]

    def run(self, context: PipelineContext) -> list[dict[str, Any]]:
        return []


class _Tx:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *_args: object) -> None:
        return None


class _Conn:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    def transaction(self) -> _Tx:
        return _Tx()

    def execute(self, sql: str, params: object = None) -> None:
        self.calls.append((" ".join(sql.split()), params))


class _SummaryProvider(_FakeProvider):
    def run(self, context: PipelineContext) -> list[dict[str, Any]]:
        context.report_provider_summary("fake", {"status": "partial", "reason": "no_speech"})
        return []


class _NoAudioProvider(_FakeProvider):
    def run(self, context: PipelineContext) -> list[dict[str, Any]]:
        context.report_provider_summary(
            "fake", {"status": "skipped_no_audio", "reason": "audio artifact absent"}
        )
        return []


def test_measure_provider_protocol() -> None:
    provider = _FakeProvider()
    assert isinstance(provider, MeasureProvider)
    assert provider.id == "fake"
    assert provider.version == "1.0.0"
    assert provider.requires == []
    assert provider.provides == ["context_switch"]


def test_write_provider_measures_deletes_then_inserts() -> None:
    conn = _Conn()

    write_provider_measures(
        conn,  # type: ignore[arg-type]
        run_id="run_1",
        org_id="org_1",
        provider_id="probe",
        provider_version="1.0.0",
        measures=[
            {
                "kind": "context_switch",
                "category": "cognitive",
                "t_start_ms": 250,
                "source": "video_analysis",
                "payload": {"cut": True},
            }
        ],
    )

    assert conn.calls[0][0].startswith("delete from measures")
    assert conn.calls[0][1] == ("run_1", "probe")
    assert conn.calls[1][0].startswith("insert into measures")
    params = conn.calls[1][1]
    assert isinstance(params, dict)
    assert params == {
        "run_id": "run_1",
        "org_id": "org_1",
        "provider_id": "probe",
        "provider_version": "1.0.0",
        "kind": "context_switch",
        "category": "cognitive",
        "t_start_ms": 250,
        "t_end_ms": None,
        "value_num": None,
        "value_text": None,
        "unit": None,
        "confidence": None,
        "source": "video_analysis",
        "payload": params["payload"],
    }
    assert params["payload"].obj == {"cut": True}


def test_run_pipeline_marks_partial_from_provider_summary(tmp_path, capsys) -> None:
    conn = _Conn()
    context = PipelineContext(
        run={"id": "run_1", "video_id": "video_1"},
        org_id="org_1",
        blob_service_client=object(),  # type: ignore[arg-type]
        db_conn=conn,  # type: ignore[arg-type]
        workdir=tmp_path,
        register_artifact=lambda _kind, _path: "artifact_1",
        heartbeat=lambda _stage, _pct, _detail: None,
    )

    result = run_pipeline(context, [_SummaryProvider()])

    assert result.status == "partial"
    assert result.provider_summaries["fake"]["reason"] == "no_speech"
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [event["event"] for event in events] == ["provider_start", "provider_outcome"]
    assert events[1]["provider_id"] == "fake"
    assert events[1]["outcome"] == "partial:no_speech"


def test_run_pipeline_marks_no_audio_partial_and_preserves_warning_code(tmp_path) -> None:
    conn = _Conn()
    context = PipelineContext(
        run={"id": "run_1", "video_id": "video_1"},
        org_id="org_1",
        blob_service_client=object(),  # type: ignore[arg-type]
        db_conn=conn,  # type: ignore[arg-type]
        workdir=tmp_path,
        register_artifact=lambda _kind, _path: "artifact_1",
        heartbeat=lambda _stage, _pct, _detail: None,
    )

    result = run_pipeline(context, [_NoAudioProvider()])

    assert result.status == "partial"
    assert result.error_code == "no_audio"
    assert result.provider_summaries["fake"]["status"] == "skipped_no_audio"


def test_run_pipeline_does_not_promote_disabled_skip_to_partial(tmp_path) -> None:
    class _DisabledProvider(_FakeProvider):
        def run(self, context: PipelineContext) -> list[dict[str, Any]]:
            context.report_provider_summary("fake", {"status": "skipped", "reason": "disabled"})
            return []

    context = PipelineContext(
        run={"id": "run_1", "video_id": "video_1"},
        org_id="org_1",
        blob_service_client=object(),  # type: ignore[arg-type]
        db_conn=_Conn(),  # type: ignore[arg-type]
        workdir=tmp_path,
        register_artifact=lambda _kind, _path: "artifact_1",
        heartbeat=lambda _stage, _pct, _detail: None,
    )

    result = run_pipeline(context, [_DisabledProvider()])

    assert result.status == "succeeded"
    assert result.error_code is None


@pytest.mark.parametrize("raises", [False, True])
def test_other_processing_issues_take_precedence_over_no_audio(tmp_path, raises) -> None:
    class _ProblemProvider(_FakeProvider):
        @property
        def id(self) -> str:
            return "problem"

        def run(self, context: PipelineContext) -> list[dict[str, Any]]:
            if raises:
                raise RuntimeError("Processing failed")
            context.report_provider_summary(
                self.id, {"status": "partial", "reason": "missing_data"}
            )
            return []

    context = PipelineContext(
        run={"id": "run_1", "video_id": "video_1"},
        org_id="org_1",
        blob_service_client=object(),  # type: ignore[arg-type]
        db_conn=_Conn(),  # type: ignore[arg-type]
        workdir=tmp_path,
        register_artifact=lambda _kind, _path: "artifact_1",
        heartbeat=lambda _stage, _pct, _detail: None,
    )
    result = run_pipeline(context, [_NoAudioProvider(), _ProblemProvider()])
    assert result.status == "partial"
    assert result.error_code is None
    assert result.provider_summaries["problem"]["status"] == "partial"
