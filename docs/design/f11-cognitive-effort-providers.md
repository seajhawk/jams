<!-- Author: kimi-k3 via aider design consult, 2026-07-18. $0.21, 14k tokens. Claude review appended at bottom. -->

# DESIGN: Cognitive-Effort Providers (CONCEPTS + CHOICES)

**Status:** implementation-ready draft · **Scope:** JAMS patent-core · **Providers:** `jams.artifact.screen-ocr`, `jams.measure.cognitive.concepts`, `jams.measure.cognitive.choices`

## 0. Context & Hard Constraints

- CPU-only, 2–4 vCPU. No GPU. No network at runtime in the default path.
- Deterministic: same inputs → byte-identical canonical measures (excluding run metadata) across repeated runs on the same build/arch.
- ZERO runtime LLM/API calls in the default path. One sanctioned exception pattern exists (segment naming): an optional feature-flagged cheap-LLM **arbiter over deterministic candidates** that may only filter/re-rank, never generate. We reuse that pattern for CONCEPTS only (§2.6).
- Golden-fixture testable end-to-end with the pipeline clock mocked.
- Canonical measure tuple emitted by all MeasureProviders:
  `{kind, category='cognitive', t_start_ms, t_end_ms?, value_num, value_text, confidence, payload}`
- Patent payload shapes we must satisfy:
  - concepts: `{concept, source{type: ocr|uri_analysis, location?}, context?}`
  - choices: `{prompt?, options{...}, duration?}`

Upstream signals assumed available (per brief): context-switch keyframes (full-res JPEG, already extracted), scene segments, word-timestamped transcript + VAD, per-utterance sentiment (frustration/confusion), 5fps/480px gray proxy + motion artifact, phase-correlation scroll/idle (dwell) info.

**Honest headline expectations (details per section):** CONCEPTS deterministic-only lands around precision 0.6–0.75 / recall 0.45–0.6 on real footage [TUNE]; CHOICES with glyph evidence ~0.85 precision, geometry-only ~0.6. Both kinds ship at **Effort-Score weight 0** until the §4.4 graduation gate passes.

---

## 1. OCR Strategy

### 1.1 Engine choice: **RapidOCR (ONNX Runtime, PP-OCRv4)** — pinned

| Candidate | Verdict | Reason |
|---|---|---|
| tesseract | Fallback only | Fully deterministic and zero-ML, but screen text at 13–16px UI fonts, dark mode, subpixel anti-aliasing, and mixed layouts measurably degrades it; requires per-frame binarization heuristics that themselves become tuning surface. |
| paddleocr | Rejected | Drags in the Paddle framework; large install, version-skew determinism risk, heavier CPU inference. No accuracy benefit over its own PP-OCR models once those are run under onnxruntime. |
| **rapidocr-onnx** | **Selected** | PP-OCRv4 det+rec under `onnxruntime` only (no framework bloat), strong on rendered screen text at small sizes, ~250–400 ms/frame at 1080p single-thread [TUNE], small vendored model files (~15 MB total) we can hash-pin. |

**Pins (lockfile; verify at vendor time):**
- `rapidocr_onnxruntime==1.3.24` [TUNE]
- `onnxruntime==1.17.1` [TUNE]
- `opencv-python-headless==4.8.1.78` [TUNE]
- `numpy==1.26.4` [TUNE]
- Vendored models: `ch_PP-OCRv4_det.onnx`, `en_PP-OCRv4_rec.onnx` (English rec head; det is script-agnostic), each with SHA256 recorded in `models.lock` [TUNE — hashes filled at vendoring].

**Determinism posture:** ORT session created with `intra_op_num_threads=1`, `inter_op_num_threads=1`, `SessionOptions.enable_mem_pattern` default, execution mode `SEQUENTIAL`. Single-thread + fixed model + fixed build ⇒ run-to-run bitwise stable on same arch. Cross-arch (x86 vs arm64) may differ in low mantissa bits of `conf`; fixtures therefore assert OCR **text equality** and `conf` within ±0.02 [TUNE], never raw float equality.

### 1.2 Which frames to OCR (candidate frames only — never 5fps)

