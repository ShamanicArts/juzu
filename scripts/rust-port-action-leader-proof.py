#!/usr/bin/env python3
"""Generate mutation-safe Action leader proof artifacts for the Rust TUI."""

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


def wait_for_screen(session: str, predicate, timeout: float = 5.0) -> str:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        last = capture(session)
        if predicate(last):
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
    jj(repo, "new", "@")
    (repo / "note.txt").write_text("two\n")
    jj(repo, "describe", "-m", "second desc")


def create_squash_fixture_repo(repo: Path) -> None:
    create_fixture_repo(repo)
    jj(repo, "new", "@")
    (repo / "note.txt").write_text("three\n")
    jj(repo, "describe", "-m", "third desc")


def create_rebase_fixture_repo(repo: Path) -> None:
    repo.mkdir(parents=True, exist_ok=True)
    jj(repo, "git", "init", ".")
    (repo / "a.txt").write_text("one\n")
    jj(repo, "describe", "-m", "first desc")
    jj(repo, "new", "@")
    (repo / "b.txt").write_text("two\n")
    jj(repo, "describe", "-m", "second desc")
    jj(repo, "new", "@")
    (repo / "c.txt").write_text("three\n")
    jj(repo, "describe", "-m", "third desc")


def current_change_id(repo: Path) -> str:
    return jj(repo, "log", "--no-graph", "-r", "@", "-T", "change_id.short()").strip()


def current_parent_id(repo: Path) -> str:
    return jj(repo, "log", "--no-graph", "-r", "@-", "-T", "change_id.short()").strip()


def current_grandparent_id(repo: Path) -> str:
    return jj(repo, "log", "--no-graph", "-r", "@--", "-T", "change_id.short()").strip()


def current_description(repo: Path) -> str:
    return jj(repo, "log", "--no-graph", "-r", "@", "-T", "description.first_line()").strip()


def total_count(repo: Path) -> int:
    return int(jj(repo, "log", "-r", "::", "--count").strip())


def description_count(repo: Path, title: str) -> int:
    raw = jj(repo, "log", "--no-graph", "-r", "::", "-T", 'description.first_line() ++ "\\n"')
    return sum(1 for line in raw.splitlines() if line.strip() == title)


def select_change(session: str, change_prefix: str, max_steps: int = 20) -> str:
    needle = f"Change: {change_prefix}"
    screen = capture(session)
    if needle in screen:
        return screen
    for _ in range(max_steps):
        send(session, "j")
        screen = wait_for_screen(session, lambda text: needle in text, timeout=0.5)
        if needle in screen:
            return screen
    return screen


def run_sequence_new(repo: Path, width: int, height: int, session_suffix: str) -> dict[str, object]:
    session = f"juzu-action-new-{session_suffix}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit 20 --mode mainline"
    captures: list[tuple[str, str]] = []
    before_count = total_count(repo)
    parent_before = current_change_id(repo)
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height))
    try:
        send(session, cmd, "Enter")
        captures.append(("01 log before Ctrl+A new", wait_for(session, "LOG")))
        send(session, "C-a")
        captures.append(("02 Ctrl+A enters Actions leader", wait_for(session, "ACT")))
        send(session, "n")
        wait_for_screen(session, lambda text: "LOG" in text and "ACT" not in text)
        time.sleep(0.3)
        captures.append(("03 log after new mutation", capture(session)))
    finally:
        tmux("kill-session", "-t", session, check=False)
    return {
        "beforeCount": before_count,
        "afterCount": total_count(repo),
        "parentBefore": parent_before,
        "parentAfter": current_parent_id(repo),
        "captures": captures,
    }


