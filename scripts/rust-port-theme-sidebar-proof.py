#!/usr/bin/env python3
"""Prove theme persistence + sidebar file collapse/diff preview behavior."""

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
BINARY = ROOT / "target" / "release" / "juzu-tui"


def run(cmd: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"command failed: {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )
    return proc


def run_json(cmd: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None) -> dict:
    return json.loads(run(cmd, cwd=cwd, env=env).stdout)


def jj(repo: Path, *args: str, env: dict[str, str] | None = None) -> str:
    return run(["jj", *args], cwd=repo, env=env).stdout


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


def launch_tui(session: str, cmd: str) -> str:
    time.sleep(0.5)
    send(session, cmd, "Enter")
    return wait_for(session, "Files (f collapse):", timeout=8.0)


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
    lines = text.splitlines()[:44]
    char_w = 11
    line_h = 22
    width = max(1280, min(2400, max((len(line) for line in lines), default=80) * char_w + 64))
    height = max(780, len(lines) * line_h + 110)
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


def create_theme_repo(repo: Path, env: dict[str, str]) -> None:
    jj(repo, "git", "init", ".", env=env)
    (repo / "note.txt").write_text("hello\n")
    jj(repo, "describe", "-m", "theme base", env=env)


def run_debug_state(repo: Path, keys: str | None = None, env: dict[str, str] | None = None) -> dict:
    cmd = [str(BINARY), "--path", str(repo), "--debug-state"]
    if keys:
        cmd.extend(["--keys", keys])
    return run_json(cmd, env=env)


def parse_visible_diff_rows(screen: str) -> str:
    for line in screen.splitlines():
        if "diff rows " in line and " of " in line:
            return line.strip()
    return ""


def render_html(report: dict, mp4: Path) -> str:
    captures_html = "".join(
        f"<section><h3>{html.escape(title)}</h3><pre>{html.escape(screen)}</pre></section>"
        for title, screen in report["captures"]
    )
    return f"""<!doctype html><html><head><meta charset='utf-8'><title>JUZU Rust theme + sidebar proof</title>
<style>
:root {{ color-scheme: dark; --bg:#111318; --panel:#1a2029; --line:#2a3442; --text:#d8dee8; --muted:#8a95a7; --info:#7f9fbf; --ok:#74b88c; }}
body {{ margin:32px; background:radial-gradient(circle at top left,#1d2530 0,#111318 44rem); color:var(--text); font-family:Inter,system-ui,sans-serif; }}
a {{ color:var(--info); }} code {{ color:#bfdbfe; }}
.grid {{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }}
.card {{ background:rgba(26,32,41,.96); border:1px solid var(--line); border-radius:16px; padding:18px; margin:18px 0; box-shadow:0 18px 60px rgba(0,0,0,.26); }}
pre {{ background:#050816; border:1px solid #2a3442; border-radius:12px; padding:14px; overflow:auto; font:12px/1.35 'JetBrains Mono',ui-monospace,monospace; color:#d8dee8; }}
h1,h2,h3 {{ margin-top:0; }} p {{ color:var(--muted); }} strong {{ color:var(--ok); }}
</style></head><body>
<h1>JUZU Rust theme persistence + sidebar proof</h1>
<p>MP4: <a href='file://{mp4}'>{html.escape(str(mp4))}</a></p>
<div class='grid'>
  <article class='card'>
    <h2>Theme persistence</h2>
    <pre>{html.escape(json.dumps(report['theme'], indent=2))}</pre>
  </article>
  <article class='card'>
    <h2>Sidebar behavior</h2>
    <pre>{html.escape(json.dumps(report['sidebar'], indent=2))}</pre>
  </article>
</div>
<article class='card'>
  <h2>Captures</h2>
  {captures_html}
</article>
</body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--limit", type=int, default=80)
    parser.add_argument("--width", type=int, default=170)
    parser.add_argument("--height", type=int, default=52)
    parser.add_argument("--output-root", default="bench/results/rust-port/theme-sidebar")
    args = parser.parse_args()

    if not BINARY.exists():
        raise SystemExit(f"missing release binary: {BINARY}")

    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00:00", "Z")
    out_dir = ROOT / args.output_root / stamp
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    captures: list[tuple[str, str]] = []
    theme_report: dict[str, object]
    sidebar_report: dict[str, object]

    with tempfile.TemporaryDirectory(prefix="juzu-theme-proof-") as td, tempfile.TemporaryDirectory(prefix="juzu-theme-xdg-") as xdg:
        theme_repo = Path(td)
        env = os.environ.copy()
        env["XDG_CONFIG_HOME"] = xdg
        create_theme_repo(theme_repo, env)

        initial = run_debug_state(theme_repo, env=env)
        changed = run_debug_state(theme_repo, "C-v,t,j,Enter,Esc", env=env)
        persisted_path = theme_repo / ".juzu.local.toml"
        persisted_raw = persisted_path.read_text() if persisted_path.exists() else ""
        relaunched = run_debug_state(theme_repo, env=env)
        theme_report = {
            "repo": str(theme_repo),
            "initialTheme": initial.get("currentTheme"),
            "changedTheme": changed.get("currentTheme"),
            "themePickerModeAfterApply": changed.get("themePickerMode"),
            "persistedConfigPath": str(persisted_path),
            "persistedConfig": persisted_raw,
            "relaunchedTheme": relaunched.get("currentTheme"),
        }

    repo = Path(args.repo).resolve()
    session = f"juzu-theme-sidebar-proof-{os.getpid()}"
    try:
        tmux("new-session", "-d", "-s", session, "-x", str(args.width), "-y", str(args.height))
        expanded = launch_tui(session, f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit {args.limit} --mode mainline")
        captures.append(("sidebar expanded", expanded))

        send(session, "f")
        collapsed = wait_for(session, "Files (f expand):")
        captures.append(("sidebar collapsed", collapsed))

        send(session, "C-d")
        full_diff = wait_for(session, "DIFF")
        captures.append(("full diff", full_diff))
    finally:
        tmux("kill-session", "-t", session, check=False)

    expanded_debug = run_debug_state(repo)
    collapsed_debug = run_debug_state(repo, "f")
    diff_debug = run_debug_state(repo, "C-d")

    sidebar_report = {
        "expandedFiles": expanded_debug.get("filesExpanded"),
        "collapsedFiles": collapsed_debug.get("filesExpanded"),
        "expandedPreviewRowLine": parse_visible_diff_rows(expanded),
        "collapsedPreviewRowLine": parse_visible_diff_rows(collapsed),
        "diffViewMode": diff_debug.get("viewMode"),
        "diffCurrentRowKind": diff_debug.get("currentDiffRowKind"),
        "diffCurrentRowText": diff_debug.get("currentDiffRowText"),
        "diffStickyContext": diff_debug.get("stickyContext"),
    }

    for idx, (title, screen) in enumerate(captures):
        render_frame(screen, title, frames_dir / f"frame-{idx:03d}.png")

    mp4 = out_dir / "theme-sidebar-proof.mp4"
    run([
        "ffmpeg", "-y", "-framerate", "1", "-i", str(frames_dir / "frame-%03d.png"),
        "-vf", "fps=30,format=yuv420p", "-movflags", "+faststart", str(mp4)
    ])

    report = {
        "createdAt": dt.datetime.now(dt.UTC).isoformat(),
        "repo": str(repo),
        "theme": theme_report,
        "sidebar": sidebar_report,
        "captures": captures,
    }
    (out_dir / "theme-sidebar-report.json").write_text(json.dumps(report, indent=2) + "\n")
    html_path = out_dir / "theme-sidebar-review.html"
    html_path.write_text(render_html(report, mp4))
    for idx, (_, screen) in enumerate(captures):
        (out_dir / f"tmux-screen-{idx:02d}.txt").write_text(screen)

    print(f"file://{mp4}")
    print(f"file://{html_path}")

    if theme_report["changedTheme"] == theme_report["initialTheme"]:
        raise SystemExit("theme change did not move away from the initial theme")
    if theme_report["relaunchedTheme"] != theme_report["changedTheme"]:
        raise SystemExit("theme did not persist across relaunch")
    if "[theme]" not in str(theme_report["persistedConfig"]) or "name = " not in str(theme_report["persistedConfig"]):
        raise SystemExit("persisted config did not contain a theme section")
    if expanded_debug.get("filesExpanded") is not True or collapsed_debug.get("filesExpanded") is not False:
        raise SystemExit("filesExpanded toggle did not round-trip")
    if diff_debug.get("viewMode") != "Diff":
        raise SystemExit("Ctrl+D did not enter diff mode")
    if not sidebar_report["expandedPreviewRowLine"]:
        raise SystemExit("expanded sidebar capture did not show diff preview rows metadata")

    shutil.rmtree(frames_dir)


if __name__ == "__main__":
    main()
