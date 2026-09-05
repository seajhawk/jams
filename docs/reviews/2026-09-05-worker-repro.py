"""Bounded review diagnostics; no database or customer data access.

Run from worker/: uv run python ../docs/reviews/2026-09-05-worker-repro.py
These print current behavior, not desired regression-test expectations.
Optional --media uses ffmpeg; --sentiment uses cached model weights offline.
"""

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import wave
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from jams_worker.effort_score import normalize, score
from jams_worker.ffmpeg import ffmpeg_path, ffprobe_path
from jams_worker.pipeline import PipelineContext, run_pipeline
from jams_worker.providers import segmentation, sentiment, transcription
from jams_worker.providers.probe import ProbeProvider


def context(config: dict[str, Any] | None = None) -> PipelineContext:
    return PipelineContext(
        run={
            "id": "review",
            "video_id": "review-video",
            "duration_ms": 1000,
            "config": config or {},
        },
        org_id="review-org",
        blob_service_client=None,
        db_conn=None,
        workdir=Path("."),
        register_artifact=lambda *_: "artifact",
        heartbeat=lambda *_: None,
    )


results = {}
weights = {"context_switch": 3, "sentiment": 4, "spoken_word": 1, "time_segment": 2}
modes = {
    "context_switch": "per_minute",
    "sentiment": "neg_density",
    "spoken_word": "per_minute",
    "time_segment": "raw_minutes",
}
video = {"duration_ms": 60000}
observed = [
    {"kind": "context_switch", "t_start_ms": 1000},
    {"kind": "sentiment", "t_start_ms": 0, "t_end_ms": 30000, "value_num": -0.8},
    {"kind": "spoken_word", "t_start_ms": 0, "t_end_ms": 60000, "value_num": 120},
]
results["missing_measures_score"] = {
    "same_video_with_measures": score(normalize(observed, video, modes), weights)["total"],
    "same_video_without_measures": score(normalize([], video, modes), weights)["total"],
    "physical_at_41_words_per_min": normalize(
        [{"kind": "spoken_word", "value_num": 41}], video, modes
    )["spoken_word"]["normalized"],
    "physical_at_120_words_per_min": normalize(observed, video, modes)["spoken_word"]["normalized"],
}


class SummaryProvider:
    id = "transcription"
    version = "review"
    requires = []
    provides = []

    def run(self, ctx: PipelineContext) -> list[dict[str, Any]]:
        ctx.report_provider_summary(self.id, {"status": "skipped_no_audio"})
        return []


with patch("jams_worker.pipeline.write_provider_measures"), redirect_stdout(StringIO()):
    outcome = run_pipeline(context(), [SummaryProvider()])
results["no_audio_pipeline_status"] = outcome.status

ctx = context({"sentiment": {"enabled": False, "fallback": "vader"}})
utterance = sentiment.UtteranceInput("u", 0, 1000, "A test", 1.0)
prediction = sentiment.SentimentPrediction(0.5, 0.75, "POSITIVE", 0.25, 0.75)
with (
    patch.object(sentiment, "_read_utterances", return_value=[utterance]),
    patch.object(sentiment, "classify_texts", return_value=[prediction]) as classifier,
):
    emitted = sentiment.SentimentProvider().run(ctx)
results["disabled_sentiment"] = {
    "classifier_called": classifier.called,
    "selected_method": classifier.call_args.args[1],
    "measures_emitted": len(emitted),
}

ctx = context({"segmentation": {"enabled": False}})
with (
    patch.object(segmentation, "_read_inputs", return_value=([], [])),
    patch.object(segmentation, "build_segments", return_value=[]) as builder,
    patch.object(segmentation, "write_segments") as writer,
):
    segmentation.SegmentationProvider().run(ctx)
results["disabled_segmentation"] = {
    "builder_called": builder.called,
    "writer_called": writer.called,
}

ctx = context()
ctx.db_conn = SimpleNamespace(execute=lambda *_: SimpleNamespace(fetchone=lambda: (60000,)))
results["stale_duration"] = {
    "claimed_client_duration_ms": ctx.run["duration_ms"],
    "probe_corrected_db_duration_ms": 60000,
    "transcription_uses_ms": transcription._video_duration_ms(ctx, Path("not-read.mp4")),
    "segmentation_uses_ms": segmentation._video_duration_ms(ctx),
}


class FailedProvider(SummaryProvider):
    def run(self, ctx: PipelineContext) -> list[dict[str, Any]]:
        raise RuntimeError("simulated provider failure after a previous attempt wrote rows")


with (
    patch("jams_worker.pipeline.write_provider_measures") as replace_rows,
    redirect_stdout(StringIO()),
):
    outcome = run_pipeline(context(), [FailedProvider()])
results["failed_provider_retry"] = {
    "pipeline_status": outcome.status,
    "previous_rows_replaced_or_cleared": replace_rows.called,
}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--media", action="store_true", help="Run real ffmpeg delayed-audio diagnostic")
parser.add_argument("--sentiment", action="store_true", help="Use cached ONNX model offline")
args = parser.parse_args()

if args.media:
    with tempfile.TemporaryDirectory(prefix="jams-review-av-") as tmp:
        root = Path(tmp)
        source = root / "source.mp4"
        subprocess.run(
            [
                ffmpeg_path(),
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x90:rate=30:duration=6",
                "-itsoffset",
                "2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=1000:sample_rate=16000:duration=2",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                str(source),
            ],
            check=True,
            timeout=60,
        )
        ctx = context()
        ctx.workdir = root
        ctx.run["poster_blob_path"] = "exists"
        ctx.db_conn = SimpleNamespace(execute=lambda *_: None, commit=lambda: None)
        with (
            patch(
                "jams_worker.providers.probe._download_blob",
                side_effect=lambda c, p: shutil.copyfile(source, p),
            ),
            patch("jams_worker.providers.probe._upload_blob"),
        ):
            ProbeProvider().run(ctx)

        def streams(path: Path) -> list[dict[str, Any]]:
            return json.loads(
                subprocess.check_output(
                    [
                        ffprobe_path(),
                        "-v",
                        "error",
                        "-show_entries",
                        "stream=codec_type,start_time,duration",
                        "-of",
                        "json",
                        str(path),
                    ],
                    timeout=60,
                )
            )["streams"]

        with wave.open(str(root / "audio.wav"), "rb") as wav:
            raw = wav.readframes(wav.getnframes())
            samples = [
                int.from_bytes(raw[i : i + 2], "little", signed=True) for i in range(0, len(raw), 2)
            ]
            onset = next(i for i, sample in enumerate(samples) if abs(sample) > 1000)
            onset_seconds = onset / wav.getframerate()
        results["delayed_audio"] = {
            "original_streams": streams(source),
            "normalized_streams": streams(root / "normalized.mp4"),
            "extracted_wav_first_tone_seconds": onset_seconds,
        }

if args.sentiment:
    os.environ["HF_HUB_OFFLINE"] = "1"
    texts = [
        "I clicked the blue button.",
        "The window is open.",
        "I am entering the account number.",
        "This is frustrating and I cannot finish.",
        "That was easy and worked perfectly.",
    ]
    predictions = sentiment.classify_onnx(texts)
    results["actual_sentiment_model"] = [
        {"text": text, "sentiment": prediction.value, "confidence": prediction.confidence}
        for text, prediction in zip(texts, predictions, strict=True)
    ]

print(json.dumps(results, indent=2))
