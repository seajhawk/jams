"""Azure Storage Queue worker entrypoint."""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from types import FrameType
from typing import Any

import psycopg
from azure.core.exceptions import ResourceExistsError
from azure.storage.blob import BlobServiceClient
from azure.storage.queue import QueueClient

from jams_worker.db import RunRepository
from jams_worker.errors import PipelineError, StaleLeaseError
from jams_worker.pipeline import MeasureProvider, PipelineContext, log_event, run_pipeline
from jams_worker.providers.clicks import ClicksProvider
from jams_worker.providers.context_switch import ContextSwitchProvider
from jams_worker.providers.keypresses import KeypressesProvider
from jams_worker.providers.probe import ProbeProvider
from jams_worker.providers.scoring import ScoringProvider
from jams_worker.providers.scrolls import ScrollsProvider
from jams_worker.providers.segment_labeling import SegmentLabelingProvider
from jams_worker.providers.segmentation import SegmentationProvider
from jams_worker.providers.sentiment import SentimentProvider
from jams_worker.providers.transcription import TranscriptionProvider
from jams_worker.settings import Settings

DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300
DEFAULT_LEASE_DURATION_SECONDS = 300
DEFAULT_RENEW_INTERVAL_SECONDS = 60
MAX_DEQUEUE_ATTEMPTS = 3
TERMINAL_ERROR_CODES = frozenset({"too_long", "corrupt_file"})


@dataclass(frozen=True, slots=True)
class MessageResult:
    run_id: str | None
    status: str
    poisoned: bool = False


