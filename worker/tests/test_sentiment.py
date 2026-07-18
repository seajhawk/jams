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
                "model_repo": "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
                "model_revision": "0b6928efcb76139cae2c6881d49cda67fe119f42",
                "model_file": "onnx/model_int8.onnx",
                "max_tokens": 256,
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
