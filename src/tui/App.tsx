import { useRenderer, useKeyboard } from "@opentui/solid";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { RGBA } from "@opentui/core";
import { readFile, readdir, watch, writeFile } from "node:fs/promises";
import { join } from "node:path";
// Lazy-load clipboardy only when actually copying to avoid startup memory cost
let _clipboardy: typeof import("clipboardy") | null = null;
const getClipboardy = async () => {
  if (!_clipboardy) _clipboardy = await import("clipboardy");
  return _clipboardy;
};
import { state, actions, navigation, selectedNode, layoutResult } from "../core/state";
import { tuiActions, tuiState } from "../core/state-tui";
import { setBackend } from "../core/runtime";
import { ensureDiff, ensureFiles, initCwdFrom, opAbandon, opBookmarkDelete, opBookmarkSet, opDescribe, opDuplicate, opEdit, opGitFetch, opGitPush, opInsertBetween, opMerge, opNew, opRebase, opRestore, opSquash, opUndo, opRedo, refreshLog, refreshOpLog, refreshObslog, opRestoreOperation } from "../core/usecases";
import { createTuiBackend } from "./backend";
import { GraphView } from "./components/GraphView";
import { Sidebar } from "./components/Sidebar";
import { OpLogView } from "./components/OpLogView";
import { ObslogView } from "./components/ObslogView";
import { StatusBar } from "./components/StatusBar";
import { FooterBar } from "./components/FooterBar";
import { DiffView } from "./components/DiffView";
import { UI_TOKENS } from "../core/ui-tokens";
import { getRuntimeConfig } from "../core/runtime-config";
import { resolveAndApplyRuntimeConfig } from "../core/config-loader";

const BG = () => RGBA.fromHex(UI_TOKENS.slate.bg0);
const PANEL_BG = () => RGBA.fromHex(UI_TOKENS.slate.panel);
const RUNTIME = getRuntimeConfig();
const TUI_LOG_LIMIT = readPositiveIntEnv("JJVIZ_TUI_LOG_LIMIT", 80);
const TUI_REFRESH_DEBOUNCE_MS = readPositiveIntEnv("JJVIZ_TUI_REFRESH_DEBOUNCE_MS", 700);
const TUI_PREFETCH_DIFF_IN_LOG = RUNTIME.tui.prefetchDiffInLog;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function extractThemeNameFromToml(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  let inTheme = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      inTheme = trimmed === "[theme]";
      continue;
    }
    if (!inTheme) continue;
    const m = trimmed.match(/^name\s*=\s*"([^"]+)"\s*$/);
    if (m?.[1]) return m[1];
  }
  return null;
}

function upsertThemeNameInToml(raw: string, themeName: string): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let inTheme = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      inTheme = trimmed === "[theme]";
      if (!inTheme) kept.push(line);
      continue;
    }
    if (!inTheme) kept.push(line);
  }

  const stripped = kept.join("\n").trimEnd();
  const spacer = stripped.length > 0 ? "\n\n" : "";
  return `${stripped}${spacer}[theme]\nname = "${themeName}"\n`;
}

