"""Comparability fingerprint: everything that changes an analysis's numbers.

Two analyses are comparable only when their fingerprints match. The web app groups by
``fingerprint_hash`` and refuses to average or subtract across different definitions.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from jams_worker.effort_score import SCORE_FORMULA_VERSION


def build_fingerprint(
    provider_versions: dict[str, str],
    provider_summaries: dict[str, dict[str, Any]],
    config: dict[str, Any] | None,
) -> tuple[dict[str, Any], str]:
    models: dict[str, Any] = {}
    sentiment = provider_summaries.get("sentiment") or {}
    if sentiment.get("model_id"):
        # The model actually used, which differs from the requested one when the fallback fired.
        models["sentiment"] = sentiment["model_id"]
    fingerprint = {
        "provider_versions": dict(sorted(provider_versions.items())),
        "models": models,
        # The whole run config: every setting can change the numbers. llm_labeling looks like
        # naming only, but the labeling provider can merge adjacent segments and rewrite the
        # time_segment measures the score uses.
        "config": dict(sorted((config or {}).items())),
        "score_formula": SCORE_FORMULA_VERSION,
    }
    canonical = json.dumps(fingerprint, sort_keys=True, separators=(",", ":"))
    return fingerprint, hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]
