"""Golden-fixture assertion and media-probe helpers."""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

try:
    from static_ffmpeg import run as static_ffmpeg_run

    @lru_cache(maxsize=1)
    def _ffmpeg() -> tuple[str, str]:
        return static_ffmpeg_run.get_or_fetch_platform_executables_else_raise()

except ImportError:

    @lru_cache(maxsize=1)
    def _ffmpeg() -> tuple[str, str]:  # type: ignore[misc]
        return "ffmpeg", "ffprobe"


@dataclass
class CutMatchResult:
    tp: int
    fp: int
    fn: int

    @property
    def precision(self) -> float:
        denom = self.tp + self.fp
        if denom == 0:
            return 0.0
        return self.tp / denom

    @property
    def recall(self) -> float:
        denom = self.tp + self.fn
        if denom == 0:
            return 0.0
        return self.tp / denom

    @property
    def f1(self) -> float:
        denom = self.precision + self.recall
        if denom == 0:
            return 0.0
        return 2 * self.precision * self.recall / denom


def cut_match(
    expected_ms: list[int] | tuple[int, ...],
    detected_ms: list[int] | tuple[int, ...],
    tolerance_ms: int = 1000,
) -> CutMatchResult:
    pool = sorted(detected_ms)
    tp = 0
    for expected in sorted(expected_ms):
        candidates = [
            (abs(detected - expected), index)
            for index, detected in enumerate(pool)
            if abs(detected - expected) <= tolerance_ms
        ]
        if candidates:
            _delta, index = min(candidates)
            tp += 1
            pool.pop(index)
    return CutMatchResult(tp=tp, fp=len(pool), fn=len(expected_ms) - tp)


def _normalize_text(text: str) -> str:
    normalized = text.lower()
    normalized = re.sub(r"[^\w\s]", "", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def compute_wer(reference: str, hypothesis: str) -> float:
    if reference == "" and hypothesis == "":
        return 0.0

    from jiwer import wer

    return wer(_normalize_text(reference), _normalize_text(hypothesis))


def assert_utterance_invariants(utterances: list[dict]) -> None:
    previous_end: int | None = None
    for utterance in utterances:
        start = int(utterance["t_start_ms"])
        end = int(utterance["t_end_ms"])
        words = utterance.get("payload", {}).get("words", [])

        if previous_end is not None:
            assert start >= previous_end
        previous_end = end

        previous_word_t0: int | None = None
        durations = []
        for word in words:
            t0 = int(word["t0"])
            t1 = int(word["t1"])
            if previous_word_t0 is not None:
                assert t0 >= previous_word_t0
            previous_word_t0 = t0

            assert t0 >= start - 50
            assert t1 <= end + 50
            durations.append(t1 - t0)

        if durations:
            mean_duration = sum(durations) / len(durations)
            assert 60 <= mean_duration <= 1200


def assert_audio_video_aligned(wav_duration_ms: int, video_duration_ms: int) -> None:
    assert abs(wav_duration_ms - video_duration_ms) <= 500


def assert_timestamps_bounded(utterances: list[dict], video_duration_ms: int) -> None:
    for utterance in utterances:
        assert int(utterance["t_start_ms"]) <= video_duration_ms + 250
        assert int(utterance["t_end_ms"]) <= video_duration_ms + 250


def assert_cross_stage(cut_ms: int, first_word_t0_ms: int, video_duration_ms: int) -> None:
    assert abs(cut_ms - 5000) <= 250
    assert abs(first_word_t0_ms - 5000) <= 250
    assert abs(cut_ms - first_word_t0_ms) <= 500
    assert abs(video_duration_ms - 25000) <= 40


def ffprobe_duration_ms(path: Path) -> int:
    _ffmpeg_path, ffprobe = _ffmpeg()
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            str(path),
        ],
        capture_output=True,
        check=True,
    )
    return int(float(result.stdout.decode().strip()) * 1000)


def _frame_rgb(ffmpeg: str, path: Path, t_s: float) -> bytes:
    result = subprocess.run(
        [
            ffmpeg,
            "-loglevel",
            "error",
            "-ss",
            str(max(0.0, t_s)),
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-vf",
            "scale=160:120",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ],
        capture_output=True,
        check=True,
    )
    return result.stdout


def frame_mae_at_cut(path: Path, cut_s: float, fps: int = 30) -> float:
    ffmpeg, _ffprobe = _ffmpeg()
    before = _frame_rgb(ffmpeg, path, cut_s - 1 / fps)
    after = _frame_rgb(ffmpeg, path, cut_s + 1 / fps)
    expected_len = 160 * 120 * 3
    if len(before) != expected_len or len(after) != expected_len:
        msg = f"expected {expected_len}-byte frames, got {len(before)} and {len(after)}"
        raise AssertionError(msg)

    def mae(start: int, end: int) -> float:
        pixel_count = (end - start) // 3
        return sum(
            max(
                abs(before[index] - after[index]),
                abs(before[index + 1] - after[index + 1]),
                abs(before[index + 2] - after[index + 2]),
            )
            for index in range(start, end, 3)
        ) / pixel_count

    full_mae = mae(0, expected_len)
    row_bytes = 160 * 3
    band_rows = 16
    band_scores = [
        mae(row_start * row_bytes, (row_start + band_rows) * row_bytes)
        for row_start in range(0, 120 - band_rows + 1, 8)
    ]
    return max(full_mae, *band_scores)


def audio_rms_db(path: Path, start_s: float, duration_s: float) -> float:
    ffmpeg, _ffprobe = _ffmpeg()
    result = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "info",
            "-ss",
            str(start_s),
            "-i",
            str(path),
            "-t",
            str(duration_s),
            "-vn",
            "-af",
            "volumedetect",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        check=True,
    )
    match = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?) dB", result.stderr.decode())
    if match is None:
        return -100.0
    return float(match.group(1))
