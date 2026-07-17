# Codex spec: f3b1 Part B — fixture harness (worker only)

## Goal
Implement the golden-fixture harness described in `docs/specs/f3b1-fixtures-contract.md` §Part B
and the normative §3 of `docs/design/f3b-patent-core-providers.md`. Create the fixture generator
script, golden assertion helpers, and harness self-consistency tests. All must be green under
`uv run pytest` + `uv run ruff check` from `worker/`. Do NOT touch any web/apps code.

---

## Files to create / modify

| Action | Path |
|--------|------|
| CREATE | `worker/scripts/make_fixtures.py` |
| CREATE | `worker/tests/golden.py` |
| CREATE | `worker/tests/conftest.py` |
| CREATE | `worker/tests/test_golden.py` |
| CREATE | `worker/tests/test_fixtures_harness.py` |
| MODIFY | `worker/pyproject.toml` (add `jiwer>=3.0.5` to dev deps) |
| MODIFY | `.gitignore` (add `worker/tests/fixtures/generated/`) |

---

## `worker/scripts/make_fixtures.py`

Deterministic synthetic fixture generator. Key design: **every constant that drives generation
also drives the ground-truth JSON — defined once, used in both places.**

### Video constants (shared)
```python
W, H = 640, 480       # resolution (scaled from spec's 1920x1080 for generation speed)
FPS = 30
_VID = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", "30", "-pix_fmt", "yuv420p"]
```

### Fixture constants (all shared between generation and GT JSON)

```python
# synth_switches — 5 color segments (no audio)
SW_DURATIONS = (8.0, 5.0, 12.0, 6.5, 9.0)   # seconds
SW_TOTAL = sum(SW_DURATIONS)                   # 40.5 s
SW_CUTS_MS = [int(sum(SW_DURATIONS[:i+1]) * 1000) for i in range(len(SW_DURATIONS)-1)]
# = [8000, 13000, 25000, 31500]
SW_COLORS = ("0xCC2222", "0x2222CC", "0x22BB22", "0xCCCC22", "0x22CCCC")

# synth_tabs — same cut times, only top 80px strip changes (exercises small-area recall)
TABS_BODY_COLOR = "0x888888"
TABS_COLORS = ("0xAA3333", "0x3333AA", "0x33AA33", "0xAAAA33", "0x33AAAA")
TABS_STRIP_H = 80     # px — top strip that changes; body = H - TABS_STRIP_H = 400px

# synth_scroll — smooth scroll with ONE planted cut at 10.0 s
SCROLL_PART_S = 10.0
SCROLL_TOTAL = 20.0
SCROLL_CUT_MS = 10000
SCROLL_SPEED_PX = 110  # px/s — at 10s: y=1100; Part B starts at y=600 → 500px backward jump
SCROLL_TALL_W, SCROLL_TALL_H = 640, 2500

# synth_drag — sliding window overlay, zero cuts
DRAG_TOTAL = 12.0

# synth_idle — static color, 120 s, zero cuts
IDLE_TOTAL = 120.0

# silence.wav / tones.wav
SILENCE_TOTAL = 60.0
TONES_TOTAL = 45.0

# TTS constants (espeak-ng; skipped if not on PATH)
ESPEAK_VOICE = "en-us"
ESPEAK_SPEED = 150
ESPEAK_TEXT = (
    "the quick brown fox jumps over the lazy dog "
    "she sells seashells by the seashore "
    "how much wood would a woodchuck chuck "
    "peter piper picked a peck of pickled peppers "
    "the rain in spain stays mainly in the plain"
)
ESPEAK_TOTAL = 60.0         # padded to this duration
SPEECH_OFFSET_1_MS = 5000
SPEECH_OFFSET_2_MS = 60000
SPEECH_OFFSETS_TOTAL = 75.0
AV_SYNC_CUT_S = 5.0
AV_SYNC_CUT_MS = 5000
AV_SYNC_TOTAL = 25.0
AV_SYNC_TEXT = "synchronised speech for cross stage alignment check"
```

