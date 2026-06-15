#!/usr/bin/env python3
"""Generate a Bun-vs-Rust visual parity audit for the JUZU Rust TUI port.

This is intentionally a review artifact, not a fake proof video. It starts isolated
Bun and Rust tmux sessions at fixed dimensions, captures matching states, and
renders a side-by-side HTML backlog focused on aesthetic parity gaps.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@dataclass
class CapturePair:
    label: str
    rust: str
    bun: str
    notes: list[str]


def run(cmd: list[str], *, cwd: Path = ROOT, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )
    return proc


def tmux(*args: str, check: bool = True) -> str:
    return run(["tmux", *args], check=check).stdout


def send(session: str, *keys: str) -> None:
    tmux("send-keys", "-t", session, *keys)


def capture(session: str) -> str:
    return tmux("capture-pane", "-p", "-t", session)


def wait_for(session: str, needles: list[str], timeout: float = 8.0) -> str:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        last = capture(session)
        if all(needle in last for needle in needles):
            return last
        time.sleep(0.12)
    return last


def normalize_screen(text: str, max_lines: int) -> str:
    lines = text.splitlines()[:max_lines]
    # Keep fixed-width feel but strip tmux history noise below the active screen.
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def metric_summary(text: str) -> dict[str, int | float]:
    lines = text.splitlines()
    nonempty = [line for line in lines if line.strip()]
    box_chars = sum(line.count(ch) for line in lines for ch in "┌┐└┘│─╭╮╰╯")
    blank_lines = len(lines) - len(nonempty)
    avg_len = round(sum(len(line.rstrip()) for line in nonempty) / max(1, len(nonempty)), 1)
    return {
        "lines": len(lines),
        "blankLines": blank_lines,
        "boxChars": box_chars,
        "avgNonemptyWidth": avg_len,
    }


def metric_table(pair: CapturePair) -> str:
    rust = metric_summary(pair.rust)
    bun = metric_summary(pair.bun)
    rows = []
    for key in ["lines", "blankLines", "boxChars", "avgNonemptyWidth"]:
        rows.append(
            f"<tr><th>{html.escape(key)}</th><td>{rust[key]}</td><td>{bun[key]}</td></tr>"
        )
    return "".join(rows)


def start_session(session: str, cmd: str, width: int, height: int, wait_needles: list[str]) -> str:
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height))
    send(session, f"cd {ROOT} && {cmd}", "Enter")
    return wait_for(session, wait_needles)


def build_release() -> None:
    run(["cargo", "build", "--release", "-p", "juzu-tui"])


def run_capture_sequence(args: argparse.Namespace) -> list[CapturePair]:
    build_release()
    suffix = f"{os.getpid()}-{int(time.time())}"
    rust_session = f"juzu-visual-rust-{suffix}"
    bun_session = f"juzu-visual-bun-{suffix}"
    try:
        rust_initial = start_session(
            rust_session,
            f"./target/release/juzu-tui --path {Path(args.repo).resolve()} --limit {args.limit} --mode mainline",
            args.width,
            args.height,
            ["LOG", "dag graph"],
        )
        bun_initial = start_session(
            bun_session,
            "bun run tui",
            args.width,
            args.height,
            ["LOG", "Details"],
        )

        pairs: list[CapturePair] = [
            CapturePair(
                "01 log surface",
                normalize_screen(rust_initial, args.lines),
                normalize_screen(bun_initial, args.lines),
                [
                    "Bun log surface is smooth: no graph/details box border scaffold, mostly negative-space layout.",
                    "Rust still reads as boxed/panelized, especially when mode panes are active. Smooth chrome needs to be default, with boxes toggleable.",
                    "Graph row rhythm differs: Bun rows breathe through blank spacer lines and compact file summaries; Rust rhythm still has heavier structural glyphs and uneven gutters.",
                ],
            )
        ]

        send(rust_session, "C-l")
        send(bun_session, "C-l")
        rust_view = wait_for(rust_session, ["VIEW"])
        bun_view = wait_for(bun_session, ["VIEW"])
        pairs.append(
            CapturePair(
                "02 view leader strip",
                normalize_screen(rust_view, args.lines),
                normalize_screen(bun_view, args.lines),
                [
                    "Leader labels are now directionally aligned, but case, spacing, and segment density still need exact Bun matching.",
                    "Rust should avoid growing controls into pane layout space; Bun keeps the strip feeling like chrome, not content.",
                ],
            )
        )

        # Move to a change with files before opening diff. Do not assume initial @ has useful diff.
        send(rust_session, "q")
        send(bun_session, "q")
        time.sleep(0.2)
        for _ in range(args.diff_down):
            send(rust_session, "j")
            send(bun_session, "j")
            time.sleep(0.04)
        send(rust_session, "C-d")
        send(bun_session, "C-d")
        rust_diff = wait_for(rust_session, ["DIFF"], timeout=8.0)
        bun_diff = wait_for(bun_session, ["DIFF"], timeout=8.0)
        pairs.append(
            CapturePair(
                "03 diff pane",
                normalize_screen(rust_diff, args.lines),
                normalize_screen(bun_diff, args.lines),
                [
                    "Bun DiffView delegates to OpenTUI's diff renderer: mutation backgrounds fill the row, line-number gutters are distinct, and the diff surface feels continuous.",
                    "Rust still has visible pane borders and text-local bands. Even when readable, it does not yet match Bun's full-bar/full-pane treatment.",
                    "Rust diff/details split leaves stronger chrome and broken-line risk; Bun's diff is a smooth pane swap with the details column remaining visually integrated.",
                ],
            )
        )

        return pairs
    finally:
        tmux("kill-session", "-t", rust_session, check=False)
        tmux("kill-session", "-t", bun_session, check=False)


def render_pair(pair: CapturePair) -> str:
    notes = "".join(f"<li>{html.escape(note)}</li>" for note in pair.notes)
    return f"""
