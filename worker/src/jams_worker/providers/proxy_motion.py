"""Shared low-fps motion artifact for CV effort providers."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from jams_worker.errors import PipelineError
from jams_worker.ffmpeg import MEDIA_TIMEOUT_SECONDS, ffmpeg_path, run_media_command

PROXY_MOTION_ID = "proxy_motion_v1"
PROXY_MOTION_BUILDER_VERSION = "1.0.0"
PROXY_FPS = 5.0
PROXY_WIDTH = 480


@dataclass(frozen=True, slots=True)
class MotionArtifact:
    path: Path
    proxy_path: Path
    fps: float
    frame_ms: np.ndarray
    width: int
    height: int
    content_val: np.ndarray
    dx_full: np.ndarray
    dy_full: np.ndarray
    resp_full: np.ndarray
    strip_dx: np.ndarray
    strip_dy: np.ndarray
    strip_resp: np.ndarray
    diff_energy: np.ndarray
    frames: list[np.ndarray] | None = None


def _run_ffmpeg(args: list[str], error_code: str = "transient") -> None:
    completed = run_media_command(args, timeout_seconds=MEDIA_TIMEOUT_SECONDS)
    if completed.returncode != 0:
        raise PipelineError(error_code, completed.stderr.strip() or "ffmpeg failed")


def build_proxy(source: Path, proxy: Path) -> None:
    proxy.parent.mkdir(parents=True, exist_ok=True)
    _run_ffmpeg(
        [
            ffmpeg_path(),
            "-y",
            "-i",
            str(source),
            "-vf",
            f"fps={PROXY_FPS:g},scale={PROXY_WIDTH}:-2,format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-an",
            str(proxy),
        ]
    )


def read_grayscale_frames(path: Path) -> list[np.ndarray]:
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise PipelineError("corrupt_file", f"Could not decode proxy video {path}")

    frames: list[np.ndarray] = []
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
    finally:
        capture.release()

    if not frames:
        raise PipelineError("corrupt_file", "Proxy video contained no frames")
    return frames


def _phase_correlate(before: np.ndarray, after: np.ndarray) -> tuple[float, float, float]:
    shift, response = cv2.phaseCorrelate(np.float32(before), np.float32(after))
    return float(shift[0]), float(shift[1]), float(response)


def _frame_delta(before: np.ndarray, after: np.ndarray) -> float:
    delta = np.abs(after.astype(np.int16) - before.astype(np.int16))
    full = float(np.mean(delta))
    height = delta.shape[0]
    band_height = max(1, height // 6)
    bands = [
        float(np.mean(delta[row : row + band_height, :]))
        for row in range(0, max(1, height - band_height + 1), max(1, band_height // 2))
    ]
    return max(full, *bands)


def content_val_series(frames: list[np.ndarray]) -> list[float]:
    if not frames:
        return []
    values = [0.0]
    values.extend(_frame_delta(frames[index - 1], frames[index]) for index in range(1, len(frames)))
    return values


def _source_hash(source: Path) -> str:
    digest = hashlib.sha256()
    with source.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()[:16]


def artifact_paths(source: Path, workdir: Path) -> tuple[Path, Path]:
    cache_dir = workdir / PROXY_MOTION_ID
    key = f"{_source_hash(source)}_{PROXY_MOTION_BUILDER_VERSION}"
    return cache_dir / f"{key}.npz", cache_dir / f"{key}.mp4"


def _build_arrays(frames: list[np.ndarray]) -> dict[str, np.ndarray]:
    height, width = frames[0].shape
    count = len(frames)
    frame_ms = np.rint(np.arange(count, dtype=np.float32) * (1000.0 / PROXY_FPS)).astype(
        np.int32
    )
    dx_full = np.zeros(count, dtype=np.float32)
    dy_full = np.zeros(count, dtype=np.float32)
    resp_full = np.zeros(count, dtype=np.float32)
    strip_dx = np.zeros((3, count), dtype=np.float32)
    strip_dy = np.zeros((3, count), dtype=np.float32)
    strip_resp = np.zeros((3, count), dtype=np.float32)
    diff_energy = np.zeros(count, dtype=np.float32)

    top = int(round(height * 0.08))
    bottom = int(round(height * 0.92))
    interior_h = max(3, bottom - top)
    strip_edges = [
        (top + round((interior_h * index) / 3), top + round((interior_h * (index + 1)) / 3))
        for index in range(3)
    ]

    for index in range(1, count):
        before = frames[index - 1]
        after = frames[index]
        dx_full[index], dy_full[index], resp_full[index] = _phase_correlate(before, after)
        diff = np.abs(
            after[top:bottom, :].astype(np.int16) - before[top:bottom, :].astype(np.int16)
        )
        diff_energy[index] = float(np.mean(diff)) if diff.size else 0.0
        for strip_index, (row0, row1) in enumerate(strip_edges):
            dx, dy, resp = _phase_correlate(before[row0:row1, :], after[row0:row1, :])
            strip_dx[strip_index, index] = dx
            strip_dy[strip_index, index] = dy
            strip_resp[strip_index, index] = resp

    return {
        "frame_ms": frame_ms,
        "content_val": np.asarray(content_val_series(frames), dtype=np.float32),
        "dx_full": dx_full,
        "dy_full": dy_full,
        "resp_full": resp_full,
        "strip_dx": strip_dx,
        "strip_dy": strip_dy,
        "strip_resp": strip_resp,
        "diff_energy": diff_energy,
        "meta": np.asarray(
            json.dumps(
                {
                    "builder_version": PROXY_MOTION_BUILDER_VERSION,
                    "fps": PROXY_FPS,
                    "width": width,
                    "height": height,
                },
                separators=(",", ":"),
            )
        ),
    }


def _load(path: Path, proxy_path: Path, *, include_frames: bool) -> MotionArtifact:
    with np.load(path, allow_pickle=False) as data:
        meta = json.loads(str(data["meta"]))
        frames = read_grayscale_frames(proxy_path) if include_frames else None
        return MotionArtifact(
            path=path,
            proxy_path=proxy_path,
            fps=float(meta["fps"]),
            frame_ms=data["frame_ms"],
            width=int(meta["width"]),
            height=int(meta["height"]),
            content_val=data["content_val"],
            dx_full=data["dx_full"],
            dy_full=data["dy_full"],
            resp_full=data["resp_full"],
            strip_dx=data["strip_dx"],
            strip_dy=data["strip_dy"],
            strip_resp=data["strip_resp"],
            diff_energy=data["diff_energy"],
            frames=frames,
        )


def ensure_proxy_motion(
    source: Path,
    workdir: Path,
    *,
    include_frames: bool = False,
) -> MotionArtifact:
    artifact_path, proxy_path = artifact_paths(source, workdir)
    if artifact_path.exists() and proxy_path.exists():
        return _load(artifact_path, proxy_path, include_frames=include_frames)

    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_proxy = proxy_path.with_suffix(".tmp.mp4")
    tmp_artifact = artifact_path.with_suffix(".tmp.npz")
    build_proxy(source, tmp_proxy)
    frames = read_grayscale_frames(tmp_proxy)
    arrays = _build_arrays(frames)
    np.savez_compressed(tmp_artifact, **arrays)
    os.replace(tmp_proxy, proxy_path)
    os.replace(tmp_artifact, artifact_path)
    return _load(artifact_path, proxy_path, include_frames=include_frames)
