"""Queue status-machine behavior with mocked queue/db collaborators."""

from __future__ import annotations

import json
from unittest.mock import create_autospec

import pytest

from jams_worker.db import RunRepository
from jams_worker.errors import PipelineError
from jams_worker.main import handle_message, run_loop


class _Message:
    def __init__(self, content: str, dequeue_count: int = 1) -> None:
        self.content = content
        self.dequeue_count = dequeue_count
        self.id = "msg"
        self.pop_receipt = "receipt"


class _Queue:
    def __init__(self) -> None:
        self.deleted: list[tuple[str, str]] = []
        self.sent: list[str] = []
        self.updated: list[tuple[str, str, int]] = []
        self.created = False

    def delete_message(self, message_id: str, pop_receipt: str) -> None:
        self.deleted.append((message_id, pop_receipt))

    def update_message(
        self, message_id: str, pop_receipt: str, visibility_timeout: int = 0
    ) -> None:
        self.updated.append((message_id, pop_receipt, visibility_timeout))

    def create_queue(self) -> None:
        self.created = True

    def send_message(self, content: str) -> None:
        self.sent.append(content)


class _Conn:
    def __init__(self) -> None:
        self.executed: list[tuple[str, object]] = []
        self.commits = 0
        self.rollbacks = 0

    def execute(self, sql: str, params: object = None) -> None:
        self.executed.append((" ".join(sql.split()), params))

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1

    def __enter__(self) -> "_Conn":
        return self

    def __exit__(self, *_args: object) -> None:
        return None


def test_handle_message_deletes_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    queue = _Queue()
    poison = _Queue()
    conn = _Conn()

    monkeypatch.setattr("jams_worker.main.process_run", lambda **_kwargs: "succeeded")

    handle_message(
        message=_Message(json.dumps({"run_id": "run_1"})),
        queue=queue,  # type: ignore[arg-type]
        poison_queue=poison,  # type: ignore[arg-type]
        conn=conn,  # type: ignore[arg-type]
        blob_service_client=object(),  # type: ignore[arg-type]
        providers=[],
    )

    assert queue.deleted == [("msg", "receipt")]
    assert poison.sent == []


def test_handle_message_leaves_transient_failure_for_redelivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queue = _Queue()
    poison = _Queue()
    conn = _Conn()

    def fail(**_kwargs: object) -> str:
        raise PipelineError("transient", "temporary")

    monkeypatch.setattr("jams_worker.main.process_run", fail)

    handle_message(
        message=_Message(json.dumps({"run_id": "run_1"}), dequeue_count=2),
        queue=queue,  # type: ignore[arg-type]
        poison_queue=poison,  # type: ignore[arg-type]
        conn=conn,  # type: ignore[arg-type]
        blob_service_client=object(),  # type: ignore[arg-type]
        providers=[],
    )

    assert queue.deleted == []
    assert poison.sent == []
    assert conn.rollbacks == 1


def test_handle_message_poisons_third_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    queue = _Queue()
    poison = _Queue()
    conn = _Conn()

    def fail(**_kwargs: object) -> str:
        raise PipelineError("corrupt_file", "bad media")

    monkeypatch.setattr("jams_worker.main.process_run", fail)

    handle_message(
        message=_Message(json.dumps({"run_id": "run_1"}), dequeue_count=3),
        queue=queue,  # type: ignore[arg-type]
        poison_queue=poison,  # type: ignore[arg-type]
        conn=conn,  # type: ignore[arg-type]
        blob_service_client=object(),  # type: ignore[arg-type]
        providers=[],
    )

    assert poison.created is True
    assert poison.sent == [json.dumps({"run_id": "run_1"})]
    assert queue.deleted == [("msg", "receipt")]
    assert conn.executed[0][0].startswith("update analysis_runs set status = 'failed'")


def test_receipt_before_commit_is_not_destructive_and_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queue = _Queue()
    poison = _Queue()
    conn = _Conn()

    # Simulate run not yet visible in DB because web transaction has not committed
    claim = create_autospec(RunRepository.claim, return_value=None)
    monkeypatch.setattr("jams_worker.main.RunRepository.claim", claim)

    result = handle_message(
        message=_Message(json.dumps({"run_id": "run_not_yet_committed"}), dequeue_count=1),
        queue=queue,  # type: ignore[arg-type]
        poison_queue=poison,  # type: ignore[arg-type]
        conn=conn,  # type: ignore[arg-type]
        blob_service_client=object(),  # type: ignore[arg-type]
        providers=[],
    )

    # Message must NOT be deleted (destructive ack avoided)
    assert queue.deleted == []
    assert poison.sent == []
    assert conn.rollbacks == 1
    assert result.status == "redelivery"
    assert result.poisoned is False
    claim.assert_called_once()
    assert queue.updated == [("msg", "receipt", 2)]