class VisibilityRenewer:
    """Periodically renews Azure queue message visibility and database lease during long jobs."""

    def __init__(
        self,
        queue: QueueClient | None,
        message: Any,
        repo: RunRepository,
        run_id: str,
        database_url: str | None = None,
        interval_seconds: float = DEFAULT_RENEW_INTERVAL_SECONDS,
        visibility_timeout_seconds: int = DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
    ) -> None:
        self.queue = queue
        self.message_id = getattr(message, "id", None) if message else None
        self.pop_receipt = getattr(message, "pop_receipt", None) if message else None
        self.repo = repo
        self.run_id = run_id
        self.database_url = database_url
        self.interval_seconds = interval_seconds
        self.visibility_timeout_seconds = visibility_timeout_seconds
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self.last_error: Exception | None = None

    def start(self) -> None:
        has_msg = self.queue is not None and self.message_id is not None
        if has_msg or self.database_url is not None:
            self._thread = threading.Thread(
                target=self._run, daemon=True, name=f"renewer-{self.run_id}"
            )
            self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2.0)

    def get_pop_receipt(self) -> str | None:
        with self._lock:
            return self.pop_receipt

    def _run(self) -> None:
        while not self._stop_event.wait(timeout=self.interval_seconds):
            if self.queue is not None and self.message_id and self.pop_receipt:
                try:
                    if hasattr(self.queue, "update_message"):
                        res = self.queue.update_message(
                            self.message_id,
                            self.pop_receipt,
                            visibility_timeout=self.visibility_timeout_seconds,
                        )
                        if res is not None and hasattr(res, "pop_receipt") and res.pop_receipt:
                            with self._lock:
                                self.pop_receipt = res.pop_receipt
                        log_event("queue_visibility_renewed", run_id=self.run_id)
                except Exception as exc:
                    self.last_error = exc
                    log_event("queue_visibility_renew_error", run_id=self.run_id, error=str(exc))

            if self.database_url and self.repo.owner_id and self.repo.lease_token:
                try:
                    with psycopg.connect(self.database_url) as conn:
                        temp_repo = RunRepository(
                            conn,
                            owner_id=self.repo.owner_id,
                            lease_token=self.repo.lease_token,
                        )
                        temp_repo.renew_lease(
                            self.run_id, extension_seconds=self.visibility_timeout_seconds
                        )
                        log_event("db_lease_renewed", run_id=self.run_id)
                except Exception as exc:
                    self.last_error = exc
                    log_event("db_lease_renew_error", run_id=self.run_id, error=str(exc))


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
    worker_id: str | None = None,
    lease_duration_seconds: int = DEFAULT_LEASE_DURATION_SECONDS,
    renewer: VisibilityRenewer | None = None,
) -> str:
    repo = RunRepository(conn, owner_id=worker_id)
    run = repo.claim(run_id, owner_id=worker_id, lease_duration_seconds=lease_duration_seconds)
    if run is None:
        raise PipelineError("transient", f"Analysis run {run_id} is not visible in database")

    claim_status = run.get("claim_status")
    if claim_status in ("completed", "partial"):
        return "skipped"
    if claim_status == "terminal":
        return "terminal"
    if claim_status == "active":
        return "active"

    if renewer is not None:
        renewer.repo = repo
        renewer.start()

    try:
        with tempfile.TemporaryDirectory(prefix=f"jams-{run_id}-") as temp_dir:
            context = PipelineContext(
                run=run,
                org_id=str(run["org_id"]),
                blob_service_client=blob_service_client,
                db_conn=conn,
                workdir=Path(temp_dir),
                owner_id=repo.owner_id,
                lease_token=repo.lease_token,
                register_artifact=lambda kind, path: repo.register_artifact(
                    run_id,
                    str(run["org_id"]),
                    kind,
                    path,
                    attempt=int(run.get("attempt") or 1),
                ),
                heartbeat=lambda stage, pct, detail: repo.heartbeat(
                    run_id,
                    stage,
                    pct,
                    detail,
                    renew_lease_seconds=lease_duration_seconds,
                ),
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
    finally:
        if renewer is not None:
            renewer.stop()


def move_to_poison(
    *,
    message: Any,
    queue: QueueClient,
    poison_queue: QueueClient,
    pop_receipt: str | None = None,
) -> None:
    ensure_queue(poison_queue)
    poison_queue.send_message(message.content)
    receipt = pop_receipt or getattr(message, "pop_receipt", None)
    if receipt is not None:
        queue.delete_message(message.id, receipt)


def handle_message(
    *,
    message: Any,
    queue: QueueClient,
    poison_queue: QueueClient,
    conn: psycopg.Connection[Any],
    blob_service_client: BlobServiceClient,
    providers: list[MeasureProvider],
    worker_id: str | None = None,
    settings: Settings | None = None,
) -> MessageResult:
    worker = worker_id or f"worker-{uuid.uuid4()}"
    repo = RunRepository(conn, owner_id=worker)
    run_id: str | None = None
    renewer: VisibilityRenewer | None = None
    try:
        run_id = parse_message(str(message.content))
        log_event(
            "message_claim",
            run_id=run_id,
            worker_id=worker,
            dequeue_count=getattr(message, "dequeue_count", None),
        )
        visibility_timeout = (
            settings.visibility_timeout_seconds
            if settings
            else DEFAULT_VISIBILITY_TIMEOUT_SECONDS
        )
        lease_duration = (
            settings.lease_duration_seconds
            if settings
            else DEFAULT_LEASE_DURATION_SECONDS
        )
        renew_interval = (
            settings.visibility_renew_interval_seconds
            if settings
            else DEFAULT_RENEW_INTERVAL_SECONDS
        )
        renewer = VisibilityRenewer(
            queue=queue,
            message=message,
            repo=repo,
            run_id=run_id,
            database_url=settings.database_url if settings else None,
            interval_seconds=renew_interval,
            visibility_timeout_seconds=visibility_timeout,
        )

        status = process_run(
            run_id=run_id,
            conn=conn,
            blob_service_client=blob_service_client,
            providers=providers,
            worker_id=worker,
            lease_duration_seconds=lease_duration,
            renewer=renewer,
        )

        receipt = renewer.get_pop_receipt() or getattr(message, "pop_receipt", None)

        if status in ("skipped", "terminal"):
            if receipt is not None:
                queue.delete_message(message.id, receipt)
            return MessageResult(run_id, status)

        if status == "active":
            conn.rollback()
            return MessageResult(run_id, "active_lease")

        if receipt is not None:
            queue.delete_message(message.id, receipt)
        return MessageResult(run_id, status)

    except StaleLeaseError as exc:
        if renewer is not None:
            renewer.stop()
        conn.rollback()
        log_event("stale_lease_abort", run_id=run_id, error=str(exc))
        return MessageResult(run_id, "stale_lease")

    except PipelineError as exc:
        if renewer is not None:
            renewer.stop()
        receipt = (
            renewer.get_pop_receipt()
            if renewer
            else getattr(message, "pop_receipt", None)
        )
        # Terminal errors fail immediately on attempt 1 without waiting through visibility intervals
        if exc.error_code in TERMINAL_ERROR_CODES:
            if run_id is not None:
                repo.fail(run_id, exc.error_code, str(exc))
            move_to_poison(
                message=message, queue=queue, poison_queue=poison_queue, pop_receipt=receipt
            )
            return MessageResult(run_id, "poisoned", poisoned=True)

        if getattr(message, "dequeue_count", 1) >= MAX_DEQUEUE_ATTEMPTS:
            if run_id is not None:
                repo.fail(run_id, exc.error_code, str(exc))
            move_to_poison(
                message=message, queue=queue, poison_queue=poison_queue, pop_receipt=receipt
            )
            return MessageResult(run_id, "poisoned", poisoned=True)
        else:
            conn.rollback()
            if hasattr(queue, "update_message"):
                try:
                    queue.update_message(message.id, receipt, visibility_timeout=2)
                except Exception as update_exc:
                    log_event(
                        "update_message_failed",
                        run_id=run_id,
                        message_id=getattr(message, "id", None),
                        error=str(update_exc),
                    )
            return MessageResult(run_id, "redelivery")

    except Exception as exc:
        if renewer is not None:
            renewer.stop()
        receipt = (
            renewer.get_pop_receipt()
            if renewer
            else getattr(message, "pop_receipt", None)
        )
        if getattr(message, "dequeue_count", 1) >= MAX_DEQUEUE_ATTEMPTS:
            if run_id is not None:
                repo.fail(run_id, "unknown", str(exc))
            move_to_poison(
                message=message, queue=queue, poison_queue=poison_queue, pop_receipt=receipt
            )
            return MessageResult(run_id, "poisoned", poisoned=True)
        else:
            conn.rollback()
            if hasattr(queue, "update_message"):
                try:
                    queue.update_message(message.id, receipt, visibility_timeout=2)
                except Exception as update_exc:
                    log_event(
                        "update_message_failed",
                        run_id=run_id,
                        message_id=getattr(message, "id", None),
                        error=str(update_exc),
                    )
            return MessageResult(run_id, "redelivery")


def run_loop(
    settings: Settings | None = None,
    *,
    drain: bool = False,
    worker_id: str | None = None,
) -> None:
    settings = settings or Settings()
    worker = worker_id or f"worker-{uuid.uuid4()}"
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
        TranscriptionProvider(),
        ContextSwitchProvider(),
        ScrollsProvider(),
        KeypressesProvider(),
        ClicksProvider(),
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
        worker_id=worker,
        queue=settings.jobs_queue_name,
        poison_queue=settings.poison_queue_name,
        drain=drain,
        openrouter_key_present=bool(os.environ.get("OPENROUTER_API_KEY")),
        labeling_model=os.environ.get("JAMS_LABELING_MODEL"),
    )

    visibility_timeout = getattr(
        settings, "visibility_timeout_seconds", DEFAULT_VISIBILITY_TIMEOUT_SECONDS
    )

    with psycopg.connect(settings.database_url) as conn:
        while not stop.requested:
            messages = queue.receive_messages(
                messages_per_page=1,
                visibility_timeout=visibility_timeout,
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
                        worker_id=worker,
                        settings=settings,
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