function App() {
  const renderer = useRenderer();
  const watchControllers: AbortController[] = [];
  let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingConfirmation: { message: string; run: () => Promise<void> | void } | null = null;
  const [confirmPrompt, setConfirmPrompt] = createSignal<string | null>(null);
  const [themeOptions, setThemeOptions] = createSignal<string[]>(["slate", "ember"]);
  const CLIPBOARD_ERROR_STATUS = "Error: clipboard copy failed in terminal session";

  const tryRawOsc52Copy = (text: string, target: "c" | "p") => {
    try {
      if (!process.stdout.isTTY) return false;
      const payload = Buffer.from(text, "utf8").toString("base64");
      const oscBel = `\u001b]52;${target};${payload}\u0007`;

      if (process.env.TMUX || process.env.STY) {
        process.stdout.write(`\u001bPtmux;\u001b${oscBel}\u001b\\`);
      } else {
        process.stdout.write(oscBel);
      }

      return true;
    } catch {
      return false;
    }
  };

  const tryNativeClipboardCopy = async (text: string) => {
    try {
      const cb = await getClipboardy();
      await cb.default.write(text);
      return true;
    } catch {
      return false;
    }
  };

  const buildDiffCopyRows = (diffText: string): string[] => {
    const raw = (diffText || "").split(/\r?\n/);
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    const rows: Array<{ n: number; s: " " | "+" | "-"; t: string }> = [];

    for (const line of raw) {
      if (line.startsWith("@@ ")) {
        const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (m) {
          oldLine = Number(m[1] || "0");
          newLine = Number(m[2] || "0");
          inHunk = true;
        }
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("diff --git ") || line.startsWith("index ")) {
        continue;
      }
      if (line.startsWith(" ")) {
        rows.push({ n: oldLine, s: " ", t: line.slice(1) });
        oldLine++;
        newLine++;
        continue;
      }
      if (line.startsWith("-") && !line.startsWith("--- ")) {
        rows.push({ n: oldLine, s: "-", t: line.slice(1) });
        oldLine++;
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++ ")) {
        rows.push({ n: newLine, s: "+", t: line.slice(1) });
        newLine++;
        continue;
      }
    }

    if (rows.length === 0) {
      return (diffText || "").trimEnd().split("\n");
    }

    const lineNumWidth = Math.max(1, String(Math.max(...rows.map((r) => r.n))).length);
    return rows.map((r) => `${String(r.n).padStart(lineNumWidth, " ")} ${r.s} ${r.t}`);
  };

  const wrapRowsToWidth = (rows: string[], width: number): string[] => {
    const w = Math.max(1, width);
    const out: string[] = [];
    for (const row of rows) {
      const text = row || "";
      if (text.length === 0) {
        out.push("");
        continue;
      }
      for (let i = 0; i < text.length; i += w) {
        out.push(text.slice(i, i + w));
      }
    }
    return out;
  };

  const extractSelectionFromLines = (
    lines: string[],
    width: number,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
  ): string => {
    if (lines.length === 0) return "";
    const maxX = Math.max(0, width - 1);
    const sx = Math.max(0, Math.min(startX, maxX));
    const ex = Math.max(0, Math.min(endX, maxX));
    const sy = Math.max(0, Math.min(startY, lines.length - 1));
    const ey = Math.max(0, Math.min(endY, lines.length - 1));
    if (ey < sy) return "";

    const out: string[] = [];
    const endExclusive = ex + 1;
    for (let y = sy; y <= ey; y++) {
      const line = (lines[y] || "").padEnd(width, " ");
      if (y === sy && y === ey) out.push(line.slice(sx, endExclusive).replace(/[ \t]+$/, ""));
      else if (y === sy) out.push(line.slice(sx).replace(/[ \t]+$/, ""));
      else if (y === ey) out.push(line.slice(0, endExclusive).replace(/[ \t]+$/, ""));
      else out.push(line.replace(/[ \t]+$/, ""));
    }
    return out.join("\n").replace(/[\n\r]+$/, "");
  };

  const getFullDiffSelectionText = (selection: any): string => {
    if (state.viewMode !== "diff") return "";

    const payload = fullDiffPayload();
    const diffText = payload.diff || "";
    if (!diffText.trim()) return "";

    const paneWidth = useVerticalLayout() ? tuiState.termSize.width : graphW();
    if (paneWidth <= 0) return "";

    const titleRows = payload.title ? 1 : 0;
    const paneX = 0;
    const paneY = statusBarHeight() + titleRows;
    const paneHeight = Math.max(1, graphH() - titleRows);

    const a = selection?.anchor;
    const f = selection?.focus;
    if (!a || !f) return "";

    const minX = Math.min(a.x, f.x);
    const maxX = Math.max(a.x, f.x);
    const minY = Math.min(a.y, f.y);
    const maxY = Math.max(a.y, f.y);

    const left = Math.max(minX, paneX);
    const right = Math.min(maxX, paneX + paneWidth - 1);
    const top = Math.max(minY, paneY);
    const bottom = Math.min(maxY, paneY + paneHeight - 1);
    if (right < left || bottom < top) return "";

    const localStartX = left - paneX;
    const localEndX = right - paneX;
    const localStartY = top - paneY;
    const localEndY = bottom - paneY;

    const rows = buildDiffCopyRows(diffText);
    const wrapped = wrapRowsToWidth(rows, paneWidth);
    return extractSelectionFromLines(wrapped, paneWidth, localStartX, localStartY, localEndX, localEndY);
  };

  const copyTextToClipboardBuffers = async (text: string, announce: boolean) => {
    if (!text) {
      if (announce) actions.setStatusMessage("Nothing selected to copy");
      return false;
    }

    const inZellij = Boolean(process.env.ZELLIJ);

    const copiedRawClipboard = tryRawOsc52Copy(text, "c");
    const copiedRawPrimary = tryRawOsc52Copy(text, "p");

    const copiedClipboard = renderer.copyToClipboardOSC52(text, 0);
    const copiedPrimary = renderer.copyToClipboardOSC52(text, 1);
    const copiedByRenderer = copiedClipboard || copiedPrimary;
    const copiedByNative = await tryNativeClipboardCopy(text);
    const copiedByRaw = copiedRawClipboard || copiedRawPrimary;

    const copied = copiedByNative || copiedByRenderer || (!inZellij && copiedByRaw);

    if (copied) {
      if (announce) {
        actions.setStatusMessage("Copied to clipboard");
      }
      return true;
    }

    actions.setStatusMessage(CLIPBOARD_ERROR_STATUS);
    return false;
  };

  const copyCurrentSelection = async () => {
    const selection = renderer.getSelection();
    if (!selection) return;

    let text = selection.getSelectedText() || "";
    if (!text) text = getFullDiffSelectionText(selection);

    if (text) {
      await copyTextToClipboardBuffers(text, true);
    }

    renderer.clearSelection();
  };

  const discoverThemes = async (repoCwd: string) => {
    const names = new Set<string>(["slate", "ember"]);
    const xdg = process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, ".config") : null);
    const dirs = [
      join(import.meta.dir, "../../themes"),
      join(repoCwd, ".jj-viz/themes"),
      xdg ? join(xdg, "jj-viz/themes") : null,
    ].filter(Boolean) as string[];

    for (const dir of dirs) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile()) continue;
          if (!e.name.endsWith(".toml")) continue;
          names.add(e.name.slice(0, -5));
        }
      } catch {
        // ignore missing directories
      }
    }

    setThemeOptions(Array.from(names).sort((a, b) => a.localeCompare(b)));
  };

  const scheduleRefresh = () => {
    if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(() => {
      if (pendingConfirmation) return;
      void refresh();
    }, TUI_REFRESH_DEBOUNCE_MS);
  };

  const startWatch = (path: string) => {
    const controller = new AbortController();
    watchControllers.push(controller);
    void (async () => {
      try {
        for await (const _event of watch(path, { recursive: false, signal: controller.signal })) {
          scheduleRefresh();
        }
      } catch (e) {
        const err = e as Error & { code?: string };
        if (err?.name === "AbortError") return;
        if (err?.code !== "ENOENT") console.error(`Watch error for ${path}:`, e);
      }
    })();
  };

  onMount(async () => {
    setBackend(createTuiBackend());
    const startDir = process.cwd();
    const repoCwd = await initCwdFrom(startDir);
    if (!repoCwd) {
      actions.setStatusMessage("No .jj directory found");
      return;
    }

    const fallbackW = (process.stdout.columns ?? 80) as number;
    const fallbackH = (process.stdout.rows ?? 24) as number;
    const initialW = renderer.width || fallbackW;
    const initialH = renderer.height || fallbackH;
    if (tuiState.termSize.width !== initialW || tuiState.termSize.height !== initialH) {
      tuiActions.setTermSize(initialW, initialH);
    }
    renderer.on("resize", (w: number, h: number) => {
      if (tuiState.termSize.width !== w || tuiState.termSize.height !== h) {
        tuiActions.setTermSize(w, h);
      }
    });

    await refresh();
    await discoverThemes(repoCwd);

    const jjDir = `${repoCwd}/.jj`;
    startWatch(`${jjDir}/working_copy`);
    startWatch(`${jjDir}/repo`);
    startWatch(`${jjDir}/repo/store`);
    startWatch(`${jjDir}/repo/store/operations`);
  });

  onCleanup(() => {
    for (const controller of watchControllers) {
      controller.abort();
    }
    if (refreshDebounceTimer) {
      clearTimeout(refreshDebounceTimer);
      refreshDebounceTimer = null;
    }
  });

  // Track last fetched IDs to avoid re-fetching for the same selection
  let _lastFilesChangeId: string | null = null;
  let _lastDiffChangeId: string | null = null;
  let _lastSelectedIdForDiffReset: string | null = null;

  createEffect(() => {
    const node = selectedNode();
    if (!node) return;
    if (state.viewMode !== "log") return;
    // Skip if we already fetched for this changeId
    if (node.changeId === _lastFilesChangeId) return;
    _lastFilesChangeId = node.changeId;
    void ensureFiles(node.changeId).catch(() => {
      // Best-effort cache hydration for selected node details.
    });
  });

  createEffect(() => {
    const node = selectedNode();
    const mode = state.viewMode;
    if (!node) return;
    if (mode === "log" && !TUI_PREFETCH_DIFF_IN_LOG) return;
    if (mode !== "log" && mode !== "diff") return;
    // Skip if we already fetched for this changeId
    if (node.changeId === _lastDiffChangeId) return;
    _lastDiffChangeId = node.changeId;
    void ensureDiff(node.changeId).catch(() => {
      // Best-effort prefetch for sidebar/full diff rendering.
    });
  });

  createEffect(() => {
    const id = state.selectedId;
    if (id === _lastSelectedIdForDiffReset) return;
    _lastSelectedIdForDiffReset = id;
    tuiActions.setDiffFileIndex(0);
  });

  const refresh = async () => {
    try {
      await refreshLog(TUI_LOG_LIMIT);
    } catch (e) {
      console.error("Refresh error:", e);
    }
  };

  const ensureSelectedVisible = (visibleRows: number) => {
    const idx = Math.max(0, layoutResult().nodes.findIndex((n) => n.changeId === state.selectedId));
    const offset = tuiState.scrollOffset;
    if (idx < offset) tuiActions.setScrollOffset(idx);
    else if (idx >= offset + visibleRows) tuiActions.setScrollOffset(Math.max(0, idx - visibleRows + 1));
  };

  const ensureOpLogVisible = (visibleRows: number) => {
    const entries = state.opLogEntries;
    if (entries.length === 0) return;
    const idx = entries.findIndex((e) => e.id === state.opLogSelectedId);
    if (idx < 0) return;
    const offset = tuiState.scrollOffset;
    if (idx < offset) tuiActions.setScrollOffset(idx);
    else if (idx >= offset + visibleRows) tuiActions.setScrollOffset(Math.max(0, idx - visibleRows + 1));
  };

  const ensureObslogVisible = (visibleRows: number) => {
    const entries = state.obslogEntries;
    if (entries.length === 0) return;
    const idx = Math.max(0, Math.min(state.obslogSelectedIndex, entries.length - 1));
    const offset = tuiState.scrollOffset;
    if (idx < offset) tuiActions.setScrollOffset(idx);
    else if (idx >= offset + visibleRows) tuiActions.setScrollOffset(Math.max(0, idx - visibleRows + 1));
  };

  const requestConfirmation = (message: string, run: () => Promise<void> | void) => {
    pendingConfirmation = { message, run };
    setConfirmPrompt(message);
    tuiActions.setLeaderMode(false);
    actions.setStatusMessage(`${message} (y/n)`);
  };

  const isPrevDiffFileKey = (key: KeyEvent, name: string) => {
    return (
      key.sequence === "[" ||
      name === "[" ||
      name === "openbracket" ||
      name === "leftbracket" ||
      name === "bracketleft"
    );
  };

  const isNextDiffFileKey = (key: KeyEvent, name: string) => {
    return (
      key.sequence === "]" ||
      name === "]" ||
      name === "closebracket" ||
      name === "rightbracket" ||
      name === "bracketright"
    );
  };

  useKeyboard((key: KeyEvent) => {
    const rawName = (key.name || key.sequence || "");
    const name = rawName.toLowerCase();

    if (key.ctrl && !key.shift && key.name === "c") {
      renderer.destroy();
      return;
    }

    if (pendingConfirmation) {
      if (name === "y" || name === "return" || name === "enter") {
        const confirm = pendingConfirmation;
        pendingConfirmation = null;
        setConfirmPrompt(null);
        void Promise.resolve(confirm.run());
        return;
      }
      if (name === "n" || name === "escape") {
        pendingConfirmation = null;
        setConfirmPrompt(null);
        actions.setStatusMessage("Cancelled");
        return;
      }
      actions.setStatusMessage(`${pendingConfirmation.message} (y/n)`);
      return;
    }

    if (key.ctrl && name === "d") {
      if (state.viewMode === "diff") {
        handleBackToLog();
      } else if (state.viewMode === "log") {
        void handleDiffView();
      }
      return;
    }

    // Handle help mode
    if (tuiState.showHelp) {
      if (name === "escape" || name === "h" || name === "q") {
        tuiActions.setShowHelp(false);
      }
      return;
    }

    // Handle op log view mode
    if (state.viewMode === "oplog") {
      if (rawName === "R") {
        handleOpRestore();
        return;
      }
      switch (name) {
        case "r":
          handleOpRestore();
          return;
        case "g":
        case "escape":
        case "q":
          handleBackToLog();
          return;
        case "up":
        case "k":
          navigation.moveUp();
          return;
        case "down":
        case "j":
          navigation.moveDown();
          return;
        case "pageup":
          {
            const entries = state.opLogEntries;
            if (entries.length === 0) return;
            const cur = Math.max(0, entries.findIndex((e) => e.id === state.opLogSelectedId));
            const next = Math.max(0, cur - 10);
            actions.selectOpLogEntry(entries[next]!.id);
          }
          return;
        case "pagedown":
          {
            const entries = state.opLogEntries;
            if (entries.length === 0) return;
            const cur = Math.max(0, entries.findIndex((e) => e.id === state.opLogSelectedId));
            const next = Math.min(entries.length - 1, cur + 10);
            actions.selectOpLogEntry(entries[next]!.id);
          }
          return;
      }
      return;
    }

    // Handle obslog view mode
    if (state.viewMode === "obslog") {
      switch (name) {
        case "g":
          handleBackToLog();
          return;
        case "escape":
        case "q":
          handleBackToLog();
          return;
        case "up":
        case "k":
          navigation.moveUp();
          return;
        case "down":
        case "j":
          navigation.moveDown();
          return;
        case "pageup":
          actions.setObslogSelectedIndex(state.obslogSelectedIndex - 10);
          return;
        case "pagedown":
          actions.setObslogSelectedIndex(state.obslogSelectedIndex + 10);
          return;
      }
      return;
    }

    // Handle full diff mode
    if (state.viewMode === "diff") {
      if (isPrevDiffFileKey(key, name)) {
        cycleSidebarDiffFile(-1);
        return;
      }
      if (isNextDiffFileKey(key, name)) {
        cycleSidebarDiffFile(1);
        return;
      }
      switch (name) {
        case "g":
        case "escape":
        case "q":
          handleBackToLog();
          return;
        case "up":
        case "k":
          navigation.moveUp();
          return;
        case "down":
        case "j":
          navigation.moveDown();
          return;
      }
      return;
    }

    // Handle revset prompt mode
    if (tuiState.revsetMode) {
      if (name === "return" || name === "enter") {
        const value = tuiActions.submitRevset();
        actions.setRevsetQuery(value.trim());
        tuiActions.setCursorPos(0);
        void refresh();
        return;
      } else if (name === "escape") {
        tuiActions.cancelRevset();
        tuiActions.setCursorPos(0);
        actions.setStatusMessage("Revset cancelled");
        return;
      } else if (name === "backspace") {
        const newValue = tuiState.revsetValue.slice(0, tuiState.cursorPos - 1) + tuiState.revsetValue.slice(tuiState.cursorPos);
        tuiActions.updateRevset(newValue);
        tuiActions.setCursorPos(Math.max(0, tuiState.cursorPos - 1));
        return;
      } else if (name === "left") {
        tuiActions.setCursorPos(Math.max(0, tuiState.cursorPos - 1));
        return;
      } else if (name === "right") {
        tuiActions.setCursorPos(Math.min(tuiState.revsetValue.length, tuiState.cursorPos + 1));
        return;
      } else if (key.sequence && key.sequence.length === 1) {
        const newValue = tuiState.revsetValue.slice(0, tuiState.cursorPos) + key.sequence + tuiState.revsetValue.slice(tuiState.cursorPos);
        tuiActions.updateRevset(newValue);
        tuiActions.setCursorPos(tuiState.cursorPos + key.sequence.length);
        return;
      }
      return;
    }

    // Handle describe mode
    if (state.describeMode) {
      if (name === "return" || name === "enter") {
        const value = actions.submitDescribe();
        tuiActions.setCursorPos(0);
        if (value !== null) {
          handleDescribeSubmit(value);
        }
        return;
      } else if (name === "escape") {
        actions.cancelDescribe();
        tuiActions.setCursorPos(0);
        actions.setStatusMessage("Cancelled");
        return;
      } else if (name === "backspace") {
        const newValue = state.describeValue.slice(0, tuiState.cursorPos - 1) + state.describeValue.slice(tuiState.cursorPos);
        actions.updateDescribeValue(newValue);
        tuiActions.setCursorPos(Math.max(0, tuiState.cursorPos - 1));
        return;
      } else if (name === "left") {
        tuiActions.setCursorPos(Math.max(0, tuiState.cursorPos - 1));
        return;
      } else if (name === "right") {
        tuiActions.setCursorPos(Math.min(state.describeValue.length, tuiState.cursorPos + 1));
        return;
      } else if (key.sequence && key.sequence.length === 1) {
        const newValue = state.describeValue.slice(0, tuiState.cursorPos) + key.sequence + state.describeValue.slice(tuiState.cursorPos);
        actions.updateDescribeValue(newValue);
        tuiActions.setCursorPos(tuiState.cursorPos + key.sequence.length);
        return;
      }
      return;
    }

    // Handle merge mode
    if (tuiState.mergeMode) {
      switch (name) {
        case "escape":
          tuiActions.setMergeMode(false);
          actions.setStatusMessage("Merge cancelled");
          return;
        case "return":
        case "enter":
          handleMerge();
          return;
        case "space": {
          const node = selectedNode();
          if (node) {
            tuiActions.toggleMergeSelection(node.changeId);
          }
          return;
        }
        default:
          // Allow navigation while in merge mode
          break;
      }
    }

    // Handle theme picker mode
    if (tuiState.themePickerMode) {
      const opts = themeOptions();
      if (opts.length === 0) return;
      switch (name) {
        case "escape":
        case "q":
          tuiActions.stopThemePicker();
          actions.setStatusMessage("Theme picker cancelled");
          return;
        case "up":
        case "k":
          tuiActions.setThemePickerIndex((tuiState.themePickerIndex - 1 + opts.length) % opts.length);
          return;
        case "down":
        case "j":
          tuiActions.setThemePickerIndex((tuiState.themePickerIndex + 1) % opts.length);
          return;
        case "return":
        case "enter": {
          const pick = opts[tuiState.themePickerIndex] || opts[0]!;
          void applyTheme(pick);
          return;
        }
      }
      return;
    }

    // Handle leader mode
    if (tuiState.leaderMode) {
      switch (name) {
        case "a":
          requestConfirmation(`Abandon selected change?${bookmarkSafetySuffix()}`, handleAbandon);
          return;
        case "s":
          requestConfirmation("Squash selected change?", handleSquash);
          return;
        case "d":
          tuiActions.setLeaderMode(false);
          handleDuplicate();
          return;
        case "u":
          requestConfirmation("Redo last operation?", handleRedo);
          return;
        case "m":
          tuiActions.setLeaderMode(false);
          tuiActions.setMergeMode(true);
          actions.setStatusMessage("Merge mode: Space=select Enter=merge Esc=cancel");
          return;
        case "f":
          tuiActions.setLeaderMode(false);
          void opGitFetch();
          return;
        case "p":
          tuiActions.setLeaderMode(false);
          void opGitPush();
          return;
        case "b": {
          tuiActions.setLeaderMode(false);
          const node = selectedNode();
          if (!node) return;
          const name = `wip/${node.changeId.slice(0, 8)}`;
          void opBookmarkSet(name, node.changeId);
          return;
        }
        case "x": {
          tuiActions.setLeaderMode(false);
          const node = selectedNode();
          if (!node) return;
          const local = (node.bookmarks || []).filter((b) => !b.includes("@"));
          if (local.length === 0) {
            actions.setStatusMessage("No local bookmark on selected change");
            return;
          }
          requestConfirmation(`Delete bookmark ${local[0]}?`, () => {
            void opBookmarkDelete(local[0]!);
          });
          return;
        }
        case "t":
          tuiActions.setLeaderMode(false);
          {
            const opts = themeOptions();
            const current = getRuntimeConfig().theme.name;
            const idx = Math.max(0, opts.indexOf(current));
            tuiActions.startThemePicker(idx);
            actions.setStatusMessage("Theme picker: j/k select theme, Enter apply, Esc exit");
          }
          return;
        case "escape":
          tuiActions.setLeaderMode(false);
          actions.setStatusMessage("Cancelled");
          return;
        case "up":
        case "down":
        case "left":
        case "right":
        case "k":
        case "j":
          // Allow navigation - cancel leader mode silently and fall through
          tuiActions.setLeaderMode(false);
          break;
        default:
          // Unknown key - just cancel leader mode silently
          tuiActions.setLeaderMode(false);
          return;
      }
    }

    switch (name) {
      case "q":
        renderer.destroy();
        return;
      case "escape":
        if (state.rebaseSourceId) {
          actions.setRebaseSource(null);
          actions.setStatusMessage("Rebase cancelled");
        }
        break;
      case "up":
      case "k":
        navigation.moveUp();
        break;
      case "down":
      case "j":
        navigation.moveDown();
        break;
      case "pageup":
        tuiActions.setSidebarScroll(tuiState.sidebarScroll - 10);
        break;
      case "pagedown":
        tuiActions.setSidebarScroll(tuiState.sidebarScroll + 10);
        break;
      case "r":
        refresh();
        break;
      case "f":
        tuiActions.toggleFilesExpanded();
        break;
      case "x":
        if (!key.ctrl && !key.meta) {
          tuiActions.toggleDescExpanded();
        }
        break;
      case "h":
        tuiActions.toggleHelp();
        break;
      case "1":
        actions.setLayoutMode("chronological");
        break;
      case "2":
        actions.setLayoutMode("mainline");
        break;
      case "3":
        actions.setLayoutMode("bookmark-centric");
        break;
      case "4":
        actions.setLayoutMode("wc-focused");
        break;
      case "5":
        actions.setLayoutMode("topological");
        break;
      case "n":
        handleNew();
        break;
      case "e":
        handleEdit();
        break;
      case "d":
        handleDescribe();
        break;
      case "b":
        handleRebase();
        break;
      case "return":
      case "enter":
        if (state.rebaseSourceId) {
          handleRebase();
        }
        break;
      case "i":
        handleInsert();
        break;
      case "u":
        requestConfirmation("Undo last operation?", handleUndo);
        break;
      case "o":
        handleOpLog();
        break;
      case "v":
        handleObslog();
        break;
      case "g":
        handleBackToLog();
        break;
      case "/":
        tuiActions.startRevset(state.revsetQuery || "");
        tuiActions.setCursorPos((state.revsetQuery || "").length);
        actions.setStatusMessage("Revset filter mode");
        break;
      case "z": {
        const node = selectedNode();
        if (!node) break;
        requestConfirmation(`Restore selected change ${node.changeId.slice(0, 8)}?`, () => {
          void opRestore(node.changeId);
        });
        break;
      }
    }

    if (isPrevDiffFileKey(key, name)) {
      cycleSidebarDiffFile(-1);
      return;
    }
    if (isNextDiffFileKey(key, name)) {
      cycleSidebarDiffFile(1);
      return;
    }

    // Leader key: Ctrl+X
    if (key.ctrl && name === "x") {
      tuiActions.setLeaderMode(true);
      actions.setStatusMessage("Leader mode");
    }
  });

  const handleNew = async () => {
    const node = selectedNode();
    if (!node) return;
    try {
      await opNew(node.changeId);
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const handleEdit = async () => {
    const node = selectedNode();
    if (!node) return;
    try {
      await opEdit(node.changeId);
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const handleDescribe = () => {
    const node = selectedNode();
    if (!node) return;
    const initial = node.descriptionTitle || "";
    actions.startDescribe(initial);
    tuiActions.setCursorPos(initial.length);
  };

  const handleDescribeSubmit = async (value: string) => {
    const node = selectedNode();
    if (!node) return;
    try {
      await opDescribe(node.changeId, value);
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const handleAbandon = async () => {
    const node = selectedNode();
    if (!node) return;
    try {
      await opAbandon(node.changeId);
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const bookmarkSafetySuffix = () => {
    const node = selectedNode();
    if (!node) return "";
    const locals = (node.bookmarks || []).filter((b) => !b.includes("@"));
    if (locals.length === 0) return "";
    return ` Bookmarks: ${locals.join(", ")}`;
  };

  const handleSquash = async () => {
    const node = selectedNode();
    if (!node) return;
    try {
      await opSquash(node.changeId);
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const handleDuplicate = async () => {
    const node = selectedNode();
    if (!node) return;
    try {
      await opDuplicate(node.changeId);
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const handleRebase = async () => {
    const node = selectedNode();
    if (!node) return;

    if (!state.rebaseSourceId) {
      actions.setRebaseSource(node.changeId);
      actions.setStatusMessage(`Rebase mode: ${node.changeId.slice(0, 8)} selected, choose destination`);
    } else if (state.rebaseSourceId === node.changeId) {
      actions.setRebaseSource(null);
      actions.setStatusMessage("Rebase cancelled");
    } else {
      const sourceId = state.rebaseSourceId;
      requestConfirmation(
        `Rebase ${sourceId.slice(0, 8)} onto ${node.changeId.slice(0, 8)}?${bookmarkSafetySuffix()}`,
        async () => {
          try {
            await opRebase(sourceId, node.changeId);
          } catch (e) {
            actions.setStatusMessage(`Error: ${String(e)}`);
            actions.setRebaseSource(null);
          }
        }
      );
    }
  };

  const handleInsert = async () => {
    const node = selectedNode();
    if (!node) return;
    const child = layoutResult().nodes.find((n) => n.parents.includes(node.changeId));
    if (!child) {
      actions.setStatusMessage("Insert: no child found to rebase");
      return;
    }
    try {
      await opInsertBetween(node.changeId, child.changeId);
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const handleUndo = async () => {
    try {
      await opUndo();
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const handleRedo = async () => {
    try {
      await opRedo();
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const applyTheme = async (next: string) => {
    if (!state.cwd) {
      actions.setStatusMessage("Theme: repo path unavailable");
      return;
    }

    const themePath = `${state.cwd}/.jj-viz.local.toml`;
    let raw = "";
    try {
      raw = await readFile(themePath, "utf8");
    } catch {
      raw = "";
    }

    const nextRaw = upsertThemeNameInToml(raw, next);
    try {
      await writeFile(themePath, nextRaw, "utf8");
      await resolveAndApplyRuntimeConfig({
        argv: process.argv.slice(2),
        repoRoot: state.cwd,
        appDir: `${import.meta.dir}/../..`,
      });
      tuiActions.bumpThemeVersion();
      actions.setStatusMessage(`Theme -> ${next}`);
      await discoverThemes(state.cwd);
    } catch (e) {
      actions.setStatusMessage(`Error writing theme config: ${String(e)}`);
    }
  };

  const handleMerge = async () => {
    const parents = Array.from(tuiState.mergeSelectedIds);
    if (parents.length < 2) {
      actions.setStatusMessage("Merge: select at least 2 commits");
      return;
    }
    try {
      await opMerge(parents);
      tuiActions.setMergeMode(false);
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const handleOpLog = async () => {
    try {
      actions.setViewMode("oplog");
      await refreshOpLog(100);
      actions.setStatusMessage("Operation log loaded");
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const handleObslog = async () => {
    const node = selectedNode();
    if (!node) return;
    try {
      actions.setViewMode("obslog");
      actions.setObslogChangeId(node.changeId);
      await refreshObslog(node.changeId, 50);
      actions.setStatusMessage(`Obslog for ${node.changeId.slice(0, 8)} loaded`);
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const handleBackToLog = () => {
    actions.setViewMode("log");
    actions.setStatusMessage("Back to log view");
  };

  const handleDiffView = async () => {
    const node = selectedNode();
    if (!node) return;
    try {
      await ensureDiff(node.changeId, 0);
      actions.setViewMode("diff");
      actions.setStatusMessage(`Diff view: ${node.changeId.slice(0, 8)}`);
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const cycleSidebarDiffFile = (dir: -1 | 1) => {
    const node = selectedNode();
    if (!node) return;
    const entry = state.diffCache.get(node.changeId);
    const total = entry?.files.length || 0;
    if (total <= 0) return;
    const next = (tuiState.diffFileIndex + dir + total) % total;
    tuiActions.setDiffFileIndex(next);
  };

  const handleOpRestore = async () => {
    if (state.viewMode !== "oplog" || !state.opLogSelectedId) return;
    try {
      await opRestoreOperation(state.opLogSelectedId);
      await refreshOpLog(100);
      actions.setStatusMessage("Operation restored");
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    }
  };

  const selectedDiffEntry = () => {
    const node = selectedNode();
    if (!node) return null;
    return state.diffCache.get(node.changeId) || null;
  };

  const sidebarDiffPreview = () => {
    const entry = selectedDiffEntry();
    if (!entry || entry.files.length === 0) return null;
    const total = entry.files.length;
    const index = Math.max(0, Math.min(tuiState.diffFileIndex, total - 1));
    const file = entry.files[index]!;
    return {
      path: file.path,
      diff: file.diff,
      index,
      total,
    };
  };

  const fullDiffPayload = () => {
    const entry = selectedDiffEntry();
    if (!entry) return { diff: "", title: "Diff" };
    if (entry.files.length === 0) return { diff: "", title: "Diff" };
    const preview = sidebarDiffPreview();
    if (!preview) return { diff: entry.files[0]?.diff || "", title: "Diff" };
    return {
      diff: preview.diff,
      title: `File ${preview.index + 1}/${preview.total}: ${preview.path}   [ / ] next/prev   Ctrl+d back`,
    };
  };

  // Layout: horizontal (side-by-side) when wide enough, vertical (stacked) when narrow
  const useVerticalLayout = () => tuiState.termSize.width < RUNTIME.tui.sidebarBreakpointWidth;
  const showSidebar = () => tuiState.termSize.height >= RUNTIME.tui.sidebarMinHeight;
  const graphPaneBg = () => {
    tuiState.themeVersion;
    return BG();
  };
  const detailW = () => !useVerticalLayout() && showSidebar() ? Math.floor(tuiState.termSize.width * 0.40) : 0;
  const graphW = () => tuiState.termSize.width - detailW();
  // Buffer between diff content and sidebar in horizontal layout
  const DIFF_SIDEBAR_BUFFER = 2;
  const sidebarH = () => useVerticalLayout() && showSidebar() ? Math.floor(mainHeight() * RUNTIME.tui.stackedSidebarRatio) : 0;
  const graphH = () => mainHeight() - sidebarH();
  const statusBarHeight = () => {
    const w = tuiState.termSize.width;
    const h = tuiState.termSize.height;
    if (h < 14) return 1;

    // Keep status bar height stable so graph area does not resize when
    // mode/status rows appear (leader mode, theme messages, etc).
    let rows = w < 90 ? 4 : 3;
    if (w < 70) rows += 1;

    const maxAllowed = Math.max(1, h - 8);
    return Math.max(1, Math.min(rows, Math.min(4, maxAllowed)));
  };
  // status bar + footer row
  const mainHeight = () => Math.max(1, tuiState.termSize.height - statusBarHeight() - 1);

  return (
    <box
      width={tuiState.termSize.width}
      height={tuiState.termSize.height}
      backgroundColor={BG()}
      flexDirection="column"
      onMouseUp={async () => {
        await copyCurrentSelection();
      }}
    >
      {/* Top status bar */}
      <StatusBar width={tuiState.termSize.width} height={statusBarHeight()} themeVersion={tuiState.themeVersion} />

      <box flexDirection={useVerticalLayout() ? "column" : "row"} flexGrow={1} height={mainHeight()}>
        <box width={useVerticalLayout() ? tuiState.termSize.width : graphW()} height={graphH()} backgroundColor={graphPaneBg()}>
        {state.viewMode === "log" && (
            <GraphView
              nodes={layoutResult().nodes}
              selectedId={state.selectedId}
              scrollOffset={tuiState.scrollOffset}
              filesCache={state.filesCache}
              width={useVerticalLayout() ? tuiState.termSize.width : graphW()}
              height={graphH()}
              onEnsureVisible={ensureSelectedVisible}
              layoutMode={state.layoutMode}
              mergeMode={tuiState.mergeMode}
              mergeSelectedIds={tuiState.mergeSelectedIds}
              themeVersion={tuiState.themeVersion}
            />
          )}
          {state.viewMode === "oplog" && (
            <OpLogView
              entries={state.opLogEntries}
              selectedId={state.opLogSelectedId}
              scrollOffset={tuiState.scrollOffset}
              width={useVerticalLayout() ? tuiState.termSize.width : graphW()}
              height={graphH()}
              onEnsureVisible={ensureOpLogVisible}
              themeVersion={tuiState.themeVersion}
            />
          )}
          {state.viewMode === "obslog" && (
            <ObslogView
              entries={state.obslogEntries}
              scrollOffset={tuiState.scrollOffset}
              selectedIndex={state.obslogSelectedIndex}
              width={useVerticalLayout() ? tuiState.termSize.width : graphW()}
              height={graphH()}
              onEnsureVisible={ensureObslogVisible}
              changeId={state.obslogChangeId}
              themeVersion={tuiState.themeVersion}
            />
          )}
          {state.viewMode === "diff" && (
            <DiffView
              width={useVerticalLayout() ? tuiState.termSize.width : Math.max(1, graphW() - DIFF_SIDEBAR_BUFFER)}
              height={graphH()}
              diff={fullDiffPayload().diff}
              title={fullDiffPayload().title}
              themeVersion={tuiState.themeVersion}
            />
          )}
        </box>

        {showSidebar() && (
          <box 
            width={useVerticalLayout() ? tuiState.termSize.width : detailW()} 
            height={useVerticalLayout() ? sidebarH() : mainHeight()} 
            backgroundColor={PANEL_BG()}
          >
               <Sidebar
               selected={selectedNode()}
               filesCache={state.filesCache}
               descExpanded={tuiState.descExpanded}
               filesExpanded={tuiState.filesExpanded}
               scrollOffset={tuiState.sidebarScroll}
               width={useVerticalLayout() ? tuiState.termSize.width : detailW()}
               height={useVerticalLayout() ? sidebarH() : mainHeight()}
               showHelp={tuiState.showHelp}
                promptMode={state.describeMode || tuiState.revsetMode}
                promptLabel={tuiState.revsetMode ? "Revset" : "Edit Description"}
                promptValue={tuiState.revsetMode ? tuiState.revsetValue : state.describeValue}
                cursorPos={tuiState.cursorPos}
                confirmPrompt={confirmPrompt()}
                mergeMode={tuiState.mergeMode}
                mergeSelectedIds={tuiState.mergeSelectedIds}
                themeVersion={tuiState.themeVersion}
                themePickerMode={tuiState.themePickerMode}
                themeOptions={themeOptions()}
                themeSelectedIndex={tuiState.themePickerIndex}
                currentTheme={getRuntimeConfig().theme.name}
                  viewMode={state.viewMode}
                 opLogSelected={state.opLogEntries.find(e => e.id === state.opLogSelectedId)}
                 obslogChangeId={state.obslogChangeId}
                 obslogSelected={state.obslogEntries[state.obslogSelectedIndex] || null}
                 diffPreview={sidebarDiffPreview()}
               />
            </box>
          )}
        </box>

      {/* Bottom footer bar */}
      <FooterBar themeVersion={tuiState.themeVersion} />
    </box>
  );
}

export default App;
