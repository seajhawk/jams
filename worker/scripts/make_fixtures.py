"""Generate deterministic media fixtures and ground-truth metadata."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from jams_worker.ffmpeg import ffmpeg_paths

WORKER_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = WORKER_ROOT.parent
DEFAULT_OUT = WORKER_ROOT / "tests" / "fixtures" / "generated"

W, H = 640, 480
FPS = 30
_VID = [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-r",
    "30",
    "-pix_fmt",
    "yuv420p",
]

SW_DURATIONS = (8.0, 5.0, 12.0, 6.5, 9.0)
SW_TOTAL = sum(SW_DURATIONS)
SW_CUTS_MS = [int(sum(SW_DURATIONS[: i + 1]) * 1000) for i in range(len(SW_DURATIONS) - 1)]
SW_COLORS = ("0xCC2222", "0x2222CC", "0x22BB22", "0xCCCC22", "0x22CCCC")

TABS_BODY_COLOR = "0x888888"
TABS_COLORS = ("0xAA3333", "0x3333AA", "0x33AA33", "0xAAAA33", "0x33AAAA")
TABS_STRIP_H = 80

SCROLL_PART_S = 10.0
SCROLL_TOTAL = 20.0
SCROLL_CUT_MS = 10000
SCROLL_SPEED_PX = 110
SCROLL_TALL_W, SCROLL_TALL_H = 640, 2500

DRAG_TOTAL = 12.0

IDLE_TOTAL = 120.0

SILENCE_TOTAL = 60.0
TONES_TOTAL = 45.0

ESPEAK_VOICE = "en-us"
ESPEAK_SPEED = 150
ESPEAK_TEXT = (
    "i opened the browser and signed into the project dashboard "
    "then i followed the tutorial steps created a new app chose the sample settings "
    "and waited for the deployment to finish "
    "next i reviewed the status page compared the result with the guide fixed one setting "
    "and confirmed the app loaded for the team "
    "after that i explained what changed and saved the notes"
)
ESPEAK_TOTAL = 60.0
SPEECH_OFFSET_1_MS = 5000
SPEECH_OFFSET_2_MS = 60000
SPEECH_OFFSETS_TOTAL = 75.0
AV_SYNC_CUT_S = 5.0
AV_SYNC_CUT_MS = 5000
AV_SYNC_TOTAL = 25.0
AV_SYNC_TEXT = "synchronised speech for cross stage alignment check"

REAL_CLIPS: list[dict[str, Any]] = [
    {
        "id": "real/amazed-frustrated",
        "path": str(REPO_ROOT / "videos" / "Sample_Amazed then Frustrated.m4a"),
        "kind": "audio",
        "transcript": "PENDING_HUMAN",
        "context_switches": "PENDING_HUMAN",
        "tts_pending": False,
    },
    {
        "id": "real/context-switches-shot-change",
        "path": str(
            REPO_ROOT / "videos" / "SettingUpGoogleVideoAnalyzerForContextSwitches-ShotChange.mp4"
        ),
        "kind": "video",
        "transcript": "PENDING_HUMAN",
        "context_switches": "PENDING_HUMAN",
        "tts_pending": False,
    },
]


def _run_cmd(args: list[str], check: bool = True) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(args, capture_output=True, check=check)


def _write_tall_ppm(path: Path) -> None:
    rows = []
    for y in range(SCROLL_TALL_H):
        band = (y // 100) % 4
        r = min(255, 60 + y * 150 // SCROLL_TALL_H)
        g = min(255, 60 + (SCROLL_TALL_H - y) * 150 // SCROLL_TALL_H)
        b = 128 + 60 * (1 if band % 2 == 0 else -1)
        rows.append(bytes([r, g, b]) * SCROLL_TALL_W)
    with path.open("wb") as f:
        f.write(f"P6\n{SCROLL_TALL_W} {SCROLL_TALL_H}\n255\n".encode())
        f.write(b"".join(rows))


def _espeak_available() -> bool:
    return shutil.which("espeak-ng") is not None


def _run_espeak(text: str, out_wav: Path) -> None:
    subprocess.run(
        [
            "espeak-ng",
            "-v",
            ESPEAK_VOICE,
            "-s",
            str(ESPEAK_SPEED),
            "-w",
            str(out_wav),
            text,
        ],
        check=True,
        capture_output=True,
    )


def _gen_synth_switches(ffmpeg: str, out: Path) -> dict[str, Any]:
    filters = [
        f"color=c={color}:s={W}x{H}:r={FPS}:d={duration}[v{i}]"
        for i, (color, duration) in enumerate(zip(SW_COLORS, SW_DURATIONS, strict=True))
    ]
    filters.append("".join(f"[v{i}]" for i in range(len(SW_DURATIONS))) + "concat=n=5:v=1:a=0[v]")
    _run_cmd(
        [
            ffmpeg,
            "-y",
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[v]",
            *_VID,
            str(out / "synth_switches.mp4"),
        ]
    )
    return {
        "id": "synth_switches",
        "file": "synth_switches.mp4",
        "kind": "video",
        "duration_ms": int(SW_TOTAL * 1000),
        "has_audio": False,
        "fps": FPS,
        "cuts_ms": SW_CUTS_MS,
        "tts_pending": False,
    }


def _gen_synth_tabs(ffmpeg: str, out: Path) -> dict[str, Any]:
    filters = []
    body_h = H - TABS_STRIP_H
    for i, (color, duration) in enumerate(zip(TABS_COLORS, SW_DURATIONS, strict=True)):
        filters.extend(
            [
                f"color=c={color}:s={W}x{TABS_STRIP_H}:r={FPS}:d={duration}[tab{i}]",
                f"color=c={TABS_BODY_COLOR}:s={W}x{body_h}:r={FPS}:d={duration}[body{i}]",
                f"[tab{i}][body{i}]vstack=inputs=2[ctx{i}]",
            ]
        )
    filters.append("".join(f"[ctx{i}]" for i in range(len(SW_DURATIONS))) + "concat=n=5:v=1:a=0[v]")
    _run_cmd(
        [
            ffmpeg,
            "-y",
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[v]",
            *_VID,
            str(out / "synth_tabs.mp4"),
        ]
    )
    return {
        "id": "synth_tabs",
        "file": "synth_tabs.mp4",
        "kind": "video",
        "duration_ms": int(SW_TOTAL * 1000),
        "has_audio": False,
        "fps": FPS,
        "cuts_ms": SW_CUTS_MS,
        "tts_pending": False,
    }


def _gen_synth_scroll(ffmpeg: str, out: Path, tall_ppm: Path) -> dict[str, Any]:
    part_a = out / "synth_scroll_part_a.mp4"
    part_b = out / "synth_scroll_part_b.mp4"
    try:
        _run_cmd(
            [
                ffmpeg,
                "-y",
                "-loop",
                "1",
                "-i",
                str(tall_ppm),
                "-vf",
                f"crop={W}:{H}:0:trunc(min(t*{SCROLL_SPEED_PX}\\,1050)),fps={FPS}",
                "-t",
                str(SCROLL_PART_S),
                *_VID,
                str(part_a),
            ]
        )
        _run_cmd(
            [
                ffmpeg,
                "-y",
                "-loop",
                "1",
                "-i",
                str(tall_ppm),
                "-vf",
                f"crop={W}:{H}:0:'600+trunc(min(t*{SCROLL_SPEED_PX}\\,1000))',fps={FPS}",
                "-t",
                str(SCROLL_PART_S),
                *_VID,
                str(part_b),
            ]
        )
        _run_cmd(
            [
                ffmpeg,
                "-y",
                "-i",
                str(part_a),
                "-i",
                str(part_b),
                "-filter_complex",
                "[0:v][1:v]concat=n=2:v=1:a=0[v]",
                "-map",
                "[v]",
                *_VID,
                str(out / "synth_scroll.mp4"),
            ]
        )
    finally:
        part_a.unlink(missing_ok=True)
        part_b.unlink(missing_ok=True)
    return {
        "id": "synth_scroll",
        "file": "synth_scroll.mp4",
        "kind": "video",
        "duration_ms": int(SCROLL_TOTAL * 1000),
        "has_audio": False,
        "fps": FPS,
        "cuts_ms": [SCROLL_CUT_MS],
        "tts_pending": False,
    }


def _gen_synth_drag(ffmpeg: str, out: Path) -> dict[str, Any]:
    _run_cmd(
        [
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=0x224466:s={W}x{H}:r={FPS}",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size=200x150:rate={FPS}",
            "-filter_complex",
            "[0][1]overlay=x='100+trunc(20*t)':y=100",
            "-t",
            str(DRAG_TOTAL),
            *_VID,
            str(out / "synth_drag.mp4"),
        ]
    )
    return {
        "id": "synth_drag",
        "file": "synth_drag.mp4",
        "kind": "video",
        "duration_ms": int(DRAG_TOTAL * 1000),
        "has_audio": False,
        "fps": FPS,
        "cuts_ms": [],
        "tts_pending": False,
    }


def _gen_synth_idle(ffmpeg: str, out: Path) -> dict[str, Any]:
    _run_cmd(
        [
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=0x336699:s={W}x{H}:r={FPS}",
            "-t",
            str(IDLE_TOTAL),
            *_VID,
            str(out / "synth_idle.mp4"),
        ]
    )
    return {
        "id": "synth_idle",
        "file": "synth_idle.mp4",
        "kind": "video",
        "duration_ms": int(IDLE_TOTAL * 1000),
        "has_audio": False,
        "fps": FPS,
        "cuts_ms": [],
        "tts_pending": False,
    }


def _gen_silence(ffmpeg: str, out: Path) -> dict[str, Any]:
    _run_cmd(
        [
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=16000:cl=mono",
            "-t",
            str(SILENCE_TOTAL),
            "-c:a",
            "pcm_s16le",
            str(out / "silence.wav"),
        ]
    )
    return {
        "id": "silence",
        "file": "silence.wav",
        "kind": "audio",
        "duration_ms": int(SILENCE_TOTAL * 1000),
        "tts_pending": False,
    }


def _gen_tones(ffmpeg: str, out: Path) -> dict[str, Any]:
    _run_cmd(
        [
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=sin(440*2*PI*t)+0.3*sin(880*2*PI*t):s=16000:c=mono",
            "-t",
            str(TONES_TOTAL),
            "-c:a",
            "pcm_s16le",
            str(out / "tones.wav"),
        ]
    )
    return {
        "id": "tones",
        "file": "tones.wav",
        "kind": "audio",
        "duration_ms": int(TONES_TOTAL * 1000),
        "tts_pending": False,
    }


def _pending_tts_fixture(fixture_id: str, filename: str, kind: str) -> dict[str, Any]:
    return {
        "id": fixture_id,
        "file": filename,
        "kind": kind,
        "tts_pending": True,
    }


def _gen_speech_espeak(ffmpeg: str, out: Path) -> dict[str, Any]:
    if not _espeak_available():
        return _pending_tts_fixture("speech_espeak", "speech_espeak.wav", "audio")

    raw = out / "espeak_raw.wav"
    try:
        _run_espeak(ESPEAK_TEXT, raw)
        _run_cmd(
            [
                ffmpeg,
                "-y",
                "-i",
                str(raw),
                "-af",
                f"aresample=16000,apad=whole_dur={ESPEAK_TOTAL:g}",
                "-t",
                str(ESPEAK_TOTAL),
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(out / "speech_espeak.wav"),
            ]
        )
    finally:
        raw.unlink(missing_ok=True)
    return {
        "id": "speech_espeak",
        "file": "speech_espeak.wav",
        "kind": "audio",
        "duration_ms": int(ESPEAK_TOTAL * 1000),
        "transcript_text": ESPEAK_TEXT,
        "wer_gate": 0.08,
        "tts_pending": False,
    }


def _gen_speech_offsets(ffmpeg: str, out: Path) -> dict[str, Any]:
    if not _espeak_available():
        return _pending_tts_fixture("speech_offsets", "speech_offsets.wav", "audio")

    phrase_raw = out / "phrase_raw.wav"
    phrase_16k = out / "phrase_16k.wav"
    try:
        _run_espeak(ESPEAK_TEXT[:60], phrase_raw)
        _run_cmd(
            [
                ffmpeg,
                "-y",
                "-i",
                str(phrase_raw),
                "-ar",
                "16000",
                "-ac",
                "1",
                str(phrase_16k),
            ]
        )
        _run_cmd(
            [
                ffmpeg,
                "-y",
                "-t",
                str(SPEECH_OFFSETS_TOTAL),
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=16000:cl=mono",
                "-i",
                str(phrase_16k),
                "-i",
                str(phrase_16k),
                "-filter_complex",
                (
                    f"[1:a]adelay={SPEECH_OFFSET_1_MS}|{SPEECH_OFFSET_1_MS}[p1];"
                    f"[2:a]adelay={SPEECH_OFFSET_2_MS}|{SPEECH_OFFSET_2_MS}[p2];"
                    "[0:a][p1][p2]amix=inputs=3:duration=first[out]"
                ),
                "-map",
                "[out]",
                "-ar",
                "16000",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(out / "speech_offsets.wav"),
            ]
        )
    finally:
        phrase_raw.unlink(missing_ok=True)
        phrase_16k.unlink(missing_ok=True)
    return {
        "id": "speech_offsets",
        "file": "speech_offsets.wav",
        "kind": "audio",
        "duration_ms": int(SPEECH_OFFSETS_TOTAL * 1000),
        "speech_onsets_ms": [SPEECH_OFFSET_1_MS, SPEECH_OFFSET_2_MS],
        "tts_pending": False,
    }


def _gen_av_sync(ffmpeg: str, out: Path) -> dict[str, Any]:
    if not _espeak_available():
        return _pending_tts_fixture("av_sync", "av_sync.mp4", "video_audio")

    video_av = out / "video_av.mp4"
    speech_raw = out / "speech_av_raw.wav"
    audio_av = out / "audio_av.wav"
    try:
        _run_cmd(
            [
                ffmpeg,
                "-y",
                "-filter_complex",
                (
                    f"color=c=0x102030:s={W}x{H}:r={FPS}:d={AV_SYNC_CUT_S:g}[a];"
                    f"color=c=0xE0D040:s={W}x{H}:r={FPS}:d={AV_SYNC_TOTAL - AV_SYNC_CUT_S:g}[b];"
                    "[a][b]concat=n=2:v=1:a=0[v]"
                ),
                "-map",
                "[v]",
                *_VID,
                str(video_av),
            ]
        )
        _run_espeak(AV_SYNC_TEXT, speech_raw)
        _run_cmd(
            [
                ffmpeg,
                "-y",
                "-t",
                str(AV_SYNC_TOTAL),
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=16000:cl=mono",
                "-i",
                str(speech_raw),
                "-filter_complex",
                (
                    f"[1:a]aresample=16000,adelay={AV_SYNC_CUT_MS}|{AV_SYNC_CUT_MS}[sp];"
                    "[0:a][sp]amix=inputs=2:duration=first[out]"
                ),
                "-map",
                "[out]",
                "-ar",
                "16000",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(audio_av),
            ]
        )
        _run_cmd(
            [
                ffmpeg,
                "-y",
                "-i",
                str(video_av),
                "-i",
                str(audio_av),
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-shortest",
                str(out / "av_sync.mp4"),
            ]
        )
    finally:
        video_av.unlink(missing_ok=True)
        speech_raw.unlink(missing_ok=True)
        audio_av.unlink(missing_ok=True)
    return {
        "id": "av_sync",
        "file": "av_sync.mp4",
        "kind": "video_audio",
        "duration_ms": int(AV_SYNC_TOTAL * 1000),
        "has_audio": True,
        "fps": FPS,
        "cuts_ms": [AV_SYNC_CUT_MS],
        "speech_onset_ms": AV_SYNC_CUT_MS,
        "transcript_text": AV_SYNC_TEXT,
        "tts_pending": False,
    }


def _write_gt(out: Path, gt: dict[str, Any]) -> None:
    path = out / f"{gt['id']}.gt.json"
    path.write_text(json.dumps(gt, indent=2, sort_keys=True) + "\n")


def generate_all(output_dir: Path, force: bool = False) -> dict[str, Any]:
    _ = force
    output_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg, _ffprobe = ffmpeg_paths()

    with tempfile.TemporaryDirectory() as tmp:
        tall_ppm = Path(tmp) / "scroll_tall.ppm"
        _write_tall_ppm(tall_ppm)
        generated = [
            _gen_synth_switches(ffmpeg, output_dir),
            _gen_synth_tabs(ffmpeg, output_dir),
            _gen_synth_scroll(ffmpeg, output_dir, tall_ppm),
            _gen_synth_drag(ffmpeg, output_dir),
            _gen_synth_idle(ffmpeg, output_dir),
            _gen_silence(ffmpeg, output_dir),
            _gen_tones(ffmpeg, output_dir),
            _gen_speech_espeak(ffmpeg, output_dir),
            _gen_speech_offsets(ffmpeg, output_dir),
            _gen_av_sync(ffmpeg, output_dir),
        ]

    for gt in generated:
        _write_gt(output_dir, gt)

    registry = {"generated": generated, "real": REAL_CLIPS}
    (output_dir / "registry.json").write_text(json.dumps(registry, indent=2, sort_keys=True) + "\n")
    return registry


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    generate_all(args.output_dir, force=args.force)
    print(f"Generated fixtures in {args.output_dir}")


if __name__ == "__main__":
    main()
