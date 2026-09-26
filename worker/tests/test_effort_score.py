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
    assert result["components"]["cognitive"] is None
    assert result["total"] == 53


def test_negative_sentiment_threshold_matches_report_attention_line() -> None:
    # Shared with apps/web/src/__tests__/effort-score-sentiment.test.ts: both scorers must agree.
    values = [-0.2, -0.29, -0.3, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    measures = [
        {"kind": "sentiment", "t_start_ms": i * 1000, "t_end_ms": i * 1000 + 1000, "value_num": v}
        for i, v in enumerate(values)
    ]
    result = normalize(measures, {"duration_ms": 10_000}, {"sentiment": "neg_density"})
    # Only -0.3 counts: 1 s of 10 s is 10%, x250 = 25. The old -0.15 cut counted all three (75).
    assert result["sentiment"]["raw"] == 0.1
    assert result["sentiment"]["normalized"] == 25


def test_words_per_minute_is_speech_not_physical() -> None:
    payload = _demo_report()
    normalized = normalize(
        payload["measures"], payload["video"], payload["score"]["profile"]["normalization"]
    )
    result = score(normalized, payload["score"]["profile"]["weights"])
    assert result["components"]["physical"] is None
    assert result["components"]["speech"] == normalized["spoken_word"]["normalized"]


def test_silent_recording_is_not_scored_as_easy() -> None:
    """Missing speech must drop out of the score, not count as zero effort."""
    payload = _demo_report()
    weights = payload["score"]["profile"]["weights"]
    norm = payload["score"]["profile"]["normalization"]
    visual_only = [
        m for m in payload["measures"] if m["kind"] not in {"spoken_word", "utterance", "sentiment"}
    ]
    silent_video = {**payload["video"], "has_audio": False}

    silent = score(normalize(visual_only, silent_video, norm), weights)
    only_visual_weights = {
        k: (v if k not in {"spoken_word", "utterance", "sentiment"} else 0)
        for k, v in weights.items()
    }
    reference = score(normalize(visual_only, payload["video"], norm), only_visual_weights)

    assert silent["total"] == reference["total"]
    assert silent["components"]["speech"] is None
    assert silent["components"]["sentiment"] is None
    not_measured = {item["kind"] for item in silent["breakdown"] if not item["measured"]}
    assert {"spoken_word", "sentiment"} <= not_measured
    assert all(item["contribution"] == 0 for item in silent["breakdown"] if not item["measured"])


def test_audio_with_silence_is_a_real_zero() -> None:
    payload = _demo_report()
    norm = payload["score"]["profile"]["normalization"]
    visual_only = [m for m in payload["measures"] if m["kind"] not in {"spoken_word", "utterance"}]
    normalized = normalize(visual_only, {**payload["video"], "has_audio": True}, norm)
    assert normalized["spoken_word"]["measured"] is True
    assert normalized["spoken_word"]["normalized"] == 0