def run_sequence_edit(repo: Path, width: int, height: int, session_suffix: str) -> dict[str, object]:
    session = f"juzu-action-edit-{session_suffix}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit 20 --mode mainline"
    captures: list[tuple[str, str]] = []
    target_change = current_parent_id(repo)
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height))
    try:
        send(session, cmd, "Enter")
        captures.append(("04 log before edit target selection", wait_for(session, "LOG")))
        selected = select_change(session, target_change[:8])
        captures.append(("05 selected earlier change for edit", selected))
        send(session, "C-a")
        captures.append(("06 Ctrl+A enters Actions leader for edit", wait_for(session, "ACT")))
        send(session, "e")
        wait_for_screen(session, lambda text: "LOG" in text and "ACT" not in text)
        time.sleep(0.3)
        captures.append(("07 log after edit mutation", capture(session)))
    finally:
        tmux("kill-session", "-t", session, check=False)
    return {
        "targetChange": target_change,
        "afterCurrentChange": current_change_id(repo),
        "afterDescription": current_description(repo),
        "captures": captures,
    }


def run_sequence_describe(repo: Path, width: int, height: int, session_suffix: str) -> dict[str, object]:
    session = f"juzu-action-describe-{session_suffix}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit 20 --mode mainline"
    captures: list[tuple[str, str]] = []
    before_title = current_description(repo)
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height))
    try:
        send(session, cmd, "Enter")
        captures.append(("08 log before describe mutation", wait_for(session, "LOG")))
        send(session, "C-a")
        captures.append(("09 Ctrl+A enters Actions leader for describe", wait_for(session, "ACT")))
        send(session, "d")
        captures.append(("10 describe prompt opens", wait_for(session, "DESCRIBE")))
        for _ in range(len(before_title)):
            send(session, "BSpace")
        send(session, "r", "e", "t", "i", "t", "l", "e", "d", "Space", "f", "r", "o", "m", "Space", "p", "r", "o", "o", "f")
        captures.append(("11 describe prompt after typing new title", wait_for_screen(session, lambda text: "retitled from proof" in text, timeout=2.0)))
        send(session, "Enter")
        wait_for_screen(session, lambda text: "LOG" in text and "DESCRIBE" not in text)
        time.sleep(0.3)
        captures.append(("12 log after describe mutation", capture(session)))
    finally:
        tmux("kill-session", "-t", session, check=False)
    return {
        "beforeTitle": before_title,
        "afterTitle": current_description(repo),
        "captures": captures,
    }


def run_sequence_duplicate(repo: Path, width: int, height: int, session_suffix: str) -> dict[str, object]:
    session = f"juzu-action-duplicate-{session_suffix}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit 20 --mode mainline"
    captures: list[tuple[str, str]] = []
    before_count = total_count(repo)
    title = current_description(repo)
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height))
    try:
        send(session, cmd, "Enter")
        captures.append(("13 log before duplicate mutation", wait_for(session, "LOG")))
        send(session, "C-a")
        captures.append(("14 Ctrl+A enters Actions leader for duplicate", wait_for(session, "ACT")))
        send(session, "y")
        wait_for_screen(session, lambda text: "LOG" in text and "ACT" not in text)
        time.sleep(0.3)
        captures.append(("15 log after duplicate mutation", capture(session)))
    finally:
        tmux("kill-session", "-t", session, check=False)
    return {
        "title": title,
        "beforeCount": before_count,
        "afterCount": total_count(repo),
        "matchingTitleCount": description_count(repo, title),
        "captures": captures,
    }


def run_sequence_abandon(repo: Path, width: int, height: int, session_suffix: str) -> dict[str, object]:
    session = f"juzu-action-abandon-{session_suffix}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit 20 --mode mainline"
    captures: list[tuple[str, str]] = []
    before_count = total_count(repo)
    target_change = current_change_id(repo)
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height))
    try:
        send(session, cmd, "Enter")
        captures.append(("16 log before abandon mutation", wait_for(session, "LOG")))
        send(session, "C-a")
        captures.append(("17 Ctrl+A enters Actions leader for abandon", wait_for(session, "ACT")))
        send(session, "a")
        wait_for_screen(session, lambda text: "LOG" in text and "ACT" not in text)
        time.sleep(0.3)
        captures.append(("18 log after abandon mutation", capture(session)))
    finally:
        tmux("kill-session", "-t", session, check=False)
    return {
        "targetChange": target_change,
        "beforeCount": before_count,
        "afterCount": total_count(repo),
        "afterCurrentChange": current_change_id(repo),
        "afterDescription": current_description(repo),
        "captures": captures,
    }


