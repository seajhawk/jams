"""Generate deterministic media fixtures and ground-truth metadata."""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import shutil
import subprocess
import tempfile
import wave
from array import array
from pathlib import Path
from typing import Any

from jams_worker.ffmpeg import ffmpeg_paths

WORKER_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = WORKER_ROOT.parent
DEFAULT_OUT = WORKER_ROOT / "tests" / "fixtures" / "generated"

W, H = 640, 480
FPS = 30
AUDIO_SR = 16_000
AUDIO_SEED = 10_010
TRANSIENT_TO_SPEECH_DB = -6.0
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
TRANSIENT_TOTAL = 24.0
NARRATED_TRANSIENT_TOTAL = 36.0
MUSIC_BED_TOTAL = 30.0
CLICK_BASE_OFFSETS_MS = (1500, 3350, 7120, 12_400, 16_850, 21_100)
KEYPRESS_BASE_OFFSETS_MS = (
    1800,
    1950,
    2110,
    2320,
    2550,
    4980,
    5160,
    5320,
    5480,
    5640,
    11_800,
    11_980,
    12_150,
    12_360,
    12_520,
    12_700,
)
INTEGRATION_AUDIO_OFFSET_MS = 0
INTEGRATION_DESYNC_AUDIO_OFFSET_MS = 300

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


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows))


def _read_wav_mono16(path: Path) -> list[float]:
    with wave.open(str(path), "rb") as wav:
        if wav.getframerate() != AUDIO_SR or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            msg = f"{path} must be 16 kHz mono PCM16 before reading"
            raise ValueError(msg)
        pcm = array("h")
        pcm.frombytes(wav.readframes(wav.getnframes()))
    if pcm.itemsize != 2:
        pcm.byteswap()
    return [sample / 32768.0 for sample in pcm]


def _write_wav_mono16(path: Path, samples: list[float]) -> None:
    pcm = array(
        "h",
        [max(-32768, min(32767, int(round(sample * 32767.0)))) for sample in samples],
    )
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(AUDIO_SR)
        wav.writeframes(pcm.tobytes())


def _rms(samples: list[float]) -> float:
    if not samples:
        return 0.0
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples))


def _seeded_offsets(
    base_offsets_ms: tuple[int, ...],
    *,
    seed: int,
    jitter_ms: int = 22,
) -> list[int]:
    rng = random.Random(seed)
    return [
        max(250, int(offset + rng.randint(-jitter_ms, jitter_ms)))
        for offset in base_offsets_ms
    ]


def _click_transient(seed: int) -> list[float]:
    rng = random.Random(seed)
    samples: list[float] = []
    for index in range(int(AUDIO_SR * 0.012)):
        t = index / AUDIO_SR
        envelope = math.exp(-index / 26.0)
        tone = math.sin(2 * math.pi * 2900 * t) + 0.55 * math.sin(2 * math.pi * 6100 * t)
        samples.append(envelope * (0.58 * tone + 0.14 * rng.uniform(-1.0, 1.0)))
    return samples


def _keypress_transient(seed: int) -> list[float]:
    rng = random.Random(seed)
    samples: list[float] = []
    for index in range(int(AUDIO_SR * 0.026)):
        t = index / AUDIO_SR
        body = math.sin(2 * math.pi * 900 * t) * math.exp(-index / 92.0)
        tick = math.sin(2 * math.pi * 4200 * t) * math.exp(-index / 33.0)
        samples.append(0.44 * body + 0.24 * tick + 0.05 * rng.uniform(-1.0, 1.0))
    return samples


def _mix_at(base: list[float], overlay: list[float], start_ms: int, gain: float = 1.0) -> None:
    start = int(AUDIO_SR * start_ms / 1000)
    for index, sample in enumerate(overlay):
        target = start + index
        if 0 <= target < len(base):
            base[target] += sample * gain


