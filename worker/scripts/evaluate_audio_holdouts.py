"""Compare fixed exploratory filters; never modify production or acceptance gates."""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import replace
from pathlib import Path

from diagnose_audio_onsets import summarize

from jams_worker.providers.audio_onsets import SpeechRegion, ensure_audio_onsets
from jams_worker.providers.physical_effort_params import AudioOnsetParams


def evaluate(fixture_dir: Path) -> dict:
    manifest_bytes = (fixture_dir / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    if not manifest["cases"]:
        raise ValueError("No held-out cases to evaluate")
    gates = json.loads(
        (Path(__file__).parents[1] / "tests/fixtures/tolerances.json").read_text(encoding="utf-8")
    )["audio"]
    rows = []
    for case in manifest["cases"]:
        for variant in ("baseline", "threshold_3_2", "flatness_0_6_crest_4"):
            params = AudioOnsetParams()
            if variant == "threshold_3_2":
                params = replace(params, in_speech_threshold_multiplier=3.2)
            for signal in ("narrated_clicks_file", "pure_speech_file"):
                expected = case["click_offsets_ms"] if signal == "narrated_clicks_file" else []
                if signal == "narrated_clicks_file" and not expected:
                    raise ValueError(f"{case['case_id']}: missing positive ground truth")
                artifact = ensure_audio_onsets(
                    fixture_dir / case[signal], fixture_dir / "evaluation-artifacts",
                    speech_regions=(SpeechRegion(0, case["duration_ms"]),), params=params,
                )
                proposals = [onset for onset in artifact.onsets
                             if onset.label in {"click_candidate", "ambiguous"}]
                if variant == "flatness_0_6_crest_4":
                    proposals = [onset for onset in proposals
                                 if onset.feats[8] >= 0.6 and onset.feats[11] >= 4]
                result = summarize(proposals, expected, gates["click_tolerance_ms"])
                result.pop("proposals")
                result.pop("feature_medians")
                result.update(case_id=case["case_id"], variant=variant, signal=signal)
                rows.append(result)
    return {"scope": "exploratory_raw_audio_proposals",
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "acceptance_gates": gates, "rows": rows}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    report = evaluate(args.fixture_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    for variant in ("baseline", "threshold_3_2", "flatness_0_6_crest_4"):
        positive = [row for row in report["rows"]
                    if row["variant"] == variant and row["signal"] == "narrated_clicks_file"]
        tp = sum(row["true_positives"] for row in positive)
        fp = sum(row["false_positives"] for row in positive)
        fn = sum(row["false_negatives"] for row in positive)
        negative_fp = sum(row["false_positives"] for row in report["rows"]
                          if row["variant"] == variant and row["signal"] == "pure_speech_file")
        print(f"{variant}: TP={tp} FP={fp} FN={fn}; pure-speech proposals={negative_fp}")


if __name__ == "__main__":
    main()
