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
