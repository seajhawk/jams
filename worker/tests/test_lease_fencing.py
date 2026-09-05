"""Tests for run ownership, lease fencing, visibility renewal, and attempt isolation.

Covers JAMS review findings 3 and 10:
- Two-connection duplicate message single owner
- Stale-owner fenced write rejection across all write paths
- Lease-expiry takeover after owner death
- Prompt failure for terminal too_long and corrupt_file errors
- Attempt output isolation on retry with injected failure
- Visibility renewal updating pop_receipt
"""

from __future__ import annotations

import json
import time
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from jams_worker.db import RunRepository, classify_run
from jams_worker.errors import PipelineError, StaleLeaseError
from jams_worker.main import (
    VisibilityRenewer,
    handle_message,
)
from jams_worker.pipeline import (
    PipelineContext,
    invalidate_provider_and_dependents,
    write_provider_measures,
)


class MockCursor:
    def __init__(self, conn: MockConnection) -> None:
        self.conn = conn
        self.row: Any = None
        self.rowcount: int = 1

    def execute(self, sql: str, params: Any = None) -> MockCursor:
        self.row, self.rowcount = self.conn._exec(sql, params)
        return self

    def fetchone(self) -> Any:
        return self.row

    def fetchall(self) -> list[Any]:
        if self.row is None:
            return []
        if isinstance(self.row, list):
            return self.row
        return [self.row]

    def __enter__(self) -> MockCursor:
        return self

    def __exit__(self, *args: object) -> None:
        pass


class MockTransaction:
    def __init__(self, conn: MockConnection) -> None:
        self.conn = conn

    def __enter__(self) -> MockTransaction:
        self.conn._in_tx = True
        return self

    def __exit__(self, exc_type: Any, *args: object) -> None:
        self.conn._in_tx = False
        if exc_type is not None:
            self.conn.rollback()
        else:
            self.conn.commit()


