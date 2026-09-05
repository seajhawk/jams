"""Terminal effort scoring provider."""

from __future__ import annotations

from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from jams_worker.effort_score import normalize, score
from jams_worker.media import get_authoritative_duration_ms
from jams_worker.pipeline import PipelineContext

PROVIDER_ID = "scoring"
PROVIDER_VERSION = "1.0.0"


def _read_video(context: PipelineContext) -> dict[str, Any]:
    duration_ms = get_authoritative_duration_ms(context)
    return {"duration_ms": duration_ms}


def _read_measures(context: PipelineContext) -> list[dict[str, Any]]:
    with context.db_conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            select
                id::text,
                kind,
                category,
                t_start_ms,
                t_end_ms,
                value_num,
                value_text,
                unit,
                confidence,
                source,
                provider_id,
                provider_version,
                payload
            from measures
            where run_id = %s
            order by t_start_ms, kind, id
            """,
            (context.run_id,),
        )
        return [dict(row) for row in cur.fetchall()]


def _default_profile(context: PipelineContext) -> dict[str, Any] | None:
    with context.db_conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            select id::text, name, weights, normalization
            from weight_profiles
            where org_id = %s
              and is_default = true
              and deleted_at is null
            order by created_at
            limit 1
            """,
            (context.org_id,),
        )
        row = cur.fetchone()
    return dict(row) if row is not None else None


def write_effort_score(
    context: PipelineContext,
    *,
    profile_id: str,
    result: dict[str, Any],
) -> None:
    components = result["components"]
    with context.db_conn.transaction():
        context.db_conn.execute(
            "delete from effort_scores where run_id = %s and profile_id = %s",
            (context.run_id, profile_id),
        )
        context.db_conn.execute(
            """
            insert into effort_scores (
                run_id, profile_id, org_id, physical, cognitive, time,
                sentiment, speech, total, breakdown
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                context.run_id,
                profile_id,
                context.org_id,
                components["physical"],
                components["cognitive"],
                components["time"],
                components["sentiment"],
                components["speech"],
                result["total"],
                Jsonb(result["breakdown"]),
            ),
        )


class ScoringProvider:
    @property
    def id(self) -> str:
        return PROVIDER_ID

    @property
    def version(self) -> str:
        return PROVIDER_VERSION

    @property
    def requires(self) -> list[str]:
        return ["measure:context_switch", "measure:spoken_word", "measure:sentiment", "segment"]

    @property
    def provides(self) -> list[str]:
        return ["effort_score"]

    def run(self, context: PipelineContext) -> list[dict[str, Any]]:
        context.heartbeat(self.id, 10, "Reading default weight profile")
        profile = _default_profile(context)
        if profile is None:
            context.report_provider_summary(
                self.id,
                {"status": "partial", "reason": "no_default_weight_profile"},
            )
            return []

        weights = dict(profile["weights"])
        normalization = dict(profile["normalization"])
        context.heartbeat(self.id, 35, "Normalizing measures")
        normalized = normalize(_read_measures(context), _read_video(context), normalization)
        result = score(normalized, weights)
        write_effort_score(context, profile_id=str(profile["id"]), result=result)

        context.report_provider_summary(
            self.id,
            {
                "status": "ok",
                "profile_id": str(profile["id"]),
                "total": result["total"],
                "components": result["components"],
            },
        )
        context.heartbeat(self.id, 95, f"Effort Score {result['total']}")
        return []
