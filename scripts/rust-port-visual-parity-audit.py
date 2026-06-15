#!/usr/bin/env python3
"""Generate a raw Bun-vs-Rust visual parity audit for the JUZU Rust TUI port.

This artifact intentionally preserves tmux ANSI styling. The first version of this
script normalized both terminals into one CSS theme, which masked the real visual
differences. This one keeps foreground/background color spans from tmux
`capture-pane -e` and shows exact grid captures side by side.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import os
import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ANSI_RE = re.compile(r"\x1b\[([0-9;]*)m")
STRIP_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


@dataclass
class TerminalCapture:
    plain: str
    ansi: str


@dataclass
class CapturePair:
    label: str
    rust: TerminalCapture
    bun: TerminalCapture
    notes: list[str]


def run(cmd: list[str], *, cwd: Path = ROOT, check: bool = True, text: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, cwd=cwd, text=text, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and proc.returncode != 0:
        stdout = proc.stdout if isinstance(proc.stdout, str) else proc.stdout.decode(errors="replace")
        stderr = proc.stderr if isinstance(proc.stderr, str) else proc.stderr.decode(errors="replace")
        raise RuntimeError(f"command failed: {' '.join(cmd)}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}")
    return proc


def tmux(*args: str, check: bool = True) -> str:
    return run(["tmux", *args], check=check).stdout


def send(session: str, *keys: str) -> None:
    tmux("send-keys", "-t", session, *keys)


def capture_plain(session: str) -> str:
    return tmux("capture-pane", "-p", "-t", session)


def capture_ansi(session: str) -> str:
    proc = run(["tmux", "capture-pane", "-e", "-p", "-t", session], text=False)
    return proc.stdout.decode("utf-8", errors="replace")


def capture_both(session: str) -> TerminalCapture:
    ansi = capture_ansi(session)
    plain = strip_ansi(ansi)
    return TerminalCapture(plain=plain, ansi=ansi)


def wait_for(session: str, needles: list[str], timeout: float = 8.0, settle: float = 0.0) -> TerminalCapture:
    deadline = time.time() + timeout
    last = TerminalCapture(plain="", ansi="")
    while time.time() < deadline:
        last = capture_both(session)
        if all(needle in last.plain for needle in needles):
            if settle > 0:
                time.sleep(settle)
                return capture_both(session)
            return last
        time.sleep(0.12)
    return last


def strip_ansi(text: str) -> str:
    return STRIP_ANSI_RE.sub("", text)


def limit_capture(capture: TerminalCapture, max_lines: int) -> TerminalCapture:
    # For ANSI, preserve exact escape sequences but line-limit by splitting on newlines.
    ansi_lines = capture.ansi.splitlines()[:max_lines]
    plain_lines = capture.plain.splitlines()[:max_lines]
    return TerminalCapture(plain="\n".join(plain_lines), ansi="\n".join(ansi_lines))


def sgr_to_html(ansi: str) -> str:
    """Convert the tmux SGR subset we care about into nested span fragments."""
    fg: str | None = None
    bg: str | None = None
    bold = False
    out: list[str] = []
    pos = 0

    def style_attr() -> str:
        parts: list[str] = []
        if fg:
            parts.append(f"color:{fg}")
        if bg:
            parts.append(f"background-color:{bg}")
        if bold:
            parts.append("font-weight:700")
        return ";".join(parts)

    def emit(chunk: str) -> None:
        if not chunk:
            return
        escaped = html.escape(chunk)
        style = style_attr()
        if style:
            out.append(f"<span style='{style}'>{escaped}</span>")
        else:
            out.append(escaped)

    for match in ANSI_RE.finditer(ansi):
        emit(ansi[pos:match.start()])
        raw_codes = match.group(1)
        codes = [0] if raw_codes == "" else [int(c) if c else 0 for c in raw_codes.split(";")]
        i = 0
        while i < len(codes):
            code = codes[i]
            if code == 0:
                fg = None
                bg = None
                bold = False
            elif code == 1:
                bold = True
            elif code == 22:
                bold = False
            elif code == 39:
                fg = None
            elif code == 49:
                bg = None
            elif code == 38 and i + 4 < len(codes) and codes[i + 1] == 2:
                fg = f"rgb({codes[i + 2]},{codes[i + 3]},{codes[i + 4]})"
                i += 4
            elif code == 48 and i + 4 < len(codes) and codes[i + 1] == 2:
                bg = f"rgb({codes[i + 2]},{codes[i + 3]},{codes[i + 4]})"
                i += 4
            elif 30 <= code <= 37:
                palette = ["#000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0"]
                fg = palette[code - 30]
            elif 40 <= code <= 47:
                palette = ["#000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0"]
                bg = palette[code - 40]
            i += 1
        pos = match.end()
    emit(ansi[pos:])
    return "".join(out)


def metric_summary(text: str) -> dict[str, int | float]:
    lines = text.splitlines()
    nonempty = [line for line in lines if line.strip()]
    box_chars = sum(line.count(ch) for line in lines for ch in "┌┐└┘│─╭╮╰╯")
    blank_lines = len(lines) - len(nonempty)
    avg_len = round(sum(len(line.rstrip()) for line in nonempty) / max(1, len(nonempty)), 1)
    return {"lines": len(lines), "blankLines": blank_lines, "boxChars": box_chars, "avgNonemptyWidth": avg_len}


def metric_table(pair: CapturePair) -> str:
    rust = metric_summary(pair.rust.plain)
    bun = metric_summary(pair.bun.plain)
    rows = []
    for key in ["lines", "blankLines", "boxChars", "avgNonemptyWidth"]:
        rows.append(f"<tr><th>{html.escape(key)}</th><td>{rust[key]}</td><td>{bun[key]}</td></tr>")
    return "".join(rows)


def start_session(session: str, cmd: str, width: int, height: int, wait_needles: list[str], settle: float) -> TerminalCapture:
    tmux("kill-session", "-t", session, check=False)
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height))
    send(session, f"cd {ROOT} && {cmd}", "Enter")
    return wait_for(session, wait_needles, settle=settle)


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
            args.rust_settle,
        )
        bun_initial = start_session(bun_session, "bun run tui", args.width, args.height, ["LOG", "Details"], args.bun_settle)

        pairs = [
            CapturePair(
                "01 log surface",
                limit_capture(rust_initial, args.lines),
                limit_capture(bun_initial, args.lines),
                [
                    "Bun log surface is smooth: no graph/details box border scaffold, mostly negative-space layout.",
                    "Rust still reads as boxed/panelized. Smooth chrome needs to be default, with boxes toggleable.",
                    "The ANSI-preserved capture makes the color/chrome mismatch obvious; the prior HTML masked this by recoloring both panes.",
                ],
            )
        ]

        send(rust_session, "C-l")
        send(bun_session, "C-l")
        rust_view = wait_for(rust_session, ["VIEW"], settle=args.rust_settle)
        bun_view = wait_for(bun_session, ["VIEW"], settle=args.bun_settle)
        pairs.append(
            CapturePair(
                "02 view leader strip",
                limit_capture(rust_view, args.lines),
                limit_capture(bun_view, args.lines),
                [
                    "Leader labels are directionally aligned, but case, spacing, tint, and segment density still differ.",
                    "Rust should avoid turning controls into content. Bun keeps the strip as one-line chrome.",
                ],
            )
        )

        send(rust_session, "q")
        send(bun_session, "q")
        time.sleep(0.2)
        for _ in range(args.diff_down):
            send(rust_session, "j")
            send(bun_session, "j")
            time.sleep(0.04)
        send(rust_session, "C-d")
        send(bun_session, "C-d")
        rust_diff = wait_for(rust_session, ["DIFF"], timeout=8.0, settle=args.rust_settle)
        bun_diff = wait_for(bun_session, ["DIFF"], timeout=8.0, settle=args.bun_settle)
        pairs.append(
            CapturePair(
                "03 diff pane",
                limit_capture(rust_diff, args.lines),
                limit_capture(bun_diff, args.lines),
                [
                    "Bun DiffView uses OpenTUI's diff renderer: full-row backgrounds, distinct gutters, and a continuous pane.",
                    "Rust still shows bordered scaffolding and text-local bands; readable is not parity.",
                    "Future diff work must compare directly to src/tui/components/DiffView.tsx, not hand-style random terminal rows.",
                ],
            )
        )
        return pairs
    finally:
        tmux("kill-session", "-t", rust_session, check=False)
        tmux("kill-session", "-t", bun_session, check=False)


def render_terminal(capture: TerminalCapture, flavor: str) -> str:
    return f"<pre class='terminal {html.escape(flavor)}'>{sgr_to_html(capture.ansi)}</pre>"


def render_pair(pair: CapturePair) -> str:
    notes = "".join(f"<li>{html.escape(note)}</li>" for note in pair.notes)
    return f"""
