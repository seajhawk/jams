"""Offline metric and configuration guards for the JEM evaluator."""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from jams_worker import jem_eval
from jams_worker.jem_eval import EvaluationError, _point_match, _union_duration_ms
from jams_worker.providers.context_switch import ContextSwitchParams


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("min_content_val", 0),
        ("adaptive_threshold", math.nan),
        ("phase_response_threshold", math.inf),
    ],
)
def test_python_params_are_validated_before_media_reads(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    field: str,
    value: float,
):
    def fail_if_media_is_read(_session: Path):
        raise AssertionError("media reads must happen after parameter validation")

    monkeypatch.setattr(jem_eval, "_session_paths", fail_if_media_is_read)
    params = ContextSwitchParams(**{field: value})

    with pytest.raises(EvaluationError, match="invalid context-switch parameters"):
        jem_eval.evaluate_session(tmp_path, params=params)


def test_union_duration_merges_overlapping_padded_customer_windows():
    windows = [(0, 1_000), (500, 2_000), (3_000, 4_000)]
    scored_windows = [(max(0, start - 500), end) for start, end in windows]

    # Matching pads only the start, as the evaluator has always done. The
    # overlapping [0, 1_000] and [0, 2_000] windows count once.
    assert scored_windows == [(0, 1_000), (0, 2_000), (2_500, 4_000)]
    assert _union_duration_ms(scored_windows) == 3_500


def test_point_match_reports_counts_timing_percentile_and_exposure_rate():
    metric = _point_match(
        [0, 100, 200, 300],
        [0, 200, 300, 500, 10_000],
        exposure_ms=60_000,
    )

    assert metric["expected_count"] == 4
    assert metric["detected_count"] == 5
    assert metric["mean_abs_error_ms"] == 100.0
    assert metric["p95_abs_error_ms"] == 185.0
    assert metric["max_abs_error_ms"] == 200
    assert metric["false_positives_per_minute"] == 1.0


def test_point_match_reports_null_rate_for_zero_exposure():
    metric = _point_match([100], [100], exposure_ms=0)

    assert metric["false_positives_per_minute"] is None
