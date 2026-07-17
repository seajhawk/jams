"""Typed worker failures surfaced to analysis_runs.error_code."""

from __future__ import annotations


class PipelineError(Exception):
    """A pipeline failure with an API-visible taxonomy code."""

    def __init__(self, error_code: str, message: str, *, fatal: bool = True) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.fatal = fatal
