#!/usr/bin/env python3
"""tmux-backed parity checks for Rust TUI diff modal behavior.

This encodes the old Bun/OpenTUI JUZU diff-mode contract:
- Ctrl+D from log enters the diff pane, replacing the graph pane while keeping the details sidebar.
- Diff pane exposes old DiffView-style file cycling title controls.
- q/Esc/g/Ctrl+D return from diff mode to log without quitting the app.

Uses tmux capture-pane instead of raw PTY byte grepping, because Ratatui emits
cursor movement and partial redraws. tmux is the real review surface here.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

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


def wait_for(session: str, needle: str, timeout: float = 5.0) -> str:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        last = capture(session)
        if needle in last:
            return last
        time.sleep(0.1)
    return last


def pane_command(session: str) -> str:
    return tmux("display-message", "-p", "-t", session, "#{pane_current_command}").strip()


def send(session: str, *keys: str) -> None:
    tmux("send-keys", "-t", session, *keys)


def run_debug_state(args: argparse.Namespace, keys: str) -> dict[str, Any]:
    proc = run([
        "cargo", "run", "-q", "-p", "juzu-tui", "--",
        "--path", str(Path(args.repo).resolve()),
        "--limit", str(args.limit),
        "--mode", "mainline",
        "--debug-state",
        "--select-prefix", "nqmmukmt",
        "--keys", keys,
    ])
    return json.loads(proc.stdout)


def assert_contains(text: str, needle: str, label: str, failures: list[str]) -> None:
    if needle not in text:
        failures.append(f"{label}: expected screen to contain {needle!r}")


def assert_not_contains(text: str, needle: str, label: str, failures: list[str]) -> None:
    if needle in text:
        failures.append(f"{label}: expected screen not to contain {needle!r}")


def assert_details_split_matches_old(text: str, width: int, failures: list[str]) -> None:
    # Old JUZU keeps details/sidebar visible beside the diff pane with a 60/40 split.
    # Rust also leaves a two-column buffer before the sidebar so long diff titles do
    # not visually crash into the details pane.
    expected = int(width * 0.60)
    for line in text.splitlines():
        marker = "┌ details"
        if marker in line:
            column = line.index(marker)
            if not (expected - 4 <= column <= expected + 6):
                failures.append(
                    f"old diff pane/sidebar split at {width} cols: details pane should start near column {expected}, got {column}"
                )
            return
    failures.append(f"old diff pane/sidebar split at {width} cols: details pane border not found")


def assert_diff_title_contract(text: str, width: int, failures: list[str]) -> None:
    for line in text.splitlines():
        if "File " in line and "Ctrl+d back" in line:
            if "Ctrl+d back" not in line:
                failures.append(f"diff title at {width} cols: Ctrl+d back hint was truncated away")
            if "[ / ] next/prev" not in line:
                failures.append(f"diff title at {width} cols: file cycling hint was truncated away")
            details_col = line.find("┌ details")
            if details_col != -1:
                title_segment = line[:details_col]
                if not title_segment.endswith("  "):
                    failures.append(f"diff title at {width} cols: missing two-column buffer before sidebar")
            elif "┌ diff " not in text:
                failures.append(f"diff title at {width} cols: sidebar details border not visible on title row or paired with diff panel border")
            return
    failures.append(f"diff title at {width} cols: no File N/N title row found")


def assert_diff_status_bar_contract(text: str, width: int, failures: list[str]) -> None:
    top = "\n".join(text.splitlines()[:4])
    for needle in ["DIFF", "^d", "Log", "[ ]", "File", "j/k", "Move", "{/}", "Hunk", "Esc", "Exit"]:
        if needle not in top:
            failures.append(f"diff status bar at {width} cols: top status row missing {needle!r}")


def assert_footer_info_contract(text: str, width: int, failures: list[str]) -> None:
    bottom = "\n".join(text.splitlines()[-4:])
    for forbidden in ["^d", "[ ]", "j/k", "Esc"]:
        if forbidden in bottom:
            failures.append(f"footer info at {width} cols: bottom footer should not contain control hint {forbidden!r}")
    for needle in ["~/dev/juzu", "nodes"]:
        if needle not in bottom:
            failures.append(f"footer info at {width} cols: bottom footer missing {needle!r}")
    if "/home/shamanic/dev/juzu" in bottom:
        failures.append(f"footer info at {width} cols: bottom footer should compact HOME to '~'")


def assert_diff_panel_contract(text: str, width: int, failures: list[str]) -> None:
    if "┌ diff " not in text:
        failures.append(f"diff panel at {width} cols: missing bordered full diff panel title bar")
    if "│ File " not in text:
        failures.append(f"diff panel at {width} cols: title should live inside the diff panel surface")
    if "VIEWPORT" not in text:
        failures.append(f"diff panel at {width} cols: missing full-width viewport/status bar")
    if "SCROLL" not in text:
        failures.append(f"diff panel at {width} cols: missing visual scroll handle")
    if "◆" not in text:
        failures.append(f"diff panel at {width} cols: missing file header bar glyph")
    hunk_lines = [line for line in text.splitlines() if "@@" in line]
    if not hunk_lines:
        failures.append(f"diff panel at {width} cols: missing hunk header bar")
    elif not any("╮" in line for line in hunk_lines):
        failures.append(f"diff panel at {width} cols: hunk header bar should span to a right cap")


def assert_diff_code_band_contract(text: str, width: int, failures: list[str]) -> None:
    if "▌+" not in text:
        failures.append(f"diff code bands at {width} cols: added rows need a continuous left band marker")


def scroll_indicator_line(text: str) -> str:
    for line in text.splitlines():
        if "SCROLL" in line:
            return line
    return ""


def assert_scroll_indicator_changes(before: str, after: str, width: int, failures: list[str]) -> None:
    before_line = scroll_indicator_line(before)
    after_line = scroll_indicator_line(after)
    if not before_line or not after_line:
        failures.append(f"diff scroll handle at {width} cols: missing before/after indicator line")
    elif before_line == after_line:
        failures.append(f"diff scroll handle at {width} cols: indicator did not change after scrolling")


def assert_sticky_context_contract(text: str, width: int, failures: list[str]) -> None:
    if "STICKY" not in text:
        failures.append(f"sticky context at {width} cols: missing explicit sticky file/hunk bar")
    if "▸" not in text:
        failures.append(f"sticky context at {width} cols: missing file-to-hunk separator")


def assert_debug_state_contract(label: str, state: dict[str, Any], failures: list[str]) -> None:
    if state.get("viewMode") != "Log":
        failures.append(f"debug-state {label}: should end in Log mode")
    if state.get("selectedChange", "")[:8] != "nqmmukmt":
        failures.append(f"debug-state {label}: should preserve selected target commit")
    if state.get("diffScroll") != 0:
        failures.append(f"debug-state {label}: should reset diff scroll on exit")


def select_change_prefix(session: str, change_prefix: str, max_steps: int = 32) -> str:
    needle = f"Change: {change_prefix}"
    screen = capture(session)
    if needle in screen:
        return screen
    for _ in range(max_steps):
        send(session, "j")
        time.sleep(0.15)
        screen = capture(session)
        if needle in screen:
            return screen
    return screen


def run_width_case(args: argparse.Namespace, width: int) -> dict[str, Any]:
    session = f"juzu-modal-parity-{os.getpid()}-{width}"
    cmd = f"cd {ROOT} && ./target/release/juzu-tui --path {Path(args.repo).resolve()} --limit {args.limit} --mode mainline"
    tmux("new-session", "-d", "-s", session, "-x", str(width), "-y", "36")
    captures: dict[str, str] = {}
    failures: list[str] = []
    try:
        send(session, cmd, "Enter")
        initial = wait_for(session, "dag graph")
        captures["initial"] = initial
        assert_contains(initial, "dag graph", "initial log mode", failures)
        for needle in ["LOG", "^X", "Act", "^O", "Ops", "^L", "View", "^B", "Book"]:
            assert_contains(initial, needle, "initial old Bun leader strip", failures)

        selected = select_change_prefix(session, "nqmmukmt")
        captures["afterSelectChange"] = selected
        assert_contains(selected, "Files", "selected non-empty change details", failures)

        send(session, "C-d")
        diff = wait_for(session, "Ctrl+d back")
        captures["afterCtrlD"] = diff
        assert_contains(diff, "File ", "diff mode title", failures)
        assert_contains(diff, "Ctrl+d back", "diff mode title", failures)
        assert_contains(diff, "[ / ] next/prev", "diff file cycling hint", failures)
        assert_contains(diff, "^d", "old diff status hint shows ctrl-d log shortcut", failures)
        assert_contains(diff, "Log", "old diff status hint labels ctrl-d as Log", failures)
        assert_contains(diff, "[ ]", "old diff status hint shows file cycling keys", failures)
        assert_contains(diff, "j/k", "old diff status hint shows movement keys", failures)
        assert_contains(diff, "Move", "old diff status hint labels j/k as Move", failures)
        assert_contains(diff, "Esc", "old diff status hint shows exit key", failures)
        assert_contains(diff, "Exit", "old diff status hint labels escape as Exit", failures)
        assert_not_contains(diff, "dag graph", "diff replaces graph pane", failures)
        assert_contains(diff, "details", "diff mode keeps sidebar", failures)
        assert_contains(diff, "Current file preview", "diff mode sidebar labels preview as current-file context", failures)
        assert_details_split_matches_old(diff, width, failures)
        assert_diff_title_contract(diff, width, failures)
        assert_diff_status_bar_contract(diff, width, failures)
        assert_footer_info_contract(diff, width, failures)
        assert_diff_panel_contract(diff, width, failures)
        assert_diff_code_band_contract(diff, width, failures)
        assert_contains(diff, "Change: nqmmukmt", "diff mode keeps selected commit", failures)
        assert_not_contains(diff, "preview capped", "full diff pane should not show sidebar preview cap rows", failures)
        assert_contains(diff, "~/dev/juzu", "after Ctrl+D keeps compact footer repo context", failures)

        send(session, "j")
        diff_scroll_down = wait_for(session, "diff rows 2-")
        captures["afterDiffJ"] = diff_scroll_down
        assert_contains(diff_scroll_down, "diff rows 2-", "j scrolls diff rows in diff mode", failures)
        assert_contains(diff_scroll_down, "Change: nqmmukmt", "j in diff mode does not move DAG selection", failures)
        assert_scroll_indicator_changes(diff, diff_scroll_down, width, failures)
        assert_sticky_context_contract(diff_scroll_down, width, failures)

        send(session, "k")
        diff_scroll_up = wait_for(session, "diff rows 1-")
        captures["afterDiffK"] = diff_scroll_up
        assert_contains(diff_scroll_up, "diff rows 1-", "k scrolls diff rows up in diff mode", failures)
        assert_contains(diff_scroll_up, "Change: nqmmukmt", "k in diff mode does not move DAG selection", failures)

        send(session, "]")
        diff_next_file = wait_for(session, "File 2/")
        captures["afterDiffNextFile"] = diff_next_file
        assert_contains(diff_next_file, "File 2/", "] cycles to next diff file in diff mode", failures)
        assert_contains(diff_next_file, "diff rows 1-", "File 2 renders diff rows", failures)
        assert_not_contains(diff_next_file, "diff rows 1-0 of 0", "File 2 is not an empty rendered diff", failures)
        assert_contains(diff_next_file, "Change: nqmmukmt", "] in diff mode does not move DAG selection", failures)
        assert_contains(diff_next_file, "▶", "diff mode sidebar visibly marks selected diff file", failures)
        assert_contains(diff_next_file, "Current file preview", "diff mode sidebar remains scoped to current file after file cycling", failures)

        send(session, "[")
        diff_prev_file = wait_for(session, "File 1/")
        captures["afterDiffPrevFile"] = diff_prev_file
        assert_contains(diff_prev_file, "File 1/", "[ cycles to previous diff file in diff mode", failures)
        assert_contains(diff_prev_file, "Change: nqmmukmt", "[ in diff mode does not move DAG selection", failures)

        send(session, "[")
        diff_last_file = wait_for(session, "File 16/")
        captures["afterDiffLastFile"] = diff_last_file
        assert_contains(diff_last_file, "File 16/", "[ from first file wraps to last diff file", failures)
        assert_contains(diff_last_file, "diff rows 1-", "Last file renders diff rows", failures)
        assert_not_contains(diff_last_file, "File 16/16: Diff", "Last file title is not generic/missing rows", failures)
        assert_not_contains(diff_last_file, "diff rows 0/0", "Last file is not an empty rendered diff", failures)
        assert_not_contains(diff_last_file, "preview capped", "wrapped full diff pane should not show sidebar preview cap rows", failures)
        assert_contains(diff_last_file, "Change: nqmmukmt", "last file navigation does not move DAG selection", failures)
        assert_contains(diff_last_file, "▶", "wrapped last diff file remains visibly selected in sidebar", failures)
        assert_not_contains(diff_last_file, "pinned Added bench/results/rust-port/diff-render", "wrapped full diff sidebar preview should not stay pinned to first file", failures)

        send(session, "]")
        diff_back_first_file = wait_for(session, "File 1/")
        captures["afterDiffLastToFirstFile"] = diff_back_first_file
        assert_contains(diff_back_first_file, "File 1/", "] from last file wraps back to first diff file", failures)

        send(session, "q")
        back = wait_for(session, "dag graph")
        captures["afterDiffQ"] = back
        assert_contains(back, "dag graph", "q returns to log", failures)
        assert_contains(back, "cap rust tui structured diff preview rows", "q returns with same selected commit", failures)
        assert_contains(back, "~/dev/juzu", "after q keeps compact footer repo context", failures)

        send(session, "PageDown")
        sidebar_scroll_down = wait_for(session, "diff rows 11-")
        captures["afterLogDiffPageDown"] = sidebar_scroll_down
        assert_contains(sidebar_scroll_down, "diff rows 11-", "PageDown scrolls sidebar diff preview in log mode", failures)
        assert_contains(sidebar_scroll_down, "cap rust tui structured diff preview rows", "PageDown diff scroll does not move DAG selection", failures)

        send(session, "PageUp")
        sidebar_scroll_up = wait_for(session, "diff rows 1-")
        captures["afterLogDiffPageUp"] = sidebar_scroll_up
        assert_contains(sidebar_scroll_up, "diff rows 1-", "PageUp scrolls sidebar diff preview in log mode", failures)
        assert_contains(sidebar_scroll_up, "cap rust tui structured diff preview rows", "PageUp diff scroll does not move DAG selection", failures)

        send(session, "C-d")
        diff_again = wait_for(session, "Ctrl+d back")
        captures["afterSecondCtrlD"] = diff_again
        assert_contains(diff_again, "File ", "second diff entry", failures)
        send(session, "C-d")
        back_ctrl = wait_for(session, "dag graph")
        captures["afterDiffCtrlD"] = back_ctrl
        assert_contains(back_ctrl, "dag graph", "Ctrl+D returns to log", failures)
        assert_contains(back_ctrl, "~/dev/juzu", "after Ctrl+D keeps compact footer repo context", failures)

        send(session, "C-d")
        diff_before_esc = wait_for(session, "Ctrl+d back")
        captures["afterThirdCtrlD"] = diff_before_esc
        send(session, "Escape")
        back_esc = wait_for(session, "dag graph")
        captures["afterDiffEsc"] = back_esc
        assert_contains(back_esc, "dag graph", "Esc returns to log", failures)
        assert_contains(back_esc, "cap rust tui structured diff preview rows", "Esc returns with same selected commit", failures)
        assert_contains(back_esc, "~/dev/juzu", "after Esc keeps compact footer repo context", failures)

        send(session, "C-d")
        diff_before_g = wait_for(session, "Ctrl+d back")
        captures["afterFourthCtrlD"] = diff_before_g
        send(session, "g")
        back_g = wait_for(session, "dag graph")
        captures["afterDiffG"] = back_g
        assert_contains(back_g, "dag graph", "g returns to log", failures)
        assert_contains(back_g, "cap rust tui structured diff preview rows", "g returns with same selected commit", failures)
        assert_contains(back_g, "~/dev/juzu", "after g keeps compact footer repo context", failures)
    finally:
        tmux("kill-session", "-t", session, check=False)
    return {
        "width": width,
        "session": session,
        "command": cmd,
        "passed": not failures,
        "failures": failures,
        "captures": captures,
    }


def run_case(args: argparse.Namespace) -> dict[str, Any]:
    subprocess.run(["cargo", "build", "--release", "-p", "juzu-tui"], cwd=ROOT, check=True)
    debug_states: dict[str, Any] = {}
    failures: list[str] = []
    scenarios = {
        "viewLeaderStaysLog": "C-l",
        "viewLeaderQReturnsLog": "C-l,q",
        "enterScrollFileExit": "C-d,j,],Esc",
        "quitReturnsLog": "C-d,q",
        "gReturnsLog": "C-d,g",
        "ctrlDTogglesLog": "C-d,C-d",
        "doubleNextFileEsc": "C-d,],],Esc",
        "pageScrollResetEsc": "C-d,PageDown,PageUp,Esc",
        "nextHunkStaysDiff": "C-d,}",
        "nextThenPrevHunkStaysDiff": "C-d,},PageDown,{",
    }
    try:
        exit_scenarios = {
            "enterScrollFileExit",
            "quitReturnsLog",
            "gReturnsLog",
            "ctrlDTogglesLog",
            "doubleNextFileEsc",
            "pageScrollResetEsc",
        }
        for label, keys in scenarios.items():
            state = run_debug_state(args, keys)
            debug_states[label] = state
            if label in exit_scenarios:
                assert_debug_state_contract(keys, state, failures)
        if debug_states["viewLeaderStaysLog"].get("viewMode") != "Log":
            failures.append("debug-state C-l should stay in Log view")
        if debug_states["viewLeaderStaysLog"].get("activeLeaderMode") != "View":
            failures.append("debug-state C-l should enter View leader mode")
        if debug_states["viewLeaderQReturnsLog"].get("viewMode") != "Log":
            failures.append("debug-state C-l,q should stay in Log view")
        if debug_states["viewLeaderQReturnsLog"].get("activeLeaderMode") is not None:
            failures.append("debug-state C-l,q should exit View leader mode")
        if debug_states["enterScrollFileExit"].get("diffFileIndex") != 1:
            failures.append("debug-state C-d,j,],Esc should cycle to file index 1 before exit")
        if debug_states["doubleNextFileEsc"].get("diffFileIndex") != 2:
            failures.append("debug-state C-d,],],Esc should cycle to file index 2 before exit")
        next_hunk = debug_states["nextHunkStaysDiff"]
        if next_hunk.get("viewMode") != "Diff":
            failures.append("debug-state C-d,} should stay in Diff mode")
        if next_hunk.get("currentDiffRowKind") != "HunkHeader":
            failures.append("debug-state C-d,} should land exactly on a hunk header row")
        if "@@" not in next_hunk.get("stickyContext", ""):
            failures.append("debug-state C-d,} should update sticky context to the target hunk")
        previous_hunk = debug_states["nextThenPrevHunkStaysDiff"]
        if previous_hunk.get("viewMode") != "Diff":
            failures.append("debug-state C-d,},PageDown,{ should stay in Diff mode")
        if previous_hunk.get("currentDiffRowKind") != "HunkHeader":
            failures.append("debug-state C-d,},PageDown,{ should land exactly on a hunk header row")
        if "@@" not in previous_hunk.get("stickyContext", ""):
            failures.append("debug-state C-d,},PageDown,{ should expose hunk sticky context")
    except Exception as exc:
        failures.append(f"debug-state emitter failed: {exc}")

    width_reports = [run_width_case(args, width) for width in args.widths]
    for width_report in width_reports:
        failures.extend(width_report["failures"])

    return {
        "passed": not failures,
        "failures": failures,
        "widths": args.widths,
        "widthReports": width_reports,
        "debugStates": debug_states,
    }


def render_html_report(report: dict[str, Any]) -> str:
    def sample_capture(width_report: dict[str, Any]) -> str:
        captures = width_report.get("captures", {})
        return captures.get("afterCtrlD") or next(iter(captures.values()), "")

    cards = []
    for width_report in report.get("widthReports", []):
        width = width_report["width"]
        status = "PASS" if width_report["passed"] else "FAIL"
        failures = "".join(f"<li>{html.escape(f)}</li>" for f in width_report.get("failures", [])) or "<li>none</li>"
        cards.append(f"""
