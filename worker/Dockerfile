# Build from the repository root:
#   docker build -f worker/Dockerfile .
FROM python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.11.29 /uv /uvx /bin/

RUN apt-get update && apt-get install --no-install-recommends -y libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker/pyproject.toml worker/uv.lock worker/README.md ./
COPY worker/src ./src
COPY worker/scripts/prepare_runtime.py ./scripts/prepare_runtime.py

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    JAMS_WHISPER_MODEL_CACHE=/opt/jams-cache/whisper \
    JAMS_SENTIMENT_MODEL_CACHE=/opt/jams-cache/sentiment \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN uv sync --locked --no-dev
ARG PREWARM_MODELS=true
RUN mkdir -p /opt/jams-cache/whisper /opt/jams-cache/sentiment \
    && if [ "$PREWARM_MODELS" = "true" ]; then .venv/bin/python scripts/prepare_runtime.py; else .venv/bin/python scripts/prepare_runtime.py --skip-models; fi \
    && useradd --create-home --uid 10001 jams \
    && chown -R jams:jams /opt/jams-cache /app

USER jams
ENV PATH="/app/.venv/bin:${PATH}"
ENV HF_HUB_OFFLINE=1

ENTRYPOINT ["jams-worker"]
