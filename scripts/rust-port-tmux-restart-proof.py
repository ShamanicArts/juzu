#!/usr/bin/env python3
"""Prove Rust TUI survives repeated tmux relaunch cycles without wedging input."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(cmd: list[str], *, cwd: Path = ROOT, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and proc.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    return proc


def tmux(*args: str, check: bool = True) -> str:
    return run(["tmux", *args], check=check).stdout


def capture(target: str) -> str:
    return tmux("capture-pane", "-p", "-t", target)


def send(target: str, *keys: str) -> None:
    tmux("send-keys", "-t", target, *keys)


def wait_for(target: str, needle: str, timeout: float = 6.0) -> str:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        last = capture(target)
        if needle in last:
            return last
        time.sleep(0.1)
    return last


def launch_tui(target: str, cmd: str) -> str:
    # Let the interactive shell settle before sending the launch command.
    time.sleep(0.5)
    send(target, cmd, "Enter")
    return wait_for(target, "^X Act")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--cycles", type=int, default=3)
    parser.add_argument("--width", type=int, default=160)
    parser.add_argument("--height", type=int, default=36)
    parser.add_argument("--output-root", default="bench/results/rust-port/tmux-restart")
    args = parser.parse_args()

    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00:00", "Z")
    out_dir = ROOT / args.output_root / stamp
    out_dir.mkdir(parents=True, exist_ok=True)

    session = f"juzu-restart-proof-{os.getpid()}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {Path(args.repo).resolve()} --limit {args.limit} --mode mainline"
    cycles: list[dict[str, object]] = []

    try:
        tmux("new-session", "-d", "-s", session, "-n", "proof", "-x", str(args.width), "-y", str(args.height))
        target = f"{session}:proof"
        for cycle in range(1, args.cycles + 1):
            if cycle > 1:
                send(target, "q")
                time.sleep(0.6)
                send(target, "clear", "Enter")
            idle = launch_tui(target, cmd)
            send(target, "C-x")
            act = wait_for(target, "ACT")
            send(target, "q")
            back_from_act = wait_for(target, "LOG")
            send(target, "C-l")
            view = wait_for(target, "VIEW")
            send(target, "q")
            back_from_view = wait_for(target, "LOG")
            cycles.append({
                "cycle": cycle,
                "idleHasAct": "^X Act" in idle and "^L View" in idle,
                "actOpened": "ACT" in act,
                "returnedFromAct": "LOG" in back_from_act,
                "viewOpened": "VIEW" in view,
                "returnedFromView": "LOG" in back_from_view,
                "captures": {
                    "idle": idle,
                    "act": act,
                    "backFromAct": back_from_act,
                    "view": view,
                    "backFromView": back_from_view,
                },
            })
    finally:
        tmux("kill-session", "-t", session, check=False)

    ok = all(
        cycle["idleHasAct"] and cycle["actOpened"] and cycle["returnedFromAct"] and cycle["viewOpened"] and cycle["returnedFromView"]
        for cycle in cycles
    )

    report = {
        "schemaVersion": 1,
        "createdAt": dt.datetime.now(dt.UTC).isoformat(),
        "repo": str(Path(args.repo).resolve()),
        "cycles": cycles,
        "ok": ok,
    }
    json_path = out_dir / "tmux-restart-report.json"
    json_path.write_text(json.dumps(report, indent=2) + "\n")

    sections = []
    for cycle in cycles:
        for name, screen in cycle["captures"].items():
            sections.append(
                f"<section><h2>Cycle {cycle['cycle']} · {html.escape(name)}</h2><pre>{html.escape(screen)}</pre></section>"
            )

    html_path = out_dir / "tmux-restart-proof.html"
    html_path.write_text(
        "<!doctype html><html><head><meta charset='utf-8'><title>JUZU tmux restart proof</title>"
        "<style>body{margin:32px;background:#111318;color:#d8dee8;font-family:Inter,system-ui,sans-serif}"
        "section{background:#1a2029;border:1px solid #2a3442;border-radius:16px;padding:16px;margin:16px 0}"
        "pre{font:12px/1.3 \"JetBrains Mono\",monospace;overflow:auto;background:#050816;padding:12px;border-radius:12px}"
        "a{color:#7f9fbf}</style></head><body>"
        f"<h1>JUZU tmux restart proof</h1><p>Pass: <strong>{str(ok).lower()}</strong></p>"
        f"<p>JSON: <a href='file://{json_path}'>{html.escape(str(json_path))}</a></p>"
        + "".join(sections)
        + "</body></html>"
    )
    print(f"file://{html_path}")
    if not ok:
        raise SystemExit("tmux restart proof failed")


if __name__ == "__main__":
    main()
