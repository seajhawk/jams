"""Ensure diagnostic metrics do not count duplicates or hide empty detections."""

import json
from pathlib import Path

import pytest
from diagnose_audio_onsets import diagnose, match_indices, summarize

from jams_worker.providers.audio_onsets import FEATURE_NAMES, AudioOnset


def _onset(t_ms: int) -> AudioOnset:
    return AudioOnset(
        t_ms=t_ms, feats=(0.0,) * len(FEATURE_NAMES), label="ambiguous",
        train_id=None, in_speech=True, requires_visual=True,
        threshold=1.0, flux_peak=2.0, spec_selfsim=None,
    )


def test_matching_counts_duplicate_proposals_as_false_positives() -> None:
    result = summarize([_onset(108), _onset(100), _onset(300)], [100, 500], 10)
    assert result["true_positives"] == 1
    assert result["false_positives"] == 2
    assert result["false_negatives"] == 1
    assert result["precision"] == 1 / 3
    assert result["recall"] == 0.5
    assert [row["matched"] for row in result["proposals"]] == [False, True, False]


def test_one_proposal_cannot_satisfy_two_expected_events() -> None:
    assert match_indices([100], [99, 101], 1) == {0}
    assert summarize([_onset(100)], [99, 101], 1)["false_negatives"] == 1


def test_empty_detections_do_not_claim_perfect_precision() -> None:
    result = summarize([], [100], 75)
    assert result["precision"] is None
    assert result["recall"] == 0
    assert result["false_negatives"] == 1
    assert result["feature_medians"] == {"matched": {}, "unmatched": {}}
    assert summarize([], [], 75)["recall"] is None


def test_partial_registry_cannot_silently_omit_evaluations(tmp_path: Path) -> None:
    (tmp_path / "registry.json").write_text(json.dumps({"generated": []}))
    with pytest.raises(ValueError, match="missing required controls"):
        diagnose(tmp_path, tmp_path / "work")


def test_positive_fixture_requires_ground_truth(tmp_path: Path) -> None:
    entries = [{"id": name} for name in (
        "narrated_clicks", "click_transients", "pure_speech_negative",
        "silence", "tones", "music_bed_negative",
    )]
    (tmp_path / "registry.json").write_text(json.dumps({"generated": entries}))
    with pytest.raises(ValueError, match="missing click ground truth"):
        diagnose(tmp_path, tmp_path / "work")