def run_sequence_squash(repo: Path, width: int, height: int, session_suffix: str) -> dict[str, object]:
    session = f"juzu-action-squash-{session_suffix}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit 20 --mode mainline"
    captures: list[tuple[str, str]] = []
    before_count = total_count(repo)
    target_change = current_parent_id(repo)
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height))
    try:
        send(session, cmd, "Enter")
        captures.append(("19 log before squash target selection", wait_for(session, "LOG")))
        selected = select_change(session, target_change[:8])
        captures.append(("20 selected earlier change for squash", selected))
        send(session, "C-a")
        captures.append(("21 Ctrl+A enters Actions leader for squash", wait_for(session, "ACT")))
        send(session, "s")
        wait_for_screen(session, lambda text: "LOG" in text and "ACT" not in text)
        time.sleep(0.3)
        captures.append(("22 log after squash mutation", capture(session)))
    finally:
        tmux("kill-session", "-t", session, check=False)
    return {
        "targetChange": target_change,
        "beforeCount": before_count,
        "afterCount": total_count(repo),
        "afterCurrentChange": current_change_id(repo),
        "afterDescription": current_description(repo),
        "captures": captures,
    }


def run_sequence_rebase(repo: Path, width: int, height: int, session_suffix: str) -> dict[str, object]:
    session = f"juzu-action-rebase-{session_suffix}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {repo} --limit 20 --mode mainline"
    captures: list[tuple[str, str]] = []
    source_change = current_change_id(repo)
    before_parent = current_parent_id(repo)
    destination_change = current_grandparent_id(repo)
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", str(height))
    try:
        send(session, cmd, "Enter")
        captures.append(("23 log before rebase mutation", wait_for(session, "LOG")))
        send(session, "C-a")
        captures.append(("24 Ctrl+A enters Actions leader for rebase", wait_for(session, "ACT")))
        send(session, "b")
        captures.append(("25 rebase mode opens with selected source", wait_for(session, "REBASE")))
        send(session, "j")
        send(session, "j")
        selected = wait_for_screen(
            session,
            lambda text: "REBASE" in text and "Destination:" in text and "first desc" in text,
            timeout=2.0,
        )
        captures.append(("26 selected destination for rebase", selected))
        send(session, "Enter")
        wait_for_screen(session, lambda text: "LOG" in text and "REBASE" not in text)
        time.sleep(0.3)
        captures.append(("27 log after rebase mutation", capture(session)))
    finally:
        tmux("kill-session", "-t", session, check=False)
    return {
        "sourceChange": source_change,
        "beforeParent": before_parent,
        "destinationChange": destination_change,
        "afterCurrentChange": current_change_id(repo),
        "afterParent": current_parent_id(repo),
        "afterDescription": current_description(repo),
        "captures": captures,
    }


