"""Export audio proposal precision and features without changing detector gates.

Run against generated fixtures; no transcription or model calls are made.
These are raw audio proposals, not visually verified click-provider measures.
"""

from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

from jams_worker.providers.audio_onsets import (
    FEATURE_NAMES,
    AudioOnset,
    SpeechRegion,
    ensure_audio_onsets,
)


def match_indices(actual: list[int], expected: list[int], tolerance_ms: int) -> set[int]:
    """Match once per expected event, using the golden harness nearest-first rule."""
    remaining = sorted(enumerate(actual), key=lambda item: item[1])
    matched: set[int] = set()
    for target in sorted(expected):
        candidates = [
            (abs(time - target), position, index)
            for position, (index, time) in enumerate(remaining)
            if abs(time - target) <= tolerance_ms
        ]
        if candidates:
            _, position, index = min(candidates)
            matched.add(index)
            remaining.pop(position)
    return matched


def summarize(onsets: list[AudioOnset], expected: list[int], tolerance_ms: int) -> dict:
    matched = match_indices([onset.t_ms for onset in onsets], expected, tolerance_ms)
    tp = len(matched)
    features = {}
    for name, indices in (
        ("matched", sorted(matched)),
        ("unmatched", [index for index in range(len(onsets)) if index not in matched]),
    ):
        features[name] = {
            feature: statistics.median(onsets[index].feats[column] for index in indices)
            for column, feature in enumerate(FEATURE_NAMES)
        } if indices else {}
    return {
        "true_positives": tp,
        "false_positives": len(onsets) - tp,
        "false_negatives": len(expected) - tp,
        "precision": tp / len(onsets) if onsets else None,
        "recall": tp / len(expected) if expected else None,
        "feature_medians": features,
        "proposals": [
            {
                "t_ms": onset.t_ms,
                "matched": index in matched,
                "label": onset.label,
                "flux_peak": onset.flux_peak,
                "threshold": onset.threshold,
                "features": dict(zip(FEATURE_NAMES, onset.feats, strict=True)),
            }
            for index, onset in enumerate(onsets)
        ],
    }


def diagnose(fixture_dir: Path, workdir: Path) -> dict:
    registry = json.loads((fixture_dir / "registry.json").read_text(encoding="utf-8"))
    tolerances = json.loads(
        (Path(__file__).parents[1] / "tests/fixtures/tolerances.json").read_text(encoding="utf-8")
    )["audio"]
    results = {}
    required = {
        "narrated_clicks", "click_transients", "pure_speech_negative",
        "silence", "tones", "music_bed_negative",
    }
    missing = required - {entry["id"] for entry in registry["generated"]}
    if missing:
        raise ValueError(f"Fixture registry missing required controls: {sorted(missing)}")
    for entry in registry["generated"]:
        fixture_id = entry["id"]
        if fixture_id not in required:
            continue
        if entry.get("tts_pending"):
            results[fixture_id] = {"status": "skipped", "reason": "espeak-ng unavailable"}
            continue
        if fixture_id in {"narrated_clicks", "click_transients"} and not entry.get("offsets_jsonl"):
            raise ValueError(f"{fixture_id}: missing click ground truth")
        expected = [
            json.loads(line)["t_ms"]
            for line in (fixture_dir / entry["offsets_jsonl"]).read_text().splitlines()
            if line.strip()
        ] if entry.get("offsets_jsonl") else []
        if fixture_id in {"narrated_clicks", "click_transients"} and (
            not expected or len(expected) != entry["event_count"]
        ):
            raise ValueError(f"{fixture_id}: empty or incomplete click ground truth")
        speech = (
            (SpeechRegion(0, int(entry["duration_ms"])),)
            if fixture_id in {"narrated_clicks", "pure_speech_negative"} else ()
        )
        artifact = ensure_audio_onsets(
            fixture_dir / entry["file"], workdir / fixture_id, speech_regions=speech,
        )
        proposals = [
            onset for onset in artifact.onsets if onset.label in {"click_candidate", "ambiguous"}
        ]
        result = summarize(proposals, expected, int(tolerances["click_tolerance_ms"]))
        result.update(status="evaluated", builder_version=artifact.builder_version)
        if fixture_id == "narrated_clicks":
            result["gate_passed"] = (
                (result["precision"] or 0) >= tolerances["in_speech_click_precision"]
                and (result["recall"] or 0) >= tolerances["in_speech_click_recall"]
            )
        results[fixture_id] = result
    return {"scope": "raw_audio_proposals_before_visual_verification", "gates": tolerances,
            "fixtures": results}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = diagnose(args.fixture_dir, args.output.parent / "audio-onset-artifacts")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    for name, result in report["fixtures"].items():
        print(name, {key: value for key, value in result.items()
                     if key not in {"proposals", "feature_medians"}})


if __name__ == "__main__":
    main()
