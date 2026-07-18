"""Pluggable analysis pipeline contracts and runner."""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from azure.storage.blob import BlobServiceClient
from psycopg import Connection
from psycopg.types.json import Jsonb

from jams_worker.errors import PipelineError

MeasureRow = dict[str, Any]


def log_event(event: str, **fields: Any) -> None:
    """Emit one structured, flushed log line."""

    record = {
        "ts": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "event": event,
        **fields,
    }
    print(json.dumps(record, default=str, separators=(",", ":")), flush=True)


def _provider_outcome_message(provider_id: str, summary: dict[str, Any]) -> str:
    if provider_id == "segment_labeling":
        status = str(summary.get("status") or "ok")
        if status == "skipped":
            return f"skipped:{summary.get('reason') or summary.get('skipped_reason') or 'unknown'}"
        if status == "rejected":
            return f"rejected:{summary.get('reason') or 'unknown'}"
        if status == "error":
            return f"error:{summary.get('reason') or 'unknown'}"

        usage = summary.get("usage") if isinstance(summary.get("usage"), dict) else {}
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        return (
            f"applied {summary.get('renamed_count', 0)} renames, "
            f"{summary.get('merge_count', 0)} merges, "
            f"usage {prompt_tokens}/{completion_tokens} tokens"
        )

    status = str(summary.get("status") or "ok")
    reason = summary.get("reason")
    return f"{status}:{reason}" if reason else status


@dataclass(slots=True)
class PipelineContext:
    """Runtime state passed to every measure provider."""

    run: dict[str, Any]
    org_id: str
    blob_service_client: BlobServiceClient
    db_conn: Connection[Any]
    workdir: Path
    register_artifact: Callable[[str, str], str]
    heartbeat: Callable[[str, int, str | None], None]
    provider_summaries: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def run_id(self) -> str:
        return str(self.run["id"])

    @property
    def video_id(self) -> str:
        return str(self.run["video_id"])

    def report_provider_summary(self, provider_id: str, summary: dict[str, Any]) -> None:
        self.provider_summaries[provider_id] = summary


@runtime_checkable
class MeasureProvider(Protocol):
    """Every analysis stage implements this interface."""

    @property
    def id(self) -> str:
        """Stable provider identifier, for example ``probe``."""
        ...

    @property
    def version(self) -> str:
        """Semver string."""
        ...

    @property
    def requires(self) -> list[str]:
        """Artifact kinds this provider needs as input."""
        ...

    @property
    def provides(self) -> list[str]:
        """Measure or artifact kinds this provider emits."""
        ...

    def run(self, context: PipelineContext) -> list[MeasureRow]:
        """Execute the provider and return measure rows."""
        ...


@dataclass(slots=True)
class PipelineResult:
    status: str
    provider_versions: dict[str, str]
    failures: list[tuple[str, str]] = field(default_factory=list)
    provider_summaries: dict[str, dict[str, Any]] = field(default_factory=dict)


def write_provider_measures(
    conn: Connection[Any],
    *,
    run_id: str,
    org_id: str,
    provider_id: str,
    provider_version: str,
    measures: Sequence[MeasureRow],
) -> None:
    """Delete then insert one provider's measures so retries are idempotent."""

    with conn.transaction():
        conn.execute(
            "delete from measures where run_id = %s and provider_id = %s",
            (run_id, provider_id),
        )
        for measure in measures:
            conn.execute(
                """
                insert into measures (
                    run_id, org_id, kind, category, t_start_ms, t_end_ms,
                    value_num, value_text, unit, confidence, source,
                    provider_id, provider_version, payload
                )
                values (
                    %(run_id)s, %(org_id)s, %(kind)s, %(category)s,
                    %(t_start_ms)s, %(t_end_ms)s, %(value_num)s,
                    %(value_text)s, %(unit)s, %(confidence)s, %(source)s,
                    %(provider_id)s, %(provider_version)s, %(payload)s
                )
                """,
                {
                    "run_id": run_id,
                    "org_id": org_id,
                    "provider_id": provider_id,
                    "provider_version": provider_version,
                    "kind": measure["kind"],
                    "category": measure["category"],
                    "t_start_ms": measure["t_start_ms"],
                    "t_end_ms": measure.get("t_end_ms"),
                    "value_num": measure.get("value_num"),
                    "value_text": measure.get("value_text"),
                    "unit": measure.get("unit"),
                    "confidence": measure.get("confidence"),
                    "source": measure.get("source", "video_analysis"),
                    "payload": Jsonb(measure.get("payload", {})),
                },
            )


def run_pipeline(
    context: PipelineContext,
    providers: Sequence[MeasureProvider],
) -> PipelineResult:
    provider_versions: dict[str, str] = {}
    failures: list[tuple[str, str]] = []

    for provider in providers:
        provider_versions[provider.id] = provider.version
        started_at = time.perf_counter()
        measures: list[MeasureRow] = []
        log_event(
            "provider_start",
            run_id=context.run_id,
            provider_id=provider.id,
            provider_version=provider.version,
        )
        context.heartbeat(provider.id, 5, f"Starting {provider.id}")

        try:
            measures = provider.run(context)
            write_provider_measures(
                context.db_conn,
                run_id=context.run_id,
                org_id=context.org_id,
                provider_id=provider.id,
                provider_version=provider.version,
                measures=measures,
            )
        except PipelineError as exc:
            duration_ms = round((time.perf_counter() - started_at) * 1000)
            context.report_provider_summary(
                provider.id,
                {
                    "status": "error",
                    "reason": f"pipeline_error:{exc.error_code}",
                    "error": str(exc),
                },
            )
            log_event(
                "provider_error",
                run_id=context.run_id,
                provider_id=provider.id,
                duration_ms=duration_ms,
                error=f"pipeline_error:{exc.error_code}",
            )
            raise
        except Exception as exc:  # pragma: no cover - defensive partial semantics
            failures.append((provider.id, str(exc)))
            context.report_provider_summary(
                provider.id,
                {
                    "status": "partial",
                    "reason": f"error:{type(exc).__name__}",
                    "error": str(exc),
                },
            )
        finally:
            duration_ms = round((time.perf_counter() - started_at) * 1000)
            summary = context.provider_summaries.get(
                provider.id,
                {"status": "ok", "measure_count": len(measures)},
            )
            context.provider_summaries[provider.id] = summary
            log_event(
                "provider_outcome",
                run_id=context.run_id,
                provider_id=provider.id,
                duration_ms=duration_ms,
                outcome=_provider_outcome_message(provider.id, summary),
                **summary,
            )

    partial_summaries = [
        summary
        for summary in context.provider_summaries.values()
        if summary.get("status") == "partial"
    ]

    return PipelineResult(
        status="partial" if failures or partial_summaries else "succeeded",
        provider_versions=provider_versions,
        failures=failures,
        provider_summaries=dict(context.provider_summaries),
    )
