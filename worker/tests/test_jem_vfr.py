"""Regression coverage for JEM VFR frame-index drift and CFR alignment."""

from __future__ import annotations

import csv
import json
import subprocess
from pathlib import Path

from jams_worker import jem_eval
from jams_worker.jem_eval import detect_flash_runs
from jams_worker.providers.context_switch import DetectorCut


def _make_vfr_fixture(path: Path) -> None:
    """Create a tiny VFR clip with two bright sync flashes.

    Frames are dropped before each flash while their original PTS is retained.
    A frame-index/fps calculation therefore reports the flashes too early; the
    evaluator's CFR pass must recover the timestamps from the retained PTS.
    """
    command = [
        jem_eval.ffmpeg_path(),
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=160x90:r=30:d=10",
        "-vf",
        (
            "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:"
            "enable='between(t,3,3.2)+between(t,8,8.2)',"
            "select='not(between(t,1,2)+between(t,5,6))'"
        ),
        "-fps_mode",
        "vfr",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        str(path),
    ]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr


def _write_session(session: Path, video: Path) -> None:
    manifest = {
        "video": {"file": video.name},
        "sync": {
            "flashes": [{"flash_log_ms": 3000}],
            "end_flash_log_ms": 8000,
        },
    }
    (session / "journey.json").write_text(json.dumps(manifest), encoding="utf-8")
    with (session / "journey.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(jem_eval.CSV_HEADER.split(","))
        writer.writerow(
            [
                "context_switch",
                "cognitive",
                "4500",
                "5500",
                "1",
                "",
                "",
                "",
                "1",
                "fixture.exe",
                "Fixture",
                "synthetic",
                "",
                "0.9",
            ]
        )
    video.rename(session / video.name)


def _naive_vfr_flash_times(video: Path) -> list[int]:
    """Model the old frame-index mapper, preserving VFR gaps while decoding."""
    completed = subprocess.run(
        [
            jem_eval.ffmpeg_path(),
            "-v",
            "error",
            "-i",
            str(video),
            "-vsync",
            "0",
            "-vf",
            "scale=64:36,format=gray",
            "-f",
            "rawvideo",
            "-",
        ],
        capture_output=True,
        timeout=120,
        check=True,
    )
    frame_bytes = 64 * 36
    times: list[int] = []
    run_start = -1
    run_length = 0
    for index in range(0, len(completed.stdout), frame_bytes):
        frame = completed.stdout[index : index + frame_bytes]
        bright = sum(frame) / frame_bytes > 245
        if bright:
            run_start = index // frame_bytes if run_length == 0 else run_start
            run_length += 1
        elif run_length >= 2:
            times.append(round(run_start * 1000 / 30))
            run_start, run_length = -1, 0
        else:
            run_start, run_length = -1, 0
    if run_length >= 2:
        times.append(round(run_start * 1000 / 30))
    return times


def test_vfr_flash_frame_index_bug_is_fixed_by_cfr_normalization(tmp_path, monkeypatch):
    session = tmp_path / "session"
    session.mkdir()
    source = tmp_path / "vfr.mp4"
    _make_vfr_fixture(source)

    raw = _naive_vfr_flash_times(source)
    assert len(raw) == 2
    assert abs(raw[0] - 3000) > 250
    assert abs(raw[1] - 8000) > 250

    _write_session(session, source)
    normalized_flash_times: list[int] = []

    def fake_detector(video: Path, workdir: Path, *, detector_impl: str):
        normalized_flash_times.extend(
            flash.video_ms for flash in detect_flash_runs(video, jem_eval.NORMALIZED_FPS)
        )
        return [
            DetectorCut(
                frame_index=135,
                t_start_ms=4500,
                confidence=0.9,
                content_val=None,
                trigger=None,
                post_factor=1.0,
                payload={"detector": "test"},
            )
        ]

    monkeypatch.setattr(jem_eval, "detect_context_switches", fake_detector)
    result = jem_eval.evaluate_session(session)

    provider = result["providers"]["context_switch"]
    assert provider["provider_version"] == "1.0.0"
    assert provider["params"]["min_content_val"] == 12.0

    assert result["alignment"]["validated"] is True
    assert result["alignment"]["end_drift_ms"] == 0
    assert all(abs(actual - expected) <= 250 for actual, expected in zip(
        normalized_flash_times, (3000, 8000), strict=True
    ))
    assert result["metrics"]["context_switch"]["tp"] == 1
