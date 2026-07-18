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
    pnpm = shutil.which("pnpm")
    if pnpm is None:
        pytest.skip("pnpm not available for Playwright CV fixture generation")
    if not (CV_GENERATOR / "node_modules" / "playwright").exists():
        pytest.skip("run pnpm install in worker/scripts/make_cv_fixtures")

    out = tmp_path / "cv"
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

    registry = json.loads((out / "cv_registry.json").read_text())
    assert {entry["id"] for entry in registry["generated"]} == {
        "cv_scroll_page",
        "cv_button_grid",
        "cv_hover_negative",
    }
    for entry in registry["generated"]:
        alignment = g.resolve_flash_alignment(out / entry["file"], out / entry["events_jsonl"])
        assert alignment.drift_ms <= g.load_tolerances()["flash_sync"]["drift_max_ms"]
