import { useRenderer, useKeyboard } from "@opentui/solid";
import { createEffect, onCleanup, onMount } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { RGBA } from "@opentui/core";
import { watch } from "node:fs/promises";
import { state, actions, navigation, selectedNode } from "../core/state";
import { setBackend } from "../core/runtime";
import { initCwdFrom, opAbandon, opDescribe, opDuplicate, opEdit, opInsertBetween, opMerge, opNew, opRebase, opSquash, opUndo, opRedo, prefetchFiles, refreshLog, refreshOpLog, refreshObslog, opRestoreOperation } from "../core/usecases";
import { createTuiBackend } from "./backend";
import { GraphView } from "./components/GraphView";
import { Sidebar } from "./components/Sidebar";
import { OpLogView } from "./components/OpLogView";
import { ObslogView } from "./components/ObslogView";
import { StatusBar } from "./components/StatusBar";
import { FooterBar } from "./components/FooterBar";

const BG = RGBA.fromHex("#24283b");
const PANEL_BG = RGBA.fromHex("#1a1b26");
const FG_DIM = RGBA.fromHex("#888888");

function App() {
  const renderer = useRenderer();
  const watchControllers: AbortController[] = [];
  let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRefresh = () => {
    if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(() => {
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
    actions.setTermSize(renderer.width || fallbackW, renderer.height || fallbackH);
    renderer.on("resize", (w: number, h: number) => {
      actions.setTermSize(w, h);
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
      void prefetchFiles(state.layoutResult.nodes.map((n) => n.changeId));
    } catch (e) {
      console.error("Refresh error:", e);
    }
  };

  const ensureSelectedVisible = (visibleRows: number) => {
    actions.scrollToSelected(visibleRows);
  };

  const ensureOpLogVisible = (visibleRows: number) => {
    const entries = state.opLogEntries;
    if (entries.length === 0) return;
    const idx = entries.findIndex((e) => e.id === state.opLogSelectedId);
    if (idx < 0) return;
    const offset = state.scrollOffset;
    if (idx < offset) actions.setScrollOffset(idx);
    else if (idx >= offset + visibleRows) actions.setScrollOffset(Math.max(0, idx - visibleRows + 1));
  };

  const ensureObslogVisible = (visibleRows: number) => {
    const entries = state.obslogEntries;
    if (entries.length === 0) return;
    const idx = Math.max(0, Math.min(state.obslogSelectedIndex, entries.length - 1));
    const offset = state.scrollOffset;
    if (idx < offset) actions.setScrollOffset(idx);
    else if (idx >= offset + visibleRows) actions.setScrollOffset(Math.max(0, idx - visibleRows + 1));
  };

  useKeyboard((key: KeyEvent) => {
    const rawName = (key.name || key.sequence || "");
    const name = rawName.toLowerCase();

    if (key.ctrl && key.name === "c") {
      renderer.destroy();
      return;
    }

    // Handle help mode
    if (state.showHelp) {
      if (name === "escape" || name === "h" || name === "q") {
        actions.setShowHelp(false);
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

    // Handle describe mode
    if (state.describeMode) {
      if (name === "return" || name === "enter") {
        const value = actions.submitDescribe();
        if (value !== null) {
          handleDescribeSubmit(value);
        }
        return;
      } else if (name === "escape") {
        actions.cancelDescribe();
        actions.setStatusMessage("Cancelled");
        return;
      } else if (name === "backspace") {
        const newValue = state.describeValue.slice(0, state.cursorPos - 1) + state.describeValue.slice(state.cursorPos);
        actions.updateDescribeValue(newValue);
        actions.setCursorPos(Math.max(0, state.cursorPos - 1));
        return;
      } else if (name === "left") {
        actions.setCursorPos(Math.max(0, state.cursorPos - 1));
        return;
      } else if (name === "right") {
        actions.setCursorPos(Math.min(state.describeValue.length, state.cursorPos + 1));
        return;
      } else if (key.sequence && key.sequence.length === 1) {
        const newValue = state.describeValue.slice(0, state.cursorPos) + key.sequence + state.describeValue.slice(state.cursorPos);
        actions.updateDescribeValue(newValue);
        actions.setCursorPos(state.cursorPos + key.sequence.length);
        return;
      }
      return;
    }

    // Handle merge mode
    if (state.mergeMode) {
      switch (name) {
        case "escape":
          actions.setMergeMode(false);
          actions.setStatusMessage("Merge cancelled");
          return;
        case "return":
        case "enter":
          handleMerge();
          return;
        case "space": {
          const node = selectedNode();
          if (node) {
            actions.toggleMergeSelection(node.changeId);
          }
          return;
        }
        default:
          // Allow navigation while in merge mode
          break;
      }
    }

    // Handle leader mode
    if (state.leaderMode) {
      switch (name) {
        case "a":
          actions.setLeaderMode(false);
          handleAbandon();
          return;
        case "s":
          actions.setLeaderMode(false);
          handleSquash();
          return;
        case "d":
          actions.setLeaderMode(false);
          handleDuplicate();
          return;
        case "u":
          actions.setLeaderMode(false);
          handleRedo();
          return;
        case "m":
          actions.setLeaderMode(false);
          actions.setMergeMode(true);
          actions.setStatusMessage("Merge mode: Space=select Enter=merge Esc=cancel");
          return;
        case "escape":
          actions.setLeaderMode(false);
          actions.setStatusMessage("Cancelled");
          return;
        case "up":
        case "down":
        case "left":
        case "right":
        case "k":
        case "j":
          // Allow navigation - cancel leader mode silently and fall through
          actions.setLeaderMode(false);
          break;
        default:
          // Unknown key - just cancel leader mode silently
          actions.setLeaderMode(false);
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
        actions.setSidebarScroll(state.sidebarScroll - 10);
        break;
      case "pagedown":
        actions.setSidebarScroll(state.sidebarScroll + 10);
        break;
      case "r":
        refresh();
        break;
      case "f":
        actions.toggleFilesExpanded();
        break;
      case "x":
        if (!key.ctrl && !key.meta) {
          actions.toggleDescExpanded();
        }
        break;
      case "h":
        actions.toggleHelp();
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
        handleUndo();
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
    }

    // Leader key: Ctrl+X
    if (key.ctrl && name === "x") {
      actions.setLeaderMode(true);
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
    actions.startDescribe(node.descriptionTitle || "");
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
      try {
        await opRebase(state.rebaseSourceId, node.changeId);
      } catch (e) {
        actions.setStatusMessage(`Error: ${String(e)}`);
        actions.setRebaseSource(null);
      }
    }
  };

  const handleInsert = async () => {
    const node = selectedNode();
    if (!node) return;
    const child = state.layoutResult.nodes.find((n) => n.parents.includes(node.changeId));
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
    const parents = Array.from(state.mergeSelectedIds);
    if (parents.length < 2) {
      actions.setStatusMessage("Merge: select at least 2 commits");
      return;
    }
    try {
      await opMerge(parents);
      actions.setMergeMode(false);
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

  const showSidebar = () => state.termSize.width >= 90 && state.termSize.height >= 16;
  const detailW = () => showSidebar() ? Math.floor(state.termSize.width * 0.40) : 0;
  const graphW = () => state.termSize.width - detailW();
  // 1 row for StatusBar + 1 row for FooterBar = 2 rows
  const mainHeight = () => state.termSize.height - 2;

  return (
    <box width={state.termSize.width} height={state.termSize.height} backgroundColor={BG} flexDirection="column">
      {/* Top status bar */}
      <StatusBar />

      <box flexDirection="row" flexGrow={1} height={mainHeight()}>
        <box width={graphW()} height={mainHeight()}>
        {state.viewMode === "log" && (
            <GraphView
              nodes={state.layoutResult.nodes}
              selectedId={state.selectedId}
              scrollOffset={state.scrollOffset}
              filesCache={state.filesCache}
              width={graphW()}
              height={mainHeight()}
              onEnsureVisible={ensureSelectedVisible}
              layoutMode={state.layoutMode}
              mergeMode={state.mergeMode}
              mergeSelectedIds={state.mergeSelectedIds}
            />
          )}
          {state.viewMode === "oplog" && (
            <OpLogView
              entries={state.opLogEntries}
              selectedId={state.opLogSelectedId}
              scrollOffset={state.scrollOffset}
              width={graphW()}
              height={mainHeight()}
              onEnsureVisible={ensureOpLogVisible}
            />
          )}
          {state.viewMode === "obslog" && (
            <ObslogView
              entries={state.obslogEntries}
              scrollOffset={state.scrollOffset}
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
               descExpanded={state.descExpanded}
               filesExpanded={state.filesExpanded}
               scrollOffset={state.sidebarScroll}
               width={detailW()}
               height={mainHeight()}
               showHelp={state.showHelp}
               promptMode={state.describeMode}
               promptValue={state.describeValue}
               cursorPos={state.cursorPos}
               mergeMode={state.mergeMode}
               mergeSelectedIds={state.mergeSelectedIds}
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
