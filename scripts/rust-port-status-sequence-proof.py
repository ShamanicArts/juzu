#!/usr/bin/env python3
"""Generate an MP4/HTML proof for Rust TUI status-bar multi-state sequences."""

from __future__ import annotations

import argparse
import datetime as dt
import html
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--width", type=int, default=160)
    parser.add_argument("--height", type=int, default=36)
    args = parser.parse_args()

    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00-00", "Z")
    out_dir = ROOT / "bench/results/rust-port/status-sequence" / stamp
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    session = f"juzu-status-sequence-{os.getpid()}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {Path(args.repo).resolve()} --limit {args.limit} --mode mainline"
    tmux("new-session", "-d", "-s", session, "-x", str(args.width), "-y", str(args.height))
    captures: list[tuple[str, str]] = []
    try:
        send(session, cmd, "Enter")
        captures.append(("01 LOG idle · ^A Act ^O Ops ^V View ^B Book", wait_for(session, "dag graph")))
        send(session, "C-a")
        captures.append(("02 Ctrl+A enters Act leader", wait_for(session, "ACT")))
        send(session, "q")
        captures.append(("03 q exits Act leader back to Log", wait_for(session, "LOG")))
        send(session, "C-o")
        captures.append(("04 Ctrl+O enters Ops leader", wait_for(session, "OPS")))
        send(session, "o")
        captures.append(("05 o opens read-only OpLog view", wait_for(session, "OPLOG")))
        send(session, "g")
        captures.append(("06 g returns from OpLog to Log", wait_for(session, "LOG")))
        send(session, "C-o")
        captures.append(("07 Ctrl+O re-enters Ops leader", wait_for(session, "OPS")))
        send(session, "v")
        captures.append(("08 v opens read-only Obslog view", wait_for(session, "OBSLOG")))
        send(session, "g")
        captures.append(("09 g returns from Obslog to Log", wait_for(session, "LOG")))
        send(session, "C-v")
        captures.append(("10 Ctrl+V enters View leader", wait_for(session, "VIEW")))
        send(session, "b")
        captures.append(("11 b toggles optional boxed chrome, then returns to Log", wait_for(session, "┌")))
        send(session, "C-v")
        captures.append(("12 Ctrl+V enters View leader from boxed chrome", wait_for(session, "VIEW")))
        send(session, "b")
        captures.append(("13 b toggles back to Bun-smooth chrome", wait_for(session, "LOG")))
        send(session, "C-d")
        captures.append(("14 Ctrl+D enters clean Bun-style diff pane", wait_for(session, "File ")))
        send(session, "q")
        captures.append(("15 q exits clean diff pane", wait_for(session, "LOG")))
        send(session, "C-v")
        send(session, "s")
        captures.append(("16 Ctrl+V s enables opt-in diff scaffold", wait_for(session, "LOG")))
        send(session, "C-d")
        captures.append(("17 Ctrl+D shows scaffold/debug diff pane", wait_for(session, "VIEWPORT")))
        send(session, "q")
        captures.append(("18 q exits scaffold diff pane", wait_for(session, "LOG")))
        send(session, "C-v")
        send(session, "s")
        captures.append(("19 Ctrl+V s disables diff scaffold", wait_for(session, "LOG")))
        send(session, "C-b")
        captures.append(("20 Ctrl+B enters Bookmarks leader", wait_for(session, "BOOK")))
        send(session, "q")
        captures.append(("21 q exits Bookmarks leader back to Log", wait_for(session, "LOG")))
    finally:
        tmux("kill-session", "-t", session, check=False)

    for idx, (title, screen) in enumerate(captures):
        render_frame(screen, title, frames_dir / f"frame-{idx:03d}.png")

    mp4 = out_dir / "status-sequence-proof.mp4"
    run([
        "ffmpeg", "-y", "-framerate", "1", "-i", str(frames_dir / "frame-%03d.png"),
        "-vf", "fps=30,format=yuv420p", "-movflags", "+faststart", str(mp4)
    ])

    cards = "".join(
        f"<section><h2>{html.escape(title)}</h2><pre>{html.escape(screen)}</pre></section>"
        for title, screen in captures
    )
    html_doc = f"""<!doctype html><html><head><meta charset='utf-8'><title>JUZU status sequence proof</title>
<style>body{{margin:32px;background:#111318;color:#d8dee8;font-family:Inter,system-ui,sans-serif}}a{{color:#7f9fbf}}section{{background:#1a2029;border:1px solid #2a3442;border-radius:16px;padding:16px;margin:16px 0}}pre{{font:12px/1.25 'JetBrains Mono',monospace;overflow:auto;background:#0b1017;padding:12px;border-radius:12px}}</style></head>
<body><h1>JUZU Rust status sequence proof</h1><p>MP4: <a href='file://{mp4}'>{html.escape(str(mp4))}</a></p>{cards}</body></html>"""
    html_path = out_dir / "status-sequence-review.html"
    html_path.write_text(html_doc)
    print(f"file://{mp4}")
    print(f"file://{html_path}")


if __name__ == "__main__":
    main()
