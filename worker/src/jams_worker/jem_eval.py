"""Bounded, offline evaluation of a JEM recording against JAMS CV output.

This module intentionally does not construct a ``PipelineContext``: the worker
pipeline is DB/blob backed.  JEM evaluation is a local, read-only harness for
real media and emits only measures that have both a JEM truth kind and a local
JAMS provider.
"""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jams_worker.ffmpeg import ffmpeg_path
from jams_worker.providers.context_switch import detect_context_switches
from jams_worker.providers.probe import ProbeResult, probe_file

CSV_HEADER = (
    "kind,category,t_start_ms,t_end_ms,value_num,value_text,x,y,monitor,process,"
    "window_title,detail,key_category,confidence"
)
MAX_OFFSET_MS = 1500
MATCH_TOLERANCE_MS = 500


class EvaluationError(ValueError):
    """A malformed or unsafe-to-score JEM session."""


@dataclass(frozen=True, slots=True)
class Flash:
    video_ms: int
    frame_count: int


def _session_paths(session: Path) -> tuple[Path, Path, Path]:
    session = session.resolve()
    if session.is_dir():
        manifests = sorted(session.glob("*.json"))
        if len(manifests) != 1:
            raise EvaluationError("session directory must contain exactly one .json manifest")
        manifest = manifests[0]
    elif session.suffix.lower() == ".json":
        manifest = session
    else:
        raise EvaluationError("session must be a JEM session directory or .json manifest")

    data = json.loads(manifest.read_text(encoding="utf-8"))
    video_block = data.get("video")
    if not isinstance(video_block, dict) or not video_block.get("file"):
        raise EvaluationError("manifest video is missing; metrics-only JEM sessions are rejected")
    video = (manifest.parent / str(video_block["file"])).resolve()
    csv_path = manifest.with_suffix(".csv")
    if not video.is_file():
        raise EvaluationError(f"video file does not exist: {video}")
    if not csv_path.is_file():
        raise EvaluationError(f"events CSV does not exist: {csv_path}")
    return video, csv_path, manifest