Frame selection runs upstream of OCR and is part of the `screen-ocr` artifact stage:

1. **Settled switch keyframes (S):** every context-switch keyframe, where "settled" = motion artifact value at that timestamp < `m_settle = 0.02` [TUNE]. If the per-switch keyframe is not settled (transitional UI), request one additional full-res extraction at the first timestamp within `switch_t + [0, 2000] ms` where motion < `m_settle`; if none, keep the original keyframe and mark `settled=false` in the artifact (downstream treats its OCR as lower trust, see §2.3 conf floor).
2. **Dwell frames (D):** for each phase-correlation dwell window ≥ `dwell_min = 4000 ms` [TUNE] (user reading/idle ⇒ where concepts and choices actually get encountered), extract one full-res frame at the dwell **midpoint**.
3. **Dedup:** drop any D frame within 1000 ms [TUNE] of an S frame.
4. **Cap:** if `|S| + |D| > frame_cap = 150` [TUNE], keep all S, keep D sorted by dwell length descending until cap. Rationale: longer dwell = more cognitive effort, higher information value.

Expected for a 15-min video: |S| ≈ 40–80, |D| ≈ 30–60, capped total ≈ 120 [TUNE].

### 1.3 Preprocessing (minimal — deliberate)

- Decode JPEG → RGB ndarray.
- If width > 1920: downscale to 1920 wide (`cv2.INTER_AREA`). 4K→1080p keeps UI text ≥ the rec model's comfort zone; detection input stays bounded.
- **No binarization, no adaptive thresholding** — it destroys dark-mode and anti-aliased glyphs and net-hurts PP-OCRv4.
- No banding/tiling in v1. If tall windows (>2160 px) appear in real footage, revisit with 50%-overlap horizontal bands [TUNE — open question §7].
- (Documented, non-default) tesseract fallback preprocessing, if we ever swap engines: 2× upscale when median glyph height < 18 px, grayscale, OTSU.

### 1.4 Cost budget (15-min video, single thread)

| Step | Unit cost [TUNE] | Count | Total |
|---|---|---|---|
| Extra full-res extraction (D + unsettled S) | ~80 ms seek+decode | ~60 | ~5 s |
| RapidOCR det+rec @1080p | ~350 ms | ~120 | ~42 s |
| Artifact write (JSON) | ~2 ms | ~120 | ~0.3 s |
| **OCR stage total** | | | **~48 s** (≈28 s at 2 vCPU with frame-level parallelism; determinism preserved — per-frame results are independent and merged in t-order) |

Stage budget cap: **120 s** [TUNE]; on exceed, degrade gracefully by trimming D frames (keep S).

### 1.5 Caching / idempotency

Content-addressed artifact store:

~~~
artifacts/<video_sha>/ocr/frames.json          # index
artifacts/<video_sha>/ocr/<frame_id>.json      # per-frame lines
~~~

- `frame_id = sha256(frame_jpeg_bytes)[0:16]`.
- Cache key = `(frame_id, ocr_pipeline_v)` where `ocr_pipeline_v = "rapidocr-1.3.24|ort-1.17.1|det:<sha>|rec:<sha>|prep:v1"` [TUNE versions]. Bumping any component invalidates cleanly.
- `frames.json` records `{frame_id, t_ms, origin: switch|dwell, settled, frame_sha256, ocr_pipeline_v, status}`.
- Per-frame artifact schema:
~~~
{
  "frame_id": "…", "t_ms": 123456, "origin": "dwell", "settled": true,
  "width": 1920, "height": 1080,
  "lines": [
    {"line_id": 0, "text": "Configure idempotency keys", "conf": 0.93,
     "bbox": [x, y, w, h]}
  ]
}
~~~
- ffmpeg full-res extraction at a fixed seek is deterministic under our pinned build; `frame_sha256` is stored and validated on cache hit — mismatch ⇒ re-extract + re-OCR (loud warning, this should never happen).

---

## 2. CONCEPTS

Goal: emit one measure per **(concept, scene segment)** encounter span. `kind='concept'`, `category='cognitive'`.

