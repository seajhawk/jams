"""Align a separately-recorded microphone track to a JEM screen recording.

JEM records silent video. With ``sync.sync_tone`` enabled it also plays a short tone at the exact
instant it paints each sync flash. So the video carries flashes and the parallel microphone
recording carries tones, and the same physical events anchor both timelines.

Two anchors (start flash and end flash) give both a constant offset and a rate correction. The rate
term is not optional at length: the screen capture and the microphone run on independent clocks, and
even 50 ppm of drift is ~60 ms across a 20-minute session, which eats a quarter of the 250 ms
cross-stage timestamp budget on its own.

Usage::

    python -m capture.audio_align align   --video s.mp4 --audio s.wav --manifest s.json
    python -m capture.audio_align mux     --video s.mp4 --audio s.wav --manifest s.json --out out.mp4
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import wave
from dataclasses import dataclass
from pathlib import Path

_WORKER_SRC = Path(__file__).resolve().parents[1] / "worker" / "src"
if str(_WORKER_SRC) not in sys.path:
    sys.path.insert(0, str(_WORKER_SRC))


def _worker_deps():
    """Imported lazily so tone detection stays usable without the worker's heavy dependencies."""
    from jams_worker.jem_eval import detect_flash_runs, ffmpeg_path

    return detect_flash_runs, ffmpeg_path

DEFAULT_TONE_HZ = 1000
# The tone is 150 ms by default; require most of it so a stray transient cannot pass as an anchor.
MIN_TONE_MS = 90
HOP_MS = 5.0
WINDOW_MS = 25.0
# Target-band energy must dominate the frame this strongly to count as tone rather than speech.
DOMINANCE = 0.35


@dataclass(frozen=True, slots=True)
class Alignment:
    """audio_ms = rate * video_ms + offset_ms."""

    offset_ms: float
    rate: float
    video_anchors_ms: list[int]
    audio_anchors_ms: list[float]

    @property
    def drift_ppm(self) -> float:
        return (self.rate - 1.0) * 1_000_000.0

    def residual_ms(self) -> list[float]:
        return [
            self.audio_anchors_ms[i] - (self.rate * self.video_anchors_ms[i] + self.offset_ms)
            for i in range(len(self.video_anchors_ms))
        ]


class AlignmentError(RuntimeError):
    """The two timelines could not be anchored to each other."""


def _read_mono(path: Path) -> tuple[list[float], int]:
    with wave.open(str(path), "rb") as handle:
        if handle.getsampwidth() != 2:
            raise AlignmentError("expected 16-bit PCM audio")
        rate = handle.getframerate()
        channels = handle.getnchannels()
        raw = handle.readframes(handle.getnframes())

    import array

    samples = array.array("h")
    samples.frombytes(raw)
    if channels == 1:
        return [s / 32768.0 for s in samples], rate
    # Downmix defensively; the recorder asks for mono but a device may ignore that.
    mixed = []
    for i in range(0, len(samples) - channels + 1, channels):
        mixed.append(sum(samples[i : i + channels]) / (channels * 32768.0))
    return mixed, rate


def _goertzel_power(frame: list[float], freq_hz: int, rate: int) -> float:
    """Single-bin DFT power at ``freq_hz`` — cheaper and sharper than a full FFT for one target."""
    n = len(frame)
    if n == 0:
        return 0.0
    k = int(0.5 + (n * freq_hz) / rate)
    omega = (2.0 * math.pi * k) / n
    coeff = 2.0 * math.cos(omega)
    s_prev = s_prev2 = 0.0
    for sample in frame:
        s = sample + coeff * s_prev - s_prev2
        s_prev2 = s_prev
        s_prev = s
    return s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2


def detect_tone_onsets(
    audio: Path,
    freq_hz: int = DEFAULT_TONE_HZ,
    min_tone_ms: int = MIN_TONE_MS,
) -> list[float]:
    """Return the onset of every sustained ``freq_hz`` burst, in milliseconds."""
    samples, rate = _read_mono(audio)
    window = int(rate * WINDOW_MS / 1000)
    hop = int(rate * HOP_MS / 1000)
    if window <= 0 or hop <= 0 or len(samples) < window:
        return []

    shares: list[float] = []
    for start in range(0, len(samples) - window, hop):
        frame = samples[start : start + window]
        total = sum(s * s for s in frame)
        if total <= 1e-7:
            shares.append(0.0)
            continue
        # Parseval: sum_k |X_k|^2 = N * sum_n |x_n|^2, so this is the share of frame energy sitting
        # in the target bin. A real sine splits across +/-f, so a pure tone tops out near 0.5 and
        # anything above DOMINANCE is overwhelmingly tonal at that frequency.
        shares.append(_goertzel_power(frame, freq_hz, rate) / (window * total))

    onsets: list[float] = []
    run_start_hop = -1
    run_hops = 0
    hops_needed = max(1, int(min_tone_ms / HOP_MS))

    def _emit(first_hop: int) -> None:
        # A window only crosses DOMINANCE once it is mostly tone, so the run starts late by roughly
        # a window. Walk back over hops that are already clearly tonal relative to silence/speech to
        # recover the true onset; leaving this uncorrected would bias the muxed audio by tens of ms.
        hop_index = first_hop
        while hop_index > 0 and shares[hop_index - 1] > DOMINANCE * 0.25:
            hop_index -= 1
        onsets.append(hop_index * HOP_MS)

    for index, share in enumerate(shares):
        if share > DOMINANCE:
            if run_hops == 0:
                run_start_hop = index
            run_hops += 1
        else:
            if run_hops >= hops_needed:
                _emit(run_start_hop)
            run_start_hop, run_hops = -1, 0

    if run_hops >= hops_needed:
        _emit(run_start_hop)
    return onsets