### Function: `ffmpeg_paths() -> tuple[str, str]`
Use `from static_ffmpeg import run as static_ffmpeg_run` and
`static_ffmpeg_run.get_or_fetch_platform_executables_else_raise()`.
Cache with `@functools.lru_cache(maxsize=1)`.

### Function: `_run_cmd(args: list[str], check: bool = True) -> subprocess.CompletedProcess`
`subprocess.run(args, capture_output=True, check=check)`

### Function: `_write_tall_ppm(path: Path) -> None`
Write a 640×2500 PPM (P6) tall image with visually distinct color bands.
Pure Python, no external deps. Algorithm:
```python
rows = []
for y in range(SCROLL_TALL_H):
    band = (y // 100) % 4
    r = min(255, 60 + y * 150 // SCROLL_TALL_H)
    g = min(255, 60 + (SCROLL_TALL_H - y) * 150 // SCROLL_TALL_H)
    b = (128 + 60 * (1 if band % 2 == 0 else -1))
    rows.append(bytes([r, g, b]) * SCROLL_TALL_W)
with open(path, "wb") as f:
    f.write(f"P6\n{SCROLL_TALL_W} {SCROLL_TALL_H}\n255\n".encode())
    f.write(b"".join(rows))
```

### Function: `_espeak_available() -> bool`
`return shutil.which("espeak-ng") is not None`

### Function: `_run_espeak(text: str, out_wav: Path) -> None`
`subprocess.run(["espeak-ng", "-v", ESPEAK_VOICE, "-s", str(ESPEAK_SPEED), "-w", str(out_wav), text], check=True, capture_output=True)`

### Fixture generators (each returns a GT dict)

**`_gen_synth_switches(ffmpeg: str, out: Path) -> dict`**
Single ffmpeg call using filter_complex with `color=c=COLOR:s=640x480:r=30:d=DUR` + `concat=n=5`.
No inputs needed (all lavfi). Writes `synth_switches.mp4`.
Returns:
```python
{"id": "synth_switches", "file": "synth_switches.mp4", "kind": "video",
 "duration_ms": int(SW_TOTAL * 1000), "has_audio": False, "fps": FPS,
 "cuts_ms": SW_CUTS_MS, "tts_pending": False}
```

**`_gen_synth_tabs(ffmpeg: str, out: Path) -> dict`**
Same 5-segment layout but each segment built with vstack:
top strip (640×80) = colored + body (640×400) = constant gray.
Use filter_complex: for each segment i, generate
`color=c=TABS_COLORS[i]:s=640x80:r=30:d=SW_DURATIONS[i][tabiN]` +
`color=c=0x888888:s=640x400:r=30:d=SW_DURATIONS[i][bodyN]` +
`[tabiN][bodyN]vstack[ctxN]` then concat all 5 `[ctx0]...[ctx4]concat=n=5`.
Writes `synth_tabs.mp4`. Returns same structure as synth_switches (same cut times).

**`_gen_synth_scroll(ffmpeg: str, out: Path, tall_ppm: Path) -> dict`**
Two-part generation using the tall PPM:
- Part A (10s): `ffmpeg -loop 1 -i tall_ppm -vf "crop=640:480:0:trunc(min(t*110\,1050)),fps=30" -t 10 partA.mp4`
- Part B (10s): `ffmpeg -loop 1 -i tall_ppm -vf "crop=640:480:0:'600+trunc(min(t*110\,1000))',fps=30" -t 10 partB.mp4`
- Concat: `ffmpeg -i partA.mp4 -i partB.mp4 -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[v]" -map [v] ... synth_scroll.mp4`
Clean up temp part files after concat.
Returns:
```python
{"id": "synth_scroll", "file": "synth_scroll.mp4", "kind": "video",
 "duration_ms": int(SCROLL_TOTAL * 1000), "has_audio": False, "fps": FPS,
 "cuts_ms": [SCROLL_CUT_MS], "tts_pending": False}
```

