# ruff: noqa: E501
"""Compare normalization settings on a real recording: speed and effect on measure output.

For each variant this runs the production normalize command, then the two providers that consume
the normalized video (context switches and visual clicks), and compares their output with the
baseline variant. The question it answers: does a faster or smaller normalized video change what
JAMS measures?

    uv run python scripts/normalize_compare.py path/to/recording.mp4 [--threads 2] [--json-out out.json]

Timings use ``-threads`` to approximate a small worker. Absolute numbers are machine-specific, so
read the ratios. Output comparisons are exact regardless of machine.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jams_worker import jem_eval
from jams_worker.ffmpeg import ffmpeg_path
from jams_worker.providers.clicks import detect_visual_clicks
from jams_worker.providers.context_switch import detect_context_switches
from jams_worker.providers.probe import build_normalize_args, probe_file
from jams_worker.providers.proxy_motion import ensure_proxy_motion

MATCH_TOLERANCE_MS = 500


@dataclass(frozen=True)
class Variant:
    name: str
    preset: str
    max_width: int | None


VARIANTS = (
    Variant("veryfast-native (baseline)", "veryfast", None),
    Variant("ultrafast-native", "ultrafast", None),
    Variant("veryfast-1920", "veryfast", 1920),
    Variant("ultrafast-1920", "ultrafast", 1920),
    Variant("ultrafast-1280", "ultrafast", 1280),
)


def match(reference: list[int], candidate: list[int]) -> dict[str, Any]:
    """Greedy one-to-one match within the tolerance; both lists sorted, in ms."""

    unmatched = list(candidate)
    shifts: list[int] = []
    tp = 0
    for ref in reference:
        best = min(unmatched, key=lambda c: abs(c - ref), default=None)
        if best is not None and abs(best - ref) <= MATCH_TOLERANCE_MS:
            unmatched.remove(best)
            shifts.append(best - ref)
            tp += 1
    fn = len(reference) - tp
    fp = len(candidate) - tp
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "reference": len(reference),
        "candidate": len(candidate),
        "matched": tp,
        "missed": fn,
        "extra": fp,
        "f1_vs_baseline": round(f1, 4),
        "max_shift_ms": max((abs(s) for s in shifts), default=0),
    }


def run_variant(source: Path, variant: Variant, threads: int) -> dict[str, Any]:
    metadata = probe_file(source)
    duration_s = max(0.001, metadata.duration_ms / 1000.0)
    with tempfile.TemporaryDirectory(prefix="jams-normcmp-") as tmp:
        workdir = Path(tmp)
        normalized = workdir / "normalized.mp4"
        command = build_normalize_args(
            ffmpeg_path(),
            source,
            normalized,
            metadata,
            duration_s=duration_s,
            preset=variant.preset,
            max_width=variant.max_width,
            threads=threads,
        )
        started = time.perf_counter()
        subprocess.run(command, check=True, capture_output=True)
        normalize_s = time.perf_counter() - started

        started = time.perf_counter()
        cuts = detect_context_switches(normalized, workdir)
        cuts_s = time.perf_counter() - started

        motion = ensure_proxy_motion(normalized, workdir, include_frames=True)
        clicks = detect_visual_clicks(
            motion, full_width=metadata.width, full_height=metadata.height
        )
        return {
            "variant": variant.name,
            "normalize_s": round(normalize_s, 1),
            "context_switch_s": round(cuts_s, 1),
            "normalized_mb": round(normalized.stat().st_size / 1048576, 1),
            "cut_times_ms": sorted(cut.t_start_ms for cut in cuts),
            "click_times_ms": sorted(click.t_start_ms for click in clicks),
        }


def jem_truth(session: Path, source: Path) -> dict[str, list[int]]:
    """Click and context-switch truth times, mapped onto the video timeline (ms)."""

    _, csv_path, manifest_path = jem_eval._session_paths(session)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    events = jem_eval._load_events(csv_path)
    with tempfile.TemporaryDirectory(prefix="jams-normcmp-sync-") as tmp:
        cfr = Path(tmp) / "sync.mp4"
        subprocess.run(
            [ffmpeg_path(), "-nostdin", "-v", "error", "-i", str(source), "-map", "0:v:0", "-an",
             "-vf", f"setpts=PTS-STARTPTS,fps={jem_eval.NORMALIZED_FPS},scale=1280:-2",
             "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
             "-fps_mode", "cfr", str(cfr)],
            check=True, capture_output=True,
        )
        flashes = jem_eval.detect_flash_runs(cfr, jem_eval.NORMALIZED_FPS)
    offsets = jem_eval._offsets(manifest, flashes)
    recorder = jem_eval._recorder_processes(events, manifest)

    def mapped(rows: list[dict[str, str]]) -> list[int]:
        return sorted(jem_eval.map_active_ms(int(r["t_start_ms"]), offsets) for r in rows)

    return {
        "clicks": mapped([r for r in events if r.get("kind") == "click"]),
        "cuts": mapped([
            r for r in events
            if r.get("kind") == "context_switch"
            and r.get("process", "").casefold() not in recorder
        ]),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recording", type=Path)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--session", type=Path,
                        help="JEM session .json/dir: also score each variant against its truth")
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--reuse", type=Path,
                        help="a previous --json-out file: skip the slow runs, re-score its output")
    args = parser.parse_args()

    if args.reuse:
        results = json.loads(args.reuse.read_text(encoding="utf-8"))
    else:
        results = [run_variant(args.recording, variant, args.threads) for variant in VARIANTS]
    baseline = results[0]
    base_normalize = baseline["normalize_s"]
    base_cuts = baseline["context_switch_s"]

    print(f"{'variant':30} {'norm s':>7} {'x':>6} {'cuts s':>7} {'x':>6} {'MB':>7}"
          f" | cuts vs base (match/miss/extra, shift)   | clicks vs base")
    for row in results:
        cuts = match(baseline["cut_times_ms"], row["cut_times_ms"])
        clicks = match(baseline["click_times_ms"], row["click_times_ms"])
        row["cuts_vs_baseline"] = cuts
        row["clicks_vs_baseline"] = clicks
        print(
            f"{row['variant']:30} {row['normalize_s']:7.1f} {base_normalize / row['normalize_s']:5.1f}x"
            f" {row['context_switch_s']:7.1f} {base_cuts / max(row['context_switch_s'], 0.01):5.1f}x"
            f" {row['normalized_mb']:7.1f} | "
            f"{cuts['matched']}/{cuts['reference']} miss {cuts['missed']} extra {cuts['extra']}"
            f" shift {cuts['max_shift_ms']}ms | "
            f"{clicks['matched']}/{clicks['reference']} miss {clicks['missed']}"
            f" extra {clicks['extra']} shift {clicks['max_shift_ms']}ms"
        )
    if args.session:
        truth = jem_truth(args.session, args.recording)
        print(f"\nagainst JEM truth ({len(truth['cuts'])} context switches,"
              f" {len(truth['clicks'])} clicks; +-{MATCH_TOLERANCE_MS} ms)")
        print(f"{'variant':30} | cuts: matched  missed  extra   F1 | clicks: matched  missed  extra   F1")
        for row in results:
            cuts = match(truth["cuts"], row["cut_times_ms"])
            clicks = match(truth["clicks"], row["click_times_ms"])
            row["cuts_vs_truth"] = cuts
            row["clicks_vs_truth"] = clicks
            print(f"{row['variant']:30} | {cuts['matched']:>12} {cuts['missed']:>7} {cuts['extra']:>6}"
                  f" {cuts['f1_vs_baseline']:>5.2f} | {clicks['matched']:>14} {clicks['missed']:>7}"
                  f" {clicks['extra']:>6} {clicks['f1_vs_baseline']:>5.2f}")
    if args.json_out:
        args.json_out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