def video_fps(video: Path) -> float:
    _, ffmpeg_path = _worker_deps()
    completed = subprocess.run(
        [
            ffmpeg_path().replace("ffmpeg", "ffprobe"),
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=avg_frame_rate",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    raw = (completed.stdout or "").strip()
    if "/" not in raw:
        raise AlignmentError(f"could not read video FPS (got {raw!r})")
    num, den = raw.split("/", 1)
    if not float(den):
        raise AlignmentError("video reports a zero frame-rate denominator")
    return float(num) / float(den)


def align(video: Path, audio: Path, freq_hz: int = DEFAULT_TONE_HZ) -> Alignment:
    """Anchor the microphone timeline to the video timeline using flash/tone pairs."""
    detect_flash_runs, _ = _worker_deps()
    fps = video_fps(video)
    flashes = [f.video_ms for f in detect_flash_runs(video, fps)]
    tones = detect_tone_onsets(audio, freq_hz)

    if len(flashes) < 2:
        raise AlignmentError(
            f"need a start and end flash to solve offset and drift; found {len(flashes)}. "
            "Confirm sync.end_flash is true and the recording was stopped normally."
        )
    if len(tones) < 2:
        raise AlignmentError(
            f"found {len(tones)} tone(s) in the audio but {len(flashes)} flash(es) in the video. "
            "Confirm sync.sync_tone is true and that the speakers were audible to the microphone "
            "— headphones defeat this anchor."
        )

    # Anchor on the outermost pair: the widest baseline gives the best-conditioned rate estimate.
    v0, v1 = flashes[0], flashes[-1]
    a0, a1 = tones[0], tones[-1]
    if v1 == v0:
        raise AlignmentError("start and end flash share a timestamp")

    rate = (a1 - a0) / (v1 - v0)
    offset = a0 - rate * v0
    return Alignment(offset_ms=offset, rate=rate, video_anchors_ms=[v0, v1], audio_anchors_ms=[a0, a1])


def detect_transients(audio: Path, threshold: float = 6.0, min_gap_ms: float = 40.0) -> list[float]:
    """Return onset times (ms) of sharp broadband transients — mouse clicks and key presses.

    Uses a fast/slow envelope ratio so it fires on attack sharpness rather than loudness, which
    keeps speech (gradual onsets) from swamping the mechanical clatter we are after.
    """
    samples, rate = _read_mono(audio)
    hop = max(1, int(rate * 1.0 / 1000))  # 1 ms resolution
    fast_n = max(1, int(rate * 3.0 / 1000))
    slow_n = max(1, int(rate * 60.0 / 1000))

    envelope: list[float] = []
    for start in range(0, len(samples) - fast_n, hop):
        window = samples[start : start + fast_n]
        envelope.append(math.sqrt(sum(s * s for s in window) / fast_n))

    slow_hops = max(1, slow_n // hop)
    onsets: list[float] = []
    last_ms = -1e9
    running = 0.0
    for i, value in enumerate(envelope):
        if i < slow_hops:
            running += value
            continue
        baseline = running / slow_hops
        if baseline > 1e-6 and value > threshold * baseline:
            ms = i * hop * 1000.0 / rate
            if ms - last_ms >= min_gap_ms:
                onsets.append(ms)
                last_ms = ms
        running += value - envelope[i - slow_hops]
    return onsets


def refine_offset_by_events(
    audio: Path | None,
    event_ms: list[float],
    search_ms: float = 400.0,
    step_ms: float = 1.0,
    tolerance_ms: float = 25.0,
    transients: list[float] | None = None,
) -> tuple[float, int]:
    """Recover the precise audio offset by cross-correlating JEM event times with audio transients.

    The sync tone traverses the output stack (speaker -> air -> microphone) and so carries tens of
    milliseconds of systematic latency. A mouse click does not: it is produced at the device and
    reaches the microphone almost immediately. Correlating JEM's logged click/keypress times against
    detected transients therefore measures the true audio offset on exactly the signal the acoustic
    transient library depends on.

    Returns ``(offset_ms, matched_count)`` where ``offset_ms`` should be ADDED to event times to land
    on the audio timeline.

    ``transients`` may be supplied directly; otherwise they are detected from ``audio``. Note that
    :func:`detect_transients` has a ``threshold`` that MUST be calibrated against real recorded
    hardware — tuning it on synthesised clicks would only measure the synthesiser.
    """
    if transients is None:
        if audio is None:
            raise AlignmentError("supply either an audio path or a transient list")
        transients = detect_transients(audio)
    if not transients or not event_ms:
        return 0.0, 0

    def _count(offset: float) -> int:
        hits = 0
        cursor = 0
        for event in event_ms:
            target = event + offset
            while cursor + 1 < len(transients) and transients[cursor] < target - tolerance_ms:
                cursor += 1
            if abs(transients[cursor] - target) <= tolerance_ms:
                hits += 1
        return hits

    steps = int((2 * search_ms) / step_ms) + 1
    counts = [(-search_ms + i * step_ms, _count(-search_ms + i * step_ms)) for i in range(steps)]
    best_hits = max(count for _, count in counts)
    if best_hits == 0:
        return 0.0, 0

    # Every offset within +/-tolerance of the truth matches the same events, so the hit count forms
    # a plateau rather than a peak. Take the plateau's centre, then refine to the mean pair residual
    # for a sub-millisecond estimate; picking the first maximum would bias by exactly tolerance_ms.
    plateau = [offset for offset, count in counts if count == best_hits]
    centre = (plateau[0] + plateau[-1]) / 2.0

    residuals: list[float] = []
    cursor = 0
    for event in event_ms:
        target = event + centre
        while cursor + 1 < len(transients) and transients[cursor] < target - tolerance_ms:
            cursor += 1
        if abs(transients[cursor] - target) <= tolerance_ms:
            residuals.append(transients[cursor] - event)

    if not residuals:
        return centre, best_hits
    return sum(residuals) / len(residuals), best_hits


def build_mux_command(
    video: Path,
    audio: Path,
    alignment: Alignment,
    out: Path,
    duration_ms: float | None = None,
) -> list[str]:
    """ffmpeg command that shifts, and if needed rate-corrects, the audio onto the video."""
    filters: list[str] = []
    # Correcting the rate means resampling the audio so its clock matches the video's. asetrate
    # retimes, aresample restores the nominal rate, atempo keeps pitch sane for large corrections.
    if duration_ms and abs(alignment.rate - 1.0) * duration_ms > 50.0:
        filters.append(f"atempo={1.0 / alignment.rate:.9f}")

    _, ffmpeg_path = _worker_deps()
    command = [ffmpeg_path(), "-v", "error", "-y", "-i", str(video)]
    # A positive offset means the tone landed later in the audio than the flash did in the video,
    # so the audio must be pulled earlier to line up.
    command += ["-itsoffset", f"{-alignment.offset_ms / 1000.0:.6f}", "-i", str(audio)]
    command += ["-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy"]
    if filters:
        command += ["-af", ",".join(filters)]
    command += ["-c:a", "aac", "-b:a", "128k", "-shortest", str(out)]
    return command


def mux(video: Path, audio: Path, alignment: Alignment, out: Path, duration_ms: float | None = None) -> Path:
    command = build_mux_command(video, audio, alignment, out, duration_ms)
    completed = subprocess.run(command, capture_output=True, text=True, timeout=1800, check=False)
    if completed.returncode != 0:
        raise AlignmentError(f"mux failed: {completed.stderr.strip()[:500]}")
    return out


def _report(alignment: Alignment) -> dict:
    return {
        "offset_ms": round(alignment.offset_ms, 2),
        "rate": round(alignment.rate, 9),
        "drift_ppm": round(alignment.drift_ppm, 1),
        "video_anchors_ms": alignment.video_anchors_ms,
        "audio_anchors_ms": [round(a, 2) for a in alignment.audio_anchors_ms],
        "residual_ms": [round(r, 3) for r in alignment.residual_ms()],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    for name in ("align", "mux", "tones"):
        p = sub.add_parser(name)
        p.add_argument("--audio", type=Path, required=True)
        p.add_argument("--tone-hz", type=int, default=DEFAULT_TONE_HZ)
        if name != "tones":
            p.add_argument("--video", type=Path, required=True)
        if name == "mux":
            p.add_argument("--out", type=Path, required=True)

    args = parser.parse_args(argv)

    if args.command == "tones":
        onsets = detect_tone_onsets(args.audio, args.tone_hz)
        print(json.dumps({"tone_onsets_ms": [round(o, 2) for o in onsets]}, indent=2))
        return 0

    alignment = align(args.video, args.audio, args.tone_hz)
    span_ms = alignment.video_anchors_ms[-1] - alignment.video_anchors_ms[0]

    if args.command == "align":
        print(json.dumps(_report(alignment), indent=2))
        return 0

    mux(args.video, args.audio, alignment, args.out, duration_ms=span_ms)
    print(json.dumps({**_report(alignment), "out": str(args.out)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
