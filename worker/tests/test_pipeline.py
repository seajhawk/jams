"""Tests for pipeline contracts and idempotent measure writes."""

from __future__ import annotations

from typing import Any

from jams_worker.pipeline import MeasureProvider, PipelineContext, write_provider_measures


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
