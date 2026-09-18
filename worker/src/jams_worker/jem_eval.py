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
import math
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

from jams_worker.errors import PipelineError
from jams_worker.ffmpeg import ffmpeg_path
from jams_worker.providers.context_switch import (
    CONTEXT_SWITCH_PROVIDER_VERSION,
    ContextSwitchParams,
    detect_context_switches,
    validated_context_switch_params,
)
from jams_worker.providers.probe import ProbeResult, probe_file

CSV_HEADER = (
    "kind,category,t_start_ms,t_end_ms,value_num,value_text,x,y,monitor,process,"
    "window_title,detail,key_category,confidence"
)
MAX_OFFSET_MS = 1500
MATCH_TOLERANCE_MS = 500
MAX_DRIFT_MS = 250
NORMALIZED_FPS = 30

# Frame rate for the visual-change profile. 10 fps resolves a transition well inside the 500 ms
# match tolerance while decoding a fraction of the frames.
VISUAL_DELTA_FPS = 10

# A truth event is reported as visually corroborated when the screen changed at least this much
# (mean per-pixel grey delta between adjacent frames) near it. Calibrated against measured sessions:
# genuine transitions produced 1.13 and 1.89, a foreground switch to an already-visible window
# produced 0.03, and a sync flash produces ~180. This threshold only STRATIFIES the report; the
# headline metric is still computed over every truth event, and each event's measured delta is
# emitted so the split can be audited or re-cut without re-running the evaluation.
VISUAL_CORROBORATION_DELTA = 0.30

# The flash takes the foreground, so the span it causes starts a few ms after the flash is logged
# (measured: flash at 512 ms, span start at 517 ms). Kept tight so a flash that merely precedes an
# unrelated span cannot misidentify that span's app as the recorder.
RECORDER_FLASH_TOLERANCE_MS = 250


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
    end = manifest.get("sync", {}).get("end_flash_log_ms")
    if not isinstance(end, int) or end <= logs[-1]:
        raise EvaluationError("ending sync flash is required to validate drift")
    # A bright webpage must not silently shift the ordinal flash pairing.
    if len(detected) != len(logs) + 1:
        raise EvaluationError(
            f"sync alignment ambiguous: expected {len(logs) + 1} flashes including end, "
            f"found {len(detected)}"
        )
    pairs = [(log_ms, detected[index].video_ms) for index, log_ms in enumerate(logs)]
    offsets = [(log_ms, video_ms - log_ms) for log_ms, video_ms in pairs]
    if any(abs(offset) > MAX_OFFSET_MS for _, offset in offsets):
        raise EvaluationError(f"sync alignment failed: offset exceeds ±{MAX_OFFSET_MS} ms")
    end_offset = detected[-1].video_ms - end
    drift = end_offset - offsets[-1][1]
    if abs(drift) > MAX_DRIFT_MS:
        raise EvaluationError(f"sync drift {drift} ms exceeds ±{MAX_DRIFT_MS} ms")
    if len(logs) > 1:
        raise EvaluationError(
            "paused sessions require per-segment ending anchors; not yet safe to score"
        )
    return offsets


def map_active_ms(active_ms: int, offsets: list[tuple[int, int]]) -> int:
    selected = offsets[0][1]
    for flash_log_ms, offset in offsets:
        if flash_log_ms > active_ms:
            break
        selected = offset
    return active_ms + selected


def _union_duration_ms(
    windows: Iterable[tuple[int, int]], *, padding_ms: int = 0
) -> int:
    """Return the duration of the merged windows, with optional match padding."""
    padded = sorted(
        (start - padding_ms, end + padding_ms)
        for start, end in windows
        if end >= start
    )
    if not padded:
        return 0

    merged_start, merged_end = padded[0]
    duration_ms = 0
    for start, end in padded[1:]:
        if start <= merged_end:
            merged_end = max(merged_end, end)
            continue
        duration_ms += merged_end - merged_start
        merged_start, merged_end = start, end
    return duration_ms + merged_end - merged_start