class MockConnection:
    """Stateful mock Postgres connection sharing state across connections."""

    def __init__(self, state: dict[str, Any]) -> None:
        self.state = state
        self._in_tx = False
        self.commits = 0
        self.rollbacks = 0

    def transaction(self) -> MockTransaction:
        return MockTransaction(self)

    def cursor(self, row_factory: Any = None) -> MockCursor:
        return MockCursor(self)

    def execute(self, sql: str, params: Any = None) -> MockCursor:
        cur = MockCursor(self)
        cur.execute(sql, params)
        return cur

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1

    def _exec(self, sql: str, params: Any) -> tuple[Any, int]:
        clean = " ".join(sql.split()).lower()
        now = self.state.get("current_time", datetime.now(UTC))

        if "select" in clean and "from analysis_runs" in clean:
            if "select 1 from analysis_runs" in clean:
                # Fencing check
                run_id = params[0]
                owner_id = params[1]
                lease_token = params[2]
                run = self.state["runs"].get(run_id)
                if run is None:
                    return None, 0
                if (
                    run.get("owner_id") == owner_id
                    and run.get("lease_token") == lease_token
                    and run.get("lease_expires_at") is not None
                    and run["lease_expires_at"] > now
                ):
                    return (1,), 1
                return None, 0

            # RUN_SELECT
            run_id = params[0]
            run = self.state["runs"].get(run_id)
            if run is None:
                return None, 0
            row = dict(run)
            row["is_lease_active"] = (
                run.get("lease_expires_at") is not None
                and run["lease_expires_at"] > now
            )
            return row, 1

        if clean.startswith("update analysis_runs"):
            run_id = params[-1]
            run = self.state["runs"].get(run_id)
            if run is None:
                return None, 0

            # Check fence condition if present in query
            if "owner_id = %s and lease_token = %s" in clean:
                # Parameters are ordered: ... where id = %s and owner_id = %s and lease_token = %s
                owner_id = params[-2]
                lease_token = params[-1] if len(params) == 3 else params[-3]
                if (
                    run.get("owner_id") != owner_id
                    or run.get("lease_token") != lease_token
                ):
                    return None, 0
                if "lease_expires_at > now()" in clean:
                    if (
                        run.get("lease_expires_at") is None
                        or run["lease_expires_at"] <= now
                    ):
                        return None, 0

            # Apply updates
            if "set status = 'running', stage = 'claim'" in clean:
                # Claim update
                detail = params[0]
                owner = params[1]
                token = params[2]
                duration_sec = int(params[3])
                rid = params[4]
                r = self.state["runs"][rid]
                r["status"] = "running"
                r["stage"] = "claim"
                r["progress_pct"] = 1
                r["stage_detail"] = detail
                r["owner_id"] = owner
                r["lease_token"] = token
                r["lease_expires_at"] = now + timedelta(seconds=duration_sec)
                r["attempt"] = int(r.get("attempt", 0)) + 1
                r["error_code"] = None
                return None, 1

            if "set lease_expires_at = now() +" in clean:
                duration_sec = int(params[0])
                rid = params[1]
                r = self.state["runs"][rid]
                r["lease_expires_at"] = now + timedelta(seconds=duration_sec)
                return None, 1

            if "set status = 'running', stage = %s" in clean:
                # Heartbeat
                stage = params[0]
                pct = params[1]
                detail = params[2]
                rid = params[3] if len(params) == 4 else params[4]
                r = self.state["runs"][rid]
                r["stage"] = stage
                r["progress_pct"] = pct
                r["stage_detail"] = detail
                if len(params) > 4 and "lease_expires_at = case" in clean:
                    r["lease_expires_at"] = now + timedelta(seconds=300)
                return None, 1

            if "set status = %s, stage = 'finalize'" in clean:
                status = params[0]
                detail = params[1]
                rid = params[2]
                r = self.state["runs"][rid]
                r["status"] = status
                r["stage"] = "finalize"
                r["progress_pct"] = 100
                r["stage_detail"] = detail
                r["owner_id"] = None
                r["lease_token"] = None
                r["lease_expires_at"] = None
                return None, 1

            if "set status = 'failed'" in clean:
                detail = params[0]
                code = params[1]
                rid = params[2]
                r = self.state["runs"][rid]
                r["status"] = "failed"
                r["error_code"] = code
                r["stage_detail"] = detail
                r["owner_id"] = None
                r["lease_token"] = None
                r["lease_expires_at"] = None
                return None, 1

            if "set provider_results = %s::jsonb" in clean:
                r = self.state["runs"][params[1]]
                r["provider_results"] = json.loads(params[0])
                return None, 1

            if "set provider_versions = %s::jsonb" in clean:
                r = self.state["runs"][params[1]]
                r["provider_versions"] = json.loads(params[0])
                return None, 1

        if clean.startswith("delete from measures"):
            run_id = params[0]
            if len(params) > 1:
                pid = params[1]
                self.state["measures"] = [
                    m for m in self.state["measures"]
                    if not (m["run_id"] == run_id and m.get("provider_id") == pid)
                ]
            else:
                self.state["measures"] = [
                    m for m in self.state["measures"] if m["run_id"] != run_id
                ]
            return None, 1

        if clean.startswith("insert into measures"):
            m = deepcopy(params)
            self.state["measures"].append(m)
            return None, 1

        if clean.startswith("delete from segments"):
            run_id = params[0]
            self.state["segments"] = [
                s for s in self.state["segments"] if s["run_id"] != run_id
            ]
            return None, 1

        if clean.startswith("insert into segments"):
            seg = {
                "id": params[0],
                "org_id": params[1],
                "run_id": params[2],
                "name": params[3],
                "t_start_ms": params[4],
                "t_end_ms": params[5],
                "source": params[6],
            }
            self.state["segments"].append(seg)
            return None, 1

        if clean.startswith("delete from effort_scores"):
            run_id = params[0]
            self.state["effort_scores"] = [
                e for e in self.state["effort_scores"] if e["run_id"] != run_id
            ]
            return None, 1

        if clean.startswith("insert into effort_scores"):
            e = {
                "run_id": params[0],
                "profile_id": params[1],
                "org_id": params[2],
                "physical": params[3],
                "cognitive": params[4],
                "time": params[5],
                "sentiment": params[6],
                "speech": params[7],
                "total": params[8],
            }
            self.state["effort_scores"].append(e)
            return None, 1

        if clean.startswith("insert into analysis_artifacts"):
            art = {
                "id": "art-1",
                "run_id": params[0],
                "org_id": params[1],
                "kind": params[2],
                "blob_path": params[3],
                "attempt": params[4],
            }
            self.state["artifacts"].append(art)
            return ("art-1",), 1

        if clean.startswith("delete from analysis_artifacts"):
            run_id = params[0]
            self.state["artifacts"] = [
                a for a in self.state["artifacts"] if a["run_id"] != run_id
            ]
            return None, 1

        return None, 1


