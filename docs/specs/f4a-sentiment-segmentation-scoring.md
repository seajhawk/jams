# Spec F4-a: sentiment + segmentation + scoring providers

Implements docs/PLAN.md §Analysis pipeline stages 5–7 and the remaining §Data model tables. Branch `f1-foundation`. NORMATIVE PARITY SOURCE: `apps/web/src/lib/effort-score.ts` — the Python scoring must reproduce it exactly (same PER_MINUTE_SCALE constants, same rounding, same category mapping incl. utterance→speech) and is parity-tested against the expected `score` block in `fixtures/demo-report.v1.json`.

## Schema (Drizzle migration, apps/web)

1. `segments`, `weight_profiles`, `effort_scores` exactly per PLAN.md §Data model. Seed a default weight profile on org creation (extend the existing Clerk webhook org upsert; also backfill for existing orgs in the migration): weights {context_switch:3, sentiment:4, spoken_word:1, time_segment:2}, normalization {context_switch:per_minute, sentiment:neg_density, spoken_word:per_minute, time_segment:raw_minutes}, is_default=true.

## Worker providers

2. `sentiment` provider v1.0.0: per-utterance sentiment via distilbert-base-uncased-finetuned-sst-2-english ONNX INT8 on onnxruntime CPU (export/quantize at image-build time or first-use cache — document; pin revision). Map to value_num ∈ [−1,1] (negative prob − positive prob convention documented), spans = utterance timing, category='sentiment', confidence = max class prob. Deterministic: fixed model revision, no truncation surprises (max 256 tokens, truncate with marker in payload). VADER fallback behind a provider param. Runs only when utterances exist; else skipped.
3. `segmentation` provider v1.0.0: regex cue pass over utterance texts (configurable cue lists per PLAN.md stage 8: start/next/done phrases) ∪ context_switch boundaries; merge rules: min segment 10s, snap cues to nearest switch within 3s; build `segments` rows (flat for now, parent_segment_id null) with source per origin + `time_segment` measures (value_num=duration_ms). Segment naming: rule-based ("Segment N" or the cue text trimmed) — the Haiku labeling stays OFF (F6).
4. `scoring` provider v1.0.0 (terminal): replicate normalize()+score() from effort-score.ts in Python; read the org default weight_profile; write the `effort_scores` snapshot row (components incl. speech, total, full breakdown jsonb). PARITY TEST: feed the demo fixture's measures through Python scoring and assert exact equality with the fixture's score block (same rounding).
5. Wire order: probe → context_switch → transcription → sentiment → segmentation → scoring. Per-provider partial semantics preserved.

## Tests + live check

6. Sentiment: deterministic unit tests on fixed sentences (clearly pos/neg/neutral); no golden transcript needed. Segmentation: unit tests on synthetic utterance+switch series covering merge/snap/min-length rules. Scoring: the parity test (exact) + property test (zero-weight kind drops out).
7. Live: enqueue the 2023 mp4 → succeeded; report segment count, sentiment distribution (n pos/neg/neutral), and the computed total Effort Score.
8. `uv run pytest` + `ruff` + `pnpm build/lint/test` + `pnpm db:migrate` green. Logical commits; no push; user dirty files untouched. Finish: summary + scorecard row (✅/⚠️/❌ legend).
