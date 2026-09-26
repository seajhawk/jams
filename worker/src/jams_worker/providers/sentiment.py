"""Narration sentiment: one measure per utterance, from whichever model the run selects.

Models live behind ``sentiment_models.SentimentModel``; this provider only picks one, applies the
optional fallback, and writes canonical measures with the model's provenance.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from jams_worker.pipeline import PipelineContext
from jams_worker.providers import sentiment_models
from jams_worker.providers.sentiment_models import SentimentModel, SentimentPrediction

__all__ = [
    "SentimentPrediction",
    "SentimentProvider",
    "UtteranceInput",
    "classify_vader",
    "measures_from_predictions",
]

PROVIDER_ID = "sentiment"
PROVIDER_VERSION = "1.2.0"


@dataclass(frozen=True, slots=True)
class UtteranceInput:
    id: str
    t0_ms: int
    t1_ms: int
    text: str
    confidence: float | None


def _sentiment_config(context: PipelineContext) -> dict[str, Any]:
    config = context.run.get("config")
    if not isinstance(config, dict):
        return {}
    sentiment_config = config.get("sentiment")
    result = dict(sentiment_config) if isinstance(sentiment_config, dict) else {}
    # Legacy shapes: sentiment.method / top-level sentiment_method ("onnx" = the default model).
    legacy = result.get("method", config.get("sentiment_method"))
    if "model" not in result and isinstance(legacy, str):
        result["model"] = "vader" if legacy == "vader" else None
    return result


def select_models(context: PipelineContext) -> tuple[str, str | None]:
    """The primary model id and, when configured, the fallback model id."""
    config = _sentiment_config(context)
    requested = config.get("model")
    primary = sentiment_models.resolve_model_id(requested if isinstance(requested, str) else None)
    fallback = config.get("fallback")
    fallback_id = fallback if isinstance(fallback, str) and fallback not in ("", "none") else None
    if fallback_id is not None:
        sentiment_models.resolve_model_id(fallback_id)
    return primary, fallback_id


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


def classify_vader(texts: list[str]) -> list[SentimentPrediction]:
    return sentiment_models.get_model("vader").classify(texts)


def measures_from_predictions(
    utterances: list[UtteranceInput],
    predictions: list[SentimentPrediction],
    model: SentimentModel | None = None,
) -> list[dict[str, Any]]:
    model = model or sentiment_models.get_model(sentiment_models.DEFAULT_MODEL_ID)
    provenance = model.provenance()
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
                    "model_id": provenance.get("model_id"),
                    "model_repo": provenance.get("model_repo"),
                    "model_revision": provenance.get("model_revision"),
                    "model_file": provenance.get("model_file"),
                    "max_tokens": provenance.get("max_tokens"),
                    "remote_host": provenance.get("remote_host"),
                    "remote_model": provenance.get("remote_model"),
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

        primary_id, fallback_id = select_models(context)
        texts = [utterance.text for utterance in utterances]
        context.heartbeat(self.id, 20, "Classifying narration sentiment")
        model = sentiment_models.get_model(primary_id)
        fallback_reason: str | None = None
        try:
            predictions = model.classify(texts)
        except Exception as exc:
            if fallback_id is None:
                raise
            fallback_reason = f"{primary_id} failed: {type(exc).__name__}: {exc}"[:300]
            model = sentiment_models.get_model(fallback_id)
            predictions = model.classify(texts)
        measures = measures_from_predictions(utterances, predictions, model)

        counts = {"positive": 0, "negative": 0, "neutral": 0}
        for prediction in predictions:
            if prediction.value > 0.15:
                counts["positive"] += 1
            elif prediction.value < -0.15:
                counts["negative"] += 1
            else:
                counts["neutral"] += 1
        summary: dict[str, Any] = {
            "status": "ok",
            "method": model.method,
            "model_id": model.model_id,
            "sentiment_count": len(measures),
            **counts,
        }
        if fallback_reason is not None:
            summary["fallback_used"] = True
            summary["fallback_reason"] = fallback_reason
        context.report_provider_summary(self.id, summary)
        context.heartbeat(self.id, 95, f"Classified {len(measures)} utterances")
        return measures
