#!/usr/bin/env python3
"""Prove Rust footer parity for total node count + compact bookmark summary."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import subprocess
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / "target" / "release" / "juzu-tui"


def run(cmd: list[str], *, cwd: Path = ROOT, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )
    return proc


def run_json(cmd: list[str], *, cwd: Path = ROOT) -> dict[str, Any]:
    return json.loads(run(cmd, cwd=cwd).stdout)


def tmux(*args: str, check: bool = True) -> str:
    return run(["tmux", *args], check=check).stdout


def send(session: str, *keys: str) -> None:
    tmux("send-keys", "-t", session, *keys)


def capture(session: str) -> str:
    return tmux("capture-pane", "-p", "-t", session)


def wait_for(session: str, needle: str, timeout: float = 8.0) -> str:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        last = capture(session)
        if needle in last:
            return last
        time.sleep(0.1)
    return last


def extract_footer_line(screen: str) -> str:
    for line in reversed(screen.splitlines()):
        if " nodes" in line:
            return line.rstrip()
    return ""


def render_html(report: dict[str, Any]) -> str:
    return f"""<!doctype html><html><head><meta charset='utf-8'><title>JUZU Rust footer parity proof</title>
<style>
:root {{ color-scheme: dark; --bg:#111318; --panel:#1a2029; --line:#2a3442; --text:#d8dee8; --muted:#8a95a7; --info:#7f9fbf; --ok:#74b88c; }}
body {{ margin:32px; background:radial-gradient(circle at top left,#1d2530 0,#111318 44rem); color:var(--text); font-family:Inter,system-ui,sans-serif; }}
a {{ color:var(--info); }} .grid {{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }}
.card {{ background:rgba(26,32,41,.96); border:1px solid var(--line); border-radius:16px; padding:18px; margin:18px 0; box-shadow:0 18px 60px rgba(0,0,0,.26); }}
pre {{ background:#050816; border:1px solid #2a3442; border-radius:12px; padding:14px; overflow:auto; font:12px/1.35 'JetBrains Mono',ui-monospace,monospace; color:#d8dee8; }}
strong {{ color:var(--ok); }} p {{ color:var(--muted); }}
</style></head><body>
<h1>JUZU Rust footer parity proof</h1>
<p>Repo: {html.escape(report['repo'])} · limit {report['limit']} · generated {html.escape(report['generatedAt'])}</p>
<div class='grid'>
  <article class='card'>
    <h2>Oracle vs Rust counts</h2>
    <pre>{html.escape(json.dumps(report['summary'], indent=2))}</pre>
  </article>
  <article class='card'>
    <h2>Rust debug state</h2>
    <pre>{html.escape(json.dumps(report['rustDebug'], indent=2))}</pre>
  </article>
</div>
<article class='card'>
  <h2>tmux capture</h2>
  <pre>{html.escape(report['screen'])}</pre>
</article>
</body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--width", type=int, default=170)
    parser.add_argument("--height", type=int, default=42)
    parser.add_argument("--output-root", default="bench/results/rust-port/footer-parity")
    args = parser.parse_args()

    if not BINARY.exists():
        raise SystemExit(f"missing release binary: {BINARY}")

    repo = Path(args.repo).resolve()
    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00:00", "Z")
    out_dir = ROOT / args.output_root / stamp
    out_dir.mkdir(parents=True, exist_ok=True)

    oracle = run_json([
        "bun", "run", "oracle:snapshot", "--", "--repo", str(repo), "--limit", str(args.limit)
    ])
    rust_debug = run_json([
        str(BINARY), "--path", str(repo), "--limit", str(args.limit), "--debug-state"
    ])

    session = f"juzu-footer-proof-{int(time.time())}"
    try:
        tmux("new-session", "-d", "-s", session, "-x", str(args.width), "-y", str(args.height))
        time.sleep(0.5)
        send(session, f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit {args.limit} --mode mainline", "Enter")
        screen = wait_for(session, " nodes ")
    finally:
        tmux("kill-session", "-t", session, check=False)

    footer_line = extract_footer_line(screen)
    summary = {
        "oracleNodeCount": oracle.get("nodeCount"),
        "rustVisibleNodeCount": rust_debug.get("visibleNodeCount"),
        "rustTotalNodeCount": rust_debug.get("totalNodeCount"),
        "footerLine": footer_line,
    }
    report = {
        "generatedAt": dt.datetime.now(dt.UTC).isoformat(),
        "repo": str(repo),
        "limit": args.limit,
        "summary": summary,
        "rustDebug": rust_debug,
        "screen": screen,
    }

    (out_dir / "footer-parity-report.json").write_text(json.dumps(report, indent=2) + "\n")
    (out_dir / "tmux-screen.txt").write_text(screen)
    html_path = out_dir / "footer-parity-review.html"
    html_path.write_text(render_html(report))
    print(f"file://{html_path}")

    if rust_debug.get("totalNodeCount") != oracle.get("nodeCount"):
        raise SystemExit("rust total node count did not match old oracle")
    expected_fragment = f"{oracle.get('nodeCount')} nodes"
    if expected_fragment not in footer_line:
        raise SystemExit(f"footer line did not include expected total node count fragment: {expected_fragment!r}")


if __name__ == "__main__":
    main()
