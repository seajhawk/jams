"""Tests for sentiment provider measure shaping and fallback classifier."""

from __future__ import annotations

from jams_worker.providers.sentiment import (
    SentimentPrediction,
    UtteranceInput,
    classify_vader,
    measures_from_predictions,
)


def test_sentiment_measures_use_utterance_spans_and_score_convention() -> None:
    utterances = [
        UtteranceInput(
            id="measure-1",
            t0_ms=1_000,
            t1_ms=2_500,
            text="This is frustrating.",
            confidence=0.91,
        )
    ]
    predictions = [
        SentimentPrediction(
            value=-0.75,
            confidence=0.875,
            label="NEGATIVE",
            negative_probability=0.875,
            positive_probability=0.125,
            token_count=6,
            truncated=False,
        )
    ]

    measures = measures_from_predictions(utterances, predictions)

    assert measures == [
        {
            "kind": "sentiment",
            "category": "sentiment",
            "t_start_ms": 1_000,
            "t_end_ms": 2_500,
            "value_num": -0.75,
            "value_text": None,
            "unit": "score",
            "confidence": 0.875,
            "source": "video_analysis",
            "payload": {
                "utterance_measure_id": "measure-1",
                "label": "NEGATIVE",
                "negative_probability": 0.875,
                "positive_probability": 0.125,
                "score_convention": "positive_probability_minus_negative_probability",
                "method": "onnx",
                "model_id": "roberta-3class",
                "model_repo": "Xenova/twitter-roberta-base-sentiment-latest",
                "model_revision": "f3ec4d0925f90c3ca7ee7814f52d6ee7cf180445",
                "model_file": "onnx/model_int8.onnx",
                "max_tokens": 256,
                "remote_host": None,
                "remote_model": None,
                "token_count": 6,
                "truncated": False,
            },
        }
    ]


def test_vader_fallback_is_deterministic_for_fixed_sentences() -> None:
    predictions = classify_vader(
        [
            "This worked perfectly and I am happy.",
            "This failed again and I hate this error.",
            "The window is open.",
        ]
    )

    assert predictions[0].value > 0.15
    assert predictions[1].value < -0.15
    assert -0.15 <= predictions[2].value <= 0.15


class _Run:
    def __init__(self, config: object) -> None:
        self.run = {"config": config}


def test_model_selection_prefers_run_config_then_env_then_default(monkeypatch) -> None:
    from jams_worker.providers.sentiment import select_models

    monkeypatch.delenv("JAMS_SENTIMENT_MODEL", raising=False)
    assert select_models(_Run({})) == ("roberta-3class", None)
    monkeypatch.setenv("JAMS_SENTIMENT_MODEL", "sst2")
    assert select_models(_Run({})) == ("sst2", None)
    assert select_models(_Run({"sentiment": {"model": "vader"}})) == ("vader", None)
    # Legacy shapes keep working: method "vader" selects VADER, "onnx" means the default.
    assert select_models(_Run({"sentiment": {"method": "vader"}}))[0] == "vader"
    assert select_models(_Run({"sentiment_method": "onnx"}))[0] == "sst2"
    assert select_models(_Run({"sentiment": {"fallback": "vader"}})) == ("sst2", "vader")
    assert select_models(_Run({"sentiment": {"fallback": "none"}})) == ("sst2", None)


def test_unknown_model_is_rejected() -> None:
    import pytest

    from jams_worker.providers.sentiment_models import resolve_model_id

    with pytest.raises(ValueError, match="Unsupported sentiment model"):
        resolve_model_id("not-a-model")


def test_remote_model_parses_batched_probabilities_without_network(monkeypatch) -> None:
    import json

    from jams_worker.providers.sentiment_models import RemoteChatSentimentModel

    monkeypatch.setenv("JAMS_SENTIMENT_REMOTE_MODEL", "some/model")
    monkeypatch.setenv("JAMS_SENTIMENT_REMOTE_KEY_ENV", "TEST_SENTIMENT_KEY")
    monkeypatch.setenv("TEST_SENTIMENT_KEY", "k")
    calls: list[dict] = []

    def transport(url, headers, body, timeout):
        calls.append(body)
        results = [
            {"i": 0, "negative": 0.1, "neutral": 0.8, "positive": 0.1},
            {"i": 1, "negative": 0.9, "neutral": 0.05, "positive": 0.05},
        ]
        return {"choices": [{"message": {"content": json.dumps({"results": results})}}]}

    model = RemoteChatSentimentModel(transport=transport)
    predictions = model.classify(["Click the button.", "Why is this failing again?"])

    assert len(calls) == 1 and calls[0]["model"] == "some/model"
    assert predictions[0].label == "NEUTRAL" and predictions[0].value == 0.0
    assert predictions[1].label == "NEGATIVE" and predictions[1].value == -0.85
    assert model.provenance()["remote_model"] == "some/model"


def test_remote_model_requires_explicit_configuration(monkeypatch) -> None:
    import pytest

    from jams_worker.providers.sentiment_models import RemoteChatSentimentModel

    monkeypatch.delenv("JAMS_SENTIMENT_REMOTE_MODEL", raising=False)
    with pytest.raises(RuntimeError, match="JAMS_SENTIMENT_REMOTE_MODEL"):
        RemoteChatSentimentModel(transport=lambda *a: {}).classify(["x"])


def test_provider_falls_back_and_says_so(monkeypatch) -> None:
    from jams_worker.providers import sentiment, sentiment_models

    class Broken:
        model_id = "roberta-3class"
        method = "onnx"

        def classify(self, texts):
            raise RuntimeError("model file missing")

        def provenance(self):
            return {"model_id": self.model_id}

    monkeypatch.delenv("JAMS_SENTIMENT_MODEL", raising=False)
    monkeypatch.setitem(sentiment_models._instances, "roberta-3class", Broken())
    utterance = sentiment.UtteranceInput(
        "m1", 0, 1000, "This failed again and I hate this error.", None
    )
    monkeypatch.setattr(sentiment, "_read_utterances", lambda context: [utterance])
    summaries: dict = {}

    class Context:
        run = {"config": {"sentiment": {"fallback": "vader"}}}

        def heartbeat(self, *args):
            pass

        def report_provider_summary(self, provider_id, summary):
            summaries[provider_id] = summary

    measures = sentiment.SentimentProvider().run(Context())

    assert measures[0]["payload"]["model_id"] == "vader"
    assert measures[0]["value_num"] < -0.15
    assert summaries["sentiment"]["fallback_used"] is True
    assert "model file missing" in summaries["sentiment"]["fallback_reason"]


def test_provider_without_fallback_raises(monkeypatch) -> None:
    import pytest

    from jams_worker.providers import sentiment, sentiment_models

    class Broken:
        model_id = "roberta-3class"
        method = "onnx"

        def classify(self, texts):
            raise RuntimeError("boom")

        def provenance(self):
            return {"model_id": self.model_id}

    monkeypatch.delenv("JAMS_SENTIMENT_MODEL", raising=False)
    monkeypatch.setitem(sentiment_models._instances, "roberta-3class", Broken())
    monkeypatch.setattr(
        sentiment, "_read_utterances", lambda c: [sentiment.UtteranceInput("m", 0, 1, "hi", None)]
    )

    class Context:
        run = {"config": {}}

        def heartbeat(self, *args):
            pass

        def report_provider_summary(self, *args):
            pass

    with pytest.raises(RuntimeError, match="boom"):
        sentiment.SentimentProvider().run(Context())