<section class='pair'>
  <h2>{html.escape(pair.label)}</h2>
  <table><thead><tr><th>Metric</th><th>Rust</th><th>Bun oracle</th></tr></thead><tbody>{metric_table(pair)}</tbody></table>
  <div class='screens'>
    <article><h3>Rust Ratatui, ANSI preserved</h3>{render_terminal(pair.rust, 'rust')}</article>
    <article><h3>Bun/OpenTUI oracle, ANSI preserved</h3>{render_terminal(pair.bun, 'bun')}</article>
  </div>
  <details><summary>Plain text fallback, no color</summary><div class='screens'><pre>{html.escape(pair.rust.plain)}</pre><pre>{html.escape(pair.bun.plain)}</pre></div></details>
  <div class='notes'><h3>Visual gaps</h3><ul>{notes}</ul></div>
</section>
"""


def render_html(pairs: list[CapturePair], args: argparse.Namespace) -> str:
    sections = "".join(render_pair(pair) for pair in pairs)
    return f"""<!doctype html>
<html><head><meta charset='utf-8'><title>JUZU Rust raw visual parity audit</title>
<style>
:root {{ color-scheme: dark; --bg:#0d1117; --panel:#151b23; --line:#303947; --text:#d8dee8; --muted:#8a95a7; --info:#7f9fbf; --warn:#c9a86a; --ok:#74b88c; }}
body {{ margin:24px; background:#0d1117; color:var(--text); font-family:Inter,system-ui,sans-serif; }}
h1 {{ margin:0 0 6px; letter-spacing:-.035em; font-size:32px; }}
.subtitle {{ color:var(--muted); max-width:110ch; line-height:1.45; margin-bottom:18px; }}
.warning {{ border:1px solid #7c5c1d; background:#221908; color:#f4d28a; border-radius:12px; padding:12px 14px; margin:16px 0; }}
.summary {{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin:18px 0; }}
.card,.pair {{ background:#151b23; border:1px solid var(--line); border-radius:14px; padding:14px; box-shadow:0 18px 50px rgba(0,0,0,.24); }}
.card strong {{ display:block; color:var(--info); font-size:12px; text-transform:uppercase; letter-spacing:.08em; margin-bottom:6px; }}
.pair {{ margin:16px 0; }} h2 {{ margin:0 0 12px; }} h3 {{ margin:0 0 8px; color:var(--info); font-size:13px; text-transform:uppercase; letter-spacing:.08em; }}
.screens {{ display:grid; grid-template-columns:1fr 1fr; gap:12px; align-items:start; }}
article {{ min-width:0; }}
.terminal, pre {{ margin:0; padding:0; color:#ddd; overflow:auto; font:12px/1.0 'JetBrains Mono','SFMono-Regular',ui-monospace,monospace; white-space:pre; border:1px solid #222b38; border-radius:8px; tab-size:8; }}
.terminal {{ line-height:1.0; letter-spacing:0; }}
.terminal.rust {{ background:#111318; }}
.terminal.bun {{ background:#1f2430; }}
pre:not(.terminal) {{ padding:10px; line-height:1.2; color:#cbd5e1; background:#050816; }}
.notes {{ margin-top:12px; background:#101722; border:1px solid #263141; border-radius:12px; padding:12px 14px; }}
ul {{ margin:0; padding-left:20px; }} li {{ margin:7px 0; color:#cbd5e1; line-height:1.4; }}
table {{ border-collapse:collapse; margin:0 0 12px; font:12px/1.35 'JetBrains Mono',monospace; }} th,td {{ border-bottom:1px solid #263141; padding:5px 9px; text-align:left; }} th {{ color:var(--muted); }} td:nth-child(2) {{ color:var(--warn); }} td:nth-child(3) {{ color:var(--ok); }}
code {{ color:#93c5fd; }} details {{ margin-top:10px; }} summary {{ cursor:pointer; color:var(--muted); margin-bottom:8px; }}
@media (max-width: 1200px) {{ .screens,.summary {{ grid-template-columns:1fr; }} }}
</style></head><body>
<h1>JUZU Rust raw visual parity audit</h1>
<p class='subtitle'>Generated from isolated tmux captures at {args.width}×{args.height}. This version preserves tmux ANSI foreground/background styling, so it does not hide the real color, spacing, chrome, and pane differences between Rust and the Bun/OpenTUI oracle.</p>
<div class='warning'>The previous audit artifact normalized both terminals into one HTML theme, which masked the differences. This artifact is deliberately uglier and more truthful: captured ANSI spans are rendered directly.</div>
<div class='summary'>
  <div class='card'><strong>Primary correction</strong><span>Default to Bun-like smooth chrome; boxed mode only as toggle.</span></div>
  <div class='card'><strong>Diff correction</strong><span>Match Bun DiffView full-row/full-pane rendering.</span></div>
  <div class='card'><strong>Layout correction</strong><span>Remove unused gaps, broken gutters, and heavy scaffolding.</span></div>
  <div class='card'><strong>Proof correction</strong><span>Use ANSI-preserved captures for visual work.</span></div>
</div>
{sections}
</body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--limit", type=int, default=80)
    parser.add_argument("--width", type=int, default=164)
    parser.add_argument("--height", type=int, default=75)
    parser.add_argument("--lines", type=int, default=75)
    parser.add_argument("--diff-down", type=int, default=2)
    parser.add_argument("--bun-settle", type=float, default=1.2)
    parser.add_argument("--rust-settle", type=float, default=0.2)
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
