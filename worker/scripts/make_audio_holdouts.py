"""Generate deterministic held-out speech/click audio pairs for exploration.

This is intentionally separate from the acceptance fixture generator. It does
not run transcription or any model and writes only to the requested directory.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from make_fixtures import (
    AUDIO_SEED,
    AUDIO_SR,
    CLICK_BASE_OFFSETS_MS,
    _read_wav_mono16,
    _rms,
    _run_cmd,
    _seeded_offsets,
    _transient_track,
    _write_wav_mono16,
    ffmpeg_paths,
)

HOLDOUT_DURATION_S = 24.0
PHRASES = (
    "i opened the browser and checked the project dashboard before continuing",
    "then i reviewed the deployment status and changed the sample setting",
    "finally i confirmed the result loaded correctly and explained the change",
)
VOICES = ("en-us", "en-gb", "en-sc")
SPEEDS = (140, 175, 155)
MIX_LEVELS_DB = (-12.0, -6.0, 0.0)


def _synthesize_speech(ffmpeg: str, text: str, voice: str, speed: int, output: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="jams-holdout-") as temp_dir:
        raw = Path(temp_dir) / "speech_raw.wav"
        subprocess.run(
            ["espeak-ng", "-v", voice, "-s", str(speed), "-w", str(raw), text],
            check=True,
            capture_output=True,
        )
        _run_cmd(
            [
                ffmpeg,
                "-y",
                "-i",
                str(raw),
                "-af",
                f"aresample={AUDIO_SR},apad=whole_dur={HOLDOUT_DURATION_S:g}",
                "-t",
                str(HOLDOUT_DURATION_S),
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(output),
            ]
        )


def _make_case(
    output_dir: Path,
    phrase_index: int,
    voice_index: int,
    mix_db: float,
    ffmpeg: str,
) -> dict[str, Any]:
    voice = VOICES[voice_index]
    speed = SPEEDS[voice_index]
    mix_label = str(mix_db).replace("-", "m").replace(".", "p")
    case_id = f"phrase_{phrase_index + 1:02d}_{voice}_{speed}_{mix_label}db"
    pure_path = output_dir / f"{case_id}.pure.wav"
    mixed_path = output_dir / f"{case_id}.clicks.wav"
    # Fill the narration bed; individual clicks can still coincide with speech pauses.
    synthesis_text = " ".join([PHRASES[phrase_index]] * 6)
    _synthesize_speech(ffmpeg, synthesis_text, voice, speed, pure_path)

    speech = _read_wav_mono16(pure_path)
    offsets = _seeded_offsets(
        CLICK_BASE_OFFSETS_MS,
        seed=AUDIO_SEED + 300 + phrase_index,
        jitter_ms=18,
    )
    track, events, active = _transient_track(
        HOLDOUT_DURATION_S,
        offsets,
        kind="click",
        seed=AUDIO_SEED + 400 + phrase_index,
    )
    transient_rms = _rms(active)
    speech_rms = _rms(speech)
    gain = 0.0 if transient_rms <= 0 else speech_rms * 10 ** (mix_db / 20) / transient_rms
    mixed = [sample + transient * gain for sample, transient in zip(speech, track, strict=True)]
    peak = max(
        max((abs(sample) for sample in speech), default=0.0),
        max((abs(sample) for sample in mixed), default=0.0),
    )
    common_peak_scale = 0.92 / peak if peak > 0 else 1.0
    pure_scaled = [sample * common_peak_scale for sample in speech]
    mixed_scaled = [sample * common_peak_scale for sample in mixed]
    _write_wav_mono16(pure_path, pure_scaled)
    _write_wav_mono16(mixed_path, mixed_scaled)
    local_speech_rms = []
    window_samples = int(0.2 * AUDIO_SR)
    for event in events:
        center = int(event["t_ms"] * AUDIO_SR / 1000)
        start = max(0, center - window_samples)
        end = min(len(pure_scaled), center + window_samples)
        local_speech_rms.append(
            {"t_ms": int(event["t_ms"]), "rms": round(_rms(pure_scaled[start:end]), 6)}
        )

    return {
        "case_id": case_id,
        "phrase": PHRASES[phrase_index],
        "synthesis_text": synthesis_text,
        "pure_speech_file": pure_path.name,
        "narrated_clicks_file": mixed_path.name,
        "duration_ms": int(HOLDOUT_DURATION_S * 1000),
        "click_offsets_ms": [int(event["t_ms"]) for event in events],
        "local_speech_rms_400ms": local_speech_rms,
        "transient_gain": gain,
        "common_peak_scale": common_peak_scale,
        "voice": voice,
        "speed": speed,
        "mix_db": mix_db,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    if shutil.which("espeak-ng") is None:
        raise SystemExit("espeak-ng is required to generate audio holdouts")
    ffmpeg, _ffprobe = ffmpeg_paths()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    cases = [
        _make_case(args.output_dir, phrase_index, voice_index, mix_db, ffmpeg)
        for phrase_index in range(len(PHRASES))
        for voice_index in range(len(VOICES))
        for mix_db in MIX_LEVELS_DB
    ]
    manifest = {
        "duration_ms": int(HOLDOUT_DURATION_S * 1000),
        "click_offsets_source_ms": list(CLICK_BASE_OFFSETS_MS),
        "cases": cases,
    }
    (args.output_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"Generated {len(cases)} audio holdout cases in {args.output_dir}")


if __name__ == "__main__":
    main()