**`_gen_synth_drag(ffmpeg: str, out: Path) -> dict`**
```
ffmpeg -y -f lavfi -i "color=c=0x224466:s=640x480:r=30" \
       -f lavfi -i "testsrc2=size=200x150:rate=30" \
       -filter_complex "[0][1]overlay=x='100+trunc(20*t)':y=100" \
       -t 12 {_VID} synth_drag.mp4
```
Returns: `{"id": "synth_drag", ..., "duration_ms": 12000, "cuts_ms": [], "tts_pending": False}`

**`_gen_synth_idle(ffmpeg: str, out: Path) -> dict`**
```
ffmpeg -y -f lavfi -i "color=c=0x336699:s=640x480:r=30" -t 120 {_VID} synth_idle.mp4
```
Returns: `{"id": "synth_idle", ..., "duration_ms": 120000, "cuts_ms": [], "tts_pending": False}`

**`_gen_silence(ffmpeg: str, out: Path) -> dict`**
```
ffmpeg -y -f lavfi -i "anullsrc=r=16000:cl=mono" -t 60 -c:a pcm_s16le silence.wav
```
Returns: `{"id": "silence", "file": "silence.wav", "kind": "audio", "duration_ms": 60000, "tts_pending": False}`

**`_gen_tones(ffmpeg: str, out: Path) -> dict`**
```
ffmpeg -y -f lavfi -i "aevalsrc=sin(440*2*PI*t)+0.3*sin(880*2*PI*t):s=16000:c=mono" \
       -t 45 -c:a pcm_s16le tones.wav
```
Returns: `{"id": "tones", "file": "tones.wav", "kind": "audio", "duration_ms": 45000, "tts_pending": False}`

**`_gen_speech_espeak(ffmpeg: str, out: Path) -> dict`**
If not `_espeak_available()`: return `{"id": "speech_espeak", ..., "tts_pending": True}` (no file written).
Otherwise:
1. `_run_espeak(ESPEAK_TEXT, out/"espeak_raw.wav")`
2. Resample + pad to 60s:
   ```
   ffmpeg -y -i espeak_raw.wav -af "aresample=16000,apad=whole_dur=60" -ac 1 -c:a pcm_s16le speech_espeak.wav
   ```
3. Clean up `espeak_raw.wav`.
Returns: `{"id": "speech_espeak", "file": "speech_espeak.wav", "kind": "audio", "duration_ms": 60000, "transcript_text": ESPEAK_TEXT, "wer_gate": 0.08, "tts_pending": False}`

**`_gen_speech_offsets(ffmpeg: str, out: Path) -> dict`**
If not `_espeak_available()`: return `{"id": "speech_offsets", ..., "tts_pending": True}`.
Otherwise:
1. `_run_espeak(ESPEAK_TEXT[:60], out/"phrase_raw.wav")` (first 60 chars of ESPEAK_TEXT)
2. Resample phrase: `ffmpeg -i phrase_raw.wav -ar 16000 -ac 1 phrase_16k.wav`
3. Place at two offsets into a 75s silence bed:
   ```
   ffmpeg -y \
     -t 75 -f lavfi -i "anullsrc=r=16000:cl=mono" \
     -i phrase_16k.wav -i phrase_16k.wav \
     -filter_complex "[1:a]adelay=5000|5000[p1];[2:a]adelay=60000|60000[p2];[0:a][p1][p2]amix=inputs=3:duration=first[out]" \
     -map [out] -ar 16000 -ac 1 -c:a pcm_s16le speech_offsets.wav
   ```
4. Clean up phrase_raw.wav, phrase_16k.wav.
Returns: `{"id": "speech_offsets", "file": "speech_offsets.wav", "kind": "audio", "duration_ms": 75000, "speech_onsets_ms": [SPEECH_OFFSET_1_MS, SPEECH_OFFSET_2_MS], "tts_pending": False}`

**`_gen_av_sync(ffmpeg: str, out: Path) -> dict`**
If not `_espeak_available()`: return `{"id": "av_sync", ..., "tts_pending": True}`.
Otherwise:
1. Generate video (colorA 5s + colorB 20s):
   ```
   ffmpeg -y -filter_complex "color=c=0x3355AA:s=640x480:r=30:d=5[a];color=c=0xAA3355:s=640x480:r=30:d=20[b];[a][b]concat=n=2:v=1:a=0[v]" -map [v] {_VID} video_av.mp4
   ```