def render_html(report: dict[str, object], mp4: Path) -> str:
    cards: list[str] = []
    for section_name in ["new", "edit", "describe", "duplicate", "abandon", "squash", "rebase"]:
        section = report[section_name]
        cards.extend(
            f"<section><h2>{html.escape(title)}</h2><pre>{html.escape(screen)}</pre></section>"
            for title, screen in section["captures"]
        )

    return f"""<!doctype html><html><head><meta charset='utf-8'><title>JUZU Rust Action leader proof</title>
<style>
:root {{ color-scheme: dark; --bg:#111318; --panel:#1a2029; --line:#2a3442; --text:#d8dee8; --muted:#8a95a7; --info:#7f9fbf; --ok:#74b88c; }}
body {{ margin:32px; background:radial-gradient(circle at top left,#1d2530 0,#111318 44rem); color:var(--text); font-family:Inter,system-ui,sans-serif; }}
a {{ color:var(--info); }} code {{ color:#bfdbfe; }}
section {{ background:rgba(26,32,41,.96); border:1px solid var(--line); border-radius:16px; padding:18px; margin:18px 0; box-shadow:0 18px 60px rgba(0,0,0,.26); }}
pre {{ background:#050816; border:1px solid #2a3442; border-radius:12px; padding:14px; overflow:auto; font:12px/1.35 'JetBrains Mono',ui-monospace,monospace; color:#d8dee8; }}
strong {{ color:var(--ok); }}
</style></head><body>
<h1>JUZU Rust Action leader proof</h1>
<p>MP4: <a href='file://{mp4}'>{html.escape(str(mp4))}</a></p>
<section>
  <h2>New</h2>
  <p>Count <strong>{report['new']['beforeCount']}</strong> → <strong>{report['new']['afterCount']}</strong></p>
  <p>New current parent: <code>{html.escape(report['new']['parentBefore'])}</code> → <code>{html.escape(report['new']['parentAfter'])}</code></p>
</section>
<section>
  <h2>Edit</h2>
  <p>Target change: <code>{html.escape(report['edit']['targetChange'])}</code></p>
  <p>Current change after edit: <code>{html.escape(report['edit']['afterCurrentChange'])}</code></p>
  <p>Description after edit: <strong>{html.escape(report['edit']['afterDescription'])}</strong></p>
</section>
<section>
  <h2>Describe</h2>
  <p>Title <code>{html.escape(report['describe']['beforeTitle'])}</code> → <strong>{html.escape(report['describe']['afterTitle'])}</strong></p>
</section>
<section>
  <h2>Duplicate</h2>
  <p>Count <strong>{report['duplicate']['beforeCount']}</strong> → <strong>{report['duplicate']['afterCount']}</strong></p>
  <p>Title <code>{html.escape(report['duplicate']['title'])}</code> now appears <strong>{report['duplicate']['matchingTitleCount']}</strong> times</p>
</section>
<section>
  <h2>Abandon</h2>
  <p>Count <strong>{report['abandon']['beforeCount']}</strong> → <strong>{report['abandon']['afterCount']}</strong></p>
  <p>Selected change <code>{html.escape(report['abandon']['targetChange'])}</code> became current <code>{html.escape(report['abandon']['afterCurrentChange'])}</code></p>
  <p>Current description after abandon: <strong>{html.escape(report['abandon']['afterDescription']) or '(empty)'}</strong></p>
</section>
<section>
  <h2>Squash</h2>
  <p>Count <strong>{report['squash']['beforeCount']}</strong> → <strong>{report['squash']['afterCount']}</strong></p>
  <p>Squashed change <code>{html.escape(report['squash']['targetChange'])}</code>; current change is now <code>{html.escape(report['squash']['afterCurrentChange'])}</code></p>
  <p>Current description after squash: <strong>{html.escape(report['squash']['afterDescription'])}</strong></p>
</section>
<section>
  <h2>Rebase</h2>
  <p>Rebased source <code>{html.escape(report['rebase']['sourceChange'])}</code> from parent <code>{html.escape(report['rebase']['beforeParent'])}</code> onto <code>{html.escape(report['rebase']['destinationChange'])}</code></p>
  <p>Current change after rebase: <code>{html.escape(report['rebase']['afterCurrentChange'])}</code></p>
  <p>Parent after rebase: <strong>{html.escape(report['rebase']['afterParent'])}</strong></p>
  <p>Current description after rebase: <strong>{html.escape(report['rebase']['afterDescription'])}</strong></p>
</section>
{''.join(cards)}
</body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, default=160)
    parser.add_argument("--height", type=int, default=36)
    parser.add_argument("--output-root", default="bench/results/rust-port/action-leader")
    args = parser.parse_args()

    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00:00", "Z")
    out_dir = ROOT / args.output_root / stamp
    frames_dir = out_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    report: dict[str, object] = {}
    new_repo = out_dir / "new-fixture-repo"
    create_fixture_repo(new_repo)
    report["new"] = run_sequence_new(new_repo, args.width, args.height, f"{os.getpid()}-new")

    edit_repo = out_dir / "edit-fixture-repo"
    create_fixture_repo(edit_repo)
    report["edit"] = run_sequence_edit(edit_repo, args.width, args.height, f"{os.getpid()}-edit")

    duplicate_repo = out_dir / "duplicate-fixture-repo"
    create_fixture_repo(duplicate_repo)
    describe_repo = out_dir / "describe-fixture-repo"
    create_fixture_repo(describe_repo)
    report["describe"] = run_sequence_describe(describe_repo, args.width, args.height, f"{os.getpid()}-describe")

    report["duplicate"] = run_sequence_duplicate(duplicate_repo, args.width, args.height, f"{os.getpid()}-dup")

    abandon_repo = out_dir / "abandon-fixture-repo"
    create_fixture_repo(abandon_repo)
    report["abandon"] = run_sequence_abandon(abandon_repo, args.width, args.height, f"{os.getpid()}-abandon")

    squash_repo = out_dir / "squash-fixture-repo"
    create_squash_fixture_repo(squash_repo)
    report["squash"] = run_sequence_squash(squash_repo, args.width, args.height, f"{os.getpid()}-squash")

    rebase_repo = out_dir / "rebase-fixture-repo"
    create_rebase_fixture_repo(rebase_repo)
    report["rebase"] = run_sequence_rebase(rebase_repo, args.width, args.height, f"{os.getpid()}-rebase")

    all_captures = [
        *report["new"]["captures"],
        *report["edit"]["captures"],
        *report["describe"]["captures"],
        *report["duplicate"]["captures"],
        *report["abandon"]["captures"],
        *report["squash"]["captures"],
        *report["rebase"]["captures"],
    ]
    for idx, (title, screen) in enumerate(all_captures):
        render_frame(screen, title, frames_dir / f"frame-{idx:03d}.png")

    mp4 = out_dir / "action-leader-sequence-proof.mp4"
    run([
        "ffmpeg", "-y", "-framerate", "1", "-i", str(frames_dir / "frame-%03d.png"),
        "-vf", "fps=30,format=yuv420p", "-movflags", "+faststart", str(mp4)
    ])

    json_path = out_dir / "action-leader-report.json"
    json_path.write_text(json.dumps(report, indent=2) + "\n")
    html_path = out_dir / "action-leader-review.html"
    html_path.write_text(render_html(report, mp4))
    print(f"file://{mp4}")
    print(f"file://{html_path}")

    if report["new"]["afterCount"] != report["new"]["beforeCount"] + 1:
        raise SystemExit("new mutation did not increase the visible commit count")
    if report["new"]["parentAfter"] != report["new"]["parentBefore"]:
        raise SystemExit("new mutation did not parent the working copy under the selected change")
    if report["edit"]["afterCurrentChange"] != report["edit"]["targetChange"]:
        raise SystemExit("edit mutation did not move the working copy to the selected change")
    if report["edit"]["afterDescription"] != "first desc":
        raise SystemExit("edit mutation did not expose the selected change description")
    if report["describe"]["afterTitle"] != "retitled from proof":
        raise SystemExit("describe mutation did not update the selected change title")
    if report["duplicate"]["afterCount"] != report["duplicate"]["beforeCount"] + 1:
        raise SystemExit("duplicate mutation did not increase the visible commit count")
    if report["duplicate"]["matchingTitleCount"] < 2:
        raise SystemExit("duplicate mutation did not create a second visible copy of the selected change")
    if report["abandon"]["afterCount"] != report["abandon"]["beforeCount"]:
        raise SystemExit("abandon mutation unexpectedly changed visible commit count")
    if report["abandon"]["afterCurrentChange"] == report["abandon"]["targetChange"]:
        raise SystemExit("abandon mutation did not replace the selected working copy change")
    if report["abandon"]["afterDescription"] != "":
        raise SystemExit("abandon mutation did not leave an empty working copy description")
    if report["squash"]["afterCount"] != report["squash"]["beforeCount"] - 1:
        raise SystemExit("squash mutation did not collapse the selected non-working-copy change")
    if report["squash"]["afterDescription"] != "third desc":
        raise SystemExit("squash mutation unexpectedly changed the current working copy description")
    if report["rebase"]["afterCurrentChange"] != report["rebase"]["sourceChange"]:
        raise SystemExit("rebase mutation moved the working copy off the selected source change")
    if report["rebase"]["afterParent"] != report["rebase"]["destinationChange"]:
        raise SystemExit("rebase mutation did not move the selected source onto the chosen destination")
    if report["rebase"]["afterDescription"] != "third desc":
        raise SystemExit("rebase mutation unexpectedly changed the rebased working copy description")


if __name__ == "__main__":
    main()
