"""Parity tests for Python effort scoring."""

from __future__ import annotations

import json
from pathlib import Path

from jams_worker.effort_score import normalize, score


def _demo_report() -> dict:
    fixture = Path(__file__).parents[2] / "fixtures" / "demo-report.v1.json"
    return json.loads(fixture.read_text(encoding="utf-8"))


def test_python_scoring_matches_demo_fixture_exactly() -> None:
    payload = _demo_report()
    normalized = normalize(
        payload["measures"],
        payload["video"],
        payload["score"]["profile"]["normalization"],
    )
    result = score(normalized, payload["score"]["profile"]["weights"])

    assert result == {
        "components": payload["score"]["components"],
        "total": payload["score"]["total"],
        "breakdown": payload["score"]["breakdown"],
    }


def test_zero_weight_kind_drops_out() -> None:
    payload = _demo_report()
    normalized = normalize(
        payload["measures"],
        payload["video"],
        payload["score"]["profile"]["normalization"],
    )
    weights = dict(payload["score"]["profile"]["weights"])
    weights["context_switch"] = 0

    result = score(normalized, weights)

    assert "context_switch" not in [item["kind"] for item in result["breakdown"]]
    assert result["components"]["cognitive"] == 0
    assert result["total"] == 53
