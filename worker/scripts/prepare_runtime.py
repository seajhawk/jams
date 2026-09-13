"""Prepare immutable worker runtime assets during the image build."""

from __future__ import annotations

import argparse
from pathlib import Path

from jams_worker import ffmpeg
from jams_worker.providers import sentiment, transcription


def prepare_runtime(*, prewarm_models: bool = True) -> tuple[str, str]:
    """Fetch static media tools and both models used by narrated analysis."""

    ffmpeg_path, ffprobe_path = ffmpeg.ffmpeg_paths()
    if not Path(ffmpeg_path).is_file() or not Path(ffprobe_path).is_file():
        raise RuntimeError("static-ffmpeg did not provide both ffmpeg and ffprobe")

    if prewarm_models:
        model, _model_sha256 = transcription.load_model(transcription.MODEL_NAME)
        del model
        model_path, tokenizer_path = sentiment._download_model()
        if not model_path.is_file() or not tokenizer_path.is_file():
            raise RuntimeError("sentiment model preparation did not produce required files")

    return ffmpeg_path, ffprobe_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--skip-models",
        action="store_true",
        help="only prefetch static ffmpeg/ffprobe (for fast local image checks)",
    )
    args = parser.parse_args()
    ffmpeg_path, ffprobe_path = prepare_runtime(prewarm_models=not args.skip_models)
    print(f"Prepared ffmpeg={ffmpeg_path} ffprobe={ffprobe_path}", flush=True)


if __name__ == "__main__":
    main()
