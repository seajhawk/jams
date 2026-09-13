"""Real PostgreSQL serialization tests against the TypeScript-migrated schema.

Set JAMS_TEST_DATABASE_URL to an isolated, migrated test database. No DDL or
model calls run here; each test removes only its own randomly identified rows.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import psycopg
import pytest

from jams_worker.db import RunRepository
from jams_worker.errors import StaleLeaseError
from jams_worker.pipeline import PipelineContext
from jams_worker.providers import context_switch, probe, transcription

Upload = Callable[[PipelineContext, Path, str], None]
UPLOADS = [probe._upload_blob, transcription._upload_derived, context_switch._upload_derived]


@pytest.fixture
def run_db() -> Iterator[tuple[Any, Any, str, str]]:
    url = os.environ.get("JAMS_TEST_DATABASE_URL")
    if not url:
        pytest.skip("JAMS_TEST_DATABASE_URL must point to an isolated migrated database")
    video_id, run_id = str(uuid.uuid4()), str(uuid.uuid4())
    with psycopg.connect(url, autocommit=True) as worker:
        with psycopg.connect(url, autocommit=True) as other:
            worker.execute(
                """insert into videos (id, org_id, title, blob_path, uploaded_by)
                   values (%s, %s, 'fencing test', 'test/original.mp4', 'test')""",
                (video_id, f"org_fence_{video_id}"),
            )
            try:
                worker.execute(
                    """insert into analysis_runs
                       (id, video_id, org_id, pipeline_version, status,
                        owner_id, lease_token, lease_expires_at)
                       values (%s, %s, %s, 'test', 'running', 'owner', 'token',
                               clock_timestamp() + interval '5 minutes')""",
                    (run_id, video_id, f"org_fence_{video_id}"),
                )
                yield worker, other, video_id, run_id
            finally:
                worker.rollback()
                other.execute("delete from videos where id = %s", (video_id,))


def upload_context(run_db: tuple[Any, Any, str, str], tmp_path: Path) -> PipelineContext:
    worker, _, video_id, run_id = run_db
    return PipelineContext(
        run={"id": run_id, "video_id": video_id},
        org_id=f"org_fence_{video_id}",
        db_conn=worker,
        blob_service_client=Mock(),
        workdir=tmp_path,
        owner_id="owner",
        lease_token="token",
        artifact_write=lambda: RunRepository(
            worker, owner_id="owner", lease_token="token"
        ).artifact_write(run_id),
        register_artifact=Mock(),
        heartbeat=Mock(),
    )


@pytest.mark.parametrize("upload", UPLOADS, ids=["probe", "transcript", "scenes"])
def test_delete_waits_for_upload_and_deleted_run_cannot_upload(
    run_db: tuple[Any, Any, str, str], tmp_path: Path, upload: Upload
) -> None:
    _, other, video_id, _ = run_db
    context = upload_context(run_db, tmp_path)
    source = tmp_path / "artifact"
    source.write_bytes(b"artifact bytes")
    container = context.blob_service_client.get_container_client.return_value

    # Production uses autocommit reads and explicit transaction scopes for
    # registration. Neither a read nor a prior registration may leak a stronger
    # row lock into the following upload and block lease renewal.
    worker = run_db[0]
    worker.execute("select id from analysis_runs where id = %s", (context.run_id,))
    RunRepository(worker, owner_id="owner", lease_token="token").register_artifact(
        context.run_id, context.org_id, "previous", "runs/test/previous", attempt=1
    )

    def upload_while_delete_attempts(*_args: Any, **_kwargs: Any) -> None:
        # Renewal must complete while storage I/O remains in progress.
        with other.transaction():
            other.execute("set local lock_timeout = '100ms'")
            RunRepository(other, owner_id="owner", lease_token="token").renew_lease(
                context.run_id
            )
        # The real FK cascade must wait while the storage call is still active.
        with pytest.raises(psycopg.errors.LockNotAvailable):
            with other.transaction():
                other.execute("set local lock_timeout = '100ms'")
                other.execute("delete from videos where id = %s", (video_id,))

    container.upload_blob.side_effect = upload_while_delete_attempts
    upload(context, source, "runs/test/artifact")
    container.upload_blob.assert_called_once()
    other.execute("delete from videos where id = %s", (video_id,))
    context.blob_service_client.reset_mock()
    with pytest.raises(StaleLeaseError):
        upload(context, source, "runs/test/artifact")
    context.blob_service_client.assert_not_called()
    container.upload_blob.assert_not_called()


@pytest.mark.parametrize("upload", UPLOADS, ids=["probe", "transcript", "scenes"])
@pytest.mark.parametrize("change", ["expired", "replaced", "terminal"])
def test_stale_or_terminal_worker_does_not_write_storage(
    run_db: tuple[Any, Any, str, str], tmp_path: Path, upload: Upload, change: str
) -> None:
    _, other, _, run_id = run_db
    context = upload_context(run_db, tmp_path)
    statements = {
        "expired": (
            "update analysis_runs set lease_expires_at = "
            "clock_timestamp() - interval '1 second' where id = %s"
        ),
        "replaced": "update analysis_runs set lease_token = 'replacement' where id = %s",
        "terminal": "update analysis_runs set status = 'failed' where id = %s",
    }
    other.execute(statements[change], (run_id,))
    with pytest.raises(StaleLeaseError):
        upload(context, tmp_path / "does-not-exist", "runs/test/artifact")
    context.blob_service_client.get_container_client.assert_not_called()


def test_upload_failure_releases_lock(run_db: tuple[Any, Any, str, str], tmp_path: Path) -> None:
    _, other, video_id, _ = run_db
    context = upload_context(run_db, tmp_path)
    source = tmp_path / "artifact"
    source.write_bytes(b"artifact bytes")
    container = context.blob_service_client.get_container_client.return_value
    container.upload_blob.side_effect = OSError("storage unavailable")
    with pytest.raises(OSError, match="storage unavailable"):
        probe._upload_blob(context, source, "runs/test/artifact")
    with other.transaction():
        other.execute("set local lock_timeout = '100ms'")
        other.execute("delete from videos where id = %s", (video_id,))


def test_takeover_during_admitted_upload_prevents_artifact_publication(
    run_db: tuple[Any, Any, str, str], tmp_path: Path
) -> None:
    worker, other, _, run_id = run_db
    context = upload_context(run_db, tmp_path)
    source = tmp_path / "artifact"
    source.write_bytes(b"old attempt")

    def take_over(*_args: Any, **_kwargs: Any) -> None:
        with other.transaction():
            other.execute("set local lock_timeout = '100ms'")
            other.execute(
                "update analysis_runs set owner_id = 'replacement', "
                "lease_token = 'new-token', attempt = attempt + 1 where id = %s",
                (run_id,),
            )

    container = context.blob_service_client.get_container_client.return_value
    container.upload_blob.side_effect = take_over
    path = f"runs/{run_id}/attempts/1/probe/poster.jpg"
    probe._upload_blob(context, source, path)
    with pytest.raises(StaleLeaseError):
        RunRepository(worker, owner_id="owner", lease_token="token").register_artifact(
            run_id, context.org_id, "poster", path, attempt=1
        )
    row = other.execute(
        "select count(*) from analysis_artifacts where run_id = %s", (run_id,)
    ).fetchone()
    assert row == (0,)


@pytest.mark.parametrize("owner, token", [(None, None), ("owner", None), (None, "token")])
def test_unclaimed_worker_cannot_enter_write_guard(owner: str | None, token: str | None) -> None:
    connection = Mock()
    repo = RunRepository(connection, owner_id=owner, lease_token=token)
    with pytest.raises(StaleLeaseError):
        with repo.artifact_write("missing-run"):
            pytest.fail("Unclaimed worker entered storage write")
    connection.execute.assert_not_called()


@pytest.mark.parametrize("upload", UPLOADS, ids=["probe", "transcript", "scenes"])
def test_context_without_guard_fails_closed(tmp_path: Path, upload: Upload) -> None:
    context = upload_context((Mock(), Mock(), "video", "run"), tmp_path)
    context.artifact_write = None
    context.owner_id = None
    context.lease_token = None
    with pytest.raises(StaleLeaseError):
        upload(context, tmp_path / "absent", "runs/test/artifact")
    context.blob_service_client.get_container_client.assert_not_called()


def test_lease_is_checked_after_waiting_for_row_lock(
    run_db: tuple[Any, Any, str, str], tmp_path: Path
) -> None:
    worker, other, _, run_id = run_db
    context = upload_context(run_db, tmp_path)
    # Block the guard behind another transaction, then expire the lease. The
    # write must be rejected after the guard finally acquires its row lock.
    with ThreadPoolExecutor(max_workers=1) as pool:
        with other.transaction():
            other.execute("select id from analysis_runs where id = %s for update", (run_id,))
            future = pool.submit(probe._upload_blob, context, tmp_path / "absent", "artifact")
            # Observe an actual PostgreSQL lock wait, avoiding a scheduling sleep.
            for _ in range(200):
                row = other.execute(
                    "select wait_event_type from pg_stat_activity where pid = %s",
                    (worker.info.backend_pid,),
                ).fetchone()
                if row and row[0] == "Lock":
                    break
                other.execute("select pg_stat_clear_snapshot(), pg_sleep(0.01)")
            else:
                pytest.fail("Worker never waited for the run row lock")
            other.execute(
                "update analysis_runs set lease_expires_at = clock_timestamp() "
                "- interval '1 second' where id = %s",
                (run_id,),
            )
        with pytest.raises(StaleLeaseError):
            future.result(timeout=5)
    context.blob_service_client.get_container_client.assert_not_called()
