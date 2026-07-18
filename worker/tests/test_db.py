"""Tests for run repository update helpers."""

from __future__ import annotations

import json
from typing import Any

from jams_worker.db import RunRepository


class _Conn:
    def __init__(self) -> None:
        self.executed: list[tuple[str, object]] = []
        self.commits = 0

    def execute(self, sql: str, params: object = None) -> None:
        self.executed.append((" ".join(sql.split()), params))

    def commit(self) -> None:
        self.commits += 1


def test_set_provider_results_persists_jsonb() -> None:
    conn = _Conn()
    results: dict[str, Any] = {
        "segment_labeling": {
            "status": "ok",
            "renamed_count": 2,
            "merge_count": 0,
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }
    }

    RunRepository(conn).set_provider_results("run-1", results)  # type: ignore[arg-type]

    sql, params = conn.executed[0]
    assert sql.startswith("update analysis_runs set provider_results = %s::jsonb")
    assert params == (json.dumps(results), "run-1")
    assert conn.commits == 1
