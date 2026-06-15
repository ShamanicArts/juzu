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
import re
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
        "--select-prefix", "uyompyrw",
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
        marker = "Change:"
        if marker in line:
            column = line.index(marker)
            if not (expected - 4 <= column <= expected + 6):
                failures.append(
                    f"old diff pane/sidebar split at {width} cols: details pane should start near column {expected}, got {column}"
                )
            return
    failures.append(f"old diff pane/sidebar split at {width} cols: details pane Change metadata not found")


def assert_diff_title_contract(text: str, width: int, failures: list[str]) -> None:
    for line in text.splitlines():
        if "File " in line and "Ctrl+d back" in line:
            if "Ctrl+d back" not in line:
                failures.append(f"diff title at {width} cols: Ctrl+d back hint was truncated away")
            if "[ / ] next/prev" not in line:
                failures.append(f"diff title at {width} cols: file cycling hint was truncated away")
            details_col = line.find("Change:")
            if details_col != -1:
                title_segment = line[:details_col]
                if not title_segment.endswith("  "):
                    failures.append(f"diff title at {width} cols: missing two-column buffer before sidebar")
            elif "__never_old_box__" in text:
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


def assert_sidebar_details_rhythm_contract(text: str, width: int, failures: list[str]) -> None:
    if any(line.strip() == "Selected" for line in text.splitlines()):
        failures.append(f"sidebar rhythm at {width} cols: old Bun details pane does not render a redundant standalone 'Selected' content heading")
    if "Change:" not in text:
        failures.append(f"sidebar rhythm at {width} cols: details pane should start with Change metadata")
    if "Bookmarks\n—" in text or "Bookmarks\r\n—" in text:
        failures.append(f"sidebar rhythm at {width} cols: empty bookmarks section should be omitted like Bun")


def diff_left_pane_text(text: str, width: int) -> str:
    left_width = max(1, int(width * 0.60))
    return "\n".join(line[:left_width] for line in text.splitlines())


def assert_diff_panel_contract(text: str, width: int, failures: list[str]) -> None:
    left = diff_left_pane_text(text, width)
    if "File " not in left:
        failures.append(f"diff panel at {width} cols: missing Bun-style file title")
    structural_lines = [line for line in left.splitlines() if not re.match(r"^\s*\d+\s+[+\- ]\s+", line)]
    structural = "\n".join(structural_lines)
    for forbidden in ["VIEWPORT", "SCROLL", "STICKY", "◆", "╭─ @@", "diff --git", "new file mode", "--- /dev/null", "+++ b/"]:
        if forbidden in structural:
            failures.append(f"diff panel at {width} cols: Rust-only patch scaffold should be hidden from Bun DiffView surface: {forbidden!r}")
    if not re.search(r"^\s*\d+\s+[+\-]\s+", left, re.MULTILINE):
        failures.append(f"diff panel at {width} cols: expected Bun DiffView code rows immediately under title")


def assert_diff_code_band_contract(text: str, width: int, failures: list[str]) -> None:
    left = diff_left_pane_text(text, width)
    if not re.search(r"^\s*\d+\s+[+\-]\s+", left, re.MULTILINE):
        failures.append(f"diff code gutters at {width} cols: expected Bun-style line number followed by +/- sign")


def first_diff_code_line(text: str) -> str:
    for line in text.splitlines():
        if re.match(r"^\s*\d+\s+[+\- ]\s+", line):
            return line.strip()
    return ""


def assert_diff_code_scrolls(before: str, after: str, width: int, failures: list[str]) -> None:
    before_line = first_diff_code_line(before)
    after_line = first_diff_code_line(after)
    if not before_line or not after_line:
        failures.append(f"diff scrolling at {width} cols: missing comparable Bun-style code rows")
    elif before_line == after_line:
        failures.append(f"diff scrolling at {width} cols: first code row did not change after scrolling")


def assert_debug_state_contract(label: str, state: dict[str, Any], failures: list[str]) -> None:
    if state.get("viewMode") != "Log":
        failures.append(f"debug-state {label}: should end in Log mode")
    if state.get("selectedChange", "")[:8] != "uyompyrw":
        failures.append(f"debug-state {label}: should preserve selected target commit")
    if state.get("diffScroll") != 0:
        failures.append(f"debug-state {label}: should reset diff scroll on exit")


