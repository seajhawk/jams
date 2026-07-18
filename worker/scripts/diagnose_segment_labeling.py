"""Run only the segment_labeling provider against an existing analysis run."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from jams_worker.db import RunRepository
from jams_worker.pipeline import PipelineContext, run_pipeline
from jams_worker.providers.segment_labeling import SegmentLabelingProvider


def _read_run(conn: psycopg.Connection[Any], run_id: str) -> dict[str, Any]:
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            select
                ar.id::text,
                ar.org_id,
                ar.video_id::text,
                ar.status,
                ar.attempt,
                ar.config,
                ar.provider_versions,
                ar.provider_results,
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
            """,
            (run_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise SystemExit(f"analysis run not found: {run_id}")
    return dict(row)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_id")
    args = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL", "postgresql://jams:jams@localhost:5432/jams")
    with psycopg.connect(database_url) as conn:
        run = _read_run(conn, args.run_id)
        repo = RunRepository(conn)
        with tempfile.TemporaryDirectory(prefix=f"jams-label-{args.run_id}-") as temp_dir:
            context = PipelineContext(
                run=run,
                org_id=str(run["org_id"]),
                blob_service_client=object(),  # type: ignore[arg-type]
                db_conn=conn,
                workdir=Path(temp_dir),
                register_artifact=lambda _kind, _path: "diagnostic",
                heartbeat=lambda stage, pct, detail: repo.heartbeat(
                    args.run_id,
                    stage,
                    pct,
                    detail,
                ),
            )
            result = run_pipeline(context, [SegmentLabelingProvider()])
        repo.set_provider_versions(args.run_id, result.provider_versions)
        repo.set_provider_results(args.run_id, result.provider_summaries)
        print(json.dumps(result.provider_summaries.get("segment_labeling", {}), indent=2))


if __name__ == "__main__":
    main()
