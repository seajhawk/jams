"""Swappable sentiment models behind one interface.

The sentiment provider asks this module for a model by id and never knows whether it is a local
ONNX classifier, a lexicon, or a remote endpoint. Adding a model means adding one registry entry.

Selection order: the run's ``sentiment.model`` config, then the ``JAMS_SENTIMENT_MODEL``
environment variable, then ``DEFAULT_MODEL_ID``. Remote models are never a default: they must be
named explicitly, and tests exercise them through an injected transport (no network in CI).
"""

from __future__ import annotations

import json
import os
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import numpy as np

DEFAULT_MODEL_ID = "roberta-3class"
DEFAULT_MODEL_CACHE = Path.home() / ".cache" / "jams-worker" / "sentiment"
MAX_TOKENS = 256


@dataclass(frozen=True)
class SentimentPrediction:
    value: float
    confidence: float
    label: str
    negative_probability: float
    positive_probability: float
    token_count: int | None = None
    truncated: bool = False
    method: str = "onnx"


class SentimentModel(Protocol):
    model_id: str
    method: str

    def prepare(self) -> None:
        """Fetch or warm whatever the model needs; called at image build and before classify."""

    def classify(self, texts: list[str]) -> list[SentimentPrediction]: ...

    def provenance(self) -> dict[str, Any]:
        """Stored on every measure so a score can always be traced to the exact model."""


def model_cache_dir() -> Path:
    raw = os.environ.get("JAMS_SENTIMENT_MODEL_CACHE")
    return Path(raw).expanduser() if raw else DEFAULT_MODEL_CACHE


def _softmax(values: np.ndarray) -> np.ndarray:
    shifted = values - np.max(values, axis=-1, keepdims=True)
    exp = np.exp(shifted)
    return exp / np.sum(exp, axis=-1, keepdims=True)


def _label_index(id_to_label: dict[int, str], prefix: str) -> int:
    for index, label in id_to_label.items():
        if label.lower().startswith(prefix):
            return index
    raise RuntimeError(f"sentiment model has no label starting with {prefix!r}: {id_to_label}")


