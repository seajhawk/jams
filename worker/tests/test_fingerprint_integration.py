"""set_fingerprint against real Postgres (lease fencing included).

Set JAMS_TEST_DATABASE_URL to an isolated, migrated test database.
"""

from __future__ import annotations

import os
import uuid

import psycopg
import pytest

from jams_worker.db import RunRepository
from jams_worker.errors import StaleLeaseError


@pytest.fixture
def run_row():
    url = os.environ.get("JAMS_TEST_DATABASE_URL")
    if not url:
        pytest.skip("JAMS_TEST_DATABASE_URL must point to an isolated migrated database")
    video_id, run_id = str(uuid.uuid4()), str(uuid.uuid4())
    org_id = f"org_fp_{video_id}"
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute(
            """insert into videos (id, org_id, title, blob_path, uploaded_by)
               values (%s, %s, 'fingerprint test', 'test/original.mp4', 'test')""",
            (video_id, org_id),
        )
        conn.execute(
            """insert into analysis_runs
               (id, video_id, org_id, pipeline_version, status, owner_id, lease_token,
                lease_expires_at)
               values (%s, %s, %s, 'test', 'running', 'owner', 'token',
                       clock_timestamp() + interval '5 minutes')""",
            (run_id, video_id, org_id),
        )
        try:
            yield url, run_id
        finally:
            conn.execute("delete from videos where id = %s", (video_id,))


def _stored(url: str, run_id: str):
    with psycopg.connect(url) as conn:
        return conn.execute(
            "select fingerprint, fingerprint_hash from analysis_runs where id = %s", (run_id,)
        ).fetchone()


def test_lease_holder_writes_fingerprint(run_row) -> None:
    url, run_id = run_row
    with psycopg.connect(url) as conn:
        RunRepository(conn, "owner", "token").set_fingerprint(run_id, {"a": 1}, "abc123abc123")
    assert _stored(url, run_id) == ({"a": 1}, "abc123abc123")


def test_stale_lease_cannot_write_fingerprint(run_row) -> None:
    url, run_id = run_row
    with psycopg.connect(url) as conn:
        with pytest.raises(StaleLeaseError):
            RunRepository(conn, "owner", "other-token").set_fingerprint(run_id, {"a": 1}, "x")
    assert _stored(url, run_id) == (None, None)


def test_unfenced_repository_writes_fingerprint(run_row) -> None:
    url, run_id = run_row
    with psycopg.connect(url) as conn:
        RunRepository(conn).set_fingerprint(run_id, {"b": 2}, "def456def456")
    assert _stored(url, run_id) == ({"b": 2}, "def456def456")
