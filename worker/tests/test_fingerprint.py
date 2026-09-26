from __future__ import annotations

from jams_worker.effort_score import SCORE_FORMULA_VERSION
from jams_worker.fingerprint import build_fingerprint

VERSIONS = {"sentiment": "1.2.0", "context_switch": "2.0.0"}
SUMMARIES = {"sentiment": {"status": "ok", "model_id": "roberta-3class"}}


def test_fingerprint_records_what_changes_the_numbers() -> None:
    fingerprint, digest = build_fingerprint(
        VERSIONS, SUMMARIES, {"sentiment": {"fallback": "none"}}
    )

    assert fingerprint == {
        "provider_versions": {"context_switch": "2.0.0", "sentiment": "1.2.0"},
        "models": {"sentiment": "roberta-3class"},
        "config": {"sentiment": {"fallback": "none"}},
        "score_formula": SCORE_FORMULA_VERSION,
    }
    assert len(digest) == 12 and int(digest, 16) >= 0


def test_hash_is_independent_of_key_order() -> None:
    reordered = {"context_switch": "2.0.0", "sentiment": "1.2.0"}
    config_a = {"sentiment": {"fallback": "none", "model": "roberta-3class"}}
    config_b = {"sentiment": {"model": "roberta-3class", "fallback": "none"}}

    assert (
        build_fingerprint(VERSIONS, SUMMARIES, config_a)[1]
        == build_fingerprint(reordered, SUMMARIES, config_b)[1]
    )


def test_hash_changes_with_provider_model_or_any_config() -> None:
    base = build_fingerprint(VERSIONS, SUMMARIES, {})[1]

    assert build_fingerprint({**VERSIONS, "sentiment": "1.3.0"}, SUMMARIES, {})[1] != base
    fell_back = {"sentiment": {"status": "ok", "model_id": "vader"}}
    assert build_fingerprint(VERSIONS, fell_back, {})[1] != base
    tuned = {"context_switch": {"params": {"min_content_val": 4}}}
    assert build_fingerprint(VERSIONS, SUMMARIES, tuned)[1] != base
    # Labeling can merge segments and rewrite time_segment measures, so it counts too.
    assert build_fingerprint(VERSIONS, SUMMARIES, {"llm_labeling": {"enabled": True}})[1] != base
    assert build_fingerprint(VERSIONS, SUMMARIES, None)[1] == base
