"""Postgres status-machine helpers for analysis runs."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Any

from psycopg import Connection
from psycopg.rows import dict_row

from jams_worker.errors import StaleLeaseError

TERMINAL_ERROR_CODES = frozenset({"too_long", "corrupt_file"})

RUN_SELECT = """
select
    ar.id::text,
    ar.org_id,
    ar.video_id::text,
    ar.status,
    ar.attempt,
    ar.config,
    ar.provider_versions,
    ar.provider_results,
    ar.owner_id,
    ar.lease_token,
    ar.lease_expires_at,
    (ar.lease_expires_at is not null and ar.lease_expires_at > now()) as is_lease_active,
    ar.error_code,
    v.blob_path,
    v.poster_blob_path,
    v.duration_ms,
    v.width,
    v.height,
    v.fps,
    v.has_audio
from analysis_runs ar
join videos v on v.id = ar.video_id and v.org_id = ar.org_id
where ar.id = %s
for update
"""


def classify_run(run: dict[str, Any], now_dt: datetime | None = None) -> str:
    """Classify run state into completed, partial, terminal, active, or retryable."""
    status = run.get("status")
    if status == "succeeded":
        return "completed"
    if status == "partial":
        return "partial"
    if status == "failed" and run.get("error_code") in TERMINAL_ERROR_CODES:
        return "terminal"
    if status == "running":
        if "is_lease_active" in run:
            if run["is_lease_active"]:
                return "active"
        else:
            lease_expires_at = run.get("lease_expires_at")
            now = now_dt or datetime.now(UTC)
            if lease_expires_at is not None:
                if hasattr(lease_expires_at, "tzinfo") and lease_expires_at.tzinfo is None:
                    lease_expires_at = lease_expires_at.replace(tzinfo=UTC)
                if lease_expires_at > now:
                    return "active"
    return "retryable"


class RunRepository:
    def __init__(
        self,
        conn: Connection[Any],
        owner_id: str | None = None,
        lease_token: str | None = None,
    ) -> None:
        self.conn = conn
        self.owner_id = owner_id
        self.lease_token = lease_token

    def claim(
        self,
        run_id: str,
        owner_id: str | None = None,
        lease_duration_seconds: int = 300,
    ) -> dict[str, Any] | None:
        owner = owner_id or self.owner_id or f"worker-{uuid.uuid4()}"
        lease_token = str(uuid.uuid4())

        with self.conn.transaction():
            with self.conn.cursor(row_factory=dict_row) as cur:
                cur.execute(RUN_SELECT, (run_id,))
                row = cur.fetchone()
                if row is None:
                    return None
                classification = classify_run(row)
                if classification in ("completed", "partial", "terminal"):
                    row["claim_status"] = classification
                    return row

                if classification == "active":
                    row["claim_status"] = "active"
                    return row

                is_takeover = row["status"] == "running"
                stage_detail = (
                    "Worker claimed run after lease expiration"
                    if is_takeover
                    else "Worker claimed run"
                )

                cur.execute(
                    """
                    update analysis_runs
                    set status = 'running',
                        stage = 'claim',
                        progress_pct = 1,
                        stage_detail = %s,
                        owner_id = %s,
                        lease_token = %s,
                        lease_expires_at = now() + (%s || ' seconds')::interval,
                        attempt = attempt + 1,
                        error_code = null,
                        started_at = coalesce(started_at, now()),
                        completed_at = null,
                        updated_at = now()
                    where id = %s
                    """,
                    (stage_detail, owner, lease_token, str(lease_duration_seconds), run_id),
                )
                cur.execute("delete from measures where run_id = %s", (run_id,))
                cur.execute("delete from segments where run_id = %s", (run_id,))
                cur.execute("delete from effort_scores where run_id = %s", (run_id,))

                self.owner_id = owner
                self.lease_token = lease_token
                row["status"] = "running"
                row["attempt"] = int(row["attempt"]) + 1
                row["owner_id"] = owner
                row["lease_token"] = lease_token
                row["claim_status"] = "claimed"
                return row

    def renew_lease(self, run_id: str, extension_seconds: int = 300) -> None:
        if self.owner_id is None or self.lease_token is None:
            return
        with self.conn.transaction():
            cur = self.conn.execute(
                """
                update analysis_runs
                set lease_expires_at = now() + (%s || ' seconds')::interval,
                    updated_at = now()
                where id = %s
                  and owner_id = %s
                  and lease_token = %s
                  and lease_expires_at > now()
                """,
                (str(extension_seconds), run_id, self.owner_id, self.lease_token),
            )
            rowcount = getattr(cur, "rowcount", None)
            if rowcount is not None and rowcount == 0:
                raise StaleLeaseError(
                    f"Write rejected: worker {self.owner_id} lost lease for run {run_id}"
                )

    def _check_fence(self, run_id: str) -> None:
        if self.owner_id is None or self.lease_token is None:
            return
        cur = self.conn.execute(
            """
            select 1 from analysis_runs
            where id = %s
              and owner_id = %s
              and lease_token = %s
              and lease_expires_at > now()
            for update
            """,
            (run_id, self.owner_id, self.lease_token),
        )
        if hasattr(cur, "fetchone"):
            row = cur.fetchone()
            if row is None:
                raise StaleLeaseError(
                    f"Write rejected: worker {self.owner_id} lost lease for run {run_id}"
                )

    def heartbeat(
        self,
        run_id: str,
        stage: str,
        progress_pct: int,
        detail: str | None,
        renew_lease_seconds: int | None = 300,
    ) -> None:
        if self.owner_id is not None and self.lease_token is not None:
            if renew_lease_seconds is not None:
                cur = self.conn.execute(
                    """
                    update analysis_runs
                    set status = 'running',
                        stage = %s,
                        progress_pct = %s,
                        stage_detail = %s,
                        lease_expires_at = now() + (%s || ' seconds')::interval,
                        updated_at = now()
                    where id = %s
                      and owner_id = %s
                      and lease_token = %s
                      and lease_expires_at > now()
                    """,
                    (
                        stage,
                        max(0, min(100, progress_pct)),
                        detail,
                        str(renew_lease_seconds),
                        run_id,
                        self.owner_id,
                        self.lease_token,
                    ),
                )
            else:
                cur = self.conn.execute(
                    """
                    update analysis_runs
                    set status = 'running',
                        stage = %s,
                        progress_pct = %s,
                        stage_detail = %s,
                        updated_at = now()
                    where id = %s
                      and owner_id = %s
                      and lease_token = %s
                      and lease_expires_at > now()
                    """,
                    (
                        stage,
                        max(0, min(100, progress_pct)),
                        detail,
                        run_id,
                        self.owner_id,
                        self.lease_token,
                    ),
                )
            rowcount = getattr(cur, "rowcount", None)
            if rowcount is not None and rowcount == 0:
                raise StaleLeaseError(
                    f"Write rejected: worker {self.owner_id} lost lease for run {run_id}"
                )
        else:
            self.conn.execute(
                """
                update analysis_runs
                set status = 'running',
                    stage = %s,
                    progress_pct = %s,
                    stage_detail = %s,
                    updated_at = now()
                where id = %s
                """,
                (stage, max(0, min(100, progress_pct)), detail, run_id),
            )
        self.conn.commit()

    def register_artifact(
        self,
        run_id: str,
        org_id: str,
        kind: str,
        blob_path: str,
        attempt: int | None = None,
    ) -> str:
        with self.conn.transaction():
            self._check_fence(run_id)
            if kind == "thumbnail":
                self.conn.execute(
                    "delete from analysis_artifacts where run_id = %s and blob_path = %s",
                    (run_id, blob_path),
                )
            else:
                self.conn.execute(
                    "delete from analysis_artifacts "
                    "where run_id = %s and kind = %s and (attempt = %s or attempt is null)",
                    (run_id, kind, attempt),
                )
            row = self.conn.execute(
                """
                insert into analysis_artifacts (run_id, org_id, kind, blob_path, attempt)
                values (%s, %s, %s, %s, %s)
                returning id::text
                """,
                (run_id, org_id, kind, blob_path, attempt),
            ).fetchone()
            if row is None:  # pragma: no cover - defensive DB invariant
                raise RuntimeError("artifact insert returned no id")
            return str(row[0])

    def set_provider_versions(self, run_id: str, provider_versions: dict[str, str]) -> None:
        if self.owner_id is not None and self.lease_token is not None:
            cur = self.conn.execute(
                """
                update analysis_runs
                set provider_versions = %s::jsonb,
                    updated_at = now()
                where id = %s
                  and owner_id = %s
                  and lease_token = %s
                  and lease_expires_at > now()
                """,
                (json.dumps(provider_versions), run_id, self.owner_id, self.lease_token),
            )
            rowcount = getattr(cur, "rowcount", None)
            if rowcount is not None and rowcount == 0:
                raise StaleLeaseError(
                    f"Write rejected: worker {self.owner_id} lost lease for run {run_id}"
                )
        else:
            self.conn.execute(
                """
                update analysis_runs
                set provider_versions = %s::jsonb,
                    updated_at = now()
                where id = %s
                """,
                (json.dumps(provider_versions), run_id),
            )
        self.conn.commit()

    def set_provider_results(self, run_id: str, provider_results: dict[str, Any]) -> None:
        if self.owner_id is not None and self.lease_token is not None:
            cur = self.conn.execute(
                """
                update analysis_runs
                set provider_results = %s::jsonb,
                    updated_at = now()
                where id = %s
                  and owner_id = %s
                  and lease_token = %s
                  and lease_expires_at > now()
                """,
                (json.dumps(provider_results), run_id, self.owner_id, self.lease_token),
            )
            rowcount = getattr(cur, "rowcount", None)
            if rowcount is not None and rowcount == 0:
                raise StaleLeaseError(
                    f"Write rejected: worker {self.owner_id} lost lease for run {run_id}"
                )
        else:
            self.conn.execute(
                """
                update analysis_runs
                set provider_results = %s::jsonb,
                    updated_at = now()
                where id = %s
                """,
                (json.dumps(provider_results), run_id),
            )
        self.conn.commit()

    def finalize(
        self, run_id: str, status: str, detail: str, error_code: str | None = None
    ) -> None:
        if self.owner_id is not None and self.lease_token is not None:
            cur = self.conn.execute(
                """
                update analysis_runs
                set status = %s,
                    stage = 'finalize',
                    progress_pct = 100,
                    stage_detail = %s,
                    error_code = %s,
                    owner_id = null,
                    lease_token = null,
                    lease_expires_at = null,
                    completed_at = now(),
                    updated_at = now()
                where id = %s
                  and owner_id = %s
                  and lease_token = %s
                  and lease_expires_at > now()
                """,
                (status, detail, error_code, run_id, self.owner_id, self.lease_token),
            )
            rowcount = getattr(cur, "rowcount", None)
            if rowcount is not None and rowcount == 0:
                raise StaleLeaseError(
                    f"Write rejected: worker {self.owner_id} lost lease for run {run_id}"
                )
        else:
            self.conn.execute(
                """
                update analysis_runs
                set status = %s,
                    stage = 'finalize',
                    progress_pct = 100,
                    stage_detail = %s,
                    error_code = %s,
                    completed_at = now(),
                    updated_at = now()
                where id = %s
                """,
                (status, detail, error_code, run_id),
            )
        self.conn.commit()

    def fail(self, run_id: str, error_code: str, detail: str) -> None:
        if self.owner_id is not None and self.lease_token is not None:
            cur = self.conn.execute(
                """
                update analysis_runs
                set status = 'failed',
                    progress_pct = 100,
                    stage_detail = %s,
                    error_code = %s,
                    owner_id = null,
                    lease_token = null,
                    lease_expires_at = null,
                    completed_at = now(),
                    updated_at = now()
                where id = %s
                  and owner_id = %s
                  and lease_token = %s
                """,
                (detail, error_code, run_id, self.owner_id, self.lease_token),
            )
            rowcount = getattr(cur, "rowcount", None)
            if rowcount is not None and rowcount == 0:
                return
        else:
            self.conn.execute(
                """
                update analysis_runs
                set status = 'failed',
                    progress_pct = 100,
                    stage_detail = %s,
                    error_code = %s,
                    completed_at = now(),
                    updated_at = now()
                where id = %s
                """,
                (detail, error_code, run_id),
            )
        self.conn.commit()

