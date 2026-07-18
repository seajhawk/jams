"""Unit tests for rule-based segmentation."""

from __future__ import annotations

from jams_worker.providers.segmentation import (
    MIN_SEGMENT_MS,
    UtteranceCue,
    _cue_lists,
    build_segments,
    time_segment_measures,
)

RUN_ID = "11111111-1111-4111-8111-111111111111"


def test_audio_cue_snaps_to_nearest_context_switch_within_window() -> None:
    segments = build_segments(
        run_id=RUN_ID,
        duration_ms=60_000,
        utterances=[
            UtteranceCue(12_000, 13_500, "Okay next, open settings."),
        ],
        switches=[10_500],
    )

    assert [(segment.t0_ms, segment.t1_ms, segment.source) for segment in segments] == [
        (0, 10_500, "audio_cue"),
        (10_500, 60_000, "audio_cue"),
    ]
    assert segments[1].name == "Okay next, open settings"
    assert "snapped_from:12000" in segments[1].origin


def test_min_segment_rule_merges_short_boundaries() -> None:
    segments = build_segments(
        run_id=RUN_ID,
        duration_ms=45_000,
        utterances=[
            UtteranceCue(5_000, 6_000, "Now this cue is too soon."),
            UtteranceCue(16_000, 17_000, "Next configure the app."),
            UtteranceCue(23_000, 24_000, "Next this one is also too soon."),
        ],
        switches=[],
    )

    assert MIN_SEGMENT_MS == 10_000
    assert [(segment.t0_ms, segment.t1_ms) for segment in segments] == [
        (0, 16_000),
        (16_000, 45_000),
    ]


def test_time_segment_measures_reference_deterministic_segment_ids() -> None:
    segments = build_segments(
        run_id=RUN_ID,
        duration_ms=20_000,
        utterances=[],
        switches=[],
    )
    measures = time_segment_measures(segments)

    assert len(measures) == 1
    assert measures[0]["value_num"] == 20_000
    assert measures[0]["payload"]["segment_id"] == segments[0].id


def test_extra_cues_are_union_boundaries() -> None:
    cues = _cue_lists({"segmentation": {"extra_cues": ["new checkpoint"]}})
    segments = build_segments(
        run_id=RUN_ID,
        duration_ms=40_000,
        utterances=[
            UtteranceCue(12_000, 13_000, "New checkpoint, configure billing."),
        ],
        switches=[],
        cues=cues,
    )

    assert [(segment.t0_ms, segment.t1_ms) for segment in segments] == [
        (0, 12_000),
        (12_000, 40_000),
    ]
    assert segments[1].origin == "next:new checkpoint"
