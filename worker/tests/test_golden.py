"""Unit tests for golden-fixture assertion helpers."""

from __future__ import annotations

import golden as g
import pytest
from golden import _normalize_text

from jams_worker.ffmpeg import ffmpeg_path


def test_cut_match_exact_match() -> None:
    result = g.cut_match([1000, 5000], [1000, 5000], tolerance_ms=1000)

    assert result.tp == 2
    assert result.fp == 0
    assert result.fn == 0
    assert result.f1 == 1.0


def test_cut_match_tolerance_hit() -> None:
    result = g.cut_match([5000], [5800], tolerance_ms=1000)

    assert result.tp == 1
    assert result.fp == 0
    assert result.fn == 0


def test_cut_match_miss() -> None:
    result = g.cut_match([5000], [7000], tolerance_ms=1000)

    assert result.tp == 0
    assert result.fp == 1
    assert result.fn == 1
    assert result.f1 == 0.0


def test_cut_match_false_positive() -> None:
    result = g.cut_match([5000], [5000, 10000], tolerance_ms=1000)

    assert result.tp == 1
    assert result.fp == 1
    assert result.fn == 0


def test_cut_match_greedy_ordering() -> None:
    result = g.cut_match([1000, 6000], [1500, 6500], tolerance_ms=1000)

    assert result.tp == 2


def test_cut_match_empty_expected_some_detected() -> None:
    result = g.cut_match([], [1000, 2000], tolerance_ms=1000)

    assert result.tp == 0
    assert result.fp == 2
    assert result.fn == 0
    assert result.precision == 0.0


def test_cut_match_empty_both() -> None:
    result = g.cut_match([], [], tolerance_ms=1000)

    assert result.tp == 0
    assert result.fp == 0
    assert result.fn == 0
    assert result.f1 == 0.0


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Hello, World!", "hello world"),
        ("foo  bar", "foo bar"),
        ("it's", "its"),
    ],
)
def test_normalize_text(text: str, expected: str) -> None:
    assert _normalize_text(text) == expected


def test_compute_wer_empty_strings() -> None:
    assert g.compute_wer("", "") == 0.0


def test_utterance_invariants_happy_path() -> None:
    g.assert_utterance_invariants(
        [
            {
                "t_start_ms": 1000,
                "t_end_ms": 1900,
                "payload": {
                    "words": [
                        {"t0": 1020, "t1": 1200},
                        {"t0": 1250, "t1": 1430},
                        {"t0": 1500, "t1": 1680},
                    ]
                },
            }
        ]
    )


def test_utterance_invariants_word_out_of_order() -> None:
    with pytest.raises(AssertionError):
        g.assert_utterance_invariants(
            [
                {
                    "t_start_ms": 1000,
                    "t_end_ms": 1900,
                    "payload": {
                        "words": [
                            {"t0": 1300, "t1": 1400},
                            {"t0": 1200, "t1": 1500},
                        ]
                    },
                }
            ]
        )


def test_utterance_invariants_non_overlapping_utterances() -> None:
    g.assert_utterance_invariants(
        [
            {"t_start_ms": 1000, "t_end_ms": 1400, "payload": {"words": []}},
            {"t_start_ms": 1400, "t_end_ms": 1800, "payload": {"words": []}},
        ]
    )


def test_utterance_invariants_overlapping_utterances() -> None:
    with pytest.raises(AssertionError):
        g.assert_utterance_invariants(
            [
                {"t_start_ms": 1000, "t_end_ms": 1500, "payload": {"words": []}},
                {"t_start_ms": 1400, "t_end_ms": 1800, "payload": {"words": []}},
            ]
        )


def test_audio_video_aligned() -> None:
    g.assert_audio_video_aligned(25000, 25400)

    with pytest.raises(AssertionError):
        g.assert_audio_video_aligned(25000, 25600)


def test_timestamps_bounded() -> None:
    g.assert_timestamps_bounded(
        [{"t_start_ms": 1000, "t_end_ms": 25250, "payload": {"words": []}}],
        video_duration_ms=25000,
    )

    with pytest.raises(AssertionError):
        g.assert_timestamps_bounded(
            [{"t_start_ms": 1000, "t_end_ms": 25251, "payload": {"words": []}}],
            video_duration_ms=25000,
        )


def test_cross_stage() -> None:
    g.assert_cross_stage(cut_ms=5100, first_word_t0_ms=4900, video_duration_ms=25010)

    with pytest.raises(AssertionError):
        g.assert_cross_stage(cut_ms=5300, first_word_t0_ms=4900, video_duration_ms=25010)


def test_tolerances_include_pinned_transient_mix() -> None:
    tolerances = g.load_tolerances()

    assert tolerances["audio"]["transient_to_speech_db"] == -6.0
    assert tolerances["provider_gates_pending"]["in_speech_click_recall"] == 0.60


def test_parse_offsets_jsonl(tmp_path) -> None:
    path = tmp_path / "offsets.jsonl"
    path.write_text(
        '{"kind":"click","t_ms":100,"recipe":"mouse_click_v1"}\n'
        '{"kind":"click","t_ms":250,"recipe":"mouse_click_v1"}\n'
    )

    assert g.parse_offsets_jsonl(path) == [100, 250]


def test_resolve_flash_alignment(tmp_path) -> None:
    video = tmp_path / "flashes.mp4"
    events = tmp_path / "events.jsonl"
    subprocess_args = [
        ffmpeg_path(),
        "-y",
        "-filter_complex",
        (
            "color=c=black:s=160x120:r=30:d=1.0[v0];"
            "color=c=white:s=160x120:r=30:d=0.1[v1];"
            "color=c=black:s=160x120:r=30:d=0.5[v2];"
            "color=c=white:s=160x120:r=30:d=0.1[v3];"
            "color=c=black:s=160x120:r=30:d=1.0[v4];"
            "[v0][v1][v2][v3][v4]concat=n=5:v=1:a=0[v]"
        ),
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        str(video),
    ]
    import subprocess

    subprocess.run(subprocess_args, capture_output=True, check=True)
    events.write_text(
        '{"kind":"sync_flash","phase":"start","index":1,"t_ms":1000}\n'
        '{"kind":"sync_flash","phase":"start","index":2,"t_ms":1600}\n'
    )

    alignment = g.resolve_flash_alignment(video, events)

    assert alignment.video_flash_ms[0] == pytest.approx(1050, abs=40)
    assert alignment.video_flash_ms[1] == pytest.approx(1650, abs=40)
    assert alignment.event_to_video_ms(1000) == alignment.video_flash_ms[0]
