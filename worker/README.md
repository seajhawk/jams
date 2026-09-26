# JAMS Worker

Local run:

1. Start shared services from the repo root:

   ```powershell
   docker compose up
   ```

2. In another shell, run the worker:

   ```powershell
   cd worker
   $env:DATABASE_URL = "postgresql://jams_worker:jams_worker@localhost:5432/jams"
   $env:AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true"
   uv run jams-worker --drain
   ```

3. For sign-in-free local checks, enqueue an uploaded video directly:

   ```powershell
   uv run python scripts/enqueue_local.py <video-id>
   uv run python scripts/enqueue_local.py <video-id> --config '{"llm_labeling":{"enabled":true}}'
   ```

`--drain` processes available `analysis-jobs` messages, writes run heartbeats to
Postgres, emits one structured summary line per run, and exits when the queue is
empty. Without `--drain`, the worker keeps polling indefinitely. Third-failure
messages are placed on `analysis-jobs-poison`.

Sentiment model cache:

- Default path: `%USERPROFILE%\.cache\jams-worker\sentiment` on Windows, or
  `~/.cache/jams-worker/sentiment` elsewhere.
- Override with `JAMS_SENTIMENT_MODEL_CACHE`.
- Models are registered in `jams_worker/providers/sentiment_models.py` behind one
  `SentimentModel` interface. Ids: `roberta-3class` (default:
  `Xenova/twitter-roberta-base-sentiment-latest`, three-class, revision
  `f3ec4d0925f90c3ca7ee7814f52d6ee7cf180445`, `onnx/model_int8.onnx` on ONNX Runtime CPU),
  `sst2` (the previous two-class model, for reproducing old runs), `vader`, and `remote`.
- Selection: the run's `sentiment.model`, then `JAMS_SENTIMENT_MODEL`, then the default.
  `sentiment.fallback: "vader"` switches to VADER if the chosen model fails, and the run summary
  records `fallback_used`. Every measure's payload names the model that produced it.
- `remote` calls any OpenAI-compatible chat-completions endpoint and is never a default:
  `JAMS_SENTIMENT_REMOTE_URL` (default OpenRouter), `JAMS_SENTIMENT_REMOTE_MODEL`, and
  `JAMS_SENTIMENT_REMOTE_KEY_ENV` naming the variable that holds the key (default
  `OPENROUTER_API_KEY`). Tests use an injected transport; CI never calls it.
- The image bakes in the default model (`scripts/prepare_runtime.py` calls
  `get_model(DEFAULT_MODEL_ID).prepare()`); the container smoke test classifies offline.

Optional LLM segment naming:

- Disabled by default. Enable per run with config
  `{"llm_labeling":{"enabled":true}}`.
- Set `OPENROUTER_API_KEY` and `JAMS_LABELING_MODEL` to use the OpenRouter
  OpenAI-compatible chat completions endpoint. Pick a cheap, low-latency model
  for concise JSON labeling; the worker intentionally has no model default.
- The provider is still a no-op when `CI` is set, even if the flag and key are
  present. Tests must never make live LLM calls.

Golden fixture generation:

- Core synthetic fixtures:

  ```powershell
  cd worker
  uv run python scripts/make_fixtures.py --force
  ```

- CV/browser fixtures require `pnpm`, `espeak-ng` for narrated audio variants,
  and the repo-wide cached Playwright Chromium used by `apps/web`:

  ```powershell
  cd worker/scripts/make_cv_fixtures
  pnpm install
  pnpm fixtures --output-dir ../../tests/fixtures/generated
  ```

  Keep this package's `playwright` version exactly aligned with
  `apps/web`'s locked `@playwright/test` version so both harnesses reuse one
  cached browser build. Do not install a separate browser for this package.

  The Playwright harness records the browser WebM, writes JSONL input events via
  `addInitScript`, and normalizes the video through the same ffmpeg resolver
  settings used by production. Pytest marks these checks as `playwright` and
  skips them when the package or browser is absent.

- Narrated transient fixtures pin `TRANSIENT_TO_SPEECH_DB = -6.0` in
  `scripts/make_fixtures.py`. Transcript/VAD artifacts are generated through the
  real faster-whisper provider only when `JAMS_RUN_WHISPER_TESTS=1` and cached
  weights exist; normal tests record those artifacts as pending.

