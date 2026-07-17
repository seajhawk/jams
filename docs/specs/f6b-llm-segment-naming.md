# Spec F6-b: flagged LLM segment naming (OpenRouter)

Branch `f1-foundation`; push when green. Read docs/PLAN.md §F6 and §Runtime AI cost strategy, plus docs/design/f3b-patent-core-providers.md's principle: **LLM as arbiter over deterministic candidates, never primary segmentation.** Worker-side slice.

1. Run config gains `llm_labeling: { enabled: boolean }` (default false). Env: `OPENROUTER_API_KEY` + `JAMS_LABELING_MODEL` (no hardcoded model; document choosing a cheap one in worker README). Hard guard: provider is a no-op when disabled, when the key is missing, or when `CI` env var is set — in that order, recorded in run payload as skipped_reason.
2. New provider `segment_labeling` v1.0.0 AFTER segmentation, BEFORE scoring: one chat-completions call to the OpenAI-compatible OpenRouter endpoint with the transcript utterances + current segment boundaries/names. Response contract (request JSON output): `[{segment_index, name, merge_with_next?}]`.
3. STRICT validation of the response — reject-and-continue on any violation (rule-based names stay; payload notes `llm_labeling: "rejected:<reason>"`): indices must exist; names 3–60 chars, no newlines; merges only adjacent pairs and at most 2 per run; NO boundary changes ever (naming + merge only). API error/timeout (15s) → same graceful skip. The run NEVER fails because of this provider.
4. Renamed segments: keep t_start/t_end, set source='llm'. time_segment measures updated only for merged pairs (idempotent write path as usual).
5. Tests: HTTP fully mocked (no live calls in tests/CI): happy rename, merge application, each rejection reason, disabled/missing-key/CI skips. `uv run pytest` + `ruff` green.
6. Live check (only if the key resolves): read the key via `powershell -c "[Environment]::GetEnvironmentVariable('OPENROUTER_API_KEY','User')"` and export for the run; enqueue the 2023 sample with the flag on; report the generated names, whether validation accepted them, and the token cost from the response usage. If the key doesn't resolve, say so and skip.
7. User dirty files untouched. Finish: summary + scorecard row.
