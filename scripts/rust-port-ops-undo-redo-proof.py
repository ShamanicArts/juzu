#!/usr/bin/env python3
"""Generate mutation-safe Ops undo/redo proof artifacts for the Rust TUI."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import subprocess
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

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


def send(session: str, *keys: str) -> None:
    tmux("send-keys", "-t", session, *keys)


def wait_for(session: str, needle: str, timeout: float = 5.0) -> str:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        last = capture(session)
        if needle in last:
            return last
        time.sleep(0.1)
    return last


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in [
        "/usr/share/fonts/TTF/JetBrainsMono-Regular.ttf",
        "/usr/share/fonts/truetype/jetbrains-mono/JetBrainsMono-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def render_frame(text: str, title: str, out: Path) -> None:
    mono = font(18)
    title_font = font(24)
    lines = text.splitlines()[:42]
    char_w = 11
    line_h = 22
    width = max(1280, min(2400, max((len(line) for line in lines), default=80) * char_w + 64))
    height = max(760, len(lines) * line_h + 110)
    if width % 2:
        width += 1
    if height % 2:
        height += 1
    img = Image.new("RGB", (width, height), "#111318")
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, width, 64), fill="#1a2029")
    draw.text((28, 18), title, font=title_font, fill="#d8dee8")
    y = 86
    for line in lines:
        draw.text((28, y), line, font=mono, fill="#d8dee8")
        y += line_h
    img.save(out)


def jj(repo: Path, *args: str) -> str:
    return run(["jj", *args], cwd=repo).stdout


def create_fixture_repo(repo: Path) -> None:
    repo.mkdir(parents=True, exist_ok=True)
    jj(repo, "git", "init", ".")
    (repo / "note.txt").write_text("one\n")
    jj(repo, "describe", "-m", "first desc")
    (repo / "note.txt").write_text("two\n")
    jj(repo, "describe", "-m", "second desc")


def current_description(repo: Path) -> str:
    return jj(repo, "log", "--no-graph", "-r", "@", "-T", "description.first_line()").strip()


def wait_for_description(repo: Path, expected: str, timeout: float = 5.0) -> str:
    deadline = time.time() + timeout
    last = current_description(repo)
    while time.time() < deadline:
        last = current_description(repo)
        if last == expected:
            return last
        time.sleep(0.1)
    return last


def run_sequence(repo: Path, width: int, height: int) -> dict[str, object]:
    session = f"juzu-ops-undo-redo-{os.getpid()}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit 20 --mode mainline"
    captures: list[tuple[str, str]] = []
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height))
    try:
        send(session, cmd, "Enter")
        captures.append(("01 log before undo", wait_for(session, "LOG")))
        send(session, "C-o")
        captures.append(("02 ops leader before undo", wait_for(session, "OPS")))
        send(session, "u")
        after_undo = wait_for_description(repo, "first desc")
        time.sleep(0.3)
        captures.append(("03 log after undo", capture(session)))
        send(session, "C-o")
        captures.append(("04 ops leader before redo", wait_for(session, "OPS")))
        send(session, "r")
        after_redo = wait_for_description(repo, "second desc")
        time.sleep(0.3)
        captures.append(("05 log after redo", capture(session)))
    finally:
        tmux("kill-session", "-t", session, check=False)

    return {
        "beforeDescription": "second desc",
        "afterUndo": after_undo,
        "afterRedo": after_redo,
        "captures": captures,
    }


def render_html(report: dict[str, object], mp4: Path) -> str:
    captures = "".join(
        f"<section><h2>{html.escape(title)}</h2><pre>{html.escape(screen)}</pre></section>"
        for title, screen in report["captures"]
    )
    return f"""<!doctype html><html><head><meta charset='utf-8'><title>JUZU Rust Ops undo/redo proof</title>
<style>
:root {{ color-scheme: dark; --bg:#111318; --panel:#1a2029; --line:#2a3442; --text:#d8dee8; --muted:#8a95a7; --info:#7f9fbf; --ok:#74b88c; }}
body {{ margin:32px; background:radial-gradient(circle at top left,#1d2530 0,#111318 44rem); color:var(--text); font-family:Inter,system-ui,sans-serif; }}
a {{ color:var(--info); }} code {{ color:#bfdbfe; }}
section {{ background:rgba(26,32,41,.96); border:1px solid var(--line); border-radius:16px; padding:18px; margin:18px 0; box-shadow:0 18px 60px rgba(0,0,0,.26); }}
pre {{ background:#050816; border:1px solid #2a3442; border-radius:12px; padding:14px; overflow:auto; font:12px/1.35 'JetBrains Mono',ui-monospace,monospace; color:#d8dee8; }}
strong {{ color:var(--ok); }}
</style></head><body>
<h1>JUZU Rust Ops undo/redo proof</h1>
<p>MP4: <a href='file://{mp4}'>{html.escape(str(mp4))}</a></p>
<section>
  <p>Before: <strong>{html.escape(report['beforeDescription'])}</strong></p>
  <p>After undo: <strong>{html.escape(report['afterUndo'])}</strong></p>
  <p>After redo: <strong>{html.escape(report['afterRedo'])}</strong></p>
</section>
{captures}
</body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, default=160)
    parser.add_argument("--height", type=int, default=36)
    parser.add_argument("--output-root", default="bench/results/rust-port/ops-undo-redo")
    args = parser.parse_args()

    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00:00", "Z")
    out_dir = ROOT / args.output_root / stamp
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    repo = out_dir / "fixture-repo"
    create_fixture_repo(repo)
    report = run_sequence(repo, args.width, args.height)

    for idx, (title, screen) in enumerate(report["captures"]):
        render_frame(screen, title, frames_dir / f"frame-{idx:03d}.png")

    mp4 = out_dir / "ops-undo-redo-sequence-proof.mp4"
    run([
        "ffmpeg", "-y", "-framerate", "1", "-i", str(frames_dir / "frame-%03d.png"),
        "-vf", "fps=30,format=yuv420p", "-movflags", "+faststart", str(mp4)
    ])

    json_path = out_dir / "ops-undo-redo-report.json"
    json_path.write_text(json.dumps(report, indent=2) + "\n")
    html_path = out_dir / "ops-undo-redo-review.html"
    html_path.write_text(render_html(report, mp4))
    print(f"file://{mp4}")
    print(f"file://{html_path}")
    if report["afterUndo"] != "first desc":
        raise SystemExit("undo did not restore the previous description")
    if report["afterRedo"] != "second desc":
        raise SystemExit("redo did not restore the later description")


if __name__ == "__main__":
    main()
