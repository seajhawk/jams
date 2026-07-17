"""Postgres status-machine helpers for analysis runs."""

from __future__ import annotations

import json
from typing import Any

from psycopg import Connection
from psycopg.rows import dict_row

RUN_SELECT = """
select
    ar.id::text,
    ar.org_id,
    ar.video_id::text,
    ar.status,
    ar.attempt,
    ar.config,
    ar.provider_versions,
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


class RunRepository:
    def __init__(self, conn: Connection[Any]) -> None:
        self.conn = conn

    def claim(self, run_id: str) -> dict[str, Any] | None:
        with self.conn.transaction():
            with self.conn.cursor(row_factory=dict_row) as cur:
                cur.execute(RUN_SELECT, (run_id,))
                row = cur.fetchone()
                if row is None:
                    return None
                if row["status"] == "succeeded":
                    return row
                cur.execute(
                    """
                    update analysis_runs
                    set status = 'running',
                        stage = 'claim',
                        progress_pct = 1,
                        stage_detail = 'Worker claimed run',
                        attempt = attempt + 1,
                        started_at = coalesce(started_at, now()),
                        updated_at = now()
                    where id = %s
                    """,
                    (run_id,),
                )
                row["status"] = "running"
                row["attempt"] = int(row["attempt"]) + 1
                return row

    def heartbeat(self, run_id: str, stage: str, progress_pct: int, detail: str | None) -> None:
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

    def register_artifact(self, run_id: str, org_id: str, kind: str, blob_path: str) -> str:
        with self.conn.transaction():
            if kind == "thumbnail":
                self.conn.execute(
                    "delete from analysis_artifacts where run_id = %s and blob_path = %s",
                    (run_id, blob_path),
                )
            else:
                self.conn.execute(
                    "delete from analysis_artifacts where run_id = %s and kind = %s",
                    (run_id, kind),
                )
            row = self.conn.execute(
                """
                insert into analysis_artifacts (run_id, org_id, kind, blob_path)
                values (%s, %s, %s, %s)
                returning id::text
                """,
                (run_id, org_id, kind, blob_path),
            ).fetchone()
            if row is None:  # pragma: no cover - defensive DB invariant
                raise RuntimeError("artifact insert returned no id")
            return str(row[0])

    def set_provider_versions(self, run_id: str, provider_versions: dict[str, str]) -> None:
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

    def finalize(self, run_id: str, status: str, detail: str) -> None:
        self.conn.execute(
            """
            update analysis_runs
            set status = %s,
                stage = 'finalize',
                progress_pct = 100,
                stage_detail = %s,
                error_code = null,
                completed_at = now(),
                updated_at = now()
            where id = %s
            """,
            (status, detail, run_id),
        )
        self.conn.commit()

    def fail(self, run_id: str, error_code: str, detail: str) -> None:
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
