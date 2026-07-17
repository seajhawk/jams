"""Pluggable analysis pipeline contracts."""
from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class MeasureProvider(Protocol):
    """Every analysis stage implements this interface."""

    @property
    def id(self) -> str:
        """Stable provider identifier (e.g. 'context_switch_v1')."""
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
        """Measure kinds this provider emits."""
        ...

    def run(self, context: dict[str, Any]) -> list[dict[str, Any]]:
        """Execute the provider and return measure rows."""
        ...
