"""Decay timing boundaries for the shared frame-energy envelope."""

import numpy as np
import pytest

from jams_worker.providers.audio_onsets import _decay_ms
from jams_worker.providers.physical_effort_params import AudioOnsetParams


@pytest.mark.parametrize(("energy", "index", "expected_ms"), [
    ([0.0, 0.0], 0, 0.0),
    ([100.0, 1.0], 0, 4.0),
    ([100.0, 2.0, 1.0], 0, 8.0),
    ([100.0] * 20, 0, 60.0),
    ([100.0, 50.0], 1, 4.0),
])
def test_decay_timing(energy: list[float], index: int, expected_ms: float) -> None:
    assert _decay_ms(np.asarray(energy), index, AudioOnsetParams()) == expected_ms