2. `_run_espeak(AV_SYNC_TEXT, out/"speech_av_raw.wav")`
3. Build audio (silence 5s then speech, padded to 25s total):
   ```
   ffmpeg -y \
     -t 25 -f lavfi -i "anullsrc=r=16000:cl=mono" \
     -i speech_av_raw.wav \
     -filter_complex "[1:a]aresample=16000,adelay=5000|5000[sp];[0:a][sp]amix=inputs=2:duration=first[out]" \
     -map [out] -ar 16000 -ac 1 -c:a pcm_s16le audio_av.wav
   ```
4. Mux:
   ```
   ffmpeg -y -i video_av.mp4 -i audio_av.wav -c:v copy -c:a aac -shortest av_sync.mp4
   ```
5. Clean up intermediates.
Returns: `{"id": "av_sync", "file": "av_sync.mp4", "kind": "video_audio", "duration_ms": 25000, "has_audio": True, "fps": FPS, "cuts_ms": [AV_SYNC_CUT_MS], "speech_onset_ms": AV_SYNC_CUT_MS, "transcript_text": AV_SYNC_TEXT, "tts_pending": False}`

### Real-clip registry constant

```python
REAL_CLIPS: list[dict] = [
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
        "path": str(REPO_ROOT / "videos" / "SettingUpGoogleVideoAnalyzerForContextSwitches-ShotChange.mp4"),
        "kind": "video",
        "transcript": "PENDING_HUMAN",
        "context_switches": "PENDING_HUMAN",
        "tts_pending": False,
    },
]
```

### Function: `generate_all(output_dir: Path, force: bool = False) -> dict`
- `output_dir.mkdir(parents=True, exist_ok=True)`
- Call all generators in order
- Write each GT dict as `{fixture_id}.gt.json` alongside the fixture file
- Return `{"generated": [list of GT dicts], "real": REAL_CLIPS}`
- Also write `registry.json` to `output_dir`
- Use a `tempfile.TemporaryDirectory()` context for the tall PPM intermediate

### `main()` CLI
```python
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    generate_all(args.output_dir, force=args.force)
    print(f"Generated fixtures in {args.output_dir}")
```

---

## `worker/tests/golden.py`

Pure assertion helpers. Import pattern:
```python
from __future__ import annotations
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from functools import lru_cache

try:
    from static_ffmpeg import run as static_ffmpeg_run
    def _ffmpeg() -> tuple[str,str]:
        return static_ffmpeg_run.get_or_fetch_platform_executables_else_raise()
except ImportError:
    def _ffmpeg() -> tuple[str,str]:  # type: ignore[misc]
        return "ffmpeg", "ffprobe"
```

### `@dataclass CutMatchResult`
Fields: `tp: int`, `fp: int`, `fn: int`.
Properties: `precision`, `recall`, `f1` (standard formulas, handle zero-denominator → 0.0).

### `cut_match(expected_ms, detected_ms, tolerance_ms=1000) -> CutMatchResult`
Greedy one-to-one matching from §3b:
```
for e in sorted(expected_ms):
    pick unused d in detected minimizing |d-e| subject to |d-e| <= tolerance_ms
    if found: tp += 1, remove d from pool
fp = remaining pool size
fn = len(expected_ms) - tp
```

### `_normalize_text(text: str) -> str`
Design §3b normalization: `lower → re.sub(r"[^\w\s]", "", text) → re.sub(r"\s+", " ", t).strip()`

### `compute_wer(reference: str, hypothesis: str) -> float`
```python
from jiwer import wer
return wer(_normalize_text(reference), _normalize_text(hypothesis))
```
Guard: if both strings are empty return 0.0.

### `assert_utterance_invariants(utterances: list[dict]) -> None`
Assert I1+I2 for a list of utterance dicts with shape:
```python
{"t_start_ms": int, "t_end_ms": int, "payload": {"words": [{"t0": int, "t1": int}]}}
```
**I1** (per utterance): words monotonically non-decreasing t0; each word inside its utterance span ±50ms; 60 ≤ mean_word_duration ≤ 1200ms.
**I2** (across utterances): spans strictly ordered (each start ≥ prev end), non-overlapping.