def _transient_track(
    duration_s: float,
    offsets_ms: list[int],
    *,
    kind: str,
    seed: int,
) -> tuple[list[float], list[dict[str, Any]], list[float]]:
    samples = [0.0] * int(duration_s * AUDIO_SR)
    active_samples: list[float] = []
    events: list[dict[str, Any]] = []
    recipe = "mouse_click_v1" if kind == "click" else "mechanical_keypress_v1"
    for index, offset_ms in enumerate(offsets_ms):
        transient_seed = seed + index * 97
        transient = (
            _click_transient(transient_seed)
            if kind == "click"
            else _keypress_transient(transient_seed)
        )
        _mix_at(samples, transient, offset_ms)
        active_samples.extend(transient)
        events.append(
            {
                "t_ms": offset_ms,
                "kind": kind,
                "recipe": recipe,
                "seed": transient_seed,
                "duration_ms": int(len(transient) * 1000 / AUDIO_SR),
            }
        )
    return samples, events, active_samples


def _normalize_peak(samples: list[float], peak: float = 0.92) -> list[float]:
    current = max((abs(sample) for sample in samples), default=0.0)
    if current <= 0:
        return samples
    gain = peak / current if current > peak else 1.0
    return [sample * gain for sample in samples]


def _write_transcript_artifact_if_available(
    audio_path: Path,
    out: Path,
    fixture_id: str,
) -> dict[str, Any]:
    from jams_worker.providers import transcription as tx

    if os.environ.get("JAMS_RUN_WHISPER_TESTS") != "1" or not tx.DEFAULT_MODEL_CACHE.exists():
        return {
            "transcript_artifact_pending": True,
            "transcript_artifact_reason": "set JAMS_RUN_WHISPER_TESTS=1 with cached model",
        }
    try:
        model, model_sha = tx.load_model()
        utterances = tx.build_utterances(tx._transcribe(model, audio_path, vad_threshold=0.5))
    except Exception as exc:  # pragma: no cover - exercised only with local model cache.
        return {
            "transcript_artifact_pending": True,
            "transcript_artifact_reason": f"transcription failed: {type(exc).__name__}",
        }

    payload = {
        "provider_id": tx.PROVIDER_ID,
        "provider_version": tx.PROVIDER_VERSION,
        "model": tx.MODEL_NAME,
        "model_sha256": model_sha,
        "vad_regions": [
            {"t_start_ms": utterance.t0_ms, "t_end_ms": utterance.t1_ms}
            for utterance in utterances
        ],
        "utterances": [
            {
                "t_start_ms": utterance.t0_ms,
                "t_end_ms": utterance.t1_ms,
                "text": utterance.text,
                "words": [
                    {"w": word.text, "t0": word.t0_ms, "t1": word.t1_ms}
                    for word in utterance.words
                ],
            }
            for utterance in utterances
        ],
    }
    artifact = out / f"{fixture_id}.transcript.json"
    artifact.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return {
        "transcript_artifact": artifact.name,
        "transcript_artifact_pending": False,
        "vad_region_count": len(payload["vad_regions"]),
    }


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


def _gen_click_transients(out: Path) -> dict[str, Any]:
    offsets = _seeded_offsets(CLICK_BASE_OFFSETS_MS, seed=AUDIO_SEED)
    samples, events, _active = _transient_track(
        TRANSIENT_TOTAL,
        offsets,
        kind="click",
        seed=AUDIO_SEED + 100,
    )
    _write_wav_mono16(out / "click_transients.wav", _normalize_peak(samples))
    _write_jsonl(out / "click_transients.offsets.jsonl", events)
    return {
        "id": "click_transients",
        "file": "click_transients.wav",
        "kind": "audio",
        "duration_ms": int(TRANSIENT_TOTAL * 1000),
        "offsets_jsonl": "click_transients.offsets.jsonl",
        "event_count": len(events),
        "event_kinds": ["click"],
        "provider_pending": "F10-c",
        "tts_pending": False,
    }


