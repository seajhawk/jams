"""Verify paired audio isolates clicks at declared timestamps and levels."""

from pathlib import Path

import make_audio_holdouts as holdouts
import numpy as np
import pytest
from make_fixtures import AUDIO_SR, _read_wav_mono16, _write_wav_mono16


@pytest.mark.parametrize("mix_db", [-12.0, -6.0, 0.0])
def test_pairs_differ_only_at_declared_clicks_and_preserve_mix_level(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, mix_db: float,
) -> None:
    def synthesize(_ffmpeg: str, _text: str, _voice: str, _speed: int, output: Path) -> None:
        time = np.arange(int(holdouts.HOLDOUT_DURATION_S * AUDIO_SR)) / AUDIO_SR
        _write_wav_mono16(output, (0.2 * np.sin(2 * np.pi * 440 * time)).tolist())

    monkeypatch.setattr(holdouts, "_synthesize_speech", synthesize)
    case = holdouts._make_case(tmp_path, 0, 0, mix_db, "unused")
    pure = np.asarray(_read_wav_mono16(tmp_path / case["pure_speech_file"]))
    mixed = np.asarray(_read_wav_mono16(tmp_path / case["narrated_clicks_file"]))
    assert len(pure) == len(mixed) == 24 * AUDIO_SR
    active = np.zeros(len(pure), dtype=bool)
    for offset in case["click_offsets_ms"]:
        start = int(offset * AUDIO_SR / 1000)
        active[start:start + int(0.012 * AUDIO_SR)] = True
        assert np.any(mixed[start:start + 192] != pure[start:start + 192])
    assert np.array_equal(mixed[~active], pure[~active])
    measured_db = 20 * np.log10(
        np.sqrt(np.mean((mixed[active] - pure[active]) ** 2)) / np.sqrt(np.mean(pure ** 2))
    )
    assert measured_db == pytest.approx(mix_db, abs=0.02)
