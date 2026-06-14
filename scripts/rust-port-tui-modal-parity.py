#!/usr/bin/env python3
"""tmux-backed parity checks for Rust TUI diff modal behavior.

This encodes the old Bun/OpenTUI JUZU diff-mode contract:
- Ctrl+D from log enters the diff pane, replacing the graph pane while keeping the details sidebar.
- Diff pane exposes old DiffView-style file cycling title controls.
- q/Esc/g/Ctrl+D return from diff mode to log without quitting the app.

Uses tmux capture-pane instead of raw PTY byte grepping, because Ratatui emits
cursor movement and partial redraws. tmux is the real review surface here.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def run(cmd: list[str], *, cwd: Path = ROOT, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and proc.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    return proc


def tmux(*args: str, check: bool = True) -> str:
    return run(["tmux", *args], check=check).stdout


def capture(session: str) -> str:
    return tmux("capture-pane", "-p", "-t", session, "-S", "-200")


def wait_for(session: str, needle: str, timeout: float = 5.0) -> str:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        last = capture(session)
        if needle in last:
            return last
        time.sleep(0.1)
    return last


def pane_command(session: str) -> str:
    return tmux("display-message", "-p", "-t", session, "#{pane_current_command}").strip()


def send(session: str, *keys: str) -> None:
    tmux("send-keys", "-t", session, *keys)


def assert_contains(text: str, needle: str, label: str, failures: list[str]) -> None:
    if needle not in text:
        failures.append(f"{label}: expected screen to contain {needle!r}")


def assert_not_contains(text: str, needle: str, label: str, failures: list[str]) -> None:
    if needle in text:
        failures.append(f"{label}: expected screen not to contain {needle!r}")


def run_case(args: argparse.Namespace) -> dict[str, Any]:
    subprocess.run(["cargo", "build", "--release", "-p", "juzu-tui"], cwd=ROOT, check=True)
    session = f"juzu-modal-parity-{os.getpid()}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {Path(args.repo).resolve()} --limit {args.limit} --mode mainline"
    tmux("new-session", "-d", "-s", session, "-x", "206", "-y", "36")
    captures: dict[str, str] = {}
    failures: list[str] = []
    try:
        send(session, cmd, "Enter")
        initial = wait_for(session, "dag graph")
        captures["initial"] = initial
        assert_contains(initial, "dag graph", "initial log mode", failures)

        send(session, "j")
        selected = wait_for(session, "cap rust tui structured diff preview rows")
        captures["afterSelectChange"] = selected
        assert_contains(selected, "Files", "selected non-empty change details", failures)

        send(session, "C-d")
        diff = wait_for(session, "Ctrl+d back")
        captures["afterCtrlD"] = diff
        assert_contains(diff, "File ", "diff mode title", failures)
        assert_contains(diff, "Ctrl+d back", "diff mode title", failures)
        assert_contains(diff, "[ / ] next/prev", "diff file cycling hint", failures)
        assert_not_contains(diff, "dag graph", "diff replaces graph pane", failures)
        assert_contains(diff, "details", "diff mode keeps sidebar", failures)
        if "JUZU" not in diff:
            failures.append("after Ctrl+D: screen no longer shows JUZU, app likely exited")

        send(session, "q")
        back = wait_for(session, "dag graph")
        captures["afterDiffQ"] = back
        assert_contains(back, "dag graph", "q returns to log", failures)
        if "JUZU" not in back:
            failures.append("after q in diff mode: screen no longer shows JUZU, app likely exited")

        send(session, "C-d")
        diff_again = wait_for(session, "Ctrl+d back")
        captures["afterSecondCtrlD"] = diff_again
        assert_contains(diff_again, "File ", "second diff entry", failures)
        send(session, "C-d")
        back_ctrl = wait_for(session, "dag graph")
        captures["afterDiffCtrlD"] = back_ctrl
        assert_contains(back_ctrl, "dag graph", "Ctrl+D returns to log", failures)
        if "JUZU" not in back_ctrl:
            failures.append("after Ctrl+D in diff mode: screen no longer shows JUZU, app likely exited")
    finally:
        tmux("kill-session", "-t", session, check=False)
    return {
        "session": session,
        "command": cmd,
        "passed": not failures,
        "failures": failures,
        "captures": captures,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--write-report")
    args = parser.parse_args()
    report = run_case(args)
    printable = {k: v for k, v in report.items() if k != "captures"}
    print(json.dumps(printable, indent=2))
    if args.write_report:
        Path(args.write_report).write_text(json.dumps(report, indent=2) + "\n")
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