### `assert_audio_video_aligned(wav_duration_ms: int, video_duration_ms: int) -> None`
**I3**: `abs(wav_duration_ms - video_duration_ms) <= 500`

### `assert_timestamps_bounded(utterances: list[dict], video_duration_ms: int) -> None`
**I4**: for every utterance, `t_start_ms <= video_duration_ms + 250` and `t_end_ms <= video_duration_ms + 250`.

### `assert_cross_stage(cut_ms: int, first_word_t0_ms: int, video_duration_ms: int) -> None`
From §2d: PLANTED_MS=5000, CROSS_TOL=250.
Assert: `|cut_ms - 5000| <= 250`, `|first_word_t0_ms - 5000| <= 250`,
`|cut_ms - first_word_t0_ms| <= 500`, `|video_duration_ms - 25000| <= 40`.

### Media probe helpers (use subprocess + ffprobe/ffmpeg from static_ffmpeg)

**`ffprobe_duration_ms(path: Path) -> int`**
Run `ffprobe -v error -show_entries format=duration -of csv=p=0 {path}`.
Parse stdout as float, return `int(float(stdout.strip()) * 1000)`.

**`frame_mae_at_cut(path: Path, cut_s: float, fps: int = 30) -> float`**
Extract two small grayscale frames:
- before: `t_s = cut_s - 1/fps`
- after: `t_s = cut_s + 1/fps`

For each: run `ffmpeg -loglevel error -ss {t_s} -i {path} -frames:v 1 -vf scale=160:120 -f rawvideo -pix_fmt gray -`
Compute mean absolute difference between the two frames (each is 160*120=19200 bytes).
Return float MAE (0–255 range).

**`audio_rms_db(path: Path, start_s: float, duration_s: float) -> float`**
Run `ffmpeg -loglevel error -ss {start_s} -i {path} -t {duration_s} -vn -af volumedetect -f null -`
Parse `mean_volume: -XX.X dB` from stderr. Return the float dB value.
If not found (e.g. all-silent produces `-inf`), return -100.0.

---

## `worker/tests/conftest.py`

```python
"""Ensure worker/scripts and worker/tests are importable from tests."""
from __future__ import annotations
import sys
from pathlib import Path

_TESTS = Path(__file__).parent
_SCRIPTS = _TESTS.parent / "scripts"
for _p in (_TESTS, _SCRIPTS):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))
```

---

## `worker/tests/test_golden.py`

Unit tests for pure helpers in `golden.py` against hand-built cases:

### cut_match tests
- exact match: expected=[1000,5000], detected=[1000,5000], tol=1000 → tp=2, fp=0, fn=0, F1=1.0
- tolerance hit: expected=[5000], detected=[5800], tol=1000 → tp=1, fp=0, fn=0
- miss: expected=[5000], detected=[7000], tol=1000 → tp=0, fp=1, fn=1, F1=0.0
- false positive: expected=[5000], detected=[5000, 10000], tol=1000 → tp=1, fp=1, fn=0
- greedy ordering: expected=[1000,6000], detected=[1500, 6500], tol=1000 → tp=2
- empty expected, some detected → fp=len(detected), fn=0, precision=0.0
- empty both → tp=0, fp=0, fn=0, f1=0.0

### normalize_text tests (import `_normalize_text` from golden)
- `"Hello, World!"` → `"hello world"`
- `"foo  bar"` → `"foo bar"`
- `"it's"` - apostrophes removed: `"its"` (punctuation stripped)

### invariant assertion tests (I1, I2, I3, I4)
- I1 happy path: single utterance with 3 words in proper order → no assertion error
- I1 word out of order → AssertionError
- I2 two utterances non-overlapping → ok
- I2 two utterances overlapping → AssertionError
- I3: abs diff 400ms → ok; abs diff 600ms → AssertionError
- I4: all within bounds → ok; one beyond → AssertionError