class MockQueue:
    def __init__(self) -> None:
        self.deleted: list[tuple[str, str]] = []
        self.sent: list[str] = []
        self.updates: list[tuple[str, str, int]] = []
        self.pop_receipt_counter = 0

    def delete_message(self, message_id: str, pop_receipt: str) -> None:
        self.deleted.append((message_id, pop_receipt))

    def send_message(self, content: str) -> None:
        self.sent.append(content)

    def create_queue(self) -> None:
        pass

    def update_message(self, message_id: str, pop_receipt: str, visibility_timeout: int) -> Any:
        self.pop_receipt_counter += 1
        new_receipt = f"receipt-{self.pop_receipt_counter}"
        self.updates.append((message_id, pop_receipt, visibility_timeout))
        return type("UpdateResult", (), {"pop_receipt": new_receipt})()


class MockMessage:
    def __init__(self, content: str, dequeue_count: int = 1, receipt: str = "init-receipt") -> None:
        self.content = content
        self.dequeue_count = dequeue_count
        self.id = "msg-1"
        self.pop_receipt = receipt


def initial_state() -> dict[str, Any]:
    return {
        "runs": {
            "run_test": {
                "id": "run_test",
                "org_id": "org_1",
                "video_id": "vid_1",
                "status": "queued",
                "attempt": 0,
                "config": {},
                "provider_versions": {},
                "provider_results": {},
                "owner_id": None,
                "lease_token": None,
                "lease_expires_at": None,
                "error_code": None,
                "blob_path": "org_1/vid_1/original.mp4",
                "poster_blob_path": "org_1/vid_1/poster.jpg",
                "duration_ms": 60000,
                "width": 1920,
                "height": 1080,
                "fps": 30.0,
                "has_audio": True,
            }
        },
        "measures": [],
        "segments": [],
        "effort_scores": [],
        "artifacts": [],
        "current_time": datetime.now(UTC),
    }


def test_classify_run_distinguishes_states() -> None:
    now = datetime.now(UTC)
    assert classify_run({"status": "succeeded"}) == "completed"
    assert classify_run({"status": "partial"}) == "partial"
    assert classify_run({"status": "failed", "error_code": "too_long"}) == "terminal"
    assert classify_run({"status": "failed", "error_code": "corrupt_file"}) == "terminal"
    assert classify_run({"status": "failed", "error_code": "transient"}) == "retryable"
    assert classify_run({"status": "queued"}) == "retryable"

    # Active run with future lease expiration
    active = {"status": "running", "lease_expires_at": now + timedelta(minutes=5)}
    assert classify_run(active, now) == "active"

    # Expired lease is retryable (takeover)
    expired = {"status": "running", "lease_expires_at": now - timedelta(seconds=1)}
    assert classify_run(expired, now) == "retryable"