def _gen_keypress_transients(out: Path) -> dict[str, Any]:
    offsets = _seeded_offsets(KEYPRESS_BASE_OFFSETS_MS, seed=AUDIO_SEED + 1, jitter_ms=16)
    samples, events, _active = _transient_track(
        TRANSIENT_TOTAL,
        offsets,
        kind="keypress",
        seed=AUDIO_SEED + 200,
    )
    _write_wav_mono16(out / "keypress_transients.wav", _normalize_peak(samples))
    _write_jsonl(out / "keypress_transients.offsets.jsonl", events)
    return {
        "id": "keypress_transients",
        "file": "keypress_transients.wav",
        "kind": "audio",
        "duration_ms": int(TRANSIENT_TOTAL * 1000),
        "offsets_jsonl": "keypress_transients.offsets.jsonl",
        "event_count": len(events),
        "event_kinds": ["keypress"],
        "provider_pending": "F10-c",
        "tts_pending": False,
    }


def _speech_16k(
    ffmpeg: str,
    out: Path,
    *,
    filename: str,
    text: str,
    duration_s: float,
) -> bool:
    if not _espeak_available():
        return False

    raw = out / f"{Path(filename).stem}_raw.wav"
    try:
        _run_espeak(text, raw)
        _run_cmd(
            [
                ffmpeg,
                "-y",
                "-i",
                str(raw),
                "-af",
                f"aresample={AUDIO_SR},apad=whole_dur={duration_s:g}",
                "-t",
                str(duration_s),
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(out / filename),
            ]
        )
    finally:
        raw.unlink(missing_ok=True)
    return True


def _gen_pure_speech_negative(ffmpeg: str, out: Path) -> dict[str, Any]:
    fixture_id = "pure_speech_negative"
    filename = f"{fixture_id}.wav"
    if not _speech_16k(
        ffmpeg,
        out,
        filename=filename,
        text=ESPEAK_TEXT,
        duration_s=NARRATED_TRANSIENT_TOTAL,
    ):
        return _pending_tts_fixture(fixture_id, filename, "audio")

    transcript = _write_transcript_artifact_if_available(out / filename, out, fixture_id)
    return {
        "id": fixture_id,
        "file": filename,
        "kind": "audio",
        "duration_ms": int(NARRATED_TRANSIENT_TOTAL * 1000),
        "event_count": 0,
        "negative": "pure_speech",
        "provider_pending": "F10-c",
        "tts_pending": False,
        **transcript,
    }


def _gen_music_bed_negative(ffmpeg: str, out: Path) -> dict[str, Any]:
    _run_cmd(
        [
            ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            (
                "aevalsrc="
                "0.35*sin(220*2*PI*t)+0.20*sin(330*2*PI*t)+"
                "0.12*sin(660*2*PI*t):s=16000:c=mono"
            ),
            "-t",
            str(MUSIC_BED_TOTAL),
            "-c:a",
            "pcm_s16le",
            str(out / "music_bed_negative.wav"),
        ]
    )
    return {
        "id": "music_bed_negative",
        "file": "music_bed_negative.wav",
        "kind": "audio",
        "duration_ms": int(MUSIC_BED_TOTAL * 1000),
        "event_count": 0,
        "negative": "music_bed",
        "provider_pending": "F10-c",
        "tts_pending": False,
    }


def _gen_narrated_transients(
    ffmpeg: str,
    out: Path,
    *,
    fixture_id: str,
    transient_kind: str,
    offsets: tuple[int, ...],
) -> dict[str, Any]:
    filename = f"{fixture_id}.wav"
    speech_filename = f"{fixture_id}.speech.wav"
    if not _speech_16k(
        ffmpeg,
        out,
        filename=speech_filename,
        text=ESPEAK_TEXT,
        duration_s=NARRATED_TRANSIENT_TOTAL,
    ):
        return _pending_tts_fixture(fixture_id, filename, "audio")

    speech = _read_wav_mono16(out / speech_filename)
    event_offsets = _seeded_offsets(offsets, seed=AUDIO_SEED + 300 + len(offsets), jitter_ms=18)
    _track, events, active = _transient_track(
        NARRATED_TRANSIENT_TOTAL,
        event_offsets,
        kind=transient_kind,
        seed=AUDIO_SEED + 400,
    )
    speech_rms = _rms(speech)
    transient_rms = _rms(active)
    gain = (
        0.0
        if transient_rms <= 0
        else speech_rms * 10 ** (TRANSIENT_TO_SPEECH_DB / 20) / transient_rms
    )
    for event in events:
        transient = (
            _click_transient(event["seed"])
            if transient_kind == "click"
            else _keypress_transient(event["seed"])
        )
        _mix_at(speech, transient, int(event["t_ms"]), gain=gain)

    _write_wav_mono16(out / filename, _normalize_peak(speech))
    _write_jsonl(out / f"{fixture_id}.offsets.jsonl", events)
    (out / speech_filename).unlink(missing_ok=True)
    transcript = _write_transcript_artifact_if_available(out / filename, out, fixture_id)
    return {
        "id": fixture_id,
        "file": filename,
        "kind": "audio",
        "duration_ms": int(NARRATED_TRANSIENT_TOTAL * 1000),
        "offsets_jsonl": f"{fixture_id}.offsets.jsonl",
        "event_count": len(events),
        "event_kinds": [transient_kind],
        "transient_to_speech_db": TRANSIENT_TO_SPEECH_DB,
        "provider_pending": "F10-c",
        "tts_pending": False,
        **transcript,
    }


