"""Create a short CFR fixture with known visual and optional speech timing."""

from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path

from jams_worker.ffmpeg import ffmpeg_path

NARRATION = "synchronised speech for cross stage alignment check"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--narrated", action="store_true")
    args = parser.parse_args()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    speech = output.with_suffix(".speech.wav")
    if args.narrated:
        espeak = shutil.which("espeak-ng")
        if not espeak:
            raise RuntimeError("Narrated fixture requires espeak-ng on PATH")
        subprocess.run(
            [espeak, "-v", "en-us", "-s", "150", "-w", str(speech), NARRATION],
            check=True, timeout=30,
        )
    command = [ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-y"]
    for color in ("white", "blue", "yellow"):
        command += ["-f", "lavfi", "-i", f"color=c={color}:s=640x360:r=30:d=4"]
    filters = "[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]"
    if args.narrated:
        command += ["-i", str(speech)]
        filters += ";[3:a]aresample=16000,adelay=4000,apad,atrim=duration=12[audio]"
    command += ["-filter_complex", filters, "-map", "[out]"]
    command += ["-map", "[audio]", "-c:a", "aac"] if args.narrated else ["-an"]
    command += [
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", str(output),
    ]
    subprocess.run(command, check=True, timeout=60)
    audio_description = "speech at 4s" if args.narrated else "no audio"
    print(f"Created {output} (12 seconds, 30 fps, {audio_description}, cuts at 4s and 8s)")


if __name__ == "__main__":
    main()
