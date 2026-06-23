#!/usr/bin/env python3
"""Safely recreate the persistent `juzu:rust-tui` review window.

This avoids the flaky launch patterns that caused stale/wedged panes:
- no direct `exec` launch (so `q` returns to shell instead of killing the pane)
- fresh tmux window each time
- short shell-settle delay before sending the command
- optional `--limit`, but none by default for the live review surface
"""

from __future__ import annotations

import argparse
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "target" / "release" / "juzu-tui"


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )
    return proc


def tmux(*args: str, check: bool = True) -> str:
    return run(["tmux", *args], check=check).stdout


def capture(target: str) -> str:
    return tmux("capture-pane", "-p", "-t", target)


def send(target: str, *keys: str) -> None:
    tmux("send-keys", "-t", target, *keys)


def wait_for(target: str, needles: list[str], timeout: float = 8.0) -> str:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        last = capture(target)
        if all(needle in last for needle in needles):
            return last
        time.sleep(0.1)
    return last


def session_exists(name: str) -> bool:
    return run(["tmux", "has-session", "-t", name], check=False).returncode == 0


def window_exists(target: str) -> bool:
    return run(["tmux", "list-windows", "-t", target], check=False).returncode == 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", default="juzu")
    parser.add_argument("--window", default="rust-tui")
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--mode", default="mainline")
    parser.add_argument("--width", type=int, default=178)
    parser.add_argument("--height", type=int, default=76)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    if not BINARY.exists():
        raise SystemExit(f"missing release binary: {BINARY}")

    repo = Path(args.repo).resolve()
    session = args.session
    window = args.window
    target = f"{session}:{window}"

    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --mode {args.mode}"
    if args.limit is not None:
        cmd += f" --limit {args.limit}"

    if not session_exists(session):
        tmux("new-session", "-d", "-s", session, "-n", window, "-x", str(args.width), "-y", str(args.height))
    else:
        tmux("kill-window", "-t", target, check=False)
        tmux("new-window", "-t", session, "-n", window, "-d")

    # Let the interactive shell initialize before sending commands.
    time.sleep(0.5)
    send(target, cmd, "Enter")
    screen = wait_for(target, ["LOG", "Change:"], timeout=10.0)

    pane_info = tmux("list-panes", "-t", target, "-F", "pane=#{pane_id} cmd=#{pane_current_command} dead=#{pane_dead} pid=#{pane_pid}").strip()
    print(pane_info)
    print(screen)

    if "LOG" not in screen or "Change:" not in screen:
        raise SystemExit("rust-tui window did not reach the expected live log surface")


if __name__ == "__main__":
    main()
