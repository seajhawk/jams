"""Queue status-machine behavior with mocked queue/db collaborators."""

from __future__ import annotations

import json

import pytest

from jams_worker.errors import PipelineError
from jams_worker.main import handle_message


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
        self.created = False

    def delete_message(self, message_id: str, pop_receipt: str) -> None:
        self.deleted.append((message_id, pop_receipt))

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
