"""Effort score normalization shared by worker scoring provider tests."""

from __future__ import annotations

import math
from typing import Any

Measure = dict[str, Any]

KIND_CATEGORY = {
    "clicks": "physical",
    "context_switch": "cognitive",
    "keypresses": "physical",
    "sentiment": "sentiment",
    "scrolls": "physical",
    # Words per minute is speech, not physical effort (preview review B6).
    "spoken_word": "speech",
    "time_segment": "time",
    "utterance": "speech",
}

# An utterance counts toward negative narration time at or below this value. Matches the report's
# "worth attention" line (apps/web/src/lib/report-moments.ts). It was -0.15 while the sentiment
# model was two-class and only produced extreme values; the three-class model leaves neutral
# lines slightly below zero, which -0.15 counted as negative. Keep in sync with effort-score.ts.
NEGATIVE_SENTIMENT_THRESHOLD = -0.3

SCORE_KIND_ORDER = [
    "clicks",
    "context_switch",
    "keypresses",
    "sentiment",
    "scrolls",
    "spoken_word",
    "time_segment",
    "utterance",
]

PER_MINUTE_SCALE = {
    "context_switch": 36.75,
    "clicks": 1,
    "keypresses": 1,
    "spoken_word": 2.47,
    "utterance": 10,
}


def round_whole(value: float) -> int:
    return math.floor(value + 0.5)


def round_tenth(value: float) -> float:
    return math.floor(value * 10 + 0.5) / 10


def clamp_score(value: float) -> float:
    return max(0, min(100, value))


def _measures_for_kind(measures: list[Measure], kind: str) -> list[Measure]:
    return [measure for measure in measures if measure.get("kind") == kind]


def _duration_minutes(video: dict[str, Any]) -> float:
    return float(video.get("duration_ms") or 0) / 60_000


def _per_minute_raw(kind: str, measures: list[Measure]) -> float:
    kind_measures = _measures_for_kind(measures, kind)
    if kind in {"keypresses", "spoken_word"}:
        return sum(float(measure.get("value_num") or 0) for measure in kind_measures)
    return float(len(kind_measures))


def _normalize_per_minute(
    kind: str,
    measures: list[Measure],
    video: dict[str, Any],
) -> dict[str, Any]:
    raw = _per_minute_raw(kind, measures)
    scale = PER_MINUTE_SCALE.get(kind, 1)
    minutes = _duration_minutes(video)
    rate = raw / minutes if minutes > 0 else 0
    return {
        "raw": int(raw) if raw.is_integer() else raw,
        "normalized": round_whole(clamp_score(rate * scale)),
    }


def _measure_end(measure: Measure) -> int:
    end_ms = measure.get("t_end_ms")
    return int(end_ms if end_ms is not None else measure["t_start_ms"])


def _normalize_negative_density(measures: list[Measure]) -> dict[str, Any]:
    sentiment_measures = _measures_for_kind(measures, "sentiment")
    narration_ms = sum(
        max(0, _measure_end(measure) - int(measure["t_start_ms"])) for measure in sentiment_measures
    )
    negative_ms = sum(
        max(0, _measure_end(measure) - int(measure["t_start_ms"]))
        for measure in sentiment_measures
        if float(measure.get("value_num") or 0) <= NEGATIVE_SENTIMENT_THRESHOLD
    )
    share = negative_ms / narration_ms if narration_ms > 0 else 0
    return {
        "raw": round_tenth(share),
        "normalized": round_whole(clamp_score(share * 250)),
    }


def _normalize_raw_minutes(video: dict[str, Any]) -> dict[str, Any]:
    minutes = _duration_minutes(video)
    return {
        "raw": round_tenth(minutes),
        "normalized": round_whole(clamp_score(minutes * (100 / 30))),
    }


def is_measured(kind: str, measures: list[Measure], video: dict[str, Any]) -> bool:
    """Whether this recording could measure the kind at all. Unmeasured is not zero.

    Speech kinds need audio (audio with silence is a real zero); sentiment needs speech to
    classify; context switches and time always come from the video; the experimental physical
    detectors count only when they produced something. Unknown audio is treated as present so
    older rows score as before.
    """
    if kind in {"spoken_word", "utterance"}:
        return video.get("has_audio") is not False
    if kind == "sentiment":
        return bool(_measures_for_kind(measures, "sentiment"))
    if kind in {"context_switch", "time_segment"}:
        return True
    return bool(_measures_for_kind(measures, kind))


def normalize(
    measures: list[Measure],
    video: dict[str, Any],
    normalization: dict[str, str],
) -> dict[str, dict[str, Any]]:
    scores: dict[str, dict[str, Any]] = {}
    for kind in SCORE_KIND_ORDER:
        mode = normalization.get(kind)
        if not mode:
            continue
        if mode == "per_minute":
            scores[kind] = {"kind": kind, **_normalize_per_minute(kind, measures, video)}
        elif mode == "neg_density":
            scores[kind] = {"kind": kind, **_normalize_negative_density(measures)}
        else:
            scores[kind] = {"kind": kind, **_normalize_raw_minutes(video)}
        scores[kind]["measured"] = is_measured(kind, measures, video)
    return scores


def score(normalized: dict[str, dict[str, Any]], weights: dict[str, float]) -> dict[str, Any]:
    weighted_kinds = [kind for kind in SCORE_KIND_ORDER if float(weights.get(kind) or 0) > 0]
    # Only kinds this recording could measure take part, in numerator and denominator alike, so a
    # missing signal never drags the score toward zero. A kind with no normalization is missing.
    active_kinds = [
        kind
        for kind in weighted_kinds
        if normalized.get(kind, {}).get("measured", kind in normalized)
    ]
    total_weight = sum(float(weights.get(kind) or 0) for kind in active_kinds)
    weighted_sum = sum(
        float(normalized.get(kind, {}).get("normalized") or 0) * float(weights.get(kind) or 0)
        for kind in active_kinds
    )

    components: dict[str, int | None] = {
        "physical": None,
        "cognitive": None,
        "time": None,
        "sentiment": None,
        "speech": None,
    }
    for category in components:
        category_kinds = [kind for kind in active_kinds if KIND_CATEGORY[kind] == category]
        category_weight = sum(float(weights.get(kind) or 0) for kind in category_kinds)
        category_weighted_sum = sum(
            float(normalized.get(kind, {}).get("normalized") or 0) * float(weights.get(kind) or 0)
            for kind in category_kinds
        )
        components[category] = (
            round_whole(category_weighted_sum / category_weight) if category_weight > 0 else None
        )

    return {
        "components": components,
        "total": round_whole(weighted_sum / total_weight) if total_weight > 0 else None,
        "breakdown": [
            {
                "kind": kind,
                "raw": normalized.get(kind, {}).get("raw") or 0,
                "normalized": normalized.get(kind, {}).get("normalized") or 0,
                "weight": weights.get(kind) or 0,
                "measured": kind in active_kinds,
                "contribution": (
                    round_tenth(
                        (
                            float(normalized.get(kind, {}).get("normalized") or 0)
                            * float(weights.get(kind) or 0)
                        )
                        / total_weight
                    )
                    if total_weight > 0 and kind in active_kinds
                    else 0
                ),
            }
            # Weighted kinds that were not measured stay listed (measured: false) so stored rows
            # can tell the report what is missing rather than implying a zero.
            for kind in weighted_kinds
        ],
    }