def _load_events(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None or ",".join(reader.fieldnames) != CSV_HEADER:
            raise EvaluationError("events CSV header does not match the JEM contract")
        rows = list(reader)
    for row in rows:
        try:
            int(row["t_start_ms"])
        except (KeyError, TypeError, ValueError) as exc:
            raise EvaluationError("events CSV contains an invalid t_start_ms") from exc
    return rows


def _manifest_flashes(manifest: dict[str, Any]) -> list[int]:
    sync = manifest.get("sync")
    flashes = sync.get("flashes") if isinstance(sync, dict) else None
    if not isinstance(flashes, list) or not flashes:
        raise EvaluationError("manifest sync.flashes is missing or empty")
    result: list[int] = []
    for item in flashes:
        if not isinstance(item, dict) or not isinstance(item.get("flash_log_ms"), int):
            raise EvaluationError("manifest contains an invalid sync flash")
        result.append(int(item["flash_log_ms"]))
    if result != sorted(result) or len(set(result)) != len(result):
        raise EvaluationError("manifest sync flashes must be ordered by active time")
    return result


def detect_flash_runs(video: Path, fps: float) -> list[Flash]:
    """Decode tiny grayscale frames and find the §12 bright-frame runs."""
    if not fps or fps <= 0:
        raise EvaluationError("video FPS is unavailable; cannot validate synchronization")
    command = [
        ffmpeg_path(),
        "-v",
        "error",
        "-i",
        str(video),
        "-vf",
        "scale=64:36,format=gray",
        "-f",
        "rawvideo",
        "-",
    ]
    try:
        completed = subprocess.run(command, capture_output=True, timeout=120, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EvaluationError(f"flash detection failed: {exc}") from exc
    if completed.returncode != 0:
        raise EvaluationError("flash detection ffmpeg command failed")
    frame_bytes = 64 * 36
    if len(completed.stdout) % frame_bytes:
        raise EvaluationError("flash detector received a partial video frame")
    flashes: list[Flash] = []
    run_start = -1
    run_length = 0
    for index in range(0, len(completed.stdout), frame_bytes):
        frame = completed.stdout[index : index + frame_bytes]
        bright = sum(frame) / frame_bytes > 245
        if bright:
            run_start = index // frame_bytes if run_length == 0 else run_start
            run_length += 1
        elif run_length >= 2:
            flashes.append(Flash(round(run_start * 1000 / fps), run_length))
            run_start, run_length = -1, 0
        else:
            run_start, run_length = -1, 0
    if run_length >= 2:
        flashes.append(Flash(round(run_start * 1000 / fps), run_length))
    return flashes


def _offsets(manifest: dict[str, Any], detected: list[Flash]) -> list[tuple[int, int]]:
    logs = _manifest_flashes(manifest)
    if len(detected) < len(logs):
        raise EvaluationError(
            f"sync alignment failed: expected {len(logs)} flash(es), found {len(detected)}"
        )
    pairs = [(log_ms, detected[index].video_ms) for index, log_ms in enumerate(logs)]
    offsets = [(log_ms, video_ms - log_ms) for log_ms, video_ms in pairs]
    if any(abs(offset) > MAX_OFFSET_MS for _, offset in offsets):
        raise EvaluationError(f"sync alignment failed: offset exceeds ±{MAX_OFFSET_MS} ms")
    return offsets


def map_active_ms(active_ms: int, offsets: list[tuple[int, int]]) -> int:
    selected = offsets[0][1]
    for flash_log_ms, offset in offsets:
        if flash_log_ms > active_ms:
            break
        selected = offset
    return active_ms + selected


def _point_match(expected: list[int], detected: list[int]) -> dict[str, Any]:
    remaining = set(range(len(detected)))
    tp = 0
    errors: list[int] = []
    for expected_ms in expected:
        candidates = [
            (abs(detected[index] - expected_ms), index)
            for index in remaining
            if abs(detected[index] - expected_ms) <= MATCH_TOLERANCE_MS
        ]
        if candidates:
            error, index = min(candidates)
            remaining.remove(index)
            tp += 1
            errors.append(error)
    fp = len(remaining)
    fn = len(expected) - tp
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    count_accuracy = 1 - abs(len(detected) - len(expected)) / len(expected) if expected else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "count_accuracy": round(max(0.0, count_accuracy), 4),
        "mean_abs_error_ms": round(sum(errors) / len(errors), 2) if errors else None,
        "match_tolerance_ms": MATCH_TOLERANCE_MS,
    }


def evaluate_session(session: Path, *, detector_impl: str = "adaptive") -> dict[str, Any]:
    video, csv_path, manifest_path = _session_paths(session)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    events = _load_events(csv_path)
    probe: ProbeResult = probe_file(video)
    detected_flashes = detect_flash_runs(video, probe.fps or 0.0)
    offsets = _offsets(manifest, detected_flashes)
    workdir = manifest_path.parent / ".jams-eval-work"
    cuts = detect_context_switches(video, workdir, detector_impl=detector_impl)  # real CV provider
    truth = [
        map_active_ms(int(row["t_start_ms"]), offsets)
        for row in events
        if row.get("kind") == "context_switch"
    ]
    detected = [cut.t_start_ms for cut in cuts]
    return {
        "status": "succeeded",
        "session": str(manifest_path),
        "video": str(video),
        "probe": {
            "duration_ms": probe.duration_ms,
            "fps": probe.fps,
            "width": probe.width,
            "height": probe.height,
        },
        "alignment": {
            "validated": True,
            "flash_count": len(offsets),
            "detected_flash_count": len(detected_flashes),
            "offsets_ms": [
                {"active_flash_ms": log, "offset_ms": offset} for log, offset in offsets
            ],
        },
        "providers": {
            "context_switch": {"provider": "context_switch", "detector_impl": detector_impl}
        },
        "metrics": {"context_switch": _point_match(truth, detected)},
        "excluded_kinds": ["click", "keypress", "scroll", "sentiment", "utterance", "spoken_word"],
    }


def markdown_report(result: dict[str, Any]) -> str:
    metric = result["metrics"].get("context_switch")
    lines = [
        "# JEM → JAMS local evaluation",
        "",
        f"- Status: `{result['status']}`",
        f"- Session: `{result['session']}`",
        "- Synchronization: validated",
        "",
        "## Available provider metrics",
        "",
        "| Kind | TP | FP | FN | Precision | Recall | F1 |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    lines.append(
        f"| context_switch | {metric['tp']} | {metric['fp']} | {metric['fn']} | "
        f"{metric['precision']:.4f} | {metric['recall']:.4f} | {metric['f1']:.4f} |"
    )
    lines.extend(
        [
            "",
            "Excluded from this context-switch-only evaluation: "
            "click, keypress, scroll, sentiment, utterance, spoken_word.",
            "",
        ]
    )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate a JEM session with local JAMS CV providers"
    )
    parser.add_argument("session", type=Path, help="JEM session directory or .json manifest")
    parser.add_argument("--detector", choices=("adaptive", "dhash"), default="adaptive")
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--markdown-out", type=Path)
    args = parser.parse_args(argv)
    try:
        result = evaluate_session(args.session, detector_impl=args.detector)
    except EvaluationError as exc:
        parser.error(str(exc))
    payload = json.dumps(result, indent=2) + "\n"
    if args.json_out:
        args.json_out.write_text(payload, encoding="utf-8")
    else:
        print(payload, end="")
    if args.markdown_out:
        args.markdown_out.write_text(markdown_report(result), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
