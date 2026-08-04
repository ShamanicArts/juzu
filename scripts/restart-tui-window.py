#!/usr/bin/env python3
"""Relaunch Juzu in a persistent tmux review window."""

from __future__ import annotations

import argparse
import shlex
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "target" / "release" / "juzu"


def run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"command failed: {shlex.join(command)}\n"
            f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result


def tmux(*args: str, check: bool = True) -> str:
    return run(["tmux", *args], check=check).stdout


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", default="juzu")
    parser.add_argument("--window", default="tui")
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--mode", default="mainline")
    parser.add_argument("--width", type=int, default=178)
    parser.add_argument("--height", type=int, default=76)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    if not BINARY.exists():
        raise SystemExit("missing release binary; run `cargo build --release -p juzu-tui`")

    repository = Path(args.repo).resolve()
    target = f"{args.session}:{args.window}"
    command = [str(BINARY), "--path", str(repository), "--mode", args.mode]
    if args.limit is not None:
        command.extend(["--limit", str(args.limit)])

    session_exists = run(
        ["tmux", "has-session", "-t", args.session], check=False
    ).returncode == 0
    if not session_exists:
        tmux(
            "new-session",
            "-d",
            "-s",
            args.session,
            "-n",
            args.window,
            "-x",
            str(args.width),
            "-y",
            str(args.height),
        )
    else:
        tmux("kill-window", "-t", target, check=False)
        tmux("new-window", "-t", args.session, "-n", args.window, "-d")

    time.sleep(0.5)
    tmux("send-keys", "-t", target, shlex.join(command), "Enter")
    print(f"launched {shlex.join(command)} in {target}")


if __name__ == "__main__":
    main()
