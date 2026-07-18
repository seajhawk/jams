"""Self-consistency tests for generated golden media fixtures."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import golden as g
import make_fixtures as mf
import pytest

from jams_worker.ffmpeg import ffmpeg_path
from jams_worker.providers.audio_onsets import SpeechRegion, ensure_audio_onsets
from jams_worker.providers.clicks import detect_audio_clicks, detect_visual_clicks
from jams_worker.providers.keypresses import detect_keypress_bursts
from jams_worker.providers.proxy_motion import ensure_proxy_motion
from jams_worker.providers.scrolls import detect_scrolls

DURATION_TOL_MS = 400
FRAME_DIFF_CUT_THRESHOLD = 40.0
CV_GENERATOR = Path(__file__).resolve().parents[1] / "scripts" / "make_cv_fixtures"


@pytest.fixture(scope="session")
def fxt(tmp_path_factory: pytest.TempPathFactory) -> tuple[dict[str, Any], Path]:
    out = tmp_path_factory.mktemp("fxt_run1")
    reg = mf.generate_all(out)
    return reg, out


def _generated(reg: dict[str, Any]) -> list[dict[str, Any]]:
    return list(reg["generated"])


def _entry(reg: dict[str, Any], fixture_id: str) -> dict[str, Any]:
    for item in _generated(reg):
        if item["id"] == fixture_id:
            return item
    raise KeyError(fixture_id)


def _run_cv_generator(out: Path) -> dict[str, Any]:
    pnpm = shutil.which("pnpm")
    if pnpm is None:
        pytest.skip("pnpm not available for Playwright CV fixture generation")
    if not (CV_GENERATOR / "node_modules" / "playwright").exists():
        pytest.skip("run pnpm install in worker/scripts/make_cv_fixtures")

    result = subprocess.run(
        [
            pnpm,
            "fixtures",
            "--output-dir",
            str(out),
            "--ffmpeg",
            ffmpeg_path(),
        ],
        cwd=CV_GENERATOR,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    if result.returncode != 0:
        pytest.skip(f"Playwright/Chromium unavailable: {result.stderr[-400:]}")
    return json.loads((out / "cv_registry.json").read_text())


def _match_times(
    actual_ms: list[int],
    expected_ms: list[int],
    tolerance_ms: int,
) -> tuple[int, int, int]:
    pool = sorted(actual_ms)
    tp = 0
    for expected in sorted(expected_ms):
        candidates = [
            (abs(actual - expected), index)
            for index, actual in enumerate(pool)
            if abs(actual - expected) <= tolerance_ms
        ]
        if not candidates:
            continue
        _delta, index = min(candidates)
        pool.pop(index)
        tp += 1
    return tp, len(pool), len(expected_ms) - tp


def _precision_recall(tp: int, fp: int, fn: int) -> tuple[float, float]:
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    return precision, recall


def _expected_bursts(offsets: list[int], split_ms: int = 800) -> list[list[int]]:
    bursts: list[list[int]] = []
    for offset in offsets:
        if not bursts or offset - bursts[-1][-1] >= split_ms:
            bursts.append([offset])
        else:
            bursts[-1].append(offset)
    return bursts


def test_all_generated_gt_jsons_present(fxt: tuple[dict[str, Any], Path]) -> None:
    reg, out_dir = fxt

    for entry in _generated(reg):
        if entry["tts_pending"]:
            continue
        assert (out_dir / f"{entry['id']}.gt.json").exists()


def test_duration_matches_gt(fxt: tuple[dict[str, Any], Path]) -> None:
    reg, out_dir = fxt

    for entry in _generated(reg):
        if entry["tts_pending"]:
            continue
        path = out_dir / entry["file"]
        duration_ms = g.ffprobe_duration_ms(path)
        assert abs(duration_ms - entry["duration_ms"]) <= DURATION_TOL_MS, entry["id"]


def test_audio_offset_lists_parse(fxt: tuple[dict[str, Any], Path]) -> None:
    reg, out_dir = fxt

    entries = [entry for entry in _generated(reg) if entry.get("offsets_jsonl")]
    assert entries
    for entry in entries:
        if entry["tts_pending"]:
            continue
        offsets = g.parse_offsets_jsonl(out_dir / entry["offsets_jsonl"])
        assert len(offsets) == entry["event_count"]


def test_narrated_transient_mix_ratio_is_pinned(fxt: tuple[dict[str, Any], Path]) -> None:
    reg, _out_dir = fxt
    pinned = g.load_tolerances()["audio"]["transient_to_speech_db"]

    for fixture_id in ("narrated_clicks", "narrated_keypresses"):
        entry = _entry(reg, fixture_id)
        if entry["tts_pending"]:
            pytest.skip("espeak-ng not available")
        assert entry["transient_to_speech_db"] == pinned


def test_audio_click_provider_matches_clean_transients(
    fxt: tuple[dict[str, Any], Path],
    tmp_path: Path,
) -> None:
    reg, out_dir = fxt
    tolerances = g.load_tolerances()["audio"]
    entry = _entry(reg, "click_transients")
    expected = g.parse_offsets_jsonl(out_dir / entry["offsets_jsonl"])
    artifact = ensure_audio_onsets(out_dir / entry["file"], tmp_path / "audio-clicks")
    events = detect_audio_clicks(artifact)

    assert len(events) == len(expected)
    actual = [event.t_start_ms for event in events]
    for actual_ms, expected_ms in zip(actual, expected, strict=True):
        assert abs(actual_ms - expected_ms) <= int(tolerances["click_tolerance_ms"])
    assert all(event.confidence >= 0.70 for event in events)


def test_keypress_provider_matches_clean_bursts(
    fxt: tuple[dict[str, Any], Path],
    tmp_path: Path,
) -> None:
    reg, out_dir = fxt
    entry = _entry(reg, "keypress_transients")
    offsets = g.parse_offsets_jsonl(out_dir / entry["offsets_jsonl"])
    expected = _expected_bursts(offsets)
    artifact = ensure_audio_onsets(out_dir / entry["file"], tmp_path / "keys")
    bursts = detect_keypress_bursts(artifact)

    assert [burst.count for burst in bursts] == [len(group) for group in expected]
    for burst, expected_group in zip(bursts, expected, strict=True):
        assert abs(burst.t_start_ms - (expected_group[0] - 30)) <= 150
        assert abs(burst.t_end_ms - (expected_group[-1] + 80)) <= 150
        assert burst.confidence >= 0.65


def test_audio_negatives_emit_zero_clicks_and_keypresses(
    fxt: tuple[dict[str, Any], Path],
    tmp_path: Path,
) -> None:
    reg, out_dir = fxt
    for fixture_id in ("silence", "tones", "music_bed_negative", "pure_speech_negative"):
        entry = _entry(reg, fixture_id)
        if entry["tts_pending"]:
            continue
        speech_regions = (
            (SpeechRegion(0, int(entry["duration_ms"])),)
            if fixture_id == "pure_speech_negative"
            else ()
        )
        artifact = ensure_audio_onsets(
            out_dir / entry["file"],
            tmp_path / f"negative-{fixture_id}",
            speech_regions=speech_regions,
        )
        assert detect_audio_clicks(artifact) == []
        assert detect_keypress_bursts(artifact) == []


def test_in_speech_click_onsets_hit_pinned_recall_gate(
    fxt: tuple[dict[str, Any], Path],
    tmp_path: Path,
) -> None:
    reg, out_dir = fxt
    tolerances = g.load_tolerances()["audio"]
    entry = _entry(reg, "narrated_clicks")
    if entry["tts_pending"]:
        pytest.skip("espeak-ng not available")
    expected = g.parse_offsets_jsonl(out_dir / entry["offsets_jsonl"])
    speech_regions = (SpeechRegion(0, int(entry["duration_ms"])),)
    artifact = ensure_audio_onsets(
        out_dir / entry["file"],
        tmp_path / "narrated-clicks",
        speech_regions=speech_regions,
    )
    candidates = [
        onset.t_ms
        for onset in artifact.onsets
        if onset.in_speech and onset.label in {"click_candidate", "ambiguous"}
    ]
    tp, fp, fn = _match_times(candidates, expected, int(tolerances["click_tolerance_ms"]))
    precision, recall = _precision_recall(tp, fp, fn)

    assert recall >= float(tolerances["in_speech_click_recall"])
    assert precision >= float(tolerances["in_speech_click_precision"])


def test_integration_av_desync_degrades_without_crashing(
    fxt: tuple[dict[str, Any], Path],
    tmp_path: Path,
) -> None:
    reg, out_dir = fxt
    aligned = _entry(reg, "integration_av_0ms")
    desynced = _entry(reg, "integration_av_desync_300ms")
    if aligned["tts_pending"] or desynced["tts_pending"]:
        pytest.skip("espeak-ng not available")

    counts = []
    for entry in (aligned, desynced):
        speech_regions = (SpeechRegion(0, int(entry["duration_ms"])),)
        artifact = ensure_audio_onsets(
            out_dir / entry["audio_source"],
            tmp_path / f"onsets-{entry['id']}",
            speech_regions=speech_regions,
        )
        motion = ensure_proxy_motion(
            out_dir / entry["file"],
            tmp_path / f"motion-{entry['id']}",
            include_frames=True,
        )
        events = detect_audio_clicks(artifact, motion=motion, full_width=640, full_height=480)
        counts.append(len(events))

    assert counts[1] <= counts[0]


def test_integration_desync_probe_metadata(fxt: tuple[dict[str, Any], Path]) -> None:
    reg, _out_dir = fxt
    aligned = _entry(reg, "integration_av_0ms")
    desynced = _entry(reg, "integration_av_desync_300ms")
    if aligned["tts_pending"] or desynced["tts_pending"]:
        pytest.skip("espeak-ng not available")

    assert aligned["audio_offset_ms"] == 0
    assert desynced["audio_offset_ms"] == 300


def test_cut_boundaries_have_large_frame_diff(fxt: tuple[dict[str, Any], Path]) -> None:
    reg, out_dir = fxt

    for entry in _generated(reg):
        if entry["tts_pending"] or not entry.get("cuts_ms"):
            continue
        if entry["kind"] not in {"video", "video_audio"}:
            continue
        path = out_dir / entry["file"]
        for cut_ms in entry["cuts_ms"]:
            assert (
                g.frame_mae_at_cut(path, cut_ms / 1000, fps=entry.get("fps", mf.FPS))
                > FRAME_DIFF_CUT_THRESHOLD
            ), f"{entry['id']}@{cut_ms}"


def test_synth_drag_no_cut_boundary(fxt: tuple[dict[str, Any], Path]) -> None:
    reg, out_dir = fxt
    entry = _entry(reg, "synth_drag")

    assert g.frame_mae_at_cut(out_dir / entry["file"], 6.0) < 30


def test_silence_wav_is_silent(fxt: tuple[dict[str, Any], Path]) -> None:
    reg, out_dir = fxt
    entry = _entry(reg, "silence")

    assert g.audio_rms_db(out_dir / entry["file"], 0, 5) < -60


def test_tones_wav_is_not_silent(fxt: tuple[dict[str, Any], Path]) -> None:
    reg, out_dir = fxt
    entry = _entry(reg, "tones")

    assert g.audio_rms_db(out_dir / entry["file"], 0, 5) > -40


def test_speech_offsets_silent_before_first_onset(fxt: tuple[dict[str, Any], Path]) -> None:
    reg, out_dir = fxt
    entry = _entry(reg, "speech_offsets")
    if entry["tts_pending"]:
        pytest.skip("espeak-ng not available")

    assert g.audio_rms_db(out_dir / entry["file"], 0, 3) < -50


def test_speech_offsets_speech_at_5s(fxt: tuple[dict[str, Any], Path]) -> None:
    reg, out_dir = fxt
    entry = _entry(reg, "speech_offsets")
    if entry["tts_pending"]:
        pytest.skip("espeak-ng not available")

    assert g.audio_rms_db(out_dir / entry["file"], 5.0, 1.0) > -40


def test_speech_offsets_speech_at_60s(fxt: tuple[dict[str, Any], Path]) -> None:
    reg, out_dir = fxt
    entry = _entry(reg, "speech_offsets")
    if entry["tts_pending"]:
        pytest.skip("espeak-ng not available")

    assert g.audio_rms_db(out_dir / entry["file"], 60.0, 1.0) > -40


def test_real_clip_registry(fxt: tuple[dict[str, Any], Path]) -> None:
    reg, _out_dir = fxt

    assert len(reg["real"]) >= 2
    for entry in reg["real"]:
        assert entry["transcript"] == "PENDING_HUMAN"


def test_determinism(fxt: tuple[dict[str, Any], Path], tmp_path: Path) -> None:
    reg, _out_dir = fxt

    def _gt_data(registry: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
        return sorted(
            [
                (entry["id"], {key: value for key, value in entry.items() if key != "file"})
                for entry in registry["generated"]
            ]
        )

    out2 = tmp_path / "run2"
    out2.mkdir()
    reg2 = mf.generate_all(out2)
    assert _gt_data(reg) == _gt_data(reg2)

    registry_json = json.loads((out2 / "registry.json").read_text())
    assert _gt_data(registry_json) == _gt_data(reg2)


@pytest.mark.playwright
def test_playwright_cv_generator_flash_alignment(tmp_path: Path) -> None:
    out = tmp_path / "cv"
    registry = _run_cv_generator(out)
    assert {entry["id"] for entry in registry["generated"]} == {
        "cv_scroll_page",
        "cv_button_grid",
        "cv_hover_negative",
    }
    for entry in registry["generated"]:
        alignment = g.resolve_flash_alignment(out / entry["file"], out / entry["events_jsonl"])
        assert alignment.drift_ms <= g.load_tolerances()["flash_sync"]["drift_max_ms"]


@pytest.mark.playwright
def test_playwright_cv_generator_records_ground_truth_jsonl(tmp_path: Path) -> None:
    out = tmp_path / "cv"
    registry = _run_cv_generator(out)
    by_id = {entry["id"]: entry for entry in registry["generated"]}

    scroll_rows = g.parse_jsonl(out / by_id["cv_scroll_page"]["events_jsonl"])
    assert sum(1 for row in scroll_rows if row.get("kind") == "wheel") == 9
    assert by_id["cv_scroll_page"]["scroll_events"] == [
        {"direction": "down", "percent_viewport": 9.0}
    ]

    button_rows = g.parse_jsonl(out / by_id["cv_button_grid"]["events_jsonl"])
    assert sum(1 for row in button_rows if row.get("kind") == "click") >= 5
    assert any(row.get("kind") == "keydown" for row in button_rows)


@pytest.mark.playwright
def test_playwright_cv_generator_determinism(tmp_path: Path) -> None:
    out1 = tmp_path / "cv1"
    out2 = tmp_path / "cv2"
    reg1 = _run_cv_generator(out1)
    reg2 = _run_cv_generator(out2)

    def comparable(registry: dict[str, Any]) -> list[dict[str, Any]]:
        return sorted(
            [
                {
                    key: value
                    for key, value in entry.items()
                    if key not in {"file", "events_jsonl"}
                }
                for entry in registry["generated"]
            ],
            key=lambda entry: entry["id"],
        )

    assert comparable(reg1) == comparable(reg2)


@pytest.mark.playwright
def test_scrolls_provider_matches_cv_fixture_gate(tmp_path: Path) -> None:
    out = tmp_path / "cv"
    registry = _run_cv_generator(out)
    tolerances = g.load_tolerances()["scrolls"]
    by_id = {entry["id"]: entry for entry in registry["generated"]}
    scroll_entry = by_id["cv_scroll_page"]
    alignment = g.resolve_flash_alignment(
        out / scroll_entry["file"],
        out / scroll_entry["events_jsonl"],
    )
    expected = g.expected_scrolls_from_jsonl(
        out / scroll_entry["events_jsonl"],
        scroll_entry,
        alignment,
        separation_ms=int(tolerances["event_separation_ms"]),
    )
    detected = detect_scrolls(out / scroll_entry["file"], tmp_path / "scroll-work")

    assert len(detected) == len(expected)
    for actual, target in zip(detected, expected, strict=True):
        assert abs(actual.t_start_ms - target.t_start_ms) <= int(tolerances["edge_tolerance_ms"])
        assert abs(actual.t_end_ms - target.t_end_ms) <= int(tolerances["edge_tolerance_ms"])
        assert actual.direction == target.direction
        assert actual.percent == pytest.approx(
            target.percent_viewport,
            rel=float(tolerances["percent_relative_tolerance"]),
        )
        assert actual.payload["lines"] is None
        assert actual.payload["direction"] == target.direction

    assert detect_scrolls(out / by_id["cv_button_grid"]["file"], tmp_path / "button-work") == []
    assert detect_scrolls(out / by_id["cv_hover_negative"]["file"], tmp_path / "hover-work") == []


@pytest.mark.playwright
def test_clicks_provider_matches_cv_button_grid_gate(tmp_path: Path) -> None:
    out = tmp_path / "cv"
    registry = _run_cv_generator(out)
    tolerances = g.load_tolerances()["clicks"]
    by_id = {entry["id"]: entry for entry in registry["generated"]}
    button_entry = by_id["cv_button_grid"]
    alignment = g.resolve_flash_alignment(
        out / button_entry["file"],
        out / button_entry["events_jsonl"],
    )
    expected = [
        alignment.event_to_video_ms(row["t_ms"])
        for row in g.parse_jsonl(out / button_entry["events_jsonl"])
        if row.get("kind") == "click"
    ]
    motion = ensure_proxy_motion(
        out / button_entry["file"],
        tmp_path / "button-click-motion",
        include_frames=True,
    )
    detected = detect_visual_clicks(motion, full_width=640, full_height=480)
    actual = [event.t_start_ms for event in detected]
    tp, fp, fn = _match_times(
        actual,
        expected,
        int(tolerances["visual_edge_tolerance_ms"]),
    )
    precision, recall = _precision_recall(tp, fp, fn)

    assert recall >= float(tolerances["visual_recall"])
    assert precision >= float(tolerances["visual_precision"])
    assert all(event.visual.response_centroid is not None for event in detected)

    hover_motion = ensure_proxy_motion(
        out / by_id["cv_hover_negative"]["file"],
        tmp_path / "hover-click-motion",
        include_frames=True,
    )
    assert detect_visual_clicks(hover_motion, full_width=640, full_height=480) == []