def select_change_prefix(session: str, change_prefix: str, max_steps: int = 80) -> str:
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
        initial = wait_for(session, "LOG")
        captures["initial"] = initial
        assert_contains(initial, "LOG", "initial log mode", failures)
        for needle in ["LOG", "^X", "Act", "^O", "Ops", "^L", "View", "^B", "Book"]:
            assert_contains(initial, needle, "initial old Bun leader strip", failures)

        send(session, "C-l")
        view_mode = wait_for(session, "VIEW")
        captures["afterCtrlLView"] = view_mode
        for needle in [
            "VIEW",
            "1", "Layout chronological",
            "2", "Layout mainline",
            "3", "Layout bookmark",
            "4", "Layout wc",
            "5", "Layout topological",
            "c", "Toggle sidebar",
            "t", "Theme picker",
            "f", "Toggle files",
            "x", "Toggle description",
            "h", "Toggle help",
            "/", "Revset filter",
            "^d", "Diff view",
        ]:
            assert_contains(view_mode, needle, "old Bun View leader strip", failures)
        send(session, "c")
        sidebar_collapsed = wait_for(session, "[ ]")
        captures["afterViewToggleSidebar"] = sidebar_collapsed
        assert_contains(sidebar_collapsed, "LOG", "View c returns to log", failures)
        assert_contains(sidebar_collapsed, "[ ]", "View c shows old collapsed sidebar marker", failures)
        assert_not_contains(sidebar_collapsed, "Selected", "View c collapses full details pane", failures)
        send(session, "C-l")
        view_mode_reopen = wait_for(session, "VIEW")
        captures["afterCtrlLViewReopen"] = view_mode_reopen
        send(session, "c")
        view_mode_expanded = wait_for(session, "Change:")
        captures["afterViewToggleSidebarExpanded"] = view_mode_expanded
        assert_contains(view_mode_expanded, "Change:", "View c toggles sidebar back open", failures)

        send(session, "C-l")
        view_mode_for_help = wait_for(session, "VIEW")
        captures["afterCtrlLViewForHelp"] = view_mode_for_help
        send(session, "h")
        help_screen = wait_for(session, "Help")
        captures["afterViewToggleHelp"] = help_screen
        assert_contains(help_screen, "Navigation", "View h opens old sidebar help surface", failures)
        send(session, "h")
        help_closed = wait_for(session, "Change:")
        captures["afterViewToggleHelpClosed"] = help_closed
        assert_contains(help_closed, "Change:", "h closes help surface", failures)

        send(session, "C-l")
        view_mode_for_theme = wait_for(session, "VIEW")
        captures["afterCtrlLViewForTheme"] = view_mode_for_theme
        send(session, "t")
        theme_screen = wait_for(session, "THEME SELECTOR")
        captures["afterViewThemePicker"] = theme_screen
        assert_contains(theme_screen, "THEME SELECTOR", "View t opens theme picker surface", failures)
        for needle in ["PREVIEW", "Surface", "Graph lanes", "Diff bands", "Add", "Remove"]:
            assert_contains(theme_screen, needle, "theme picker shows rich preview panel", failures)
        send(session, "Escape")
        theme_closed = wait_for(session, "Change:")
        captures["afterThemeEsc"] = theme_closed
        assert_contains(theme_closed, "Change:", "Esc closes theme picker surface", failures)

        send(session, "C-l")
        view_mode_for_revset = wait_for(session, "VIEW")
        captures["afterCtrlLViewForRevset"] = view_mode_for_revset
        send(session, "/")
        revset_screen = wait_for(session, "Revset:")
        captures["afterViewRevset"] = revset_screen
        assert_contains(revset_screen, "Revset:", "View / opens revset prompt surface", failures)
        send(session, "Escape")
        revset_closed = wait_for(session, "Change:")
        captures["afterRevsetEsc"] = revset_closed
        assert_contains(revset_closed, "Change:", "Esc closes revset prompt surface", failures)

        selected = select_change_prefix(session, "uyompyrw")
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
        assert_contains(diff, "Change: uyompyrw", "diff mode keeps sidebar metadata", failures)
        assert_contains(diff, "Current file preview", "diff mode sidebar labels preview as current-file context", failures)
        assert_details_split_matches_old(diff, width, failures)
        assert_sidebar_details_rhythm_contract(diff, width, failures)
        assert_diff_title_contract(diff, width, failures)
        assert_diff_status_bar_contract(diff, width, failures)
        assert_footer_info_contract(diff, width, failures)
        assert_diff_panel_contract(diff, width, failures)
        assert_diff_code_band_contract(diff, width, failures)
        assert_contains(diff, "Change: uyompyrw", "diff mode keeps selected commit", failures)
        assert_not_contains(diff, "preview capped", "full diff pane should not show sidebar preview cap rows", failures)
        assert_contains(diff, "~/dev/juzu", "after Ctrl+D keeps compact footer repo context", failures)

        send(session, "j")
        time.sleep(0.15)
        diff_scroll_down = capture(session)
        captures["afterDiffJ"] = diff_scroll_down
        assert_contains(diff_scroll_down, "Change: uyompyrw", "j in diff mode does not move DAG selection", failures)
        assert_diff_code_scrolls(diff, diff_scroll_down, width, failures)

        send(session, "k")
        time.sleep(0.15)
        diff_scroll_up = capture(session)
        captures["afterDiffK"] = diff_scroll_up
        assert_contains(diff_scroll_up, "Change: uyompyrw", "k in diff mode does not move DAG selection", failures)
        if first_diff_code_line(diff_scroll_up) != first_diff_code_line(diff):
            failures.append(f"diff scrolling at {width} cols: k should restore the first visible Bun-style code row")

        send(session, "]")
        diff_next_file = wait_for(session, "File 2/")
        captures["afterDiffNextFile"] = diff_next_file
        assert_contains(diff_next_file, "File 2/", "] cycles to next diff file in diff mode", failures)
        if not first_diff_code_line(diff_next_file):
            failures.append(f"diff file cycling at {width} cols: File 2 should render Bun-style code rows")
        assert_contains(diff_next_file, "Change: uyompyrw", "] in diff mode does not move DAG selection", failures)
        assert_contains(diff_next_file, "▶", "diff mode sidebar visibly marks selected diff file", failures)
        assert_contains(diff_next_file, "Current file preview", "diff mode sidebar remains scoped to current file after file cycling", failures)

        send(session, "[")
        diff_prev_file = wait_for(session, "File 1/")
        captures["afterDiffPrevFile"] = diff_prev_file
        assert_contains(diff_prev_file, "File 1/", "[ cycles to previous diff file in diff mode", failures)
        assert_contains(diff_prev_file, "Change: uyompyrw", "[ in diff mode does not move DAG selection", failures)

        send(session, "[")
        diff_last_file = wait_for(session, "File 2/")
        captures["afterDiffLastFile"] = diff_last_file
        assert_contains(diff_last_file, "File 2/", "[ from first file wraps to last diff file", failures)
        if not first_diff_code_line(diff_last_file):
            failures.append(f"diff file cycling at {width} cols: wrapped last file should render Bun-style code rows")
        assert_not_contains(diff_last_file, "File 2/2: Diff", "Last file title is not generic/missing rows", failures)
        assert_not_contains(diff_last_file, "preview capped", "wrapped full diff pane should not show sidebar preview cap rows", failures)
        assert_contains(diff_last_file, "Change: uyompyrw", "last file navigation does not move DAG selection", failures)
        assert_contains(diff_last_file, "▶", "wrapped last diff file remains visibly selected in sidebar", failures)
        assert_not_contains(diff_last_file, "pinned Added bench/results/rust-port/diff-render", "wrapped full diff sidebar preview should not stay pinned to first file", failures)

        send(session, "]")
        diff_back_first_file = wait_for(session, "File 1/")
        captures["afterDiffLastToFirstFile"] = diff_back_first_file
        assert_contains(diff_back_first_file, "File 1/", "] from last file wraps back to first diff file", failures)

        send(session, "q")
        back = wait_for(session, "LOG")
        captures["afterDiffQ"] = back
        assert_contains(back, "LOG", "q returns to log", failures)
        assert_contains(back, "restore readable rust diff row colors", "q returns with same selected commit", failures)
        assert_contains(back, "~/dev/juzu", "after q keeps compact footer repo context", failures)

        send(session, "PageDown")
        sidebar_scroll_down = wait_for(session, "diff rows 11-")
        captures["afterLogDiffPageDown"] = sidebar_scroll_down
        assert_contains(sidebar_scroll_down, "diff rows 11-", "PageDown scrolls sidebar diff preview in log mode", failures)
        assert_contains(sidebar_scroll_down, "restore readable rust diff row colors", "PageDown diff scroll does not move DAG selection", failures)

        send(session, "PageUp")
        sidebar_scroll_up = wait_for(session, "diff rows 1-")
        captures["afterLogDiffPageUp"] = sidebar_scroll_up
        assert_contains(sidebar_scroll_up, "diff rows 1-", "PageUp scrolls sidebar diff preview in log mode", failures)
        assert_contains(sidebar_scroll_up, "restore readable rust diff row colors", "PageUp diff scroll does not move DAG selection", failures)

        send(session, "C-d")
        diff_again = wait_for(session, "Ctrl+d back")
        captures["afterSecondCtrlD"] = diff_again
        assert_contains(diff_again, "File ", "second diff entry", failures)
        send(session, "C-d")
        back_ctrl = wait_for(session, "LOG")
        captures["afterDiffCtrlD"] = back_ctrl
        assert_contains(back_ctrl, "LOG", "Ctrl+D returns to log", failures)
        assert_contains(back_ctrl, "~/dev/juzu", "after Ctrl+D keeps compact footer repo context", failures)

        send(session, "C-d")
        diff_before_esc = wait_for(session, "Ctrl+d back")
        captures["afterThirdCtrlD"] = diff_before_esc
        send(session, "Escape")
        back_esc = wait_for(session, "LOG")
        captures["afterDiffEsc"] = back_esc
        assert_contains(back_esc, "LOG", "Esc returns to log", failures)
        assert_contains(back_esc, "restore readable rust diff row colors", "Esc returns with same selected commit", failures)
        assert_contains(back_esc, "~/dev/juzu", "after Esc keeps compact footer repo context", failures)

        send(session, "C-d")
        diff_before_g = wait_for(session, "Ctrl+d back")
        captures["afterFourthCtrlD"] = diff_before_g
        send(session, "g")
        back_g = wait_for(session, "LOG")
        captures["afterDiffG"] = back_g
        assert_contains(back_g, "LOG", "g returns to log", failures)
        assert_contains(back_g, "restore readable rust diff row colors", "g returns with same selected commit", failures)
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
        "actionLeaderStaysLog": "C-x",
        "opsLeaderStaysLog": "C-o",
        "viewLeaderStaysLog": "C-l",
        "bookLeaderStaysLog": "C-b",
        "viewLeaderQReturnsLog": "C-l,q",
        "viewToggleSidebar": "C-l,c",
        "viewToggleFiles": "C-l,f",
        "viewToggleDescription": "C-l,x",
        "viewToggleHelp": "C-l,h",
        "viewToggleBoxedChrome": "C-l,b",
        "viewToggleDiffScaffold": "C-l,s",
        "viewThemePicker": "C-l,t",
        "viewThemePickerDownApplyStaysOpen": "C-l,t,j,Enter",
        "viewThemePickerEscCancels": "C-l,t,j,Esc",
        "viewRevsetFilter": "C-l,/",
        "viewRevsetTextSubmit": "C-l,/,m,a,i,n,Enter",
        "viewRevsetCancel": "C-l,/,x,Esc",
        "viewDiffShortcut": "C-l,C-d",
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
        expected_leaders = {
            "actionLeaderStaysLog": ("Actions", "C-x"),
            "opsLeaderStaysLog": ("Operations", "C-o"),
            "viewLeaderStaysLog": ("View", "C-l"),
            "bookLeaderStaysLog": ("Bookmarks", "C-b"),
        }
        for label, (expected_mode, key_label) in expected_leaders.items():
            if debug_states[label].get("viewMode") != "Log":
                failures.append(f"debug-state {key_label} should stay in Log view")
            if debug_states[label].get("activeLeaderMode") != expected_mode:
                failures.append(f"debug-state {key_label} should enter {expected_mode} leader mode")
        if debug_states["viewLeaderQReturnsLog"].get("viewMode") != "Log":
            failures.append("debug-state C-l,q should stay in Log view")
        if debug_states["viewLeaderQReturnsLog"].get("activeLeaderMode") is not None:
            failures.append("debug-state C-l,q should exit View leader mode")
        view_behavior_expectations = {
            "viewToggleSidebar": ("sidebarCollapsed", True, "debug-state C-l,c should collapse sidebar and exit View leader"),
            "viewToggleFiles": ("filesExpanded", False, "debug-state C-l,f should collapse files and exit View leader"),
            "viewToggleDescription": ("descExpanded", True, "debug-state C-l,x should expand description and exit View leader"),
            "viewToggleHelp": ("showHelp", True, "debug-state C-l,h should open help and exit View leader"),
            "viewToggleBoxedChrome": ("boxedChrome", True, "debug-state C-l,b should toggle boxed chrome and exit View leader"),
            "viewToggleDiffScaffold": ("diffScaffold", True, "debug-state C-l,s should toggle full diff scaffold and exit View leader"),
            "viewThemePicker": ("themePickerMode", True, "debug-state C-l,t should open theme picker and exit View leader"),
            "viewRevsetFilter": ("revsetMode", True, "debug-state C-l,/ should open revset filter and exit View leader"),
        }
        for label, (field, expected, message) in view_behavior_expectations.items():
            if debug_states[label].get("viewMode") != "Log":
                failures.append(f"{message}: expected to remain in Log view")
            if debug_states[label].get("activeLeaderMode") is not None:
                failures.append(f"{message}: active leader mode should clear")
            if debug_states[label].get(field) != expected:
                failures.append(message)
        theme_apply = debug_states["viewThemePickerDownApplyStaysOpen"]
        if theme_apply.get("themePickerMode") is not True:
            failures.append("debug-state C-l,t,j,Enter should keep theme picker open after applying preview")
        if theme_apply.get("themePickerIndex") != 20:
            failures.append("debug-state C-l,t,j,Enter should move theme picker selection from slate to next bundled theme")
        if theme_apply.get("currentTheme") != "tokyo-night":
            failures.append("debug-state C-l,t,j,Enter should apply selected bundled theme in Rust state")
        theme_cancel = debug_states["viewThemePickerEscCancels"]
        if theme_cancel.get("themePickerMode") is not False:
            failures.append("debug-state C-l,t,j,Esc should close theme picker")
        if theme_cancel.get("currentTheme") != "slate":
            failures.append("debug-state C-l,t,j,Esc should not apply unconfirmed theme")
        revset_submit = debug_states["viewRevsetTextSubmit"]
        if revset_submit.get("revsetMode") is not False:
            failures.append("debug-state C-l,/,m,a,i,n,Enter should close revset mode")
        if revset_submit.get("revsetQuery") != "main":
            failures.append("debug-state C-l,/,m,a,i,n,Enter should store revset query text")
        revset_cancel = debug_states["viewRevsetCancel"]
        if revset_cancel.get("revsetMode") is not False:
            failures.append("debug-state C-l,/,x,Esc should close revset mode")
        if revset_cancel.get("revsetQuery"):
            failures.append("debug-state C-l,/,x,Esc should not apply cancelled revset text")
        if debug_states["viewDiffShortcut"].get("viewMode") != "Diff":
            failures.append("debug-state C-l,C-d should enter Diff view from View leader")
        if debug_states["viewDiffShortcut"].get("activeLeaderMode") is not None:
            failures.append("debug-state C-l,C-d should clear View leader mode")
        if debug_states["enterScrollFileExit"].get("diffFileIndex") != 1:
            failures.append("debug-state C-d,j,],Esc should cycle to file index 1 before exit")
        if debug_states["doubleNextFileEsc"].get("diffFileIndex") != 0:
            failures.append("debug-state C-d,],],Esc should wrap through two-file diff back to file index 0")
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
