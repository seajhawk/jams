"""Reject misleading synchronization claims before metrics can be published."""

import pytest

from jams_worker.jem_eval import EvaluationError, Flash, _offsets, _point_match, map_active_ms


def manifest(end=10500):
    return {"sync": {"flashes": [{"flash_log_ms": 500}], "end_flash_log_ms": end}}


def test_matching_start_and_end_with_constant_recorder_latency():
    offsets = _offsets(manifest(), [Flash(300, 9), Flash(10300, 9)])
    assert map_active_ms(2000, offsets) == 1800


def test_rejects_missing_end_anchor():
    with pytest.raises(EvaluationError, match="ending sync flash"):
        _offsets(manifest(None), [Flash(300, 9)])


def test_rejects_clock_drift_even_when_start_matches():
    with pytest.raises(EvaluationError, match="drift"):
        _offsets(manifest(), [Flash(300, 9), Flash(11000, 9)])


def test_rejects_extra_white_page_instead_of_pairing_it_as_sync():
    with pytest.raises(EvaluationError, match="ambiguous"):
        _offsets(manifest(), [Flash(300, 9), Flash(9000, 100), Flash(10300, 9)])


def test_rejects_missing_end_flash_in_video():
    with pytest.raises(EvaluationError, match="ambiguous"):
        _offsets(manifest(), [Flash(300, 9)])


def test_rejects_unbounded_recorder_latency():
    with pytest.raises(EvaluationError, match="offset"):
        _offsets(manifest(), [Flash(3000, 9), Flash(13000, 9)])


def test_rejects_unvalidated_paused_segment_drift():
    data = manifest()
    data["sync"]["flashes"].append({"flash_log_ms": 5000})
    with pytest.raises(EvaluationError, match="per-segment"):
        _offsets(data, [Flash(300, 9), Flash(4800, 9), Flash(10300, 9)])


def test_point_matching_does_not_steal_later_events_only_candidate():
    metric = _point_match([400, 0], [100, -400])
    assert (metric["tp"], metric["fp"], metric["fn"]) == (2, 0, 0)


def test_point_matching_never_reuses_a_detection():
    metric = _point_match([0, 100, 200], [100])
    assert (metric["tp"], metric["fp"], metric["fn"]) == (1, 0, 2)
