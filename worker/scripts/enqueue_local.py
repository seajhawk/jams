"""Create a local queued analysis run and enqueue it for worker development."""

from __future__ import annotations

import argparse
import json
import os
import uuid

import psycopg
from azure.core.exceptions import ResourceExistsError
from azure.storage.queue import QueueClient

PIPELINE_VERSION = "f3-worker-spine.1"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("video_id")
    parser.add_argument(
        "--config",
        default="{}",
        help='Analysis config JSON, for example {"llm_labeling":{"enabled":true}}.',
    )
    args = parser.parse_args()
    try:
        config = json.loads(args.config)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"--config must be valid JSON: {exc}") from exc
    if not isinstance(config, dict):
        raise SystemExit("--config must be a JSON object")

    database_url = os.environ.get(
        "DATABASE_URL", "postgresql://jams_worker:jams_worker@localhost:5432/jams"
    )
    storage = os.environ["AZURE_STORAGE_CONNECTION_STRING"]

    run_id = str(uuid.uuid4())
    with psycopg.connect(database_url) as conn:
        row = conn.execute(
            "select id::text, org_id from videos where id = %s and status = 'uploaded'",
            (args.video_id,),
        ).fetchone()
        if row is None:
            raise SystemExit("Uploaded video row not found")
        _video_id, org_id = row
        with conn.transaction():
            conn.execute(
                """
                insert into analysis_runs (
                    id, org_id, video_id, config, pipeline_version, status,
                    stage, progress_pct, stage_detail
                )
                values (%s, %s, %s, %s::jsonb, %s, 'queued', 'queued', 0, 'Waiting for worker')
                """,
                (run_id, org_id, args.video_id, json.dumps(config), PIPELINE_VERSION),
            )
            conn.execute(
                """
                update analysis_runs
                set superseded_by = %s
                where org_id = %s
                  and video_id = %s
                  and superseded_by is null
                  and id <> %s
                """,
                (run_id, org_id, args.video_id, run_id),
            )

    queue = QueueClient.from_connection_string(storage, "analysis-jobs")
    try:
        queue.create_queue()
    except ResourceExistsError:
        pass
    queue.send_message(json.dumps({"run_id": run_id}))
    print(run_id)


if __name__ == "__main__":
    main()