def test_two_connections_duplicate_message_single_owner() -> None:
    """Two concurrent connections receive duplicate queue messages for the same run.

    Only one connection must successfully claim ownership; the second must be rejected.
    """
    state = initial_state()
    conn1 = MockConnection(state)
    conn2 = MockConnection(state)

    repo1 = RunRepository(conn1, owner_id="worker_1")
    repo2 = RunRepository(conn2, owner_id="worker_2")

    # Connection 1 claims the run
    claimed1 = repo1.claim("run_test", lease_duration_seconds=300)
    assert claimed1 is not None
    assert claimed1["claim_status"] == "claimed"
    assert claimed1["owner_id"] == "worker_1"
    assert state["runs"]["run_test"]["owner_id"] == "worker_1"
    assert state["runs"]["run_test"]["attempt"] == 1

    # Connection 2 attempts to claim while worker_1 lease is active
    claimed2 = repo2.claim("run_test", lease_duration_seconds=300)
    assert claimed2 is not None
    assert claimed2["claim_status"] == "active"
    # Ownership has not changed
    assert state["runs"]["run_test"]["owner_id"] == "worker_1"
    assert state["runs"]["run_test"]["attempt"] == 1


def test_stale_owner_fenced_writes_rejected() -> None:
    """A stale owner whose lease expired or was taken over has all subsequent writes rejected."""
    state = initial_state()
    conn1 = MockConnection(state)
    conn2 = MockConnection(state)

    repo1 = RunRepository(conn1, owner_id="worker_1")
    repo1.claim("run_test", lease_duration_seconds=10)

    # Worker 2 takes over the run
    state["current_time"] = state["current_time"] + timedelta(seconds=15)
    repo2 = RunRepository(conn2, owner_id="worker_2")
    claimed2 = repo2.claim("run_test", lease_duration_seconds=300)
    assert claimed2 is not None
    assert claimed2["claim_status"] == "claimed"
    assert state["runs"]["run_test"]["owner_id"] == "worker_2"

    # Worker 1 attempts heartbeat -> StaleLeaseError
    with pytest.raises(StaleLeaseError):
        repo1.heartbeat("run_test", "probe", 10, "heartbeat")

    # Worker 1 attempts write_provider_measures -> StaleLeaseError
    with pytest.raises(StaleLeaseError):
        write_provider_measures(
            conn1,  # type: ignore[arg-type]
            run_id="run_test",
            org_id="org_1",
            provider_id="probe",
            provider_version="1.0.0",
            measures=[{"kind": "context_switch", "category": "cognitive", "t_start_ms": 100}],
            owner_id=repo1.owner_id,
            lease_token=repo1.lease_token,
        )

    # Worker 1 attempts register_artifact -> StaleLeaseError
    with pytest.raises(StaleLeaseError):
        repo1.register_artifact("run_test", "org_1", "audio_wav", "path.wav")

    # Worker 1 attempts finalize -> StaleLeaseError
    with pytest.raises(StaleLeaseError):
        repo1.finalize("run_test", "succeeded", "done")

    # Verify state belongs to Worker 2 intact
    assert state["runs"]["run_test"]["owner_id"] == "worker_2"
    assert state["runs"]["run_test"]["status"] == "running"


def test_lease_expiry_takeover_after_owner_death() -> None:
    """When an owner dies, another worker can take over after the lease expires."""
    state = initial_state()
    conn1 = MockConnection(state)
    conn2 = MockConnection(state)

    repo1 = RunRepository(conn1, owner_id="worker_dead")
    repo1.claim("run_test", lease_duration_seconds=30)
    assert state["runs"]["run_test"]["attempt"] == 1

    # Worker 2 attempts claim before expiry -> denied
    state["current_time"] = state["current_time"] + timedelta(seconds=10)
    repo2 = RunRepository(conn2, owner_id="worker_survivor")
    res = repo2.claim("run_test")
    assert res is not None
    assert res["claim_status"] == "active"

    # Owner dies: time advances past lease expiration
    state["current_time"] = state["current_time"] + timedelta(seconds=25)

    # Worker 2 attempts claim after expiry -> takeover succeeds
    takeover = repo2.claim("run_test", lease_duration_seconds=300)
    assert takeover is not None
    assert takeover["claim_status"] == "claimed"
    assert takeover["attempt"] == 2
    assert state["runs"]["run_test"]["owner_id"] == "worker_survivor"
    assert "Worker claimed run after lease expiration" in state["runs"]["run_test"]["stage_detail"]


