#!/usr/bin/env python3
"""Generate mutation-safe Ops fetch/push proof artifacts for the Rust TUI."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import shutil
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


def wait_for_value(fn, expected: str, timeout: float = 5.0) -> str:
    deadline = time.time() + timeout
    last = fn()
    while time.time() < deadline:
        last = fn()
        if last == expected:
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


def git(cwd: Path, *args: str) -> str:
    return run(["git", *args], cwd=cwd).stdout


def create_remote_fixture(base: Path) -> tuple[Path, Path, Path]:
    remote_work = base / "remote-work"
    remote_bare = base / "remote.git"
    local = base / "local"
    git(base, "init", str(remote_work))
    (remote_work / "readme.txt").write_text("hi\n")
    git(remote_work, "add", ".")
    git(remote_work, "commit", "-m", "init")
    git(remote_work, "branch", "-M", "main")
    git(base, "clone", "--bare", str(remote_work), str(remote_bare))
    jj(base, "git", "clone", str(remote_bare), str(local))
    return local, remote_work, remote_bare


def main_description(repo: Path) -> str:
    return jj(repo, "log", "--no-graph", "-r", "main", "-T", "description.first_line()").strip()


def current_description(repo: Path) -> str:
    return jj(repo, "log", "--no-graph", "-r", "@", "-T", "description.first_line()").strip()


def remote_main_subject(remote_bare: Path) -> str:
    proc = run(["git", "--git-dir", str(remote_bare), "log", "-1", "--format=%s", "refs/heads/main"])
    return proc.stdout.strip()


def run_fetch_sequence(repo: Path, remote_work: Path, remote_bare: Path, width: int, height: int, session_suffix: str) -> dict[str, object]:
    session = f"juzu-ops-fetch-{session_suffix}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit 20 --mode mainline"
    captures: list[tuple[str, str]] = []
    before_main = main_description(repo)
    (remote_work / "readme.txt").write_text("hi\nmore\n")
    git(remote_work, "add", ".")
    git(remote_work, "commit", "-m", "remote two")
    git(remote_work, "push", str(remote_bare), "main")
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height))
    try:
        send(session, cmd, "Enter")
        captures.append(("01 log before fetch", wait_for(session, "LOG")))
        send(session, "C-o")
        captures.append(("02 ops leader before fetch", wait_for(session, "OPS")))
        send(session, "f")
        after_main = wait_for_value(lambda: main_description(repo), "remote two")
        time.sleep(0.3)
        captures.append(("03 log after fetch", capture(session)))
    finally:
        tmux("kill-session", "-t", session, check=False)
    return {
        "beforeMain": before_main,
        "afterMain": after_main,
        "captures": captures,
    }


def run_push_sequence(repo: Path, remote_bare: Path, width: int, height: int, session_suffix: str) -> dict[str, object]:
    session = f"juzu-ops-push-{session_suffix}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit 20 --mode mainline"
    captures: list[tuple[str, str]] = []
    before_remote = remote_main_subject(remote_bare)
    (repo / "note2.txt").write_text("new\n")
    jj(repo, "describe", "-m", "second desc")
    jj(repo, "bookmark", "set", "main", "-r", "@")
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height))
    try:
        send(session, cmd, "Enter")
        captures.append(("04 log before push", wait_for(session, "LOG")))
        send(session, "C-o")
        captures.append(("05 ops leader before push", wait_for(session, "OPS")))
        send(session, "p")
        after_remote = wait_for_value(lambda: remote_main_subject(remote_bare), "second desc")
        time.sleep(0.3)
        captures.append(("06 log after push", capture(session)))
    finally:
        tmux("kill-session", "-t", session, check=False)
    return {
        "beforeRemote": before_remote,
        "afterRemote": after_remote,
        "afterCurrent": current_description(repo),
        "captures": captures,
    }


def render_html(report: dict[str, object], mp4: Path) -> str:
    captures = "".join(
        f"<section><h2>{html.escape(title)}</h2><pre>{html.escape(screen)}</pre></section>"
        for section_name in ["fetch", "push"]
        for title, screen in report[section_name]["captures"]
    )
    return f"""<!doctype html><html><head><meta charset='utf-8'><title>JUZU Rust Ops fetch/push proof</title>
