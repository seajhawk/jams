"""Azure Storage Queue worker entrypoint."""

from __future__ import annotations

import json
import signal
import tempfile
import time
from pathlib import Path
from types import FrameType
from typing import Any

import psycopg
from azure.core.exceptions import ResourceExistsError
from azure.storage.blob import BlobServiceClient
from azure.storage.queue import QueueClient

from jams_worker.db import RunRepository
from jams_worker.errors import PipelineError
from jams_worker.pipeline import MeasureProvider, PipelineContext, run_pipeline
from jams_worker.providers.probe import ProbeProvider
from jams_worker.settings import Settings

VISIBILITY_TIMEOUT_SECONDS = 45 * 60
MAX_DEQUEUE_ATTEMPTS = 3


def ensure_queue(queue: QueueClient) -> None:
    try:
        queue.create_queue()
    except ResourceExistsError:
        pass


class StopSignal:
    def __init__(self) -> None:
        self.requested = False

    def handle(self, _signum: int, _frame: FrameType | None) -> None:
        self.requested = True


def parse_message(content: str) -> str:
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as exc:
        raise PipelineError("unknown", "Queue message was not valid JSON") from exc
    run_id = payload.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        raise PipelineError("unknown", "Queue message is missing run_id")
    return run_id


def process_run(
    *,
    run_id: str,
    conn: psycopg.Connection[Any],
    blob_service_client: BlobServiceClient,
    providers: list[MeasureProvider],
) -> str:
    repo = RunRepository(conn)
    run = repo.claim(run_id)
    if run is None or run["status"] == "succeeded":
        return "skipped"

    with tempfile.TemporaryDirectory(prefix=f"jams-{run_id}-") as temp_dir:
        context = PipelineContext(
            run=run,
            org_id=str(run["org_id"]),
            blob_service_client=blob_service_client,
            db_conn=conn,
            workdir=Path(temp_dir),
            register_artifact=lambda kind, path: repo.register_artifact(
                run_id, str(run["org_id"]), kind, path
            ),
            heartbeat=lambda stage, pct, detail: repo.heartbeat(run_id, stage, pct, detail),
        )
        result = run_pipeline(context, providers)
        repo.set_provider_versions(run_id, result.provider_versions)
        detail = (
            "Analysis completed"
            if result.status == "succeeded"
            else "Analysis partially completed"
        )
        repo.finalize(
            run_id,
            result.status,
            detail,
        )
        return result.status


def move_to_poison(
    *,
    message: Any,
    queue: QueueClient,
    poison_queue: QueueClient,
) -> None:
    ensure_queue(poison_queue)
    poison_queue.send_message(message.content)
    queue.delete_message(message.id, message.pop_receipt)


def handle_message(
    *,
    message: Any,
    queue: QueueClient,
    poison_queue: QueueClient,
    conn: psycopg.Connection[Any],
    blob_service_client: BlobServiceClient,
    providers: list[MeasureProvider],
) -> None:
    repo = RunRepository(conn)
    try:
        run_id = parse_message(str(message.content))
        process_run(
            run_id=run_id,
            conn=conn,
            blob_service_client=blob_service_client,
            providers=providers,
        )
    except PipelineError as exc:
        if getattr(message, "dequeue_count", 1) >= MAX_DEQUEUE_ATTEMPTS:
            if "run_id" in locals():
                repo.fail(run_id, exc.error_code, str(exc))
            move_to_poison(message=message, queue=queue, poison_queue=poison_queue)
        else:
            conn.rollback()
    except Exception as exc:
        if getattr(message, "dequeue_count", 1) >= MAX_DEQUEUE_ATTEMPTS:
            if "run_id" in locals():
                repo.fail(run_id, "unknown", str(exc))
            move_to_poison(message=message, queue=queue, poison_queue=poison_queue)
        else:
            conn.rollback()
    else:
        queue.delete_message(message.id, message.pop_receipt)


def run_loop(settings: Settings | None = None) -> None:
    settings = settings or Settings()
    queue = QueueClient.from_connection_string(
        settings.azure_storage_connection_string,
        settings.jobs_queue_name,
    )
    poison_queue = QueueClient.from_connection_string(
        settings.azure_storage_connection_string,
        settings.poison_queue_name,
    )
    ensure_queue(queue)
    ensure_queue(poison_queue)
    blob_service_client = BlobServiceClient.from_connection_string(
        settings.azure_storage_connection_string
    )
    providers: list[MeasureProvider] = [ProbeProvider()]

    stop = StopSignal()
    signal.signal(signal.SIGINT, stop.handle)
    signal.signal(signal.SIGTERM, stop.handle)

    with psycopg.connect(settings.database_url) as conn:
        while not stop.requested:
            messages = queue.receive_messages(
                messages_per_page=1,
                visibility_timeout=VISIBILITY_TIMEOUT_SECONDS,
            )
            handled = False
            for message in messages:
                handled = True
                try:
                    handle_message(
                        message=message,
                        queue=queue,
                        poison_queue=poison_queue,
                        conn=conn,
                        blob_service_client=blob_service_client,
                        providers=providers,
                    )
                except Exception:
                    conn.rollback()
                    raise
            if not handled:
                time.sleep(2)


def main() -> None:
    run_loop()


if __name__ == "__main__":
    main()
