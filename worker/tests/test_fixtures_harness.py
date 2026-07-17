"""Self-consistency tests for generated golden media fixtures."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import golden as g
import make_fixtures as mf
import pytest

DURATION_TOL_MS = 400
FRAME_DIFF_CUT_THRESHOLD = 40.0


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
