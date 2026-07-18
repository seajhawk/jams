"""Per-utterance narration sentiment provider."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import numpy as np

from jams_worker.pipeline import PipelineContext

PROVIDER_ID = "sentiment"
PROVIDER_VERSION = "1.0.0"
MODEL_REPO = "Xenova/distilbert-base-uncased-finetuned-sst-2-english"
MODEL_REVISION = "0b6928efcb76139cae2c6881d49cda67fe119f42"
MODEL_FILE = "onnx/model_int8.onnx"
MAX_TOKENS = 256
DEFAULT_MODEL_CACHE = Path.home() / ".cache" / "jams-worker" / "sentiment"

SentimentMethod = Literal["onnx", "vader"]


@dataclass(frozen=True, slots=True)
class UtteranceInput:
    id: str
    t0_ms: int
    t1_ms: int
    text: str
    confidence: float | None


@dataclass(frozen=True, slots=True)
class SentimentPrediction:
    value: float
    confidence: float
    label: str
    negative_probability: float
    positive_probability: float
    token_count: int | None = None
    truncated: bool = False
    method: SentimentMethod = "onnx"


def model_cache_dir() -> Path:
    raw = os.environ.get("JAMS_SENTIMENT_MODEL_CACHE")
    return Path(raw).expanduser() if raw else DEFAULT_MODEL_CACHE


def _config_method(context: PipelineContext) -> SentimentMethod:
    config = context.run.get("config")
    method = "onnx"
    if isinstance(config, dict):
        sentiment_config = config.get("sentiment")
        if isinstance(sentiment_config, dict) and isinstance(sentiment_config.get("method"), str):
            method = sentiment_config["method"]
        elif isinstance(config.get("sentiment_method"), str):
            method = config["sentiment_method"]
    if method not in ("onnx", "vader"):
        raise ValueError(f"Unsupported sentiment method: {method}")
    return method  # type: ignore[return-value]


def _softmax(values: np.ndarray) -> np.ndarray:
    shifted = values - np.max(values, axis=-1, keepdims=True)
    exp = np.exp(shifted)
    return exp / np.sum(exp, axis=-1, keepdims=True)


def _read_utterances(context: PipelineContext) -> list[UtteranceInput]:
    rows = context.db_conn.execute(
        """
        select id::text, t_start_ms, t_end_ms, value_text, confidence, payload
        from measures
        where run_id = %s and kind = 'utterance'
        order by t_start_ms, id
        """,
        (context.run_id,),
    ).fetchall()

    utterances: list[UtteranceInput] = []
    for row in rows:
        payload = row[5] if isinstance(row[5], dict) else {}
        text = row[3] if isinstance(row[3], str) else payload.get("text")
        if not isinstance(text, str) or not text.strip() or row[2] is None:
            continue
        utterances.append(
            UtteranceInput(
                id=str(row[0]),
                t0_ms=int(row[1]),
                t1_ms=int(row[2]),
                text=text.strip(),
                confidence=float(row[4]) if row[4] is not None else None,
            )
        )
    return utterances


def _download_model() -> tuple[Path, Path]:
    from huggingface_hub import snapshot_download

    cache = model_cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    model_path = Path(
        snapshot_download(
            repo_id=MODEL_REPO,
            revision=MODEL_REVISION,
            cache_dir=cache,
            allow_patterns=[
                MODEL_FILE,
                "config.json",
                "tokenizer.json",
                "tokenizer_config.json",
                "special_tokens_map.json",
                "vocab.txt",
            ],
        )
    )
    return model_path / MODEL_FILE, model_path / "tokenizer.json"


@lru_cache(maxsize=1)
def _onnx_runtime() -> tuple[Any, Any, dict[int, str]]:
    import onnxruntime as ort
    from tokenizers import Tokenizer

    model_path, tokenizer_path = _download_model()
    session_options = ort.SessionOptions()
    session_options.intra_op_num_threads = min(4, os.cpu_count() or 1)
    session_options.inter_op_num_threads = 1
    session = ort.InferenceSession(
        str(model_path),
        sess_options=session_options,
        providers=["CPUExecutionProvider"],
    )
    tokenizer = Tokenizer.from_file(str(tokenizer_path))

    config_path = model_path.parents[1] / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    id_to_label = {
        int(key): str(value).upper()
        for key, value in dict(config.get("id2label", {0: "NEGATIVE", 1: "POSITIVE"})).items()
    }
    return session, tokenizer, id_to_label


def classify_onnx(texts: list[str]) -> list[SentimentPrediction]:
    session, tokenizer, id_to_label = _onnx_runtime()
    input_names = [item.name for item in session.get_inputs()]
    predictions: list[SentimentPrediction] = []

    for text in texts:
        tokenizer.no_truncation()
        full = tokenizer.encode(text)
        truncated = len(full.ids) > MAX_TOKENS
        if truncated:
            tokenizer.enable_truncation(max_length=MAX_TOKENS)
        encoded = tokenizer.encode(text)
        tokenizer.no_truncation()

        ids = np.asarray([encoded.ids], dtype=np.int64)
        mask = np.asarray([encoded.attention_mask], dtype=np.int64)
        token_types = np.zeros_like(ids)
        inputs: dict[str, np.ndarray] = {}
        for name in input_names:
            if name == "input_ids":
                inputs[name] = ids
            elif name == "attention_mask":
                inputs[name] = mask
            elif name == "token_type_ids":
                inputs[name] = token_types

        logits = np.asarray(session.run(None, inputs)[0], dtype=np.float64)
        probabilities = _softmax(logits)[0]
        negative = float(probabilities[0])
        positive = float(probabilities[1])
        label_index = int(np.argmax(probabilities))
        predictions.append(
            SentimentPrediction(
                value=round(positive - negative, 4),
                confidence=round(max(negative, positive), 4),
                label=id_to_label.get(label_index, str(label_index)),
                negative_probability=round(negative, 6),
                positive_probability=round(positive, 6),
                token_count=len(full.ids),
                truncated=truncated,
                method="onnx",
            )
        )
    return predictions


def classify_vader(texts: list[str]) -> list[SentimentPrediction]:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

    analyzer = SentimentIntensityAnalyzer()
    predictions: list[SentimentPrediction] = []
    for text in texts:
        scores = analyzer.polarity_scores(text)
        compound = float(scores["compound"])
        negative = float(scores["neg"])
        positive = float(scores["pos"])
        label = "NEGATIVE" if compound < -0.05 else "POSITIVE" if compound > 0.05 else "NEUTRAL"
        predictions.append(
            SentimentPrediction(
                value=round(compound, 4),
                confidence=round(max(negative, positive, float(scores["neu"])), 4),
                label=label,
                negative_probability=round(negative, 6),
                positive_probability=round(positive, 6),
                token_count=None,
                truncated=False,
                method="vader",
            )
        )
    return predictions


def classify_texts(texts: list[str], method: SentimentMethod) -> list[SentimentPrediction]:
    if method == "vader":
        return classify_vader(texts)
    return classify_onnx(texts)


def measures_from_predictions(
    utterances: list[UtteranceInput],
    predictions: list[SentimentPrediction],
) -> list[dict[str, Any]]:
    measures: list[dict[str, Any]] = []
    for utterance, prediction in zip(utterances, predictions, strict=True):
        measures.append(
            {
                "kind": "sentiment",
                "category": "sentiment",
                "t_start_ms": utterance.t0_ms,
                "t_end_ms": utterance.t1_ms,
                "value_num": prediction.value,
                "value_text": None,
                "unit": "score",
                "confidence": prediction.confidence,
                "source": "video_analysis",
                "payload": {
                    "utterance_measure_id": utterance.id,
                    "label": prediction.label,
                    "negative_probability": prediction.negative_probability,
                    "positive_probability": prediction.positive_probability,
                    "score_convention": "positive_probability_minus_negative_probability",
                    "method": prediction.method,
                    "model_repo": MODEL_REPO if prediction.method == "onnx" else None,
                    "model_revision": MODEL_REVISION if prediction.method == "onnx" else None,
                    "model_file": MODEL_FILE if prediction.method == "onnx" else None,
                    "max_tokens": MAX_TOKENS if prediction.method == "onnx" else None,
                    "token_count": prediction.token_count,
                    "truncated": prediction.truncated,
                },
            }
        )
    return measures


class SentimentProvider:
    @property
    def id(self) -> str:
        return PROVIDER_ID

    @property
    def version(self) -> str:
        return PROVIDER_VERSION

    @property
    def requires(self) -> list[str]:
        return ["measure:utterance"]

    @property
    def provides(self) -> list[str]:
        return ["measure:sentiment"]

    def run(self, context: PipelineContext) -> list[dict[str, Any]]:
        context.heartbeat(self.id, 5, "Loading utterances")
        utterances = _read_utterances(context)
        if not utterances:
            context.report_provider_summary(
                self.id,
                {"status": "skipped", "reason": "no_utterances", "sentiment_count": 0},
            )
            return []

        method = _config_method(context)
        context.heartbeat(self.id, 20, "Classifying narration sentiment")
        predictions = classify_texts([utterance.text for utterance in utterances], method)
        measures = measures_from_predictions(utterances, predictions)

        counts = {"positive": 0, "negative": 0, "neutral": 0}
        for prediction in predictions:
            if prediction.value > 0.15:
                counts["positive"] += 1
            elif prediction.value < -0.15:
                counts["negative"] += 1
            else:
                counts["neutral"] += 1
        context.report_provider_summary(
            self.id,
            {
                "status": "ok",
                "method": method,
                "sentiment_count": len(measures),
                **counts,
            },
        )
        context.heartbeat(self.id, 95, f"Classified {len(measures)} utterances")
        return measures
