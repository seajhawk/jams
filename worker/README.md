# JAMS Worker

Local run:

1. Start shared services from the repo root:

   ```powershell
   docker compose up
   ```

2. In another shell, run the worker:

   ```powershell
   cd worker
   $env:DATABASE_URL = "postgresql://jams:jams@localhost:5432/jams"
   $env:AZURE_STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true"
   uv run jams-worker
   ```

3. For sign-in-free local checks, enqueue an uploaded video directly:

   ```powershell
   uv run python scripts/enqueue_local.py <video-id>
   ```

The loop long-polls `analysis-jobs`, writes run heartbeats to Postgres, and
places third-failure messages on `analysis-jobs-poison`.

Sentiment model cache:

- Default path: `%USERPROFILE%\.cache\jams-worker\sentiment` on Windows, or
  `~/.cache/jams-worker/sentiment` elsewhere.
- Override with `JAMS_SENTIMENT_MODEL_CACHE`.
- The provider downloads the pinned
  `Xenova/distilbert-base-uncased-finetuned-sst-2-english` revision
  `0b6928efcb76139cae2c6881d49cda67fe119f42` on first use and runs
  `onnx/model_int8.onnx` with ONNX Runtime CPU. Build images may pre-warm this
  cache by importing `jams_worker.providers.sentiment` and calling
  `classify_onnx(["cache warmup"])`.