@dataclass
class HfOnnxSentimentModel:
    """A Hugging Face sequence classifier exported to ONNX, pinned to an exact revision.

    Works for two-class (negative/positive) and three-class (negative/neutral/positive) models:
    labels are resolved by name from the model's config, and neutral mass pulls the value to 0.
    """

    model_id: str
    repo: str
    revision: str
    file: str
    max_tokens: int = MAX_TOKENS
    method: str = "onnx"
    _runtime: tuple[Any, Any, dict[int, str]] | None = field(default=None, repr=False)

    def _download(self) -> tuple[Path, Path]:
        from huggingface_hub import snapshot_download

        cache = model_cache_dir()
        cache.mkdir(parents=True, exist_ok=True)
        model_path = Path(
            snapshot_download(
                repo_id=self.repo,
                revision=self.revision,
                cache_dir=cache,
                allow_patterns=[
                    self.file,
                    "config.json",
                    "tokenizer.json",
                    "tokenizer_config.json",
                    "special_tokens_map.json",
                    "vocab.txt",
                ],
            )
        )
        return model_path / self.file, model_path / "tokenizer.json"

    def prepare(self) -> None:
        model_path, tokenizer_path = self._download()
        if not model_path.is_file() or not tokenizer_path.is_file():
            raise RuntimeError(f"sentiment model {self.model_id} did not produce required files")

    def _load(self) -> tuple[Any, Any, dict[int, str]]:
        if self._runtime is not None:
            return self._runtime
        import onnxruntime as ort
        from tokenizers import Tokenizer

        model_path, tokenizer_path = self._download()
        options = ort.SessionOptions()
        options.intra_op_num_threads = min(4, os.cpu_count() or 1)
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(
            str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        tokenizer = Tokenizer.from_file(str(tokenizer_path))
        config = json.loads((model_path.parents[1] / "config.json").read_text(encoding="utf-8"))
        id_to_label = {
            int(key): str(value).upper()
            for key, value in dict(config.get("id2label", {0: "NEGATIVE", 1: "POSITIVE"})).items()
        }
        self._runtime = (session, tokenizer, id_to_label)
        return self._runtime

    def classify(self, texts: list[str]) -> list[SentimentPrediction]:
        session, tokenizer, id_to_label = self._load()
        input_names = {item.name for item in session.get_inputs()}
        negative_index = _label_index(id_to_label, "neg")
        positive_index = _label_index(id_to_label, "pos")
        predictions: list[SentimentPrediction] = []
        for text in texts:
            full = tokenizer.encode(text)
            truncated = len(full.ids) > self.max_tokens
            tokenizer.enable_truncation(max_length=self.max_tokens)
            encoded = tokenizer.encode(text)
            tokenizer.no_truncation()

            ids = np.asarray([encoded.ids], dtype=np.int64)
            inputs: dict[str, np.ndarray] = {}
            if "input_ids" in input_names:
                inputs["input_ids"] = ids
            if "attention_mask" in input_names:
                inputs["attention_mask"] = np.asarray([encoded.attention_mask], dtype=np.int64)
            if "token_type_ids" in input_names:
                inputs["token_type_ids"] = np.zeros_like(ids)

            logits = np.asarray(session.run(None, inputs)[0], dtype=np.float64)
            probabilities = _softmax(logits)[0]
            negative = float(probabilities[negative_index])
            positive = float(probabilities[positive_index])
            label_index = int(np.argmax(probabilities))
            predictions.append(
                SentimentPrediction(
                    value=round(positive - negative, 4),
                    confidence=round(float(probabilities[label_index]), 4),
                    label=id_to_label.get(label_index, str(label_index)),
                    negative_probability=round(negative, 6),
                    positive_probability=round(positive, 6),
                    token_count=len(full.ids),
                    truncated=truncated,
                    method=self.method,
                )
            )
        return predictions

    def provenance(self) -> dict[str, Any]:
        return {
            "model_id": self.model_id,
            "model_repo": self.repo,
            "model_revision": self.revision,
            "model_file": self.file,
            "max_tokens": self.max_tokens,
        }


@dataclass
class VaderSentimentModel:
    """Deterministic lexicon fallback; no download, no network."""

    model_id: str = "vader"
    method: str = "vader"

    def prepare(self) -> None:
        return None

    def classify(self, texts: list[str]) -> list[SentimentPrediction]:
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

        analyzer = SentimentIntensityAnalyzer()
        predictions: list[SentimentPrediction] = []
        for text in texts:
            scores = analyzer.polarity_scores(text)
            compound = float(scores["compound"])
            label = "NEGATIVE" if compound < -0.05 else "POSITIVE" if compound > 0.05 else "NEUTRAL"
            predictions.append(
                SentimentPrediction(
                    value=round(compound, 4),
                    confidence=round(abs(compound), 4),
                    label=label,
                    negative_probability=round(float(scores["neg"]), 6),
                    positive_probability=round(float(scores["pos"]), 6),
                    method=self.method,
                )
            )
        return predictions

    def provenance(self) -> dict[str, Any]:
        return {"model_id": self.model_id}


Transport = Callable[[str, dict[str, str], dict[str, Any], float], dict[str, Any]]

REMOTE_PROMPT = (
    "Classify the sentiment of each numbered line of spoken narration from someone performing a "
    "task on a computer. Plain instructions and descriptions of actions are neutral. Return only "
    'JSON: {"results": [{"i": <line number>, "negative": p, "neutral": p, "positive": p}, ...]} '
    "with probabilities summing to 1 for every line."
)


def _urllib_transport(
    url: str, headers: dict[str, str], body: dict[str, Any], timeout: float
) -> dict[str, Any]:
    request = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST"
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


@dataclass
class RemoteChatSentimentModel:
    """Any OpenAI-compatible chat-completions endpoint (OpenRouter, Azure OpenAI, a local server).

    Configured entirely by environment so no endpoint or key ever lives in run config:
    ``JAMS_SENTIMENT_REMOTE_URL``, ``JAMS_SENTIMENT_REMOTE_MODEL``, and the name of the variable
    holding the key in ``JAMS_SENTIMENT_REMOTE_KEY_ENV`` (default ``OPENROUTER_API_KEY``).
    """

    model_id: str = "remote"
    method: str = "remote"
    batch_size: int = 20
    timeout_seconds: float = 60.0
    transport: Transport = _urllib_transport

    def _settings(self) -> tuple[str, str, str]:
        url = os.environ.get(
            "JAMS_SENTIMENT_REMOTE_URL", "https://openrouter.ai/api/v1/chat/completions"
        )
        model = os.environ.get("JAMS_SENTIMENT_REMOTE_MODEL")
        key = os.environ.get(os.environ.get("JAMS_SENTIMENT_REMOTE_KEY_ENV", "OPENROUTER_API_KEY"))
        if not model or not key:
            raise RuntimeError(
                "remote sentiment needs JAMS_SENTIMENT_REMOTE_MODEL and an API key variable"
            )
        return url, model, key

    def prepare(self) -> None:
        self._settings()

    def classify(self, texts: list[str]) -> list[SentimentPrediction]:
        url, model, key = self._settings()
        predictions: list[SentimentPrediction] = []
        for start in range(0, len(texts), self.batch_size):
            batch = texts[start : start + self.batch_size]
            numbered = "\n".join(f"{i}. {text}" for i, text in enumerate(batch))
            body = {
                "model": model,
                "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": REMOTE_PROMPT},
                    {"role": "user", "content": numbered},
                ],
            }
            headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
            response = self.transport(url, headers, body, self.timeout_seconds)
            content = response["choices"][0]["message"]["content"]
            results = {int(item["i"]): item for item in json.loads(content)["results"]}
            for i in range(len(batch)):
                if i not in results:
                    raise RuntimeError(f"remote sentiment omitted line {i}")
                probs = np.asarray(
                    [float(results[i][name]) for name in ("negative", "neutral", "positive")]
                )
                probs = probs / probs.sum() if probs.sum() > 0 else np.full(3, 1 / 3)
                label_index = int(np.argmax(probs))
                predictions.append(
                    SentimentPrediction(
                        value=round(float(probs[2] - probs[0]), 4),
                        confidence=round(float(probs[label_index]), 4),
                        label=("NEGATIVE", "NEUTRAL", "POSITIVE")[label_index],
                        negative_probability=round(float(probs[0]), 6),
                        positive_probability=round(float(probs[2]), 6),
                        method=self.method,
                    )
                )
        return predictions

    def provenance(self) -> dict[str, Any]:
        url = os.environ.get(
            "JAMS_SENTIMENT_REMOTE_URL", "https://openrouter.ai/api/v1/chat/completions"
        )
        return {
            "model_id": self.model_id,
            "remote_host": urllib.request.urlparse(url).hostname,
            "remote_model": os.environ.get("JAMS_SENTIMENT_REMOTE_MODEL"),
        }


