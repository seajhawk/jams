"""Context-switch provider detection and post-filter tests."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import golden as g
import make_fixtures as mf
import pytest

from jams_worker.errors import PipelineError
from jams_worker.providers.context_switch import (
    ContextSwitchParams,
    PhaseCorrelation,
    _config_params,
    confidence_from_content_val,
    decide_post_filter,
    detect_context_switches,
    validated_context_switch_params,
)


@pytest.fixture(scope="session")
def generated_fixtures(tmp_path_factory: pytest.TempPathFactory) -> tuple[dict[str, Any], Path]:
    out = tmp_path_factory.mktemp("context_switch_fixtures")
    return mf.generate_all(out), out


def _generated(registry: dict[str, Any], fixture_id: str) -> dict[str, Any]:
    for entry in registry["generated"]:
        if entry["id"] == fixture_id:
            return entry
    raise KeyError(fixture_id)


def test_confidence_formula() -> None:
    assert confidence_from_content_val(content_val=12.0, trigger=12.0, post_factor=1.0) == 0.5
    assert confidence_from_content_val(
        content_val=12.0 * 2.718281828,
        trigger=12.0,
        post_factor=1.0,
    ) == 0.75
    assert confidence_from_content_val(content_val=1000.0, trigger=12.0, post_factor=0.6) == 0.6


class _ConfigContext:
    def __init__(self, config: object) -> None:
        self.run = {"config": config}


def test_run_config_can_select_a_reproducible_detector_variant() -> None:
    params = _config_params(
        _ConfigContext({"context_switch": {"params": {"min_content_val": 4}}}),  # type: ignore[arg-type]
        ContextSwitchParams(),
    )

    assert params.min_content_val == 4.0
    assert params.min_gap_seconds == ContextSwitchParams().min_gap_seconds


@pytest.mark.parametrize(
    "config",
    [
        {"context_switch": {"params": {"unknown": 1}}},
        {"context_switch": {"params": {"min_content_val": True}}},
        {"context_switch": {"params": {"min_content_val": 0}}},
        {"context_switch": {"params": {"confidence_floor": 1.1}}},
    ],
)
def test_run_config_rejects_invalid_detector_variants(config: object) -> None:
    with pytest.raises(PipelineError):
        _config_params(_ConfigContext(config), ContextSwitchParams())  # type: ignore[arg-type]


@pytest.mark.parametrize("value", [float("nan"), float("inf")])
def test_detector_variants_reject_nonfinite_values(value: float) -> None:
    with pytest.raises(PipelineError):
        validated_context_switch_params({"min_content_val": value})


def test_post_filter_drops_boundary_translation() -> None:
    decision = decide_post_filter(
        boundary=PhaseCorrelation(response=0.4, shift_x=3.0, shift_y=0.0),
        post=(),
        params=ContextSwitchParams(),
    )

    assert not decision.keep
    assert decision.reason == "boundary_translation"


def test_post_filter_drops_repeated_post_translation() -> None:
    moving = PhaseCorrelation(response=0.3, shift_x=0.0, shift_y=4.0)
    decision = decide_post_filter(
        boundary=PhaseCorrelation(response=0.2, shift_x=0.0, shift_y=0.0),
        post=(moving, moving),
        params=ContextSwitchParams(),
    )

    assert not decision.keep
    assert decision.reason == "post_translation"


def test_post_filter_borderline_post_translation_reduces_confidence() -> None:
    moving = PhaseCorrelation(response=0.3, shift_x=0.0, shift_y=4.0)
    decision = decide_post_filter(
        boundary=PhaseCorrelation(response=0.2, shift_x=0.0, shift_y=0.0),
        post=(moving,),
        params=ContextSwitchParams(),
    )

    assert decision.keep
    assert decision.post_factor == 0.6
    assert decision.reason == "borderline_post_translation"


def test_post_filter_low_boundary_response_exempts_cut_into_scroll() -> None:
    moving = PhaseCorrelation(response=0.4, shift_x=0.0, shift_y=16.0)
    decision = decide_post_filter(
        boundary=PhaseCorrelation(response=0.05, shift_x=12.0, shift_y=12.0),
        post=(moving, moving, moving),
        params=ContextSwitchParams(),
    )

    assert decision.keep
    assert decision.post_factor == 1.0
    assert decision.reason == "low_boundary_response_exemption"


@pytest.mark.parametrize("detector_impl", ["adaptive", "dhash"])
@pytest.mark.parametrize(
    "fixture_id",
    ["synth_switches", "synth_tabs", "synth_scroll", "synth_drag", "synth_idle"],
)
def test_detector_matches_synthetic_fixture_expectations(
    generated_fixtures: tuple[dict[str, Any], Path],
    tmp_path: Path,
    detector_impl: str,
    fixture_id: str,
) -> None:
    registry, out = generated_fixtures
    entry = _generated(registry, fixture_id)

    cuts = detect_context_switches(
        out / entry["file"],
        tmp_path,
        detector_impl=detector_impl,  # type: ignore[arg-type]
    )
    detected_ms = [cut.t_start_ms for cut in cuts]
    expected_ms = entry.get("cuts_ms", [])
    match = g.cut_match(expected_ms, detected_ms, tolerance_ms=1000)

    assert match.fn == 0
    assert match.fp == 0
    if fixture_id in {"synth_switches", "synth_tabs"}:
        assert len(detected_ms) == len(expected_ms)
        assert all(cut.confidence >= 0.5 for cut in cuts)
    if fixture_id == "synth_scroll":
        assert detected_ms == [10000]
    if fixture_id in {"synth_drag", "synth_idle"}:
        assert detected_ms == []