<section class='pair'>
  <h2>{html.escape(pair.label)}</h2>
  <div class='metrics'>
    <table><thead><tr><th>Metric</th><th>Rust</th><th>Bun oracle</th></tr></thead><tbody>{metric_table(pair)}</tbody></table>
  </div>
  <div class='screens'>
    <article><h3>Rust Ratatui</h3><pre>{html.escape(pair.rust)}</pre></article>
    <article><h3>Bun/OpenTUI oracle</h3><pre>{html.escape(pair.bun)}</pre></article>
  </div>
  <div class='notes'><h3>Visual gaps</h3><ul>{notes}</ul></div>
</section>
"""


def render_html(pairs: list[CapturePair], args: argparse.Namespace) -> str:
    sections = "".join(render_pair(pair) for pair in pairs)
    return f"""<!doctype html>
<html><head><meta charset='utf-8'><title>JUZU Rust visual parity audit</title>
<style>
:root {{ color-scheme: dark; --bg:#0f131a; --panel:#171d26; --panel2:#101722; --line:#2a3442; --text:#d8dee8; --muted:#8a95a7; --info:#7f9fbf; --warn:#c9a86a; --bad:#ce6f7c; --ok:#74b88c; }}
body {{ margin:32px; background:radial-gradient(circle at top left,#1c2634 0,#0f131a 48rem); color:var(--text); font-family:Inter,system-ui,sans-serif; }}
h1 {{ margin:0 0 6px; letter-spacing:-.035em; font-size:34px; }}
.subtitle {{ color:var(--muted); margin-bottom:22px; max-width:98ch; line-height:1.45; }}
.summary {{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin:20px 0 26px; }}
.card, .pair {{ background:linear-gradient(180deg,rgba(23,29,38,.96),rgba(16,23,34,.96)); border:1px solid var(--line); border-radius:18px; padding:18px; box-shadow:0 18px 60px rgba(0,0,0,.28); }}
.card strong {{ display:block; color:var(--info); font-size:13px; text-transform:uppercase; letter-spacing:.08em; margin-bottom:6px; }}
.card span {{ font-size:18px; }}
.pair {{ margin:18px 0; }} h2 {{ margin:0 0 14px; color:#e6edf7; }} h3 {{ margin:0 0 10px; color:var(--info); font-size:14px; text-transform:uppercase; letter-spacing:.08em; }}
.screens {{ display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:start; }}
article {{ min-width:0; }}
pre {{ margin:0; padding:14px; background:#050816; border:1px solid #273449; border-radius:14px; color:#d8dee8; overflow:auto; font:12px/1.32 'JetBrains Mono','SFMono-Regular',ui-monospace,monospace; white-space:pre; }}
.notes {{ margin-top:14px; background:rgba(5,8,22,.45); border:1px solid #273449; border-radius:14px; padding:14px 16px; }}
ul {{ margin:0; padding-left:20px; }} li {{ margin:8px 0; color:#cbd5e1; line-height:1.45; }}
table {{ border-collapse:collapse; margin:0 0 14px; font:12px/1.35 'JetBrains Mono',monospace; }} th,td {{ border-bottom:1px solid #263141; padding:6px 10px; text-align:left; }} th {{ color:var(--muted); }} td:nth-child(2) {{ color:var(--warn); }} td:nth-child(3) {{ color:var(--ok); }}
.backlog {{ display:grid; grid-template-columns:1fr 1fr; gap:14px; }}
.badge {{ display:inline-block; border:1px solid #334155; border-radius:999px; padding:4px 8px; color:var(--muted); font-size:12px; margin-left:8px; }}
@media (max-width: 1100px) {{ .screens,.summary,.backlog {{ grid-template-columns:1fr; }} }}
</style></head><body>
<h1>JUZU Rust visual parity audit <span class='badge'>Bun oracle vs Rust</span></h1>
<p class='subtitle'>Generated from isolated tmux captures at {args.width}×{args.height}. This audit intentionally focuses on visible craft gaps, not backend capability. The Rust port is fast and functional, but the current surface still diverges from the original Bun/OpenTUI product in chrome, spacing, row rhythm, and diff treatment.</p>
<div class='summary'>
  <div class='card'><strong>Primary correction</strong><span>Default to Bun-like smooth chrome; make boxes optional.</span></div>
  <div class='card'><strong>Diff correction</strong><span>Match Bun DiffView full-row bars and pane continuity.</span></div>
  <div class='card'><strong>Layout correction</strong><span>Reduce unused gaps, broken gutters, and heavy borders.</span></div>
  <div class='card'><strong>Process correction</strong><span>Visual audit first, then one parity slice at a time.</span></div>
</div>
<section class='pair'>
  <h2>Aesthetic backlog from this audit</h2>
  <div class='backlog'>
    <div class='notes'><h3>Immediate slices</h3><ul>
      <li>Add a Rust <strong>smooth chrome</strong> mode and make it the default for Bun parity; keep boxed chrome as an explicit toggle.</li>
      <li>Replace diff box/panel treatment with a Bun-like full-pane surface, preserving details sidebar but reducing border scaffolding.</li>
      <li>Make add/remove/context rows fill the full available diff row, not just the text span/glyph prefix.</li>
      <li>Tighten graph/sidebar spacing to Bun row rhythm, especially blank lines, file summary placement, and details heading hierarchy.</li>
    </ul></div>
    <div class='notes'><h3>Parity rules going forward</h3><ul>
      <li>Do not claim visual parity from tests alone. Capture Bun and Rust side by side.</li>
      <li>Do not invent diff visuals. Use <code>src/tui/components/DiffView.tsx</code> as the oracle.</li>
      <li>Before changing chrome, prove whether Bun uses boxes, soft fills, or raw negative space in that state.</li>
      <li>Every visual slice gets an HTML artifact, benchmark, tmux capture verification, and JJ commit.</li>
    </ul></div>
  </div>
</section>
{sections}
</body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--limit", type=int, default=80)
    parser.add_argument("--width", type=int, default=164)
    parser.add_argument("--height", type=int, default=75)
    parser.add_argument("--lines", type=int, default=70)
    parser.add_argument("--diff-down", type=int, default=2)
    args = parser.parse_args()

    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00-00", "Z")
    out_dir = ROOT / "bench/results/rust-port/visual-parity-audit" / stamp
    out_dir.mkdir(parents=True, exist_ok=True)
    pairs = run_capture_sequence(args)
    path = out_dir / "visual-parity-audit.html"
    path.write_text(render_html(pairs, args))
    print(f"file://{path}")


if __name__ == "__main__":
    main()