REGISTRY: dict[str, Callable[[], SentimentModel]] = {
    # Three-class default (2026-09-26). Has a neutral class, so plain narration is not frustration.
    "roberta-3class": lambda: HfOnnxSentimentModel(
        model_id="roberta-3class",
        repo="Xenova/twitter-roberta-base-sentiment-latest",
        revision="f3ec4d0925f90c3ca7ee7814f52d6ee7cf180445",
        file="onnx/model_int8.onnx",
    ),
    # The original two-class model, kept so old runs can be reproduced and compared.
    "sst2": lambda: HfOnnxSentimentModel(
        model_id="sst2",
        repo="Xenova/distilbert-base-uncased-finetuned-sst-2-english",
        revision="0b6928efcb76139cae2c6881d49cda67fe119f42",
        file="onnx/model_int8.onnx",
    ),
    "vader": VaderSentimentModel,
    "remote": RemoteChatSentimentModel,
}

_instances: dict[str, SentimentModel] = {}


def resolve_model_id(requested: str | None) -> str:
    model_id = requested or os.environ.get("JAMS_SENTIMENT_MODEL") or DEFAULT_MODEL_ID
    if model_id not in REGISTRY:
        raise ValueError(f"Unsupported sentiment model: {model_id}")
    return model_id


def get_model(model_id: str) -> SentimentModel:
    """One instance per model id per process, so an ONNX session loads once."""
    if model_id not in _instances:
        _instances[model_id] = REGISTRY[model_id]()
    return _instances[model_id]