### 2.1 Candidate extraction

From OCR lines of candidate frames (conf ≥ `ocr_conf_min = 0.6` [TUNE], skip lines from `settled=false` frames unless conf ≥ 0.75 [TUNE]):

Tokenize on whitespace/punctuation; keep a token if any of:
- **Code identifier:** matches camelCase / PascalCase / snake_case / kebab-case / dotted path (`java.util.Map`) / path (`src/main.rs`) / contains digit-letter mix (`SHA256`, `HTTP2`) → `is_code_ident`.
- **Acronym:** `^[A-Z][A-Z0-9]{1,7}$` → `is_acronym`.
- **Rare word:** alpha, len ≥ 4 [TUNE], `zipf(token_lc) < zipf_rare = 4.0` [TUNE] via `wordfreq==3.0.3` [TUNE] (English v1; see §7).
- **Glossary hit:** token in deployment glossary (§2.4) → `is_glossary`.

Hard drops: stopwords; pure numerics; tokens appearing in ≥ 80% of all frames [TUNE] (browser chrome, app boilerplate); tokens within edit-distance 1 of a common English word (zipf ≥ 5.0) **and** line conf < 0.8 [TUNE] (probable OCR noise of a mundane word).

### 2.2 Evidence signals (all deterministic)

| Signal | Definition | Weight [TUNE] |
|---|---|---|
| `zipf_rarity` | `clip(4.5 − zipf(token_lc), 0, 3)`; code idents not in wordfreq get zipf≈0 ⇒ 3.0 | ×2.0 |
| `is_code_ident` | §2.1 | +1.5 |
| `is_acronym` | §2.1 | +1.0 |
| `recurrence` | seen in ≥ 3 distinct frames | +1.0 |
| `multi_segment` | seen in ≥ 2 scene segments | +0.5 |
| `in_transcript` | normalized match OR Levenshtein ≤ 1 (len ≤ 6) / ≤ 2 (len > 6) [TUNE] against transcript vocab (ASR mangles rare words; fuzzy catches "idem-potency"-style splits only when close) | +1.5 |
| `near_confusion` | any observation frame within ±5000 ms [TUNE] of a frustration/confusion utterance (patent's attention-anchor correlation) | +1.5 |
| `is_glossary` | §2.4 | +2.5 |

`score = Σ`. **Keep if score ≥ keep_threshold = 4.0** [TUNE]. `confidence = min(0.95, score / 8.0)` [TUNE].

Recurrence and `in_transcript` are the garbage-killers: random OCR noise almost never repeats across frames or appears in speech.

### 2.3 Emission

- Group kept tokens by `(normalized_form, segment_id)`. `value_text` = most frequent surface form.
- `t_start_ms` / `t_end_ms` = first/last observing frame time within the segment (single-frame ⇒ `t_end_ms` null).
- `value_num` = observation count (frames) [TUNE].
- Payload:
~~~
{
  "concept": "idempotency",
  "source": {"type": "ocr",
             "location": {"frame_id": "…", "bbox": [x,y,w,h]}},
  "context": "Configure idempotency keys for retries"   // OCR line, ≤120 chars
}
~~~
- **`uri_analysis` (partial v1):** regex `(https?://)?[\w-]+(\.[\w-]+)+(/[\w\-./?%&=]*)?` over OCR lines in the top 8% of the frame (address-bar band [TUNE]); path segments and non-TLD domain tokens become concept candidates with `source.type='uri_analysis'`, `location=null`, same scoring. Frequently null in practice (address bar legibility) — honest expectation: fires on a minority of browser footage [TUNE].
- **Not v1:** transcript-only concepts. The patent `source.type` enum is `ocr|uri_analysis`; we do not mint a third type unilaterally. Transcript is evidence, not a source. Flagged in §7.

Example measure:
~~~
{"kind": "concept", "category": "cognitive",
 "t_start_ms": 812300, "t_end_ms": 826100,
 "value_num": 5, "value_text": "idempotency",
 "confidence": 0.78, "payload": { … as above … }}
~~~

### 2.4 Glossary

Optional YAML config `glossary_path` (list of domain terms, e.g., patent-prosecution or internal jargon). Deterministic, version-controlled, recorded in provider `config_hash`. This is the **only** lever for common-word domain terms ("claim", "continuation", "closure") that rarity scoring structurally cannot see.

### 2.5 What deterministic-only misses (honest)

1. **Common-word jargon** (rarity-blind) — mitigated only by glossary. Without one, expect recall loss concentrated here.
2. **User-specific unfamiliarity** — we proxy with population rarity; a term familiar to this user but rare globally is a false positive. Unfixable without a user model.
3. **OCR-mangled stylized text** (code themes, low contrast) — recurrence filter trades recall for precision.
4. **Aurally-introduced concepts** ASR mangles beyond fuzzy range.
5. Expected real-footage: precision 0.6–0.75, recall 0.45–0.6 [TUNE]; synthetic fixtures should exceed 0.9/0.9 because terms are planted cleanly.

### 2.6 Optional flagged LLM arbiter (segment-naming precedent)

- Flag: `JAMS_CONCEPT_ARBITER=1` (default **off**; CI and fixtures always off).
- Input: the kept candidate list (term, score, context line, counts) — capped at 60 terms [TUNE].
- Contract: cheap tier model (same class/config as the segment-naming arbiter [TUNE — reuse precedent's client]) returns strict JSON `{"keep": [...], "reject": [...]}`.
- **Hard validation:** every returned term must ∈ candidate set; unknown terms, schema violations, or timeouts ⇒ discard arbiter output entirely and keep deterministic results (log `arbiter_rejected`). Arbiter may only filter/re-rank (`confidence *= 1.1`, clamped 0.95, for kept-borderline terms [TUNE]), never add.
- Decisions cached by `sha256(candidate_set + model_version)`; no scoring-path usage until §4.4 gate passes.

---

## 3. CHOICES

Goal: detect **option sets presented to the user**, count options, attach prompt and dwell duration. `kind='choice'`, `category='cognitive'`.

### 3.1 Candidate set detection (four detectors, all deterministic)

**A. Glyph-anchored sets (strongest).**
1. Cluster OCR lines into row groups: ≥ 2 rows [TUNE; 3 for geometry-only below], each text ≤ 60 chars [TUNE], left-edge alignment `std(x0) < 15 px` [TUNE], vertical spacing CV < 0.25 [TUNE], total span ≤ 400 px [TUNE].
2. For each row, crop a glyph patch at full res: `[y−4 : y+h+4, x0−48 : x0−6]` [TUNE].
3. Radio: Canny(50,150) → HoughCircles, radius ∈ [4,14] px scaled to row height, `param2=12` [TUNE]. Checkbox: contour approx → quadrilateral, aspect 0.8–1.25, area within 0.3–1.2× row-height² [TUNE].
4. ≥ 2 rows with consistent glyph kind ⇒ set; `glyph='radio'|'checkbox'`; base conf **0.9**.

**B. Enumerated lists (terminals, menus).** Rows matching `^\s*(\(?\d{1,2}[\).\]:]?|[a-zA-Z][\).])\s+\S` with **sequential** markers (1,2,3… or a,b,c…) ⇒ set; `glyph='number'|'letter'`; base conf **0.8**.

**C. Geometry-only.** Row-group rules from A without glyphs or enumeration ⇒ base conf **0.55** [TUNE].

**D. Dropdown-expanded (best-effort).** A row group whose region shows a large appearance diff vs the same region in the previous candidate frame (mean-abs-diff on the gray proxy > `τ_appear = 0.2` [TUNE]) with a single-line control directly above the panel ⇒ `glyph='none'`, `dropdown=true`, base conf **0.5** [TUNE]. Honest: custom JS dropdowns will be missed whenever they animate in between candidate frames; this detector is opportunistic.

### 3.2 False-positive traps & mitigations

| Trap | Mitigation |
|---|---|
| Nav bars / app menus | Reject groups whose centroid is in the top 8% of frame height **and** y0 < 100 px [TUNE]; require vertical stacking (kills horizontal menus); **persistence blacklist:** any text row appearing in ≥ 70% [TUNE] of frames across ≥ 3 segments is chrome — blacklist `(text, quantized region)` globally. |
| Search results / file lists / feeds | Reject if rows ≥ 9 [TUNE] **and** (length CV > 0.5 or presence of right-aligned secondary column: ≥ 50% of rows have a second OCR line whose x0 exceeds group median x1 + 40 px [TUNE]). Hard cap: > 12 options ⇒ never a choice [TUNE]. |
| Code editors | Reject if > 50% of rows match code-line regexes (brackets/operators/keywords) or group overlaps a detected code block (≥ 3 rows with ≥ 30% symbol-char density) [TUNE]. |
| Form label+input pairs | Empty input boxes are large wide rects, not glyphs; label-only groups fall to detector C (0.55) and usually fail threshold unless enumerated. Acceptable: a labeled radio row **is** a choice; a text field is not. |
| Re-emission every frame | Dedupe signature `sha1(sorted(normalized_option_texts)) + quantize(region, 50px)` [TUNE] within a segment ⇒ single measure; update `t_end_ms` as interaction evidence accrues. |

Final: `confidence = base − penalties`; **emit if ≥ 0.5** [TUNE].

### 3.3 Prompt association, counting, duration

- **Prompt:** nearest OCR line above group top within 120 px [TUNE], not itself in any set; +rank if ends with `[?:]` or matches `(select|choose|which|pick|option)` [TUNE]. Else `prompt=null`.
- **Count:** `value_num = len(options.items)` — the patent's effort driver.
- **Duration:** `t_start_ms` = first frame the signature is seen (or containing-dwell start, whichever earlier). `t_end_ms` = earliest of: context switch, phase-correlation scroll-resume, region screen-change (gray-proxy mean-abs-diff in region > `τ_change = 0.15` [TUNE]), segment end. If segment end closes it: `duration.capped=true`. **Note:** no click/keypress stream is listed upstream — region-change is our interaction proxy; flagged in §7.
- Payload:
~~~
{
  "prompt": "Choose a retry policy",            // or null
  "options": {
    "count": 4,
    "items": [{"text": "Exponential backoff", "glyph": "radio", "bbox": [x,y,w,h]}, …],
    "dropdown": false,
    "selected": null                            // v1: selection state not committed
  },
  "duration": {"ms": 9300, "capped": false}     // or null
}
~~~

### 3.4 Honest accuracy

Glyph sets: ~0.85–0.9 precision / ~0.7 recall [TUNE]. Enumerated: ~0.8/0.7 (terminals good, dense menus trip the list-cap). Geometry-only: ~0.6 precision — exists for recall, kept quiet by the 0.5 emit floor and weight-0 policy. Dropdowns: weakest; treat as bonus, never load-bearing.

---

## 4. Fixtures

### 4.1 Synthetic pages (existing Playwright generator)

| Fixture | Planted ground truth |
|---|---|
| `concepts_article.html` | Nonsense-rare terms ("flongle", "unobtanium" — zipf≈0), real rare terms ("idempotency", "quorum"), and decoy common words that must **not** fire. One term repeated across 3 sections (recurrence), one term near a scripted confusion-sentiment utterance in the paired transcript fixture. |
| `choices_form.html` | Radio group (4 options + known prompt "Choose a plan:"), checkbox group (3), native `<select>` opened via script, JS custom dropdown. |
| `terminal_menu` (ffmpeg) | `drawtext` frame sequence rendering a 5-item numbered list; scroll simulated by animated crop offset to exercise phase-correlation dwell production upstream. |
| `distractors.html` | Top nav bar (6 links), 20-row search-results list, syntax-highlighted code block, label+text-input form ⇒ **zero** choice measures; only whitelisted planted concept terms. |

Paired transcripts: word-timestamped JSON fixtures, one utterance carrying `confusion` sentiment adjacent to a planted term.

### 4.2 Assertion design (golden measures JSON)

- Exact: `kind`, `category`, `value_num` (option counts, occurrence counts), planted `value_text`, option `items` (order-insensitive set equality), `glyph`.
- Toleranced: `t_start_ms`/`t_end_ms` ±500 ms [TUNE]; `confidence` within ±0.05 [TUNE] or band assert (`≥ 0.8` for glyph sets); OCR `conf` never asserted raw.
- Distractor page: assert empty choice list; concept list ⊆ whitelist.
- **Determinism test:** run the provider stage twice, canonical-JSON compare (ignoring run-id/wall-clock fields) ⇒ byte-identical.

### 4.3 What real-footage validation requires (before Effort-Score graduation)

**Weight-0 policy (restated):** both new kinds register in the Effort Score with weight 0. They are recorded, queryable, and visible in debug output, but contribute nothing to scoring until the gate passes:

1. ≥ 10 real videos [TUNE] spanning browser + terminal + docs, human-labeled for concepts encountered and choice sets presented.
2. Concepts: precision ≥ 0.70, recall ≥ 0.50 [TUNE]. Choices: precision ≥ 0.80, recall ≥ 0.60 [TUNE].
3. No P0 false-positive class: e.g., nav/search-results emitted as choices in > 5% of segments [TUNE] blocks graduation regardless of averages.
4. Golden fixtures green for ≥ 3 consecutive pipeline releases [TUNE].
5. Arbiter (if ever enabled) remains off the scoring path until a separate review.

Only then propose nonzero weights via the normal score-tuning review.

---

## 5. Provider Architecture

**Two MeasureProviders + one shared artifact stage.** Concepts and choices share OCR output but have independent failure modes, thresholds, and graduation timelines — coupling them in one provider forces joint versioning and joint weight-0 gating for no benefit. The OCR stage is an artifact provider (emits no measures), so both consumers stay pure functions of artifacts.

### 5.1 Manifests

~~~
id: jams.artifact.screen-ocr
version: 1.0.0
requires: [context_switch_keyframes, motion_artifact, dwell_info, frame_extractor]
provides: [artifact:screen_ocr_lines]     # §1.5 schema
emits: []                                 # artifact-only
budget_s: 120  # [TUNE]

id: jams.measure.cognitive.concepts
version: 1.0.0
requires: [artifact:screen_ocr_lines, transcript_words, sentiment, scene_segments]
provides: [measure:concept]
config: {glossary_path?: str, arbiter_flag: env JAMS_CONCEPT_ARBITER}
budget_s: 10   # [TUNE]

id: jams.measure.cognitive.choices
version: 1.0.0
requires: [artifact:screen_ocr_lines, scene_segments, interaction_events]
provides: [measure:choice]
budget_s: 20   # [TUNE]
~~~

**Execution order:** `screen-ocr` → (`concepts` ∥ `choices`). DAG-resolved via requires; the two measure providers are independent.

### 5.2 Payload commitments vs patent format

| Patent field | v1 status |
|---|---|
| concepts.concept / source.type=ocr / source.location / context | Committed (location = first-observation frame+bbox; context ≤ 120 chars, null if line unavailable) |
| concepts.source.type=uri_analysis | Partial: only from OCR'd address-bar band; `location=null`; often absent |
| choices.prompt | Committed, nullable |
| choices.options.{count, items{text, glyph, bbox}} | Committed |
| choices.options.selected | **Null v1** (filled-glyph detection specced in §3.1 but not committed) |
| choices.duration | Committed, nullable, with `capped` flag |

### 5.3 CPU budget table (15-min video, 2 vCPU)

| Stage | Est. [TUNE] | Cap [TUNE] |
|---|---|---|
| Frame extraction (extra) | 5 s | 15 s |
| OCR (parallel ×2) | 28 s | 90 s |
| Concept scoring (wordfreq, matching) | <1 s | 10 s |
| Glyph patches + geometry | 7 s | 20 s |
| **Total added pipeline time** | **~45 s** | **150 s** |

---

## 6. Risks (top 5, ranked)

1. **OCR garbage inflates concept candidates.** Rarity scoring structurally rewards garbage (zipf≈0). *Impact:* precision collapse, the worst failure mode for a cognitive-effort signal. *Mitigation:* recurrence + transcript cross-ref + conf floors + edit-distance-from-common-word drop; arbiter as optional backstop. *Residual:* medium — this is the risk the weight-0 gate exists for.
2. **Choice false positives from list UIs** (search results, feeds, file trees) that slip geometry filters. *Mitigation:* row-count caps, secondary-column and length-variance rejects, persistence blacklist, P0-class graduation blocker. *Residual:* medium.
3. **Cross-build/cross-arch ORT nondeterminism** breaks golden fixtures after a dependency bump. *Mitigation:* full pin set + model SHA256 + single-thread sessions + text-equality (not float-equality) assertions + documented tesseract fallback. *Residual:* low but permanent vigilance.
4. **Duration attribution error** — `t_end` relies on interaction proxies (no click stream), so durations skew long on passive viewing. *Mitigation:* `capped` flag, confidence penalty (−0.1 [TUNE]) when closed by segment end, treat duration as advisory until validated. *Residual:* medium-high for `duration` specifically, low for detection itself.
5. **Domain-term blindness** (common-word jargon) caps concept recall; the arbiter can only filter, so it cannot fix this. *Mitigation:* glossary config; documented limitation. *Residual:* high without deployment glossary — set stakeholder expectations accordingly.

---

## 7. Open Questions

1. **Arbitrary-timestamp full-res extraction:** assumed available for dwell frames. If only per-switch keyframes exist, D frames fall back to nearest keyframe (concept/choice recall drops; durations degrade). Confirm extractor capability.
2. **Interaction stream:** is there *any* click/keypress signal upstream? Region screen-change is a weak proxy for choice `t_end`.
3. **Transcript as concept source:** patent enum is `ocr|uri_analysis`. Do we extend the enum (patent-holder decision) or keep transcript evidence-only (current v1)?
4. **Glossary governance:** per-deployment config only, or do we ship a default software/patent glossary with the provider? Affects default recall materially.
5. **Arbiter model:** reuse the exact sanctioned cheap-LLM config from segment naming — confirm which model/tier that precedent pinned.
6. **Language scope:** v1 thresholds are English-tuned (wordfreq en). Multi-language OCR is supported by the det model, but rarity thresholds are not calibrated — declare English-only v1?
7. **Address-bar legibility:** at our keyframe resolution, is `uri_analysis` viable on real browser footage, or should v1 formally omit it (payload type never emitted)?
8. **Tall-window banding:** do real recordings include >2160 px captures that need tiled OCR (§1.3)?

---

## Claude's review (2026-07-18)

**Verdict: accepted with integration amendments.** Highlights: RapidOCR-onnx selection with honest tradeoffs and full determinism posture (single-thread ONNX, model SHA pins, text-equality assertions — the INT8 lesson generalized unprompted); candidate-frame selection that encodes the patent's own theory (dwell = reading = concept encounters; the cap prioritizes by dwell length); risk #1 correctly identifies that Zipf-rarity scoring structurally rewards OCR garbage.

**Amendments / open-question resolutions:**
1. OQ2 (interaction stream): F10's `physical.clicks`/`physical.keypresses` land before this implements — `jams.measure.cognitive.choices` takes them as OPTIONAL requires for `t_end`/duration, with the region-change proxy as documented fallback.
2. OQ1 (frame extraction): arbitrary-timestamp full-res extraction exists (pinned-ffmpeg seek, same path as thumbnails). Capability confirmed; not open.
3. OQ5 (arbiter): reuse the segment-naming precedent — OpenRouter endpoint, `OPENROUTER_API_KEY`, model via env (`JAMS_CONCEPT_ARBITER_MODEL`, default = `JAMS_LABELING_MODEL`), flag default off, always off in CI, filter-only with strict validation.
4. OQ6 (language): English-only v1, matching the transcription language pin. Declared, not open.
5. OQ3 (patent enum extension for transcript-sourced concepts) and OQ4 (glossary governance) are patent-holder decisions → moved to docs/CHRIS-TODO.md.

Implementation waits until after F10-c; slice order when it starts: screen-ocr artifact stage → choices → concepts.
