"""Benchmark faster-whisper model real-time factor on a local speech fixture."""

from __future__ import annotations

import argparse
import json
import tempfile
import time
from pathlib import Path

import make_fixtures as mf

from jams_worker.providers.probe import ffmpeg_paths
from jams_worker.providers.transcription import (
    DEFAULT_MODEL_CACHE,
    MODEL_NAME,
    _transcribe,
    load_model,
    model_cache_dir,
    wav_duration_ms,
)

WORKER_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = WORKER_ROOT.parent
DEFAULT_BENCHMARK_DOC = REPO_ROOT / "docs" / "benchmarks" / "whisper-local.md"


def _run(args: list[str]) -> None:
    import subprocess

    completed = subprocess.run(args, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "command failed")


def _extract_wav(source: Path, target: Path) -> None:
    ffmpeg, _ffprobe = ffmpeg_paths()
    _run(
        [
            ffmpeg,
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(target),
        ]
    )


def _default_fixture(workdir: Path) -> tuple[Path, str]:
    fixture_dir = workdir / "fixtures"
    registry = mf.generate_all(fixture_dir)
    speech = next(item for item in registry["generated"] if item["id"] == "speech_espeak")
    if not speech["tts_pending"]:
        return fixture_dir / speech["file"], "speech_espeak"

    real = (
        REPO_ROOT
        / "videos"
        / "(Audio) SettingUpGoogleVideoAnalyzerForContextSwitches-ShotChange.m4a"
    )
    if real.exists():
        wav = workdir / "real_sample_16k.wav"
        _extract_wav(real, wav)
        return wav, real.name
    raise RuntimeError("No 60s+ speech fixture available; install espeak-ng or provide --fixture")


def _benchmark_model(model_name: str, audio: Path) -> dict[str, str | float]:
    start = time.perf_counter()
    model, _sha = load_model(model_name)
    _transcribe(model, audio, vad_threshold=0.5)
    wall_s = time.perf_counter() - start
    duration_s = wav_duration_ms(audio) / 1000
    return {
        "model": model_name,
        "rtf": round(wall_s / duration_s, 4),
        "wall_time_s": round(wall_s, 2),
    }


def _write_doc(path: Path, fixture_label: str, rows: list[dict[str, str | float]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cache = model_cache_dir()
    lines = [
        "# Whisper Local Benchmark",
        "",
        "Local baseline for the F3-b3 transcription provider. "
        "The ACA SKU benchmark remains a deploy-time gate.",
        "",
        f"- Fixture: `{fixture_label}`",
        f"- Model cache: `{cache if cache != DEFAULT_MODEL_CACHE else DEFAULT_MODEL_CACHE}`",
        "",
        "| Model | RTF | Wall time (s) |",
        "|---|---:|---:|",
    ]
    lines.extend(f"| {row['model']} | {row['rtf']} | {row['wall_time_s']} |" for row in rows)
    lines.extend(["", "```json", json.dumps(rows, indent=2, sort_keys=True), "```", ""])
    path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--out", type=Path, default=DEFAULT_BENCHMARK_DOC)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        fixture = args.fixture
        label = str(fixture) if fixture is not None else ""
        if fixture is None:
            fixture, label = _default_fixture(workdir)

        wav = fixture
        if wav.suffix.lower() != ".wav":
            wav = workdir / "fixture_16k.wav"
            _extract_wav(fixture, wav)

        rows = [_benchmark_model(MODEL_NAME, wav), _benchmark_model("small.en", wav)]
        _write_doc(args.out, label, rows)
        print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