def test_missing_run_poisons_after_max_dequeue_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queue = _Queue()
    poison = _Queue()
    conn = _Conn()

    # Run remains missing after 3 attempts
    claim = create_autospec(RunRepository.claim, return_value=None)
    monkeypatch.setattr("jams_worker.main.RunRepository.claim", claim)

    result = handle_message(
        message=_Message(json.dumps({"run_id": "run_never_exists"}), dequeue_count=3),
        queue=queue,  # type: ignore[arg-type]
        poison_queue=poison,  # type: ignore[arg-type]
        conn=conn,  # type: ignore[arg-type]
        blob_service_client=object(),  # type: ignore[arg-type]
        providers=[],
    )

    assert poison.created is True
    assert poison.sent == [json.dumps({"run_id": "run_never_exists"})]
    assert queue.deleted == [("msg", "receipt")]
    assert result.status == "poisoned"
    assert result.poisoned is True
    claim.assert_called_once()


@pytest.mark.parametrize(
    ("status", "claim_status", "expected_status"),
    [("succeeded", "completed", "skipped"), ("partial", "partial", "skipped"),
     ("failed", "terminal", "terminal")],
)
def test_duplicate_send_for_completed_run_skipped_and_deleted(
    monkeypatch: pytest.MonkeyPatch, status: str, claim_status: str, expected_status: str
) -> None:
    queue = _Queue()
    poison = _Queue()
    conn = _Conn()

    pipeline_invoked = False

    def fake_run_pipeline(*_args: object, **_kwargs: object) -> object:
        nonlocal pipeline_invoked
        pipeline_invoked = True
        return object()

    claim = create_autospec(
        RunRepository.claim,
        return_value={
            "id": "run_done", "status": status, "org_id": "org_1", "claim_status": claim_status,
        },
    )
    monkeypatch.setattr("jams_worker.main.RunRepository.claim", claim)
    monkeypatch.setattr("jams_worker.main.run_pipeline", fake_run_pipeline)

    result = handle_message(
        message=_Message(json.dumps({"run_id": "run_done"}), dequeue_count=1),
        queue=queue,  # type: ignore[arg-type]
        poison_queue=poison,  # type: ignore[arg-type]
        conn=conn,  # type: ignore[arg-type]
        blob_service_client=object(),  # type: ignore[arg-type]
        providers=[],
    )

    assert pipeline_invoked is False
    assert queue.deleted == [("msg", "receipt")]
    assert poison.sent == []
    assert result.status == expected_status
    claim.assert_called_once()


def test_update_message_failure_is_logged_and_message_left_for_redelivery(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    queue = _Queue()
    poison = _Queue()
    conn = _Conn()

    def failing_update(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("network failure during visibility update")

    queue.update_message = failing_update  # type: ignore[method-assign]
    claim = create_autospec(RunRepository.claim, return_value=None)
    monkeypatch.setattr("jams_worker.main.RunRepository.claim", claim)

    result = handle_message(
        message=_Message(json.dumps({"run_id": "run_visibility_fail"}), dequeue_count=1),
        queue=queue,  # type: ignore[arg-type]
        poison_queue=poison,  # type: ignore[arg-type]
        conn=conn,  # type: ignore[arg-type]
        blob_service_client=object(),  # type: ignore[arg-type]
        providers=[],
    )

    assert queue.deleted == []
    assert poison.sent == []
    assert result.status == "redelivery"

    logs = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    failure_logs = [log for log in logs if log.get("event") == "update_message_failed"]
    assert len(failure_logs) == 1
    assert "network failure" in failure_logs[0]["error"]
    assert failure_logs[0]["run_id"] == "run_visibility_fail"
    claim.assert_called_once()


def test_run_loop_drain_exits_when_queue_empty(monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    queue = _Queue()
    poison = _Queue()

    def receive_messages(**_kwargs: object) -> list[object]:
        return []

    queue.receive_messages = receive_messages  # type: ignore[method-assign]

    class _Settings:
        database_url = "postgresql://example"
        azure_storage_connection_string = "UseDevelopmentStorage=true"
        jobs_queue_name = "analysis-jobs"
        poison_queue_name = "analysis-jobs-poison"

    queues = [queue, poison]

    monkeypatch.setattr(
        "jams_worker.main.QueueClient.from_connection_string",
        lambda *_args: queues.pop(0),
    )
    monkeypatch.setattr(
        "jams_worker.main.BlobServiceClient.from_connection_string",
        lambda *_args: object(),
    )
    monkeypatch.setattr("jams_worker.main.psycopg.connect", lambda *_args: _Conn())

    run_loop(settings=_Settings(), drain=True)  # type: ignore[arg-type]

    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events[-1]["event"] == "drain_complete"