def _inclusive_percentile(values: list[int], percentile: float) -> float | None:
    """Return an inclusive, linearly interpolated percentile.

    The rank is ``(n - 1) * percentile`` (the same convention as NumPy's
    ``method='linear'``/``statistics.quantiles(..., method='inclusive')``),
    so p95 is reproducible for small offline evaluation samples.
    """
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    rank = (len(ordered) - 1) * percentile
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return float(ordered[lower])
    fraction = rank - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def _visual_delta_profile(video: Path, fps: int = VISUAL_DELTA_FPS) -> list[float]:
    """Mean per-pixel frame-to-frame delta of a downscaled grayscale decode.

    Used to record how much the screen actually changed at each truth event. JEM's context switches
    are foreground/title changes, which are a proxy for visual change and can diverge from it
    completely: a measured session logged a switch to an already-visible Outlook window whose peak
    delta was 0.03, against 1.13-1.89 for genuine transitions and ~180 for a sync flash. Scoring a
    video analyser as wrong for missing a 0.03 event measures the proxy, not the detector.
    """
    command = [
        ffmpeg_path(), "-v", "error", "-i", str(video),
        "-vf", f"fps={fps},scale=64:36,format=gray", "-f", "rawvideo", "-",
    ]
    try:
        completed = subprocess.run(command, capture_output=True, timeout=300, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EvaluationError(f"visual delta decode failed: {exc}") from exc
    if completed.returncode != 0:
        raise EvaluationError("visual delta decode failed")

    frame_bytes = 64 * 36
    raw = completed.stdout
    frames = [raw[i : i + frame_bytes] for i in range(0, len(raw) - frame_bytes + 1, frame_bytes)]
    deltas: list[float] = []
    for index in range(1, len(frames)):
        previous, current = frames[index - 1], frames[index]
        deltas.append(sum(abs(a - b) for a, b in zip(previous, current)) / frame_bytes)
    return deltas


def _peak_delta_near(
    profile: list[float],
    t_ms: int,
    *,
    window_ms: int = MATCH_TOLERANCE_MS,
    fps: int = VISUAL_DELTA_FPS,
) -> float:
    """Largest frame-to-frame delta within ``window_ms`` of ``t_ms``."""
    if not profile:
        return 0.0
    span = max(1, round(window_ms * fps / 1000))
    centre = round(t_ms * fps / 1000)
    low = max(0, centre - span)
    high = min(len(profile), centre + span + 1)
    if low >= high:
        return 0.0
    return max(profile[low:high])


def _recorder_processes(events: list[dict[str, str]], manifest: dict[str, Any]) -> set[str]:
    """Identify the recorder by which context span was foreground during a sync flash.

    Matching a hardcoded process name silently breaks the moment the recorder is renamed or driven
    headlessly: the flash spans stop being excluded and become truth events sitting on the single
    most detectable visual transition that exists, handing the detector free true positives.
    """
    flashes = _manifest_flashes(manifest)
    found: set[str] = set()
    for flash_ms in flashes:
        for row in events:
            if row.get("kind") != "context_switch":
                continue
            try:
                start = int(row["t_start_ms"])
                end = int(row["t_end_ms"])
            except (KeyError, TypeError, ValueError):
                continue
            # The flash takes the foreground, so the span it causes may start a few ms after it.
            if start - RECORDER_FLASH_TOLERANCE_MS <= flash_ms <= end:
                process = row.get("process", "").casefold()
                if process:
                    found.add(process)
    return found or {"jem.app.exe"}


def _point_match(
    expected: list[int],
    detected: list[int],
    *,
    exposure_ms: int | None = None,
) -> dict[str, Any]:
    # Ordered interval matching maximizes one-to-one matches. Nearest-first can
    # consume the only detection available for a later truth event.
    expected = sorted(expected)
    detected = sorted(detected)
    truth_index = detection_index = 0
    errors: list[int] = []
    while truth_index < len(expected) and detection_index < len(detected):
        delta = detected[detection_index] - expected[truth_index]
        if delta < -MATCH_TOLERANCE_MS:
            detection_index += 1
        elif delta > MATCH_TOLERANCE_MS:
            truth_index += 1
        else:
            errors.append(abs(delta))
            truth_index += 1
            detection_index += 1
    tp = len(errors)
    fp = len(detected) - tp
    fn = len(expected) - tp
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    count_accuracy = 1 - abs(len(detected) - len(expected)) / len(expected) if expected else 0.0
    p95_abs_error_ms = _inclusive_percentile(errors, 0.95)
    false_positives_per_minute = (
        fp / (exposure_ms / 60_000)
        if exposure_ms is not None and exposure_ms > 0
        else None
    )
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "expected_count": len(expected),
        "detected_count": len(detected),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "count_accuracy": round(max(0.0, count_accuracy), 4),
        "mean_abs_error_ms": round(sum(errors) / len(errors), 2) if errors else None,
        "p95_abs_error_ms": round(p95_abs_error_ms, 2) if p95_abs_error_ms is not None else None,
        "max_abs_error_ms": max(errors) if errors else None,
        "false_positives_per_minute": (
            round(false_positives_per_minute, 4)
            if false_positives_per_minute is not None
            else None
        ),
        "scored_exposure_ms": exposure_ms,
        "match_tolerance_ms": MATCH_TOLERANCE_MS,
    }


