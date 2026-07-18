"""ffprobe parsing and typed error taxonomy."""

from __future__ import annotations

from pathlib import Path

import pytest

from jams_worker.errors import PipelineError
from jams_worker.providers.probe import probe_file


def test_probe_file_reads_tiny_fixture() -> None:
    fixture = Path(__file__).parents[2] / "fixtures" / "e2e-tiny.mp4"
    result = probe_file(fixture)

    assert result.duration_ms > 0
    assert result.width > 0
    assert result.height > 0
    assert result.video_codec != "unknown"


def test_probe_file_maps_corrupt_file(tmp_path: Path) -> None:
    corrupt = tmp_path / "corrupt.mp4"
    corrupt.write_bytes(b"not a video file")

    with pytest.raises(PipelineError) as exc:
        probe_file(corrupt)

    assert exc.value.error_code == "corrupt_file"
