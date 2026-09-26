"""Typed worker failures surfaced to analysis_runs.error_code."""

from __future__ import annotations

# Failures that retrying cannot fix: the run fails on its first attempt and the message goes
# straight to the poison queue instead of costing two more full attempts.
TERMINAL_ERROR_CODES = frozenset({"too_long", "corrupt_file", "too_large", "unsupported_media"})


class PipelineError(Exception):
    """A pipeline failure with an API-visible taxonomy code."""

    def __init__(self, error_code: str, message: str, *, fatal: bool = True) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.fatal = fatal


class StaleLeaseError(RuntimeError):
    """Raised when a worker's lease expired, was stolen, or fenced by another owner."""
