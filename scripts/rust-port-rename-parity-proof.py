#!/usr/bin/env python3
"""Generate pure-rename parity proof artifacts for the Rust TUI."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]


def run(cmd: list[str], *, cwd: Path = ROOT, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )
    return proc


def run_json(cmd: list[str], *, cwd: Path = ROOT) -> dict:
    return json.loads(run(cmd, cwd=cwd).stdout)


def jj(repo: Path, *args: str) -> str:
    return run(["jj", *args], cwd=repo).stdout


def tmux(*args: str, check: bool = True) -> str:
    return run(["tmux", *args], check=check).stdout


def send(session: str, *keys: str) -> None:
    tmux("send-keys", "-t", session, *keys)


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


def create_fixture_repo(repo: Path) -> str:
    jj(repo, "git", "init", ".")
    (repo / "old.txt").write_text("hello\n")
    jj(repo, "describe", "-m", "rename base")
    jj(repo, "new")
    (repo / "old.txt").rename(repo / "new.txt")
    jj(repo, "describe", "-m", "rename change")
    return jj(repo, "log", "--no-graph", "-r", "@", "-T", "change_id.short()").strip()


def render_html(report: dict, mp4: Path) -> str:
    captures_html = "".join(
        f"<section><h3>{html.escape(title)}</h3><pre>{html.escape(screen)}</pre></section>"
        for title, screen in report["captures"]
    )
    old_files = json.dumps(report["oldSidebar"]["files"], indent=2)
    rust_files = json.dumps(report["rustFiles"]["files"], indent=2)
    old_diff = "\n".join(report["oldSidebar"]["diffSummary"]["firstLines"])
    rust_diff = report["rustDiff"]["diff"]
    return f"""<!doctype html><html><head><meta charset='utf-8'><title>JUZU Rust rename parity proof</title>
<style>
:root {{ color-scheme: dark; --bg:#111318; --panel:#1a2029; --line:#2a3442; --text:#d8dee8; --muted:#8a95a7; --info:#7f9fbf; --ok:#74b88c; }}
body {{ margin:32px; background:radial-gradient(circle at top left,#1d2530 0,#111318 44rem); color:var(--text); font-family:Inter,system-ui,sans-serif; }}
a {{ color:var(--info); }} code {{ color:#bfdbfe; }}
.grid {{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }}
.card {{ background:rgba(26,32,41,.96); border:1px solid var(--line); border-radius:16px; padding:18px; margin:18px 0; box-shadow:0 18px 60px rgba(0,0,0,.26); }}
pre {{ background:#050816; border:1px solid #2a3442; border-radius:12px; padding:14px; overflow:auto; font:12px/1.35 'JetBrains Mono',ui-monospace,monospace; color:#d8dee8; }}
h1,h2,h3 {{ margin-top:0; }} p {{ color:var(--muted); }} strong {{ color:var(--ok); }}
</style></head><body>
<h1>JUZU Rust rename parity proof</h1>
<p>MP4: <a href='file://{mp4}'>{html.escape(str(mp4))}</a></p>
<div class='card'>
  <p>change <code>{html.escape(report['changeId'])}</code> · files match <strong>{'yes' if report['filesMatch'] else 'no'}</strong> · diff prefix match <strong>{'yes' if report['diffPrefixMatch'] else 'no'}</strong></p>
</div>
<div class='grid'>
  <article class='card'><h2>Old oracle files</h2><pre>{html.escape(old_files)}</pre></article>
  <article class='card'><h2>Rust native files</h2><pre>{html.escape(rust_files)}</pre></article>
  <article class='card'><h2>Old oracle diff summary</h2><pre>{html.escape(old_diff)}</pre></article>
  <article class='card'><h2>Rust native diff</h2><pre>{html.escape(rust_diff)}</pre></article>
</div>
<article class='card'>
  <h2>Rust TUI capture</h2>
  {captures_html}
</article>
</body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, default=160)
    parser.add_argument("--height", type=int, default=36)
    parser.add_argument("--output-root", default="bench/results/rust-port/rename-parity")
    args = parser.parse_args()

    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00:00", "Z")
    out_dir = ROOT / args.output_root / stamp
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    binary = ROOT / "target" / "release" / "juzu-tui"
    if not binary.exists():
        raise SystemExit(f"missing release binary: {binary}")

    with tempfile.TemporaryDirectory(prefix="juzu-rename-proof-") as td:
        repo = Path(td)
        change_id = create_fixture_repo(repo)
        old_sidebar = run_json(
            [
                "bun",
                "run",
                "oracle:sidebar",
                "--",
                "--repo",
                str(repo),
                "--limit",
                "10",
                "--selected",
                change_id,
            ]
        )
        rust_files = run_json(
            [
                "cargo",
                "run",
                "-q",
                "-p",
                "juzu-cli",
                "--",
                "files",
                "--path",
                str(repo),
                "--change",
                change_id,
            ]
        )
        rust_diff = run_json(
            [
                "cargo",
                "run",
                "-q",
                "-p",
                "juzu-cli",
                "--",
                "diff",
                "--path",
                str(repo),
                "--change",
                change_id,
            ]
        )

        session = f"juzu-rename-proof-{os.getpid()}"
        captures: list[tuple[str, str]] = []
        try:
            tmux("new-session", "-d", "-s", session, "-x", str(args.width), "-y", str(args.height))
            send(session, f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit 20 --mode mainline", "Enter")
            captures.append(("log", wait_for(session, "LOG")))
            send(session, "C-d")
            captures.append(("rename diff", wait_for(session, "rename from old.txt")))
        finally:
            tmux("kill-session", "-t", session, check=False)

    for idx, (title, screen) in enumerate(captures):
        render_frame(screen, title, frames_dir / f"frame-{idx:03d}.png")

    mp4 = out_dir / "rename-parity-proof.mp4"
    run([
        "ffmpeg", "-y", "-framerate", "1", "-i", str(frames_dir / "frame-%03d.png"),
        "-vf", "fps=30,format=yuv420p", "-movflags", "+faststart", str(mp4)
    ])

    report = {
        "createdAt": dt.datetime.now(dt.UTC).isoformat(),
        "outputDir": str(out_dir),
        "changeId": change_id,
        "oldSidebar": old_sidebar,
        "rustFiles": rust_files,
        "rustDiff": rust_diff,
        "filesMatch": old_sidebar.get("files") == rust_files.get("files"),
        "diffPrefixMatch": old_sidebar.get("diffSummary", {}).get("firstLines", [])[:3]
        == rust_diff.get("diff", "").splitlines()[:3],
        "captures": captures,
    }
    (out_dir / "rename-parity-report.json").write_text(json.dumps(report, indent=2) + "\n")
    html_path = out_dir / "rename-parity-review.html"
    html_path.write_text(render_html(report, mp4))
    for idx, (_, screen) in enumerate(captures):
        (out_dir / f"tmux-screen-{idx:02d}.txt").write_text(screen)

    print(f"file://{mp4}")
    print(f"file://{html_path}")
    if not report["filesMatch"] or not report["diffPrefixMatch"]:
        raise SystemExit("rename parity did not match old oracle")
    if "rename to new.txt" not in captures[-1][1]:
        raise SystemExit("rust tui diff capture did not show rename metadata")
    shutil.rmtree(frames_dir)


if __name__ == "__main__":
    main()
