#!/usr/bin/env python3
"""Generate mutation-safe OpLog restore proof artifacts for the Rust TUI."""

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


def current_description(repo: Path) -> str:
    return jj(repo, "log", "--no-graph", "-r", "@", "-T", "description.first_line()").strip()


def create_fixture_repo(repo: Path) -> None:
    repo.mkdir(parents=True, exist_ok=True)
    jj(repo, "git", "init", ".")
    (repo / "note.txt").write_text("one\n")
    jj(repo, "describe", "-m", "first desc")
    (repo / "note.txt").write_text("two\n")
    jj(repo, "describe", "-m", "second desc")


def choose_restore_target(repo: Path) -> tuple[str, str]:
    raw = jj(
        repo,
        "op",
        "log",
        "--no-graph",
        "--limit",
        "10",
        "-T",
        'id.short() ++ "|" ++ description.first_line() ++ "|" ++ current_operation ++ "\\n"',
    )
    for line in raw.splitlines():
        parts = [part.strip() for part in line.split("|")]
        if len(parts) != 3:
            continue
        op_id, title, current = parts
        if title == "snapshot working copy" and current == "false":
            return op_id, title
    raise RuntimeError("failed to find snapshot working copy op to restore")


def wait_for_restored_description(repo: Path, expected: str, timeout: float = 5.0) -> str:
    deadline = time.time() + timeout
    last = current_description(repo)
    while time.time() < deadline:
        last = current_description(repo)
        if last == expected:
            return last
        time.sleep(0.1)
    return last


def run_restore_sequence(repo: Path, trigger_label: str, trigger_keys: list[str], width: int, height: int) -> dict[str, object]:
    before_desc = current_description(repo)
    target_op, target_title = choose_restore_target(repo)
    session = f"juzu-op-restore-{os.getpid()}-{trigger_label.lower()}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit 20 --mode mainline"
    captures: list[tuple[str, str]] = []
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height))
    try:
        send(session, cmd, "Enter")
        captures.append((f"{trigger_label} · log before restore", wait_for(session, "LOG")))
        send(session, "C-o")
        captures.append((f"{trigger_label} · ops leader", wait_for(session, "OPS")))
        send(session, "o")
        wait_for(session, "OPLOG")
        send(session, "j")
        time.sleep(0.2)
        captures.append((f"{trigger_label} · oplog before restore", capture(session)))
        send(session, *trigger_keys)
        after_desc = wait_for_restored_description(repo, "first desc")
        time.sleep(0.3)
        captures.append((f"{trigger_label} · oplog after restore", capture(session)))
        send(session, "g")
        back_log = wait_for(session, "LOG")
        captures.append((f"{trigger_label} · log after restore", back_log))
    finally:
        tmux("kill-session", "-t", session, check=False)

    return {
        "trigger": trigger_label,
        "targetOperation": target_op,
        "targetTitle": target_title,
        "beforeDescription": before_desc,
        "afterDescription": after_desc,
        "restored": after_desc == "first desc",
        "captures": captures,
    }


def render_html(report: dict[str, object], mp4: Path) -> str:
    cards = []
    for scenario in report["scenarios"]:
        scenario = scenario  # type: ignore[assignment]
        captures = "".join(
            f"<section><h3>{html.escape(title)}</h3><pre>{html.escape(screen)}</pre></section>"
            for title, screen in scenario["captures"]
        )
        cards.append(
            f"<article class='card'><h2>{html.escape(scenario['trigger'])}</h2>"
            f"<p>target op <code>{html.escape(scenario['targetOperation'])}</code> · before <code>{html.escape(scenario['beforeDescription'])}</code> · after <code>{html.escape(scenario['afterDescription'])}</code> · restored <strong>{'yes' if scenario['restored'] else 'no'}</strong></p>"
            f"{captures}</article>"
        )
    return f"""<!doctype html><html><head><meta charset='utf-8'><title>JUZU Rust OpLog restore proof</title>
<style>
:root {{ color-scheme: dark; --bg:#111318; --panel:#1a2029; --line:#2a3442; --text:#d8dee8; --muted:#8a95a7; --info:#7f9fbf; --ok:#74b88c; }}
body {{ margin:32px; background:radial-gradient(circle at top left,#1d2530 0,#111318 44rem); color:var(--text); font-family:Inter,system-ui,sans-serif; }}
a {{ color:var(--info); }} code {{ color:#bfdbfe; }}
.card {{ background:rgba(26,32,41,.96); border:1px solid var(--line); border-radius:16px; padding:18px; margin:18px 0; box-shadow:0 18px 60px rgba(0,0,0,.26); }}
pre {{ background:#050816; border:1px solid #2a3442; border-radius:12px; padding:14px; overflow:auto; font:12px/1.35 'JetBrains Mono',ui-monospace,monospace; color:#d8dee8; }}
h1,h2,h3 {{ margin-top:0; }} p {{ color:var(--muted); }} strong {{ color:var(--ok); }}
</style></head><body>
<h1>JUZU Rust OpLog restore proof</h1>
<p>MP4: <a href='file://{mp4}'>{html.escape(str(mp4))}</a></p>
{''.join(cards)}
</body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, default=160)
    parser.add_argument("--height", type=int, default=36)
    parser.add_argument("--output-root", default="bench/results/rust-port/op-restore")
    args = parser.parse_args()

    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00:00", "Z")
    out_dir = ROOT / args.output_root / stamp
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    scenarios = []
    for trigger_label, trigger_keys in [("r", ["r"]), ("Enter", ["Enter"] )]:
        repo = out_dir / f"fixture-{trigger_label.lower()}"
        create_fixture_repo(repo)
        scenarios.append(run_restore_sequence(repo, trigger_label, trigger_keys, args.width, args.height))

    frame_index = 0
    for scenario in scenarios:
        for title, screen in scenario["captures"]:
            render_frame(screen, title, frames_dir / f"frame-{frame_index:03d}.png")
            frame_index += 1

    mp4 = out_dir / "op-restore-sequence-proof.mp4"
    run([
        "ffmpeg", "-y", "-framerate", "1", "-i", str(frames_dir / "frame-%03d.png"),
        "-vf", "fps=30,format=yuv420p", "-movflags", "+faststart", str(mp4)
    ])

    report = {
        "createdAt": dt.datetime.now(dt.UTC).isoformat(),
        "outputDir": str(out_dir),
        "scenarios": scenarios,
    }
    (out_dir / "op-restore-report.json").write_text(json.dumps(report, indent=2) + "\n")
    html_path = out_dir / "op-restore-review.html"
    html_path.write_text(render_html(report, mp4))
    print(f"file://{mp4}")
    print(f"file://{html_path}")
    if not all(scenario["restored"] for scenario in scenarios):
        raise SystemExit("one or more restore scenarios failed")


if __name__ == "__main__":
    main()
