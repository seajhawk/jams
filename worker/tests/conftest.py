"""Ensure worker/scripts and worker/tests are importable from tests."""

from __future__ import annotations

import sys
from pathlib import Path

_TESTS = Path(__file__).parent
_SCRIPTS = _TESTS.parent / "scripts"
for _p in (_TESTS, _SCRIPTS):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))
