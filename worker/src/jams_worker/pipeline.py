"""Pluggable analysis pipeline contracts and runner."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from azure.storage.blob import BlobServiceClient
from psycopg import Connection
from psycopg.types.json import Jsonb

from jams_worker.errors import PipelineError

MeasureRow = dict[str, Any]


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

    @property
    def run_id(self) -> str:
        return str(self.run["id"])

    @property
    def video_id(self) -> str:
        return str(self.run["video_id"])


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
        except PipelineError:
            raise
        except Exception as exc:  # pragma: no cover - defensive partial semantics
            failures.append((provider.id, str(exc)))

    return PipelineResult(
        status="partial" if failures else "succeeded",
        provider_versions=provider_versions,
        failures=failures,
    )
