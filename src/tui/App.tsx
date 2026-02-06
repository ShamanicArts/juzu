import { useRenderer, useKeyboard } from "@opentui/solid";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { RGBA } from "@opentui/core";
import { watch } from "node:fs/promises";
import { state, actions, navigation, selectedNode, layoutResult } from "../core/state";
import { tuiActions, tuiState } from "../core/state-tui";
import { setBackend } from "../core/runtime";
import { initCwdFrom, opAbandon, opBookmarkDelete, opBookmarkSet, opDescribe, opDuplicate, opEdit, opGitFetch, opGitPush, opInsertBetween, opMerge, opNew, opRebase, opRestore, opSquash, opUndo, opRedo, prefetchFiles, refreshLog, refreshOpLog, refreshObslog, opRestoreOperation } from "../core/usecases";
import { createTuiBackend } from "./backend";
import { GraphView } from "./components/GraphView";
import { Sidebar } from "./components/Sidebar";
import { OpLogView } from "./components/OpLogView";
import { ObslogView } from "./components/ObslogView";
import { StatusBar } from "./components/StatusBar";
import { FooterBar } from "./components/FooterBar";
import { UI_TOKENS } from "../core/ui-tokens";

const BG = RGBA.fromHex(UI_TOKENS.slate.bg0);
const PANEL_BG = RGBA.fromHex(UI_TOKENS.slate.panel);

function App() {
  const renderer = useRenderer();
  const watchControllers: AbortController[] = [];
  let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingConfirmation: { message: string; run: () => Promise<void> | void } | null = null;
  const [confirmPrompt, setConfirmPrompt] = createSignal<string | null>(null);

  const scheduleRefresh = () => {
    if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(() => {
      if (pendingConfirmation) return;
      void refresh();
    }, 500);
  };

  const startWatch = (path: string, recursive: boolean) => {
    const controller = new AbortController();
    watchControllers.push(controller);
    void (async () => {
      try {
        for await (const _event of watch(path, { recursive, signal: controller.signal })) {
          scheduleRefresh();
        }
      } catch (e) {
        const err = e as Error & { code?: string };
        if (err?.name === "AbortError") return;
        if (recursive) {
          // Linux may not support recursive fs.watch; fallback to non-recursive watches.
          startWatch(path, false);
          return;
        }
        console.error(`Watch error for ${path}:`, e);
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
    tuiActions.setTermSize(renderer.width || fallbackW, renderer.height || fallbackH);
    renderer.on("resize", (w: number, h: number) => {
      tuiActions.setTermSize(w, h);
    });

    await refresh();

    const jjDir = `${repoCwd}/.jj`;
    startWatch(jjDir, true);
    // Fallback/extra coverage for platforms where recursive watch is not available.
    startWatch(`${jjDir}/working_copy`, false);
    startWatch(`${jjDir}/repo`, false);
    startWatch(`${jjDir}/repo/store`, false);
    startWatch(`${jjDir}/repo/store/operations`, false);
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

  const refresh = async () => {
    try {
      await refreshLog(500);
      void prefetchFiles(layoutResult().nodes.map((n) => n.changeId));
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

  useKeyboard((key: KeyEvent) => {
    const rawName = (key.name || key.sequence || "");
    const name = rawName.toLowerCase();

    if (key.ctrl && key.name === "c") {
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

  const showSidebar = () => tuiState.termSize.width >= 90 && tuiState.termSize.height >= 16;
  const detailW = () => showSidebar() ? Math.floor(tuiState.termSize.width * 0.40) : 0;
  const graphW = () => tuiState.termSize.width - detailW();
  const hasStatusRow = () => {
    const msg = (state.statusMessage || "").trim();
    if (!msg) return false;
    if (/^nodes:\d+$/i.test(msg)) return false;
    if (msg === "Loading...") return false;
    if (msg.startsWith("Error")) return true;
    return !tuiState.leaderMode;
  };
  const isModalMode = () =>
    tuiState.revsetMode ||
    state.describeMode ||
    tuiState.leaderMode ||
    !!state.rebaseSourceId ||
    tuiState.mergeMode ||
    state.viewMode !== "log";
  const statusBarHeight = () => {
    const w = tuiState.termSize.width;
    const h = tuiState.termSize.height;
    if (h < 14) return 1;

    let rows = w < 90 ? 2 : 1;
    if (isModalMode()) rows += 1;
    if (hasStatusRow()) rows += 1;
    if (w < 70) rows += 1;

    const maxAllowed = Math.max(1, h - 8);
    return Math.max(1, Math.min(rows, Math.min(4, maxAllowed)));
  };
  // status bar + footer row
  const mainHeight = () => Math.max(1, tuiState.termSize.height - statusBarHeight() - 1);

  return (
    <box width={tuiState.termSize.width} height={tuiState.termSize.height} backgroundColor={BG} flexDirection="column">
      {/* Top status bar */}
      <StatusBar width={tuiState.termSize.width} height={statusBarHeight()} />

      <box flexDirection="row" flexGrow={1} height={mainHeight()}>
        <box width={graphW()} height={mainHeight()}>
        {state.viewMode === "log" && (
            <GraphView
              nodes={layoutResult().nodes}
              selectedId={state.selectedId}
              scrollOffset={tuiState.scrollOffset}
              filesCache={state.filesCache}
              width={graphW()}
              height={mainHeight()}
              onEnsureVisible={ensureSelectedVisible}
              layoutMode={state.layoutMode}
              mergeMode={tuiState.mergeMode}
              mergeSelectedIds={tuiState.mergeSelectedIds}
            />
          )}
          {state.viewMode === "oplog" && (
            <OpLogView
              entries={state.opLogEntries}
              selectedId={state.opLogSelectedId}
              scrollOffset={tuiState.scrollOffset}
              width={graphW()}
              height={mainHeight()}
              onEnsureVisible={ensureOpLogVisible}
            />
          )}
          {state.viewMode === "obslog" && (
            <ObslogView
              entries={state.obslogEntries}
              scrollOffset={tuiState.scrollOffset}
              selectedIndex={state.obslogSelectedIndex}
              width={graphW()}
              height={mainHeight()}
              onEnsureVisible={ensureObslogVisible}
              changeId={state.obslogChangeId}
            />
          )}
        </box>

        {showSidebar() && (
          <box width={detailW()} height={mainHeight()} backgroundColor={PANEL_BG}>
               <Sidebar
               selected={selectedNode()}
               filesCache={state.filesCache}
               descExpanded={tuiState.descExpanded}
               filesExpanded={tuiState.filesExpanded}
               scrollOffset={tuiState.sidebarScroll}
               width={detailW()}
               height={mainHeight()}
               showHelp={tuiState.showHelp}
                promptMode={state.describeMode || tuiState.revsetMode}
                promptLabel={tuiState.revsetMode ? "Revset" : "Edit Description"}
                promptValue={tuiState.revsetMode ? tuiState.revsetValue : state.describeValue}
                cursorPos={tuiState.cursorPos}
                confirmPrompt={confirmPrompt()}
                mergeMode={tuiState.mergeMode}
                mergeSelectedIds={tuiState.mergeSelectedIds}
                  viewMode={state.viewMode}
                 opLogSelected={state.opLogEntries.find(e => e.id === state.opLogSelectedId)}
                 obslogChangeId={state.obslogChangeId}
                 obslogSelected={state.obslogEntries[state.obslogSelectedIndex] || null}
               />
            </box>
          )}
        </box>

      {/* Bottom footer bar */}
      <FooterBar />
    </box>
  );
}

export default App;