<section class='card'>
  <h2>{width} cols · {status}</h2>
  <ul>{failures}</ul>
  <pre>{html.escape(sample_capture(width_report))}</pre>
</section>""")
    debug_rows = []
    for label, state in report.get("debugStates", {}).items():
        debug_rows.append(
            f"<tr><td>{html.escape(label)}</td><td>{html.escape(state.get('viewMode', ''))}</td><td>{html.escape(str(state.get('diffFileIndex', '')))}</td><td>{html.escape(str(state.get('diffScroll', '')))}</td><td><code>{html.escape(state.get('selectedChange', '')[:12])}</code></td></tr>"
        )
    failures = "".join(f"<li>{html.escape(f)}</li>" for f in report.get("failures", [])) or "<li>none</li>"
    return f"""<!doctype html>
<html><head><meta charset='utf-8'><title>JUZU Rust TUI modal parity</title>
<style>
:root {{ color-scheme: dark; --bg:#07111f; --panel:#0f172a; --line:#334155; --text:#dbeafe; --muted:#94a3b8; --cyan:#67e8f9; --green:#86efac; --red:#fca5a5; }}
body {{ margin:32px; background:radial-gradient(circle at top left,#12233f 0,#07111f 45rem); color:var(--text); font-family:Inter,system-ui,sans-serif; }}
h1 {{ margin:0 0 8px; }} .meta {{ color:var(--muted); margin-bottom:20px; }} .grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(360px,1fr)); gap:16px; }}
.card {{ border:1px solid var(--line); background:rgba(15,23,42,.94); border-radius:16px; padding:16px; box-shadow:0 18px 60px rgba(0,0,0,.25); }}
h2 {{ color:var(--cyan); font-size:16px; margin:0 0 12px; }} pre {{ background:#020617; border:1px solid #1e293b; border-radius:12px; padding:12px; overflow:auto; font:12px/1.35 'JetBrains Mono',ui-monospace,monospace; }}
table {{ width:100%; border-collapse:collapse; margin-bottom:16px; }} td, th {{ border-bottom:1px solid #1e293b; padding:8px; text-align:left; }} th {{ color:var(--cyan); }} .pass {{ color:var(--green); }} .fail {{ color:var(--red); }}
</style></head><body>
<h1>JUZU Rust TUI modal parity</h1>
<div class='meta'>Width variants, footer/title/sidebar contract, and debug-state exit scenarios.</div>
<section class='card'><h2>Overall: <span class='{ 'pass' if report.get('passed') else 'fail' }'>{'PASS' if report.get('passed') else 'FAIL'}</span></h2><ul>{failures}</ul></section>
<section class='card'><h2>Debug-state scenarios</h2><table><thead><tr><th>Scenario</th><th>Mode</th><th>File</th><th>Scroll</th><th>Selected</th></tr></thead><tbody>{''.join(debug_rows)}</tbody></table></section>
<div class='grid'>{''.join(cards)}</div>
</body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--widths", default="120,160,206")
    parser.add_argument("--write-report")
    args = parser.parse_args()
    args.widths = [int(raw.strip()) for raw in args.widths.split(",") if raw.strip()]
    report = run_case(args)
    printable = {k: v for k, v in report.items() if k != "widthReports"}
    printable["widthReports"] = [
        {k: v for k, v in width_report.items() if k != "captures"}
        for width_report in report["widthReports"]
    ]
    print(json.dumps(printable, indent=2))
    if args.write_report:
        report_path = Path(args.write_report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        html_path = report_path.with_suffix(".html")
        html_path.write_text(render_html_report(report))
        print(f"file://{html_path}")
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
