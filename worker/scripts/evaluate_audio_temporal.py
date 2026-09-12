"""Evaluate fixed temporal contrast filters on held-out audio proposals.

Exploratory only: this script does not change production detector parameters or
acceptance gates. It computes one 4--8 kHz power envelope per WAV and reuses it
for the fixed contrast ratios requested by the experiment.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from diagnose_audio_onsets import summarize

from jams_worker.providers.audio_onsets import (
    AudioOnset,
    SpeechRegion,
    _read_wav_mono,
    _stft,
    ensure_audio_onsets,
)
from jams_worker.providers.physical_effort_params import AudioOnsetParams

TEMPORAL_RATIOS = (2.0, 4.0, 8.0)
TOLERANCE_MS = json.loads(
    (Path(__file__).parents[1] / "tests/fixtures/tolerances.json").read_text(encoding="utf-8")
)["audio"]["click_tolerance_ms"]


def _power_envelope(path: Path, params: AudioOnsetParams) -> list[float]:
    samples = _read_wav_mono(path, params)
    spectra, freqs = _stft(samples, params)
    band = (freqs >= 4_000) & (freqs <= 8_000)
    return [float((spectrum[band] ** 2).sum()) for spectrum in spectra]


def _contrast(envelope: list[float], t_ms: int, params: AudioOnsetParams) -> float:
    frame = round(t_ms * params.sample_rate_hz / (1_000 * params.stft_hop_samples))
    if not envelope or frame < 0 or frame >= len(envelope):
        return 0.0
    local = envelope[max(0, frame - 1) : min(len(envelope), frame + 4)]
    left = envelope[max(0, frame - 8) : max(0, frame - 3)]
    right = envelope[min(len(envelope), frame + 5) : min(len(envelope), frame + 10)]
    if not local or not left and not right:
        return 0.0
    shoulder_values = []
    if left:
        shoulder_values.append(sum(left) / len(left))
    if right:
        shoulder_values.append(sum(right) / len(right))
    shoulder = max(shoulder_values, default=0.0)
    return max(local) / max(shoulder, 1e-9)


def _matched_pairs(onsets: list[AudioOnset], expected: list[int]) -> list[tuple[int, int]]:
    remaining = sorted(enumerate(onsets), key=lambda item: item[1].t_ms)
    pairs: list[tuple[int, int]] = []
    for target in sorted(expected):
        candidates = [
            (abs(onset.t_ms - target), position, index)
            for position, (index, onset) in enumerate(remaining)
            if abs(onset.t_ms - target) <= TOLERANCE_MS
        ]
        if candidates:
            _, position, index = min(candidates)
            pairs.append((index, target))
            remaining.pop(position)
    return pairs


def _row(
    *,
    case_id: str,
    signal: str,
    variant: str,
    onsets: list[AudioOnset],
    expected: list[int],
    contrasts: dict[int, float],
) -> dict[str, Any]:
    summary = summarize(onsets, expected, TOLERANCE_MS)
    pairs = _matched_pairs(onsets, expected)
    errors = [onsets[index].t_ms - target for index, target in pairs]
    summary.pop("proposals", None)
    summary.pop("feature_medians", None)
    summary.update(
        {
            "case_id": case_id,
            "signal": signal,
            "variant": variant,
            "matched_timing_errors_ms": errors,
            "mean_abs_matched_timing_error_ms": (
                sum(abs(error) for error in errors) / len(errors) if errors else None
            ),
            "proposal_contrasts": [
                {"t_ms": onset.t_ms, "contrast": contrasts[index]}
                for index, onset in enumerate(onsets)
            ],
        }
    )
    return summary


def evaluate(fixture_dir: Path, output: Path) -> dict[str, Any]:
    manifest_bytes = (fixture_dir / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    if not manifest.get("cases"):
        raise ValueError("No held-out cases to evaluate")
    params = AudioOnsetParams()
    artifact_dir = output.parent / "audio-onset-temporal-artifacts"
    rows: list[dict[str, Any]] = []
    for case in manifest["cases"]:
        for signal in ("narrated_clicks_file", "pure_speech_file"):
            expected = case["click_offsets_ms"] if signal == "narrated_clicks_file" else []
            if signal == "narrated_clicks_file" and not expected:
                raise ValueError(f"{case['case_id']}: missing positive ground truth")
            audio_path = fixture_dir / case[signal]
            artifact = ensure_audio_onsets(
                audio_path,
                artifact_dir / case["case_id"] / signal,
                speech_regions=(SpeechRegion(0, case["duration_ms"]),),
                params=params,
            )
            proposals = [
                onset
                for onset in artifact.onsets
                if onset.label in {"click_candidate", "ambiguous"}
            ]
            envelope = _power_envelope(audio_path, params)
            contrasts = {
                index: _contrast(envelope, onset.t_ms, params)
                for index, onset in enumerate(proposals)
            }
            rows.append(
                _row(
                    case_id=case["case_id"],
                    signal=signal,
                    variant="baseline",
                    onsets=proposals,
                    expected=expected,
                    contrasts=contrasts,
                )
            )
            for ratio in TEMPORAL_RATIOS:
                filtered = [
                    onset
                    for index, onset in enumerate(proposals)
                    if contrasts[index] >= ratio
                ]
                rows.append(
                    _row(
                        case_id=case["case_id"],
                        signal=signal,
                        variant=f"temporal_contrast_{ratio:g}",
                        onsets=filtered,
                        expected=expected,
                        contrasts={
                            index: _contrast(envelope, onset.t_ms, params)
                            for index, onset in enumerate(filtered)
                        },
                    )
                )
    return {
        "scope": "exploratory_raw_audio_temporal_filter",
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "parameters": {
            "sample_rate_hz": params.sample_rate_hz,
            "stft_window_samples": params.stft_window_samples,
            "stft_hop_samples": params.stft_hop_samples,
            "band_hz": [4_000, 8_000],
            "local_peak_frames": [-1, 4],
            "window_convention": "half-open [start, stop), relative to proposal frame",
            "shoulder_frames": [[-8, -3], [5, 10]],
            "ratios": list(TEMPORAL_RATIOS),
            "match_tolerance_ms": TOLERANCE_MS,
            "speech_region": "0..duration_ms",
        },
        "rows": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = evaluate(args.fixture_dir, args.output)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    variants = ("baseline", "temporal_contrast_2", "temporal_contrast_4", "temporal_contrast_8")
    for variant in variants:
        positive = [
            row
            for row in report["rows"]
            if row["variant"] == variant and row["signal"] == "narrated_clicks_file"
        ]
        print(
            variant,
            {
                key: sum(row[key] for row in positive)
                for key in ("true_positives", "false_positives", "false_negatives")
            },
        )


if __name__ == "__main__":
    main()
