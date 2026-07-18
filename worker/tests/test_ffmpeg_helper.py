"""Shared media subprocess helper behavior."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

from jams_worker.errors import PipelineError
from jams_worker.ffmpeg import run_media_command


def test_media_command_timeout_kills_process_tree(tmp_path: Path) -> None:
    child_marker = tmp_path / "child-survived.txt"
    child = tmp_path / "slow_child.py"
    child.write_text(
        "\n".join(
            [
                "from pathlib import Path",
                "import sys",
                "import time",
                "time.sleep(2.5)",
                "Path(sys.argv[1]).write_text('survived', encoding='utf-8')",
            ]
        ),
        encoding="utf-8",
    )
    parent = tmp_path / "slow_parent.py"
    parent.write_text(
        "\n".join(
            [
                "import subprocess",
                "import sys",
                "import time",
                "subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]])",
                "time.sleep(30)",
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(PipelineError) as exc:
        run_media_command(
            [sys.executable, str(parent), str(child), str(child_marker)],
            timeout_seconds=1,
        )

    assert exc.value.error_code == "transient"
    assert exc.value.fatal is False

    time.sleep(3)
    assert not child_marker.exists()
