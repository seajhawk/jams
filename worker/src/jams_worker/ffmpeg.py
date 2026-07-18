"""Pinned ffmpeg/ffprobe executable resolution and subprocess helpers."""

from __future__ import annotations

import os
import signal
import subprocess
import threading
from functools import lru_cache
from pathlib import Path
from typing import Callable

from static_ffmpeg import run as static_ffmpeg_run

from jams_worker.errors import PipelineError

PROBE_TIMEOUT_SECONDS = 60
MEDIA_TIMEOUT_SECONDS = 15 * 60


@lru_cache(maxsize=1)
def ffmpeg_paths() -> tuple[str, str]:
    """Return the static-ffmpeg managed ffmpeg and ffprobe executable paths."""

    return static_ffmpeg_run.get_or_fetch_platform_executables_else_raise()


def ffmpeg_path() -> str:
    return ffmpeg_paths()[0]


def ffprobe_path() -> str:
    return ffmpeg_paths()[1]


def _is_ffmpeg_executable(executable: str) -> bool:
    return Path(executable).name.lower().startswith("ffmpeg")


def _args_with_nostdin(args: list[str]) -> list[str]:
    if not args or not _is_ffmpeg_executable(args[0]) or "-nostdin" in args:
        return args
    return [args[0], "-nostdin", *args[1:]]


def _popen_kwargs() -> dict[str, object]:
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _kill_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except ProcessLookupError:
            return
    if process.poll() is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass


def _timeout_error(args: list[str], timeout_seconds: int) -> PipelineError:
    executable = Path(args[0]).name if args else "media command"
    return PipelineError(
        "transient",
        f"{executable} timed out after {timeout_seconds}s",
        fatal=False,
    )


def run_media_command(
    args: list[str],
    *,
    timeout_seconds: int,
) -> subprocess.CompletedProcess[str]:
    """Run ffmpeg/ffprobe with stdin closed, drained pipes, and a hard timeout."""

    safe_args = _args_with_nostdin(args)
    process = subprocess.Popen(
        safe_args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        **_popen_kwargs(),
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        _kill_process_tree(process)
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        raise _timeout_error(safe_args, timeout_seconds) from exc

    return subprocess.CompletedProcess(
        safe_args,
        process.returncode if process.returncode is not None else -1,
        stdout,
        stderr,
    )


def run_media_command_with_progress(
    args: list[str],
    *,
    timeout_seconds: int,
    on_stdout_line: Callable[[str], None],
) -> subprocess.CompletedProcess[str]:
    """Run ffmpeg progress mode while actively draining stdout and stderr."""

    safe_args = _args_with_nostdin(args)
    process = subprocess.Popen(
        safe_args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        **_popen_kwargs(),
    )
    stdout_lines: list[str] = []
    stderr_lines: list[str] = []

    def drain_stdout() -> None:
        if process.stdout is None:
            return
        for line in process.stdout:
            stdout_lines.append(line)
            on_stdout_line(line)

    def drain_stderr() -> None:
        if process.stderr is None:
            return
        for line in process.stderr:
            stderr_lines.append(line)

    stdout_thread = threading.Thread(target=drain_stdout, daemon=True)
    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    try:
        returncode = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        _kill_process_tree(process)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        raise _timeout_error(safe_args, timeout_seconds) from exc
    finally:
        stdout_thread.join(timeout=5)
        stderr_thread.join(timeout=5)

    return subprocess.CompletedProcess(
        safe_args,
        returncode,
        "".join(stdout_lines),
        "".join(stderr_lines),
    )
