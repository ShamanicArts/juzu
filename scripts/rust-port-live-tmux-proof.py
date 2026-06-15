#!/usr/bin/env python3
"""Capture the live juzu:rust-tui tmux review surface into an HTML proof artifact."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and proc.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    return proc


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="juzu:rust-tui")
    parser.add_argument("--expect", default="LOG,Change:")
    parser.add_argument("--lines", type=int, default=160)
    args = parser.parse_args()

    capture = run(["tmux", "capture-pane", "-p", "-t", args.target, "-S", f"-{args.lines}"]).stdout
    command = run(["tmux", "display-message", "-p", "-t", args.target, "#{pane_current_command}"], check=False).stdout.strip()
    expected = [needle.strip() for needle in args.expect.split(",") if needle.strip()]
    missing = [needle for needle in expected if needle not in capture]
    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00-00", "Z")
    out_dir = ROOT / "bench/results/rust-port/live-tmux" / stamp
    out_dir.mkdir(parents=True, exist_ok=True)
    status = "PASS" if not missing else "FAIL"
    html_doc = f"""<!doctype html>
<html><head><meta charset='utf-8'><title>JUZU Rust live tmux proof</title>
<style>
:root {{ color-scheme: dark; --bg:#111318; --panel:#1a2029; --line:#2a3442; --text:#d8dee8; --muted:#8a95a7; --ok:#74b88c; --bad:#ce6f7c; --info:#7f9fbf; }}
body {{ margin:32px; background:radial-gradient(circle at top left,#1d2530 0,#111318 44rem); color:var(--text); font-family:Inter,system-ui,sans-serif; }}
h1 {{ margin:0 0 6px; }} .meta {{ color:var(--muted); margin-bottom:18px; }} .status.pass {{ color:var(--ok); }} .status.fail {{ color:var(--bad); }}
.card {{ background:rgba(26,32,41,.96); border:1px solid var(--line); border-radius:16px; padding:18px; box-shadow:0 18px 60px rgba(0,0,0,.26); }}
pre {{ background:#050816; border:1px solid #2a3442; border-radius:12px; padding:14px; overflow:auto; font:12px/1.35 'JetBrains Mono',ui-monospace,monospace; color:#d8dee8; }} code {{ color:var(--info); }}
</style></head><body>
<h1>JUZU Rust live tmux proof · <span class='status {'pass' if not missing else 'fail'}'>{status}</span></h1>
<div class='meta'>Target: <code>{html.escape(args.target)}</code> · pane command: <code>{html.escape(command)}</code> · expected: <code>{html.escape(', '.join(expected))}</code> · missing: <code>{html.escape(', '.join(missing) or 'none')}</code></div>
<section class='card'><pre>{html.escape(capture)}</pre></section>
</body></html>"""
    path = out_dir / "live-tmux-proof.html"
    path.write_text(html_doc)
    print(f"file://{path}")
    if missing:
        raise SystemExit(f"missing expected tmux text: {', '.join(missing)}")


if __name__ == "__main__":
    main()
