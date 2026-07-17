"""Smoke tests for MeasureProvider protocol."""
from typing import Any

from jams_worker.pipeline import MeasureProvider


class _FakeProvider:
    """Minimal concrete implementation of MeasureProvider."""

    @property
    def id(self) -> str:
        return "fake_v1"

    @property
    def version(self) -> str:
        return "1.0.0"

    @property
    def requires(self) -> list[str]:
        return []

    @property
    def provides(self) -> list[str]:
        return ["fake_measure"]

    def run(self, context: dict[str, Any]) -> list[dict[str, Any]]:
        return []


def test_measure_provider_protocol() -> None:
    provider = _FakeProvider()
    assert isinstance(provider, MeasureProvider)
    assert provider.id == "fake_v1"
    assert provider.version == "1.0.0"
    assert provider.requires == []
    assert provider.provides == ["fake_measure"]
    assert provider.run({}) == []
