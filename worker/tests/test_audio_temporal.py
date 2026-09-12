"""Temporal contrast distinguishes a short pulse from sustained power."""

import pytest
from evaluate_audio_temporal import _contrast

from jams_worker.providers.physical_effort_params import AudioOnsetParams


def test_pulse_contrast_and_sustained_signal() -> None:
    params = AudioOnsetParams()
    envelope = [1.0] * 40
    envelope[20] = 8.0
    assert _contrast(envelope, 80, params) == 8.0
    assert _contrast([8.0] * 40, 80, params) == 1.0


@pytest.mark.parametrize("envelope,time", [([], 0), ([0.0], 0), ([1.0]*40, -4),
                                          ([1.0]*40, 160)])
def test_missing_context_is_safe(envelope: list[float], time: int) -> None:
    assert _contrast(envelope, time, AudioOnsetParams()) == 0.0