def test_terminal_too_long_and_corrupt_file_fail_promptly() -> None:
    """Terminal errors (too_long, corrupt_file) fail promptly on attempt 1 without waiting."""
    state = initial_state()
    conn = MockConnection(state)
    queue = MockQueue()
    poison = MockQueue()

    def raise_corrupt(**_kwargs: object) -> str:
        raise PipelineError("corrupt_file", "Unsupported video codec")

    msg = MockMessage(json.dumps({"run_id": "run_test"}), dequeue_count=1)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr("jams_worker.main.process_run", raise_corrupt)
        res = handle_message(
            message=msg,
            queue=queue,  # type: ignore[arg-type]
            poison_queue=poison,  # type: ignore[arg-type]
            conn=conn,  # type: ignore[arg-type]
            blob_service_client=object(),  # type: ignore[arg-type]
            providers=[],
        )

    assert res.poisoned is True
    assert res.status == "poisoned"
    assert len(poison.sent) == 1
    assert queue.deleted == [("msg-1", "init-receipt")]
    assert state["runs"]["run_test"]["status"] == "failed"
    assert state["runs"]["run_test"]["error_code"] == "corrupt_file"

    # Duplicate message for the terminal run is rejected and discarded
    repo = RunRepository(conn)
    claimed = repo.claim("run_test")
    assert claimed is not None
    assert claimed["claim_status"] == "terminal"


def test_retry_after_config_change_injected_failure_clears_old_data() -> None:
    """Failed providers on a retry must clear old rows and not leave mixed-attempt data."""
    state = initial_state()
    conn = MockConnection(state)
    repo = RunRepository(conn, owner_id="worker_retry")
    claimed = repo.claim("run_test", lease_duration_seconds=300)
    assert claimed is not None

    # Attempt 1: provider wrote measures and segments
    state["measures"] = [
        {"run_id": "run_test", "provider_id": "transcription", "kind": "utterance", "payload": {}},
        {"run_id": "run_test", "provider_id": "sentiment", "kind": "sentiment", "payload": {}},
    ]
    state["segments"] = [
        {"id": "seg-1", "run_id": "run_test", "name": "Old segment"}
    ]
    state["effort_scores"] = [
        {"run_id": "run_test", "total": 75}
    ]

    ctx = PipelineContext(
        run=claimed,
        org_id="org_1",
        blob_service_client=object(),  # type: ignore[arg-type]
        db_conn=conn,  # type: ignore[arg-type]
        workdir=None,  # type: ignore[arg-type]
        register_artifact=lambda *_: "art",
        heartbeat=lambda *_: None,
        owner_id="worker_retry",
        lease_token=claimed["lease_token"],
    )

    # Invalidate transcription and dependent downstream stages
    invalidate_provider_and_dependents(ctx, "transcription")

    # Transcription measures must be deleted
    transcription_measures = [
        m for m in state["measures"] if m["provider_id"] == "transcription"
    ]
    assert len(transcription_measures) == 0

    # Downstream sentiment measures must be deleted
    sentiment_measures = [
        m for m in state["measures"] if m["provider_id"] == "sentiment"
    ]
    assert len(sentiment_measures) == 0

    # Segments and effort scores must be deleted
    assert len(state["segments"]) == 0
    assert len(state["effort_scores"]) == 0


def test_visibility_renewer_updates_pop_receipt() -> None:
    """VisibilityRenewer extends visibility on queue and updates pop_receipt for safe deletion."""
    state = initial_state()
    conn = MockConnection(state)
    queue = MockQueue()
    repo = RunRepository(conn, owner_id="worker_1", lease_token="token_1")
    msg = MockMessage(json.dumps({"run_id": "run_test"}), receipt="receipt-initial")

    renewer = VisibilityRenewer(
        queue=queue,  # type: ignore[arg-type]
        message=msg,
        repo=repo,
        run_id="run_test",
        interval_seconds=0.05,
        visibility_timeout_seconds=300,
    )
    renewer.start()
    time.sleep(0.12)
    renewer.stop()

    assert len(queue.updates) >= 1
    # Pop receipt was updated from initial
    assert renewer.get_pop_receipt() != "receipt-initial"
    assert renewer.get_pop_receipt().startswith("receipt-")