<style>
:root {{ color-scheme: dark; --bg:#111318; --panel:#1a2029; --line:#2a3442; --text:#d8dee8; --muted:#8a95a7; --info:#7f9fbf; --ok:#74b88c; }}
body {{ margin:32px; background:radial-gradient(circle at top left,#1d2530 0,#111318 44rem); color:var(--text); font-family:Inter,system-ui,sans-serif; }}
a {{ color:var(--info); }} code {{ color:#bfdbfe; }}
section {{ background:rgba(26,32,41,.96); border:1px solid var(--line); border-radius:16px; padding:18px; margin:18px 0; box-shadow:0 18px 60px rgba(0,0,0,.26); }}
pre {{ background:#050816; border:1px solid #2a3442; border-radius:12px; padding:14px; overflow:auto; font:12px/1.35 'JetBrains Mono',ui-monospace,monospace; color:#d8dee8; }}
strong {{ color:var(--ok); }}
</style></head><body>
<h1>JUZU Rust Ops fetch/push proof</h1>
<p>MP4: <a href='file://{mp4}'>{html.escape(str(mp4))}</a></p>
<section>
  <h2>Fetch</h2>
  <p>Main before fetch: <strong>{html.escape(report['fetch']['beforeMain'])}</strong></p>
  <p>Main after fetch: <strong>{html.escape(report['fetch']['afterMain'])}</strong></p>
</section>
<section>
  <h2>Push</h2>
  <p>Remote main before push: <strong>{html.escape(report['push']['beforeRemote'])}</strong></p>
  <p>Remote main after push: <strong>{html.escape(report['push']['afterRemote'])}</strong></p>
  <p>Current description after push: <strong>{html.escape(report['push']['afterCurrent']) or '(empty)'}</strong></p>
</section>
{captures}
</body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, default=160)
    parser.add_argument("--height", type=int, default=36)
    parser.add_argument("--output-root", default="bench/results/rust-port/ops-fetch-push")
    args = parser.parse_args()

    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00:00", "Z")
    out_dir = ROOT / args.output_root / stamp
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    report: dict[str, object] = {}

    fetch_base = out_dir / "fetch-fixture"
    fetch_base.mkdir(parents=True, exist_ok=True)
    fetch_repo, fetch_remote_work, fetch_remote_bare = create_remote_fixture(fetch_base)
    report["fetch"] = run_fetch_sequence(fetch_repo, fetch_remote_work, fetch_remote_bare, args.width, args.height, f"{os.getpid()}-fetch")

    push_base = out_dir / "push-fixture"
    push_base.mkdir(parents=True, exist_ok=True)
    push_repo, _push_remote_work, push_remote_bare = create_remote_fixture(push_base)
    report["push"] = run_push_sequence(push_repo, push_remote_bare, args.width, args.height, f"{os.getpid()}-push")

    shutil.rmtree(fetch_base, ignore_errors=True)
    shutil.rmtree(push_base, ignore_errors=True)

    all_captures = [*report["fetch"]["captures"], *report["push"]["captures"]]
    for idx, (title, screen) in enumerate(all_captures):
        render_frame(screen, title, frames_dir / f"frame-{idx:03d}.png")

    mp4 = out_dir / "ops-fetch-push-sequence-proof.mp4"
    run([
        "ffmpeg", "-y", "-framerate", "1", "-i", str(frames_dir / "frame-%03d.png"),
        "-vf", "fps=30,format=yuv420p", "-movflags", "+faststart", str(mp4)
    ])

    json_path = out_dir / "ops-fetch-push-report.json"
    json_path.write_text(json.dumps(report, indent=2) + "\n")
    html_path = out_dir / "ops-fetch-push-review.html"
    html_path.write_text(render_html(report, mp4))
    print(f"file://{mp4}")
    print(f"file://{html_path}")

    if report["fetch"]["beforeMain"] != "init":
        raise SystemExit("fetch fixture did not start on the expected main description")
    if report["fetch"]["afterMain"] != "remote two":
        raise SystemExit("fetch did not import the remote bookmark advance")
    if report["push"]["beforeRemote"] != "init":
        raise SystemExit("push fixture remote did not start on the expected main description")
    if report["push"]["afterRemote"] != "second desc":
        raise SystemExit("push did not update the remote main bookmark")


if __name__ == "__main__":
    main()