def _gen_integration_av(
    ffmpeg: str,
    out: Path,
    *,
    fixture_id: str,
    audio_offset_ms: int,
) -> dict[str, Any]:
    video_path = out / "synth_tabs.mp4"
    audio_path = out / "narrated_clicks.wav"
    if not video_path.exists() or not audio_path.exists():
        return _pending_tts_fixture(fixture_id, f"{fixture_id}.mp4", "video_audio")

    delayed_audio = out / f"{fixture_id}.audio.wav"
    try:
        _run_cmd(
            [
                ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"anullsrc=r={AUDIO_SR}:cl=mono",
                "-i",
                str(audio_path),
                "-filter_complex",
                (
                    f"[1:a]adelay={audio_offset_ms}|{audio_offset_ms},"
                    f"apad=whole_dur={SW_TOTAL:g}[a1];"
                    "[0:a][a1]amix=inputs=2:duration=first[out]"
                ),
                "-t",
                str(SW_TOTAL),
                "-map",
                "[out]",
                "-ar",
                str(AUDIO_SR),
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(delayed_audio),
            ]
        )
        _run_cmd(
            [
                ffmpeg,
                "-y",
                "-i",
                str(video_path),
                "-i",
                str(delayed_audio),
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-shortest",
                str(out / f"{fixture_id}.mp4"),
            ]
        )
    finally:
        delayed_audio.unlink(missing_ok=True)
    return {
        "id": fixture_id,
        "file": f"{fixture_id}.mp4",
        "kind": "video_audio",
        "duration_ms": int(SW_TOTAL * 1000),
        "has_audio": True,
        "fps": FPS,
        "cuts_ms": SW_CUTS_MS,
        "audio_source": "narrated_clicks.wav",
        "audio_offset_ms": audio_offset_ms,
        "provider_pending": "F10-b/c",
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
            _gen_click_transients(output_dir),
            _gen_keypress_transients(output_dir),
            _gen_speech_espeak(ffmpeg, output_dir),
            _gen_speech_offsets(ffmpeg, output_dir),
            _gen_pure_speech_negative(ffmpeg, output_dir),
            _gen_music_bed_negative(ffmpeg, output_dir),
            _gen_narrated_transients(
                ffmpeg,
                output_dir,
                fixture_id="narrated_clicks",
                transient_kind="click",
                offsets=CLICK_BASE_OFFSETS_MS,
            ),
            _gen_narrated_transients(
                ffmpeg,
                output_dir,
                fixture_id="narrated_keypresses",
                transient_kind="keypress",
                offsets=KEYPRESS_BASE_OFFSETS_MS,
            ),
            _gen_integration_av(
                ffmpeg,
                output_dir,
                fixture_id="integration_av_0ms",
                audio_offset_ms=INTEGRATION_AUDIO_OFFSET_MS,
            ),
            _gen_integration_av(
                ffmpeg,
                output_dir,
                fixture_id="integration_av_desync_300ms",
                audio_offset_ms=INTEGRATION_DESYNC_AUDIO_OFFSET_MS,
            ),
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
