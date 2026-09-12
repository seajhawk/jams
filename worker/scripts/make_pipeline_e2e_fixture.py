"""Create a short silent CFR fixture with two known visual transitions."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from jams_worker.ffmpeg import ffmpeg_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    output = parser.parse_args().output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-y"]
    for color in ("white", "blue", "yellow"):
        command += ["-f", "lavfi", "-i", f"color=c={color}:s=640x360:r=30:d=4"]
    command += [
        "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]",
        "-map", "[out]", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(output),
    ]
    subprocess.run(command, check=True, timeout=60)
    print(f"Created {output} (12 seconds, 30 fps, no audio, cuts at 4s and 8s)")


if __name__ == "__main__":
    main()