def evaluate_session(
    session: Path,
    *,
    detector_impl: str = "adaptive",
    params: ContextSwitchParams | None = None,
) -> dict[str, Any]:
    try:
        resolved_params = validated_context_switch_params(
            asdict(params) if params is not None else {}
        )
    except (PipelineError, TypeError, ValueError) as exc:
        raise EvaluationError(f"invalid context-switch parameters: {exc}") from exc

    video, csv_path, manifest_path = _session_paths(session)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    events = _load_events(csv_path)
    probe: ProbeResult = probe_file(video)
    # gdigrab output can be VFR despite manifest fps=30. Counting decoded frames
    # using avg_frame_rate shifts event times. Normalize before EVERY CV stage.
    with tempfile.TemporaryDirectory(prefix="jams-jem-eval-") as temporary:
        workdir = Path(temporary)
        normalized = workdir / "normalized.mp4"
        command = [
            ffmpeg_path(), "-nostdin", "-v", "error", "-i", str(video),
            "-map", "0:v:0", "-an", "-vf", f"setpts=PTS-STARTPTS,fps={NORMALIZED_FPS}",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-fps_mode", "cfr", str(normalized),
        ]
        try:
            completed = subprocess.run(command, capture_output=True, timeout=300, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise EvaluationError("CFR normalization failed") from exc
        if completed.returncode:
            raise EvaluationError("CFR normalization failed")
        detected_flashes = detect_flash_runs(normalized, NORMALIZED_FPS)
        offsets = _offsets(manifest, detected_flashes)
        detector_kwargs: dict[str, Any] = {"detector_impl": detector_impl}
        if params is not None:
            detector_kwargs["params"] = resolved_params
        cuts = detect_context_switches(normalized, workdir, **detector_kwargs)
        delta_profile = _visual_delta_profile(normalized)
    recorder_processes = _recorder_processes(events, manifest)
    workload = [
        row for row in events
        if row.get("kind") == "context_switch"
        and row.get("process", "").casefold() not in recorder_processes
    ]
    if not workload:
        raise EvaluationError(
            "no customer-app context spans; recorder-only session cannot be scored"
        )
    truth = [
        map_active_ms(int(row["t_start_ms"]), offsets)
        for row in workload
    ]
    windows = [
        (map_active_ms(int(row["t_start_ms"]), offsets),
         map_active_ms(int(row["t_end_ms"]), offsets)) for row in workload
    ]
    if any(end < start for start, end in windows):
        raise EvaluationError("customer-app context span ends before it starts")
    scored_windows = [
        (
            max(0, start - MATCH_TOLERANCE_MS),
            min(probe.duration_ms, end),
        )
        for start, end in windows
    ]
    detected = [
        cut.t_start_ms for cut in cuts
        if any(start <= cut.t_start_ms <= end for start, end in scored_windows)
    ]
    exposure_ms = _union_duration_ms(scored_windows)
    truth_details = [
        (t_ms, _peak_delta_near(delta_profile, t_ms), row)
        for t_ms, row in zip(truth, workload)
    ]
    corroborated_truth = [
        t_ms for t_ms, delta, _ in truth_details if delta >= VISUAL_CORROBORATION_DELTA
    ]
    proxy_only_truth = [
        t_ms for t_ms, delta, _ in truth_details if delta < VISUAL_CORROBORATION_DELTA
    ]
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
            "normalized_fps": NORMALIZED_FPS,
            "end_drift_ms": detected_flashes[-1].video_ms
            - manifest["sync"]["end_flash_log_ms"] - offsets[-1][1],
            "flash_count": len(offsets),
            "detected_flash_count": len(detected_flashes),
            "offsets_ms": [
                {"active_flash_ms": log, "offset_ms": offset} for log, offset in offsets
            ],
        },
        "providers": {
            "context_switch": {
                "provider": "context_switch",
                "detector_impl": detector_impl,
                "provider_version": CONTEXT_SWITCH_PROVIDER_VERSION,
                "params": asdict(resolved_params),
            }
        },
        "metrics": {
            # Unchanged definition, so this stays directly comparable to every earlier baseline.
            "context_switch": _point_match(
                truth,
                detected,
                exposure_ms=exposure_ms,
            ),
            # Same detections, truth split by whether the screen actually changed. Reported
            # alongside rather than replacing: a foreground switch with no visual delta is a
            # limitation of the proxy label, not evidence about the detector.
            "context_switch_visually_corroborated": _point_match(
                corroborated_truth,
                detected,
                exposure_ms=exposure_ms,
            ),
            "context_switch_proxy_only": _point_match(
                proxy_only_truth,
                detected,
                exposure_ms=exposure_ms,
            ),
        },
        "visual_corroboration": {
            "delta_threshold": VISUAL_CORROBORATION_DELTA,
            "delta_fps": VISUAL_DELTA_FPS,
            "window_ms": MATCH_TOLERANCE_MS,
            "corroborated_count": len(corroborated_truth),
            "proxy_only_count": len(proxy_only_truth),
            "recorder_processes": sorted(recorder_processes),
            "events": [
                {
                    "t_ms": t_ms,
                    "peak_delta": round(delta, 3),
                    "corroborated": delta >= VISUAL_CORROBORATION_DELTA,
                    "process": row.get("process", ""),
                    "context": (row.get("value_text") or "")[:80],
                }
                for t_ms, delta, row in truth_details
            ],
        },
        "expected_context_ms": truth,
        "detected_context_ms": detected,
        "limitations": [
            "Local CV provider evaluation only; no upload, database, or report UI exercised.",
            "Foreground/title changes are a proxy for visual task changes, not human cognition.",
            "Recorder-only spans and detections outside customer-app spans are excluded.",
            "Automated action timing is not representative of human task effort.",
        ],
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
    lines.extend(["## Interpretation", "", *[f"- {item}" for item in result["limitations"]], ""])
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate a JEM session with local JAMS CV providers"
    )
    parser.add_argument("session", type=Path, help="JEM session directory or .json manifest")
    parser.add_argument("--detector", choices=("adaptive", "dhash"), default="adaptive")
    parser.add_argument(
        "--min-content-val",
        type=float,
        help="Evaluate an explicit adaptive content floor; does not change production defaults",
    )
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--markdown-out", type=Path)
    args = parser.parse_args(argv)
    params = None
    if args.min_content_val is not None:
        if not math.isfinite(args.min_content_val):
            parser.error("--min-content-val must be finite")
        try:
            params = validated_context_switch_params({"min_content_val": args.min_content_val})
        except PipelineError as exc:
            parser.error(str(exc))
    try:
        result = evaluate_session(args.session, detector_impl=args.detector, params=params)
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
