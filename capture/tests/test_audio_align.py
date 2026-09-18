"""Tests for aligning a separate microphone track to a JEM screen recording.

The offset search is tested on exact inputs rather than synthesised audio on purpose: the
transient detector's threshold can only be calibrated honestly against real recorded hardware, so
asserting against clicks we generated ourselves would only measure our own synthesiser.
"""

from __future__ import annotations

import math
import random
import struct
import sys
import wave
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from capture.audio_align import (  # noqa: E402
    Alignment,
    build_mux_command,
    detect_tone_onsets,
    refine_offset_by_events,
)

RATE = 44100
TONE_HZ = 1000
TONE_MS = 150


def _write_probe(path: Path, tone_onsets_ms: list[float], total_ms: int = 20000) -> None:
    """Tones over a speech-like bed with broadband transients the detector must ignore."""
    count = int(RATE * total_ms / 1000)
    buf = [0.0] * count
    rng = random.Random(7)

    for i in range(count):
        t = i / RATE
        value = 0.05 * rng.uniform(-1, 1)
        value += 0.08 * math.sin(2 * math.pi * (180 + 40 * math.sin(2 * math.pi * 0.3 * t)) * t)
        value += 0.04 * math.sin(2 * math.pi * 2600 * t) * (0.5 + 0.5 * math.sin(2 * math.pi * 1.7 * t))
        buf[i] = value

    fade = int(RATE * 0.005)
    for onset_ms in tone_onsets_ms:
        start = int(RATE * onset_ms / 1000)
        length = int(RATE * TONE_MS / 1000)
        for j in range(length):
            if start + j >= count:
                break
            env = 1.0
            if j < fade:
                env = 0.5 * (1 - math.cos(math.pi * j / fade))
            elif j >= length - fade:
                env = 0.5 * (1 - math.cos(math.pi * (length - 1 - j) / fade))
            buf[start + j] += 0.6 * env * math.sin(2 * math.pi * TONE_HZ * j / RATE)

    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(
            b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in buf)
        )


def test_detects_every_tone_without_false_positives(tmp_path: Path) -> None:
    truth = [2000.0, 10000.0, 17500.0]
    probe = tmp_path / "probe.wav"
    _write_probe(probe, truth)

    found = detect_tone_onsets(probe, TONE_HZ)

    assert len(found) == len(truth), f"expected {len(truth)} tones, got {found}"
    # 30 ms: the video side quantises flashes to frame boundaries (+/-33 ms at 30 fps) and the
    # speaker->air->microphone path adds a far larger systematic delay. The tone is a coarse anchor
    # and a drift baseline; precise offset comes from event cross-correlation below.
    for actual, expected in zip(found, truth):
        assert abs(actual - expected) <= 30.0


def test_ignores_audio_with_no_tone(tmp_path: Path) -> None:
    probe = tmp_path / "silent.wav"
    _write_probe(probe, [])
    assert detect_tone_onsets(probe, TONE_HZ) == []


EVENTS = [1000.0, 4000.0, 6500.0, 9000.0, 12000.0, 15000.0, 18000.0]


@pytest.mark.parametrize(
    ("name", "lag", "tolerance"),
    [("positive lag", 73.0, 3.0), ("negative lag", -120.0, 3.0), ("no lag", 0.0, 3.0)],
)
def test_recovers_exact_offset(name: str, lag: float, tolerance: float) -> None:
    offset, matched = refine_offset_by_events(
        None, EVENTS, transients=[e + lag for e in EVENTS]
    )
    assert matched == len(EVENTS)
    assert abs(offset - lag) <= tolerance


def test_recovers_offset_despite_jitter_and_clutter() -> None:
    rng = random.Random(11)
    lag = 73.0
    transients = [e + lag + rng.uniform(-4, 4) for e in EVENTS]
    transients += [rng.uniform(0, 20000) for _ in range(120)]

    offset, matched = refine_offset_by_events(None, EVENTS, transients=sorted(transients))

    assert matched == len(EVENTS)
    assert abs(offset - lag) <= 6.0


def test_recovers_offset_when_most_events_are_undetected() -> None:
    rng = random.Random(3)
    lag = 73.0
    detected = sorted(rng.sample([e + lag for e in EVENTS], 4))

    offset, matched = refine_offset_by_events(None, EVENTS, transients=detected)

    assert matched == 4
    assert abs(offset - lag) <= 3.0


def test_offset_is_plateau_centred_not_edge_biased() -> None:
    """A tolerance window makes the hit count a plateau; taking its first maximum biases by exactly
    the tolerance, which is a silent tens-of-milliseconds error in every muxed recording."""
    lag = 50.0
    offset, _ = refine_offset_by_events(
        None, EVENTS, transients=[e + lag for e in EVENTS], tolerance_ms=25.0
    )
    assert abs(offset - lag) <= 2.0


def test_returns_nothing_when_no_events_match() -> None:
    offset, matched = refine_offset_by_events(None, EVENTS, transients=[999999.0])
    assert matched == 0
    assert offset == 0.0


def test_mux_command_rate_corrects_only_when_drift_is_material() -> None:
    video, audio, out = Path("v.mp4"), Path("a.wav"), Path("o.mp4")

    # 10 ppm over 2 minutes is ~1 ms — not worth resampling for.
    negligible = Alignment(offset_ms=12.0, rate=1.00001, video_anchors_ms=[0, 120000], audio_anchors_ms=[0.0, 0.0])
    assert "-af" not in build_mux_command(video, audio, negligible, out, duration_ms=120000)

    # 500 ppm over 20 minutes is ~600 ms — far past the 250 ms cross-stage budget.
    material = Alignment(offset_ms=12.0, rate=1.0005, video_anchors_ms=[0, 1200000], audio_anchors_ms=[0.0, 0.0])
    command = build_mux_command(video, audio, material, out, duration_ms=1200000)
    assert "-af" in command
    assert any("atempo" in part for part in command)


def test_mux_shifts_audio_against_the_measured_offset() -> None:
    alignment = Alignment(offset_ms=80.0, rate=1.0, video_anchors_ms=[0, 1000], audio_anchors_ms=[80.0, 1080.0])
    command = build_mux_command(Path("v.mp4"), Path("a.wav"), alignment, Path("o.mp4"))
    # The tone landed 80 ms later in audio than the flash did in video, so audio is pulled earlier.
    assert "-itsoffset" in command
    assert command[command.index("-itsoffset") + 1].startswith("-0.08")
