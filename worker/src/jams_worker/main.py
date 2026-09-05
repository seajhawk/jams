"""Azure Storage Queue worker entrypoint."""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from types import FrameType
from typing import Any

import psycopg
from azure.core.exceptions import ResourceExistsError
from azure.storage.blob import BlobServiceClient
from azure.storage.queue import QueueClient

from jams_worker.db import RunRepository
from jams_worker.errors import PipelineError
from jams_worker.pipeline import MeasureProvider, PipelineContext, log_event, run_pipeline
from jams_worker.providers.context_switch import ContextSwitchProvider
from jams_worker.providers.probe import ProbeProvider
from jams_worker.providers.scoring import ScoringProvider
from jams_worker.providers.segment_labeling import SegmentLabelingProvider
from jams_worker.providers.segmentation import SegmentationProvider
from jams_worker.providers.sentiment import SentimentProvider
from jams_worker.providers.transcription import TranscriptionProvider
from jams_worker.settings import Settings

VISIBILITY_TIMEOUT_SECONDS = 45 * 60
MAX_DEQUEUE_ATTEMPTS = 3


@dataclass(frozen=True, slots=True)
class MessageResult:
    run_id: str | None
    status: str
    poisoned: bool = False


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
    if run is None:
        raise PipelineError("transient", f"Analysis run {run_id} is not visible in database")
    if run["status"] in ("succeeded", "partial", "failed"):
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
        repo.set_provider_results(run_id, result.provider_summaries)
        partial_reasons = [
            f"{provider_id}:{summary.get('reason')}"
            for provider_id, summary in result.provider_summaries.items()
            if summary.get("status") == "partial"
        ]
        detail = (
            "Analysis completed"
            if result.status == "succeeded"
            else f"Analysis partially completed ({', '.join(partial_reasons)})"
            if partial_reasons
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
) -> MessageResult:
    repo = RunRepository(conn)
    run_id: str | None = None
    try:
        run_id = parse_message(str(message.content))
        log_event(
            "message_claim",
            run_id=run_id,
            dequeue_count=getattr(message, "dequeue_count", None),
        )
        status = process_run(
            run_id=run_id,
            conn=conn,
            blob_service_client=blob_service_client,
            providers=providers,
        )
    except PipelineError as exc:
        if getattr(message, "dequeue_count", 1) >= MAX_DEQUEUE_ATTEMPTS:
            if run_id is not None:
                repo.fail(run_id, exc.error_code, str(exc))
            move_to_poison(message=message, queue=queue, poison_queue=poison_queue)
            return MessageResult(run_id, "poisoned", poisoned=True)
        else:
            conn.rollback()
            if hasattr(queue, "update_message"):
                try:
                    queue.update_message(message.id, message.pop_receipt, visibility_timeout=2)
                except Exception as update_exc:
                    log_event(
                        "update_message_failed",
                        run_id=run_id,
                        message_id=getattr(message, "id", None),
                        error=str(update_exc),
                    )
            return MessageResult(run_id, "redelivery")
    except Exception as exc:
        if getattr(message, "dequeue_count", 1) >= MAX_DEQUEUE_ATTEMPTS:
            if run_id is not None:
                repo.fail(run_id, "unknown", str(exc))
            move_to_poison(message=message, queue=queue, poison_queue=poison_queue)
            return MessageResult(run_id, "poisoned", poisoned=True)
        else:
            conn.rollback()
            if hasattr(queue, "update_message"):
                try:
                    queue.update_message(message.id, message.pop_receipt, visibility_timeout=2)
                except Exception as update_exc:
                    log_event(
                        "update_message_failed",
                        run_id=run_id,
                        message_id=getattr(message, "id", None),
                        error=str(update_exc),
                    )
            return MessageResult(run_id, "redelivery")
    else:
        queue.delete_message(message.id, message.pop_receipt)
        return MessageResult(run_id, status)


def run_loop(settings: Settings | None = None, *, drain: bool = False) -> None:
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
    providers: list[MeasureProvider] = [
        ProbeProvider(),
        ContextSwitchProvider(),
        TranscriptionProvider(),
        SentimentProvider(),
        SegmentationProvider(),
        SegmentLabelingProvider(),
        ScoringProvider(),
    ]

    stop = StopSignal()
    signal.signal(signal.SIGINT, stop.handle)
    signal.signal(signal.SIGTERM, stop.handle)

    log_event(
        "worker_start",
        queue=settings.jobs_queue_name,
        poison_queue=settings.poison_queue_name,
        drain=drain,
        openrouter_key_present=bool(os.environ.get("OPENROUTER_API_KEY")),
        labeling_model=os.environ.get("JAMS_LABELING_MODEL"),
    )

    with psycopg.connect(settings.database_url) as conn:
        while not stop.requested:
            messages = queue.receive_messages(
                messages_per_page=1,
                visibility_timeout=VISIBILITY_TIMEOUT_SECONDS,
            )
            handled = False
            for message in messages:
                handled = True
                started_at = time.perf_counter()
                try:
                    result = handle_message(
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
                finally:
                    duration_ms = round((time.perf_counter() - started_at) * 1000)
                log_event(
                    "run_summary",
                    run_id=result.run_id,
                    status=result.status,
                    poisoned=result.poisoned,
                    duration_ms=duration_ms,
                )
            if not handled:
                if drain:
                    log_event("drain_complete")
                    return
                time.sleep(2)


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True, write_through=True)
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--drain",
        action="store_true",
        help="Process available queue messages, then exit when the queue is empty.",
    )
    args = parser.parse_args()
    run_loop(drain=args.drain)


if __name__ == "__main__":
    main()
