# Preview container contract

Both images build from the repository root and use Dockerfile-specific ignore
files. Build and push are separate operations; CI only builds and runs smoke checks.

## Web

`docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=... .`

The publishable Clerk key is the only build argument. Secret Clerk, database,
storage, queue, scheduler and preview settings are runtime environment values. The
image runs `node apps/web/server.js` as user `node` on port 3000. A load balancer
should probe `GET /api/health/live`; it returns cache-disabled `{ "status": "ok" }`
without Clerk or database access.

## Worker

`docker build -f worker/Dockerfile .` downloads immutable media/model assets during
the build. `DATABASE_URL` and `AZURE_STORAGE_CONNECTION_STRING` are required only
when the `jams-worker` entrypoint starts. The image defaults to offline Hugging Face
mode and uses `/opt/jams-cache/whisper` and `/opt/jams-cache/sentiment`. The final
process runs as user `jams` and needs writable temporary storage for per-run media.

`PREWARM_MODELS=false` skips model downloads for fast Dockerfile structure checks;
such an image is not suitable for narrated production work. CI's release smoke build
uses the default prewarm and then verifies Whisper and ONNX sentiment with no network.

The local Docker engine was unavailable during this preparation. GitHub Actions
verified the Linux image build after the demo fixture was added to the web context;
actual ACA startup remains a staging verification gate.