### cross_stage tests
- valid: cut=5100, word=4900, dur=25010 → ok
- cut too far: cut=5300, word=4900 → AssertionError (|5300-5000|=300 > 250)

---

## `worker/tests/test_fixtures_harness.py`

Integration tests that actually generate fixtures and probe the media.

**IMPORTANT**: These tests use `ffmpeg` via subprocess and will generate media files.
They must be robust: if a fixture is `tts_pending=True`, skip that fixture's media-specific assertions.

```python
import json
import pytest
from pathlib import Path
import make_fixtures as mf
import golden as g

DURATION_TOL_MS = 400   # ffprobe vs GT duration tolerance
FRAME_DIFF_CUT_THRESHOLD = 40.0   # MAE > this at declared cut times
```

### Session fixture
```python
@pytest.fixture(scope="session")
def fxt(tmp_path_factory):
    out = tmp_path_factory.mktemp("fxt_run1")
    reg = mf.generate_all(out)
    return reg, out
```

### Tests

**`test_all_generated_gt_jsons_present(fxt)`**
For every entry in `registry["generated"]` that has `tts_pending=False`:
assert `(out_dir / f"{entry['id']}.gt.json").exists()`.

**`test_duration_matches_gt[fixture_id]`** (parametrized over non-tts-pending generated entries)
`ffprobe_duration_ms(path)` within `DURATION_TOL_MS` of `entry["duration_ms"]`.

**`test_cut_boundaries_have_large_frame_diff[fixture_id@cut_ms]`** (parametrize over video fixtures with non-empty `cuts_ms`)
`frame_mae_at_cut(path, cut_ms/1000) > FRAME_DIFF_CUT_THRESHOLD`

**`test_synth_drag_no_cut_boundary`**
Probe frame MAE at t=6s (mid-video): should be < 30 (pure motion, no wholesale change).

**`test_silence_wav_is_silent`**
audio_rms_db(silence.wav, 0, 5) < -60 dB.

**`test_tones_wav_is_not_silent`**
audio_rms_db(tones.wav, 0, 5) > -40 dB.

**`test_speech_offsets_silent_before_first_onset`** (skip if tts_pending)
audio_rms_db(speech_offsets.wav, 0, 3) < -50 dB.

**`test_speech_offsets_speech_at_5s`** (skip if tts_pending)
audio_rms_db(speech_offsets.wav, 5.0, 1.0) > -40 dB.

**`test_speech_offsets_speech_at_60s`** (skip if tts_pending)
audio_rms_db(speech_offsets.wav, 60.0, 1.0) > -40 dB.

**`test_real_clip_registry`**
`len(reg["real"]) >= 2`. For each: `entry["transcript"] == "PENDING_HUMAN"`.

**`test_determinism`**
Generate into a second temp dir, compare the GT JSON content (not the binary files):
```python
def _gt_data(reg):
    return sorted([(e["id"], {k:v for k,v in e.items() if k != "file"})
                   for e in reg["generated"]])

out2 = tmp_path / "run2"
out2.mkdir()
reg2 = mf.generate_all(out2)
assert _gt_data(reg) == _gt_data(reg2)
```
Use `tmp_path` (function-scoped) for run2; `fxt` provides run1.

---

## `worker/pyproject.toml` changes

Under `[dependency-groups]` `dev`, add `"jiwer>=3.0.5"`.

---

## `.gitignore` changes

Add the line `worker/tests/fixtures/generated/` to the root `.gitignore`.

---

## Acceptance

Run from `worker/`:
```
uv run ruff check
uv run pytest tests/test_golden.py tests/test_fixtures_harness.py tests/test_pipeline.py tests/test_probe.py tests/test_main.py -v
```
All tests green. Ruff clean.

The `test_fixtures_harness.py` tests WILL invoke ffmpeg (generation takes 1–3 min). That is expected.

---

Finish by running the tests and printing a concise summary of every file you changed and anything left incomplete. Then append one row for this run to docs/delegation-log.md (delegate=Codex, model from your session, grade ✅/⚠️/❌ per that file's legend, terse note) without rewriting the file.
