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
    return tmux("capture-pane", "-p", "-t", session)


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


def select_change_prefix(session: str, change_prefix: str, max_steps: int = 16) -> str:
    needle = f"Change: {change_prefix}"
    screen = capture(session)
    if needle in screen:
        return screen
    for _ in range(max_steps):
        send(session, "j")
        time.sleep(0.15)
        screen = capture(session)
        if needle in screen:
            return screen
    return screen


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

        selected = select_change_prefix(session, "nqmmukmt")
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
        assert_contains(diff, "Change: nqmmukmt", "diff mode keeps selected commit", failures)
        if "JUZU" not in diff:
            failures.append("after Ctrl+D: screen no longer shows JUZU, app likely exited")

        send(session, "j")
        diff_scroll_down = wait_for(session, "diff rows 2-")
        captures["afterDiffJ"] = diff_scroll_down
        assert_contains(diff_scroll_down, "diff rows 2-", "j scrolls diff rows in diff mode", failures)
        assert_contains(diff_scroll_down, "Change: nqmmukmt", "j in diff mode does not move DAG selection", failures)

        send(session, "k")
        diff_scroll_up = wait_for(session, "diff rows 1-")
        captures["afterDiffK"] = diff_scroll_up
        assert_contains(diff_scroll_up, "diff rows 1-", "k scrolls diff rows up in diff mode", failures)
        assert_contains(diff_scroll_up, "Change: nqmmukmt", "k in diff mode does not move DAG selection", failures)

        send(session, "]")
        diff_next_file = wait_for(session, "File 2/")
        captures["afterDiffNextFile"] = diff_next_file
        assert_contains(diff_next_file, "File 2/", "] cycles to next diff file in diff mode", failures)
        assert_contains(diff_next_file, "diff rows 1-", "File 2 renders diff rows", failures)
        assert_not_contains(diff_next_file, "diff rows 1-0 of 0", "File 2 is not an empty rendered diff", failures)
        assert_contains(diff_next_file, "Change: nqmmukmt", "] in diff mode does not move DAG selection", failures)

        send(session, "[")
        diff_prev_file = wait_for(session, "File 1/")
        captures["afterDiffPrevFile"] = diff_prev_file
        assert_contains(diff_prev_file, "File 1/", "[ cycles to previous diff file in diff mode", failures)
        assert_contains(diff_prev_file, "Change: nqmmukmt", "[ in diff mode does not move DAG selection", failures)

        send(session, "[")
        diff_last_file = wait_for(session, "File 16/")
        captures["afterDiffLastFile"] = diff_last_file
        assert_contains(diff_last_file, "File 16/", "[ from first file wraps to last diff file", failures)
        assert_contains(diff_last_file, "diff rows 1-", "Last file renders diff rows", failures)
        assert_not_contains(diff_last_file, "File 16/16: Diff", "Last file title is not generic/missing rows", failures)
        assert_not_contains(diff_last_file, "diff rows 0/0", "Last file is not an empty rendered diff", failures)
        assert_contains(diff_last_file, "Change: nqmmukmt", "last file navigation does not move DAG selection", failures)

        send(session, "]")
        diff_back_first_file = wait_for(session, "File 1/")
        captures["afterDiffLastToFirstFile"] = diff_back_first_file
        assert_contains(diff_back_first_file, "File 1/", "] from last file wraps back to first diff file", failures)

        send(session, "q")
        back = wait_for(session, "dag graph")
        captures["afterDiffQ"] = back
        assert_contains(back, "dag graph", "q returns to log", failures)
        assert_contains(back, "cap rust tui structured diff preview rows", "q returns with same selected commit", failures)
        if "JUZU" not in back:
            failures.append("after q in diff mode: screen no longer shows JUZU, app likely exited")

        send(session, "PageDown")
        sidebar_scroll_down = wait_for(session, "diff rows 11-")
        captures["afterLogDiffPageDown"] = sidebar_scroll_down
        assert_contains(sidebar_scroll_down, "diff rows 11-", "PageDown scrolls sidebar diff preview in log mode", failures)
        assert_contains(sidebar_scroll_down, "cap rust tui structured diff preview rows", "PageDown diff scroll does not move DAG selection", failures)

        send(session, "PageUp")
        sidebar_scroll_up = wait_for(session, "diff rows 1-")
        captures["afterLogDiffPageUp"] = sidebar_scroll_up
        assert_contains(sidebar_scroll_up, "diff rows 1-", "PageUp scrolls sidebar diff preview in log mode", failures)
        assert_contains(sidebar_scroll_up, "cap rust tui structured diff preview rows", "PageUp diff scroll does not move DAG selection", failures)

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
