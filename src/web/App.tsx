import { render } from "solid-js/web";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, Switch, Match } from "solid-js";
import { actions, navigation, selectedNode, state, layoutResult } from "../core/state";
import { webActions, webState } from "../core/state-web";
import { setBackend } from "../core/runtime";
import { ensureFiles, fetchDiff, opAbandon, opBookmarkDelete, opBookmarkRename, opBookmarkSet, opBookmarkTrack, opBookmarkUntrack, opDescribe, opDuplicate, opEdit, opGitFetch, opGitPush, opInsertAfter, opInsertBetween, opMerge, opMove, opNew, opRebase, opRedo, opRestore, opRestoreOperation, opSquash, opSplit, opUndo, refreshLog, refreshOpLog, refreshObslog } from "../core/usecases";
import { createWebBackend } from "./backend";
import { CanvasGraph } from "./components/CanvasGraph";
import { Sidebar } from "./components/Sidebar";
import { OpLogView } from "./components/OpLogView";
import { ObslogView } from "./components/ObslogView";
import { OpLogSidebar } from "./components/OpLogSidebar";
import { ObslogSidebar } from "./components/ObslogSidebar";
import { ConfirmModal } from "./components/ConfirmModal";

type PersistedLayout = {
  layoutMode?: string;
  pinned?: Array<[string, number]>;
  viewport?: { offsetX: number; offsetY: number; scale: number };
  revset?: string;
};

type ConfirmRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
  run: () => void;
};

function App() {
  const [diffText, setDiffText] = createSignal<string>("");
  const [pendingConfirm, setPendingConfirm] = createSignal<ConfirmRequest | null>(null);
  const [revsetDraft, setRevsetDraft] = createSignal("");

  const selected = createMemo(() => selectedNode());
  const multiCount = createMemo(() => state.selectedIds.size);

  const persistKey = "jj-viz-layout";
  let pollingInterval: ReturnType<typeof setInterval> | null = null;
  let sse: EventSource | null = null;
  let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let sseBackoffMs = 1000;
  let sseConnected = false;
  let pollInFlight = false;
  let lastNodesHash: string | null = null;
  const onVisibilityChange = () => {
    void pollForUpdates();
  };

  const stopPollingLoop = () => {
    if (!pollingInterval) return;
    clearInterval(pollingInterval);
    pollingInterval = null;
  };

  const ensurePollingLoop = () => {
    if (pollingInterval) return;
    pollingInterval = setInterval(() => {
      void pollForUpdates();
    }, 3000);
  };

  const hashNodes = (nodes: unknown) => {
    try {
      return JSON.stringify(nodes);
    } catch {
      return null;
    }
  };

  const pollForUpdates = async () => {
    if (document.visibilityState === "hidden") return;
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const q = new URLSearchParams({ limit: "500" });
      if (state.revsetQuery && state.revsetQuery.trim()) q.set("revset", state.revsetQuery.trim());
      const response = await fetch(`/api/log?${q.toString()}`, { cache: "no-store" });
      if (!response.ok) return;
      const nodes = await response.json();
      if (!Array.isArray(nodes)) return;

      const newHash = hashNodes(nodes);
      if (newHash && newHash !== lastNodesHash) {
        lastNodesHash = newHash;
        actions.setNodes(nodes as any);
      }
    } catch {
      // Keep polling loop resilient; regular refresh/mutations surface errors.
    } finally {
      pollInFlight = false;
    }
  };

  const scheduleSseReconnect = () => {
    if (sseReconnectTimer) return;
    sseReconnectTimer = setTimeout(() => {
      sseReconnectTimer = null;
      connectSse();
    }, sseBackoffMs);
    sseBackoffMs = Math.min(15_000, sseBackoffMs * 2);
  };

  const handleRepoEvent = () => {
    void pollForUpdates();
  };

  const connectSse = () => {
    if (typeof window === "undefined") return;
    if (!("EventSource" in window)) {
      ensurePollingLoop();
      return;
    }

    if (sse) {
      sse.close();
      sse = null;
    }

    sseConnected = false;

    const client = new EventSource("/api/events");
    sse = client;

    client.addEventListener("open", () => {
      sseConnected = true;
      sseBackoffMs = 1000;
      stopPollingLoop();
    });

    client.addEventListener("repo-updated", handleRepoEvent as EventListener);
    client.addEventListener("ready", handleRepoEvent as EventListener);

    client.onerror = () => {
      if (!sseConnected) {
        ensurePollingLoop();
      } else {
        sseConnected = false;
        ensurePollingLoop();
      }
      if (sse) {
        sse.close();
        sse = null;
      }
      scheduleSseReconnect();
    };
  };

  onMount(() => {
    setBackend(createWebBackend());
    // Restore layout state for the web UI (best-effort)
    try {
      const raw = localStorage.getItem(persistKey);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedLayout;
        if (parsed.layoutMode && typeof parsed.layoutMode === "string") {
          actions.setLayoutMode(parsed.layoutMode as any);
        }
        if (Array.isArray(parsed.pinned)) {
          actions.setPinnedNodes(new Map(parsed.pinned));
        }
        if (parsed.viewport) {
          webActions.setViewport(parsed.viewport);
        }
        if (typeof parsed.revset === "string") {
          actions.setRevsetQuery(parsed.revset);
        }
      }
    } catch {
      // ignore
    }

    void (async () => {
      // Fetch repo info (cwd)
      try {
        const resp = await fetch("/api/repo");
        if (resp.ok) {
          const data = await resp.json();
          if (data.cwd) actions.setCwd(data.cwd);
        }
      } catch {
        // ignore
      }
      await refresh();
      lastNodesHash = hashNodes(state.nodes);
      setRevsetDraft(state.revsetQuery || "");
    })();

    ensurePollingLoop();
    connectSse();
    document.addEventListener("visibilitychange", onVisibilityChange);
  });

  onCleanup(() => {
    stopPollingLoop();
    if (sseReconnectTimer) {
      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = null;
    }
    if (sse) {
      sse.close();
      sse = null;
    }
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });

  createEffect(() => {
    // Persist layout + pinned nodes + viewport (best-effort)
    try {
      const payload: PersistedLayout = {
        layoutMode: state.layoutMode,
        pinned: Array.from(state.pinnedNodes.entries()),
        viewport: webState.viewport,
        revset: state.revsetQuery,
      };
      localStorage.setItem(persistKey, JSON.stringify(payload));
    } catch {
      // ignore
    }
  });

  const refresh = async () => {
    try {
      await refreshLog(500);
    } catch (e) {
      // status already set
    }
  };

  const maybeRunDestructive = (title: string, run: () => void, confirmLabel = "Confirm") => {
    setPendingConfirm({
      title,
      body: "Review and confirm to continue.",
      confirmLabel,
      cancelLabel: "Cancel",
      destructive: true,
      run,
    });
  };

  const bookmarkAwareMessage = (base: string) => {
    const n = selected();
    if (!n) return base;
    const local = (n.bookmarks || []).filter((b) => !b.includes("@"));
    if (local.length === 0) return base;
    return `${base}\nBookmarks on this change: ${local.join(", ")}`;
  };

  const isError = createMemo(() => (state.statusMessage || "").toLowerCase().startsWith("error"));
  const headerMode = createMemo(() => (state.viewMode === "log" ? "log" : state.viewMode));
  const headerContext = createMemo(() => {
    if (state.viewMode === "log") return state.layoutMode;
    if (state.viewMode === "obslog") return state.obslogChangeId ? `change:${state.obslogChangeId.slice(0, 8)}` : "change:none";
    return "operation history";
  });

  // Mode badge colors (TUI-inspired)
  const modeBadgeColor = createMemo(() => {
    if (state.describeMode) return "#7f9fbf"; // info
    if (state.rebaseSourceId) return "#c9a86a"; // warn
    return "#6f89ad"; // modeLog
  });

  const modeLabel = createMemo(() => {
    if (state.describeMode) return "DESCRIBE";
    if (state.rebaseSourceId) return "REBASE";
    return state.viewMode === "log" ? "LOG" : state.viewMode.toUpperCase();
  });

  // Working copy info (TUI FooterBar parity)
  const workingCopy = createMemo(() => {
    return state.nodes.find(n => n.isWorkingCopy);
  });

  const wcChangeId = createMemo(() => {
    const wc = workingCopy();
    return wc ? `@${wc.changeId.slice(0, 8)}` : "";
  });

  const currentBookmark = createMemo(() => {
    const wc = workingCopy();
    if (!wc?.bookmarks?.length) return "";
    const first = wc.bookmarks[0];
    const more = wc.bookmarks.length > 1 ? `+${wc.bookmarks.length - 1}` : "";
    return `${first}${more}`;
  });
  const footerPrimaryHint = createMemo(() => {
    if (state.viewMode === "oplog") return "j/k move · PgUp/PgDn jump · Enter restore · g/Esc back";
    if (state.viewMode === "obslog") return "j/k move · PgUp/PgDn jump · r refresh · g/Esc back";
    if (state.describeMode) return "Enter save description · Esc cancel · h help";
    if (state.rebaseSourceId) return `rebase source:${state.rebaseSourceId.slice(0, 8)} · select destination · b rebase · Esc cancel`;
    return "j/k move · 1-5 layout · / revset · h help";
  });
  const footerSecondaryHint = createMemo(() => {
    if (state.viewMode !== "log") return "";
    if (state.describeMode || state.rebaseSourceId) return "";
    return "Shift/Ctrl select · Alt+drag move/pin · Right-click pin · Alt+click insert";
  });

  createEffect(() => {
    const node = selected();
    if (!node) {
      setDiffText("");
      return;
    }

    // Keep the inspector hydrated (files + diff) for the currently selected commit.
    void (async () => {
      try {
        await ensureFiles(node.changeId);
      } catch {
        const next = new Map(state.filesCache);
        next.set(node.changeId, { atMs: Date.now(), files: [] });
        actions.setFilesCache(next);
      }
    })();

    void (async () => {
      try {
        const diff = await fetchDiff(node.changeId);
        setDiffText(diff);
      } catch (e) {
        setDiffText(String(e));
      }
    })();
  });

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
    const node = selected();
    if (!node) {
      actions.setStatusMessage("Select a commit first");
      return;
    }
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

  const onKeyDown = (e: KeyboardEvent) => {
    if (pendingConfirm()) return;

    // Help overlay
    if (webState.showHelp) {
      if (e.key === "Escape" || e.key.toLowerCase() === "h") {
        webActions.toggleHelp();
      }
      return;
    }

    if (state.describeMode) {
      if (e.key === "Enter") {
        void describeSubmit();
      } else if (e.key === "Escape") {
        actions.cancelDescribe();
      }
      return;
    }

    // View-specific shortcuts
    if (state.viewMode === "oplog") {
      const k = e.key.toLowerCase();
      if (k === "g" || e.key === "Escape") {
        handleBackToLog();
        return;
      }
      if (k === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        navigation.moveDown();
        return;
      }
      if (k === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        navigation.moveUp();
        return;
      }
      if (e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        const entries = state.opLogEntries;
        if (entries.length === 0) return;
        const cur = Math.max(0, entries.findIndex((x) => x.id === state.opLogSelectedId));
        const next = e.key === "PageDown" ? Math.min(entries.length - 1, cur + 10) : Math.max(0, cur - 10);
        actions.selectOpLogEntry(entries[next]!.id);
        return;
      }
      if (e.key === "Enter") {
        if (!state.opLogSelectedId) return;
        void (async () => {
          try {
            await opRestoreOperation(state.opLogSelectedId!);
            await refreshOpLog(100);
            actions.setStatusMessage("Operation restored");
          } catch (err) {
            actions.setStatusMessage(`Error: ${String(err)}`);
          }
        })();
        return;
      }
      if (k === "u") {
        maybeRunDestructive("Undo last operation?", () => {
          void opUndo();
        }, "Undo");
        return;
      }
      if (k === "r") {
        if (e.shiftKey) {
          maybeRunDestructive("Redo last operation?", () => {
            void opRedo();
          }, "Redo");
        }
        else void refreshOpLog(100);
        return;
      }
      return;
    }

    if (state.viewMode === "obslog") {
      const k = e.key.toLowerCase();
      if (k === "g" || e.key === "Escape") {
        handleBackToLog();
        return;
      }
      if (k === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        actions.setObslogSelectedIndex(state.obslogSelectedIndex + 1);
        return;
      }
      if (k === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        actions.setObslogSelectedIndex(state.obslogSelectedIndex - 1);
        return;
      }
      if (e.key === "PageDown") {
        e.preventDefault();
        actions.setObslogSelectedIndex(state.obslogSelectedIndex + 10);
        return;
      }
      if (e.key === "PageUp") {
        e.preventDefault();
        actions.setObslogSelectedIndex(state.obslogSelectedIndex - 10);
        return;
      }
      if (k === "r") {
        if (!state.obslogChangeId) return;
        void refreshObslog(state.obslogChangeId, 50);
        return;
      }
      return;
    }

    if (e.key.toLowerCase() === "h") {
      webActions.toggleHelp();
      return;
    }

    if (e.key === "Escape") {
      actions.setRebaseSource(null);
      webActions.resetOpMode();
      return;
    }

    switch (e.key.toLowerCase()) {
      case "j":
      case "arrowdown":
        webActions.resetOpMode();
        navigation.moveDown();
        break;
      case "k":
      case "arrowup":
        webActions.resetOpMode();
        navigation.moveUp();
        break;
      case "r":
        if (e.shiftKey) {
          maybeRunDestructive("Redo last operation?", () => {
            void opRedo();
          }, "Redo");
        } else {
          void refresh();
        }
        break;
      case "f":
        void toggleInlineFilesForSelected();
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
      case "o":
        void handleOpLog();
        break;
      case "v":
        void handleObslog();
        break;
      case "b": {
        const node = selected();
        if (!node) break;
        if (!state.rebaseSourceId) {
          actions.setRebaseSource(node.changeId);
          actions.setStatusMessage(`Rebase: source ${node.changeId.slice(0, 8)} selected`);
        } else {
          const sourceId = state.rebaseSourceId;
          maybeRunDestructive(`Rebase ${sourceId.slice(0, 8)} onto ${node.changeId.slice(0, 8)}?`, () => {
            void opRebase(sourceId, node.changeId);
          }, "Rebase");
        }
        break;
      }
      case "n": {
        const node = selected();
        if (!node) break;
        void opNew(node.changeId);
        break;
      }
      case "e": {
        const node = selected();
        if (!node) break;
        void opEdit(node.changeId);
        break;
      }
      case "d": {
        const node = selected();
        if (!node) break;
        actions.startDescribe(node.descriptionFull || node.descriptionTitle || "");
        break;
      }
      case "u":
        maybeRunDestructive("Undo last operation?", () => {
          void opUndo();
        }, "Undo");
        break;
      case "i": {
        const node = selected();
        if (!node) break;
        void opInsertAfter(node.changeId);
        break;
      }
    }
  };

  const describeSubmit = async () => {
    const node = selected();
    if (!node) return;
    const value = state.describeValue;
    actions.cancelDescribe();
    await opDescribe(node.changeId, value);
  };

  const handleMergeSelected = async () => {
    const parents = Array.from(state.selectedIds);
    if (parents.length < 2) return;
    await opMerge(parents);
  };

  const handleExecuteOp = async () => {
    const node = selected();
    if (!node) return;
    const paths = Array.from(webState.opSelectedPaths);

    if (webState.opMode === "split") {
      if (paths.length === 0) {
        actions.setStatusMessage("Split: select at least one file");
        return;
      }
      await opSplit(node.changeId, paths);
      webActions.resetOpMode();
      return;
    }

    if (webState.opMode === "squash") {
      // Squash selected paths (or all if none) into parent
      await opSquash(node.changeId, { paths: paths.length > 0 ? paths : undefined });
      webActions.resetOpMode();
      return;
    }

    if (webState.opMode === "move") {
      if (!webState.opTargetId) {
        actions.setStatusMessage("Move: click a target node in the graph");
        return;
      }
      await opSquash(node.changeId, { intoId: webState.opTargetId, paths: paths.length > 0 ? paths : undefined });
      webActions.resetOpMode();
      return;
    }
  };

  const toggleInlineFilesForSelected = async () => {
    const sel = state.selectedId;
    if (!sel) return;

    const prev = webState.expandedFilesNodeId;
    if (prev && prev !== sel) {
      actions.setNodeExtraHeight(prev, 0);
    }

    if (webState.expandedFilesNodeId === sel) {
      webActions.setExpandedFilesNode(null);
      actions.setNodeExtraHeight(sel, 0);
      return;
    }

    webActions.setExpandedFilesNode(sel);
    try {
      const files = await ensureFiles(sel);
      actions.setNodeExtraHeight(sel, files.length * 14 + 34);
    } catch {
      actions.setNodeExtraHeight(sel, 0);
    }
  };

  // Global key handler on window so canvas focus isn't required.
  const onWinKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Shift") (window as any).__jjvShiftActive = true;
    onKeyDown(e);
  };
  const onWinKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Shift") (window as any).__jjvShiftActive = false;
  };
  onMount(() => {
    (window as any).__jjvShiftActive = false;
    window.addEventListener("keydown", onWinKeyDown);
    window.addEventListener("keyup", onWinKeyUp);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onWinKeyDown);
    window.removeEventListener("keyup", onWinKeyUp);
  });

  return (
    <div class="jjv-root">
      <header class="jjv-header">
        <div class="jjv-headerMain">
          <div class="jjv-brand">
            <span
              class="jjv-modeBadge"
              style={{ "background-color": modeBadgeColor() }}
            >
              {modeLabel()}
            </span>
            <Show when={state.rebaseSourceId}>
              <span class="jjv-rebaseSource">source:{state.rebaseSourceId?.slice(0, 8)}</span>
            </Show>
          </div>

          <div class="jjv-controls">
            <Show when={state.viewMode === "log"}>
              <select
                class="jjv-select"
                value={state.layoutMode}
                onChange={(e) => actions.setLayoutMode((e.currentTarget.value as any) || "chronological")}
              >
                <option value="chronological">Chronological</option>
                <option value="mainline">Mainline</option>
                <option value="bookmark-centric">Bookmark-centric</option>
                <option value="wc-focused">WC-focused</option>
                <option value="topological">Topological</option>
              </select>

              <div class="jjv-row jjv-row--wrap">
                <input
                  class="jjv-input mono"
                  placeholder="revset (e.g. ::@, @::, bookmarks())"
                  value={revsetDraft()}
                  onInput={(e) => setRevsetDraft(e.currentTarget.value)}
                />
                <button class="jjv-btn jjv-btn--ghost" onClick={() => {
                  actions.setRevsetQuery(revsetDraft().trim());
                  void refresh();
                }}>Apply</button>
                <button class="jjv-btn jjv-btn--ghost" onClick={() => {
                  setRevsetDraft("");
                  actions.setRevsetQuery("");
                  void refresh();
                }}>Clear</button>
              </div>

              <button class="jjv-btn jjv-btn--ghost" onClick={() => void opGitFetch()}>Fetch</button>
              <button class="jjv-btn jjv-btn--ghost" onClick={() => void opGitPush()}>Push</button>
            </Show>

            <button class="jjv-btn" disabled={state.isLoading} onClick={() => void refresh()}>
              Refresh
            </button>
            <button class="jjv-btn jjv-btn--ghost" disabled={state.isLoading} onClick={() => {
              maybeRunDestructive("Undo last operation?", () => {
                void opUndo();
              }, "Undo");
            }}>
              Undo
            </button>
            <button class="jjv-btn jjv-btn--ghost" disabled={state.isLoading} onClick={() => {
              maybeRunDestructive("Redo last operation?", () => {
                void opRedo();
              }, "Redo");
            }}>
              Redo
            </button>
          </div>
        </div>

        <div class="jjv-headerRail">
          <div class="jjv-viewTabs">
            <button
              class={`jjv-btn ${state.viewMode === "log" ? "jjv-btn--primary" : "jjv-btn--ghost"}`}
              onClick={() => actions.setViewMode("log")}
            >
              Log
            </button>
            <button
              class={`jjv-btn ${state.viewMode === "oplog" ? "jjv-btn--primary" : "jjv-btn--ghost"}`}
              onClick={() => void handleOpLog()}
            >
              Op Log
            </button>
            <button
              class={`jjv-btn ${state.viewMode === "obslog" ? "jjv-btn--primary" : "jjv-btn--ghost"}`}
              disabled={!selected()}
              onClick={() => void handleObslog()}
            >
              Obslog
            </button>
          </div>
        </div>
      </header>

      <main class="jjv-main">
        <section class="jjv-canvasPane">
          <Switch>
            <Match when={state.viewMode === "log"}>
              <CanvasGraph
                onMoveCommit={(sourceId, destinationId) => void opMove(sourceId, destinationId)}
                onInsertBetween={(parentId, childId) => void opInsertBetween(parentId, childId)}
                onInsertAfter={(afterId) => void opInsertAfter(afterId)}
                onRebase={(sourceId, destinationId) => {
                  maybeRunDestructive(`Rebase ${sourceId.slice(0, 8)} onto ${destinationId.slice(0, 8)}?`, () => {
                    void opRebase(sourceId, destinationId);
                  }, "Rebase");
                }}
                onToggleInlineFiles={() => void toggleInlineFilesForSelected()}
                onInlineAction={(action, nodeId) => {
                  if (action === "files") {
                    // Toggle files for the specific node whose button was clicked
                    void (async () => {
                      const prev = webState.expandedFilesNodeId;
                      // If clicking the same node, close it
                      if (prev === nodeId) {
                        webActions.setExpandedFilesNode(null);
                        actions.setNodeExtraHeight(nodeId, 0);
                        return;
                      }
                      // Close previous if different
                      if (prev) {
                        actions.setNodeExtraHeight(prev, 0);
                      }
                      // Open the clicked node's files
                      webActions.setExpandedFilesNode(nodeId);
                      try {
                        const files = await ensureFiles(nodeId);
                        // Reserve room for inline controls + padding + files.
                        actions.setNodeExtraHeight(nodeId, files.length * 14 + 34);
                      } catch (e) {
                        actions.setStatusMessage(`Error: ${String(e)}`);
                        actions.setNodeExtraHeight(nodeId, 0);
                      }
                    })();
                    return;
                  }
                  if (action === "rebase") {
                    if (!state.rebaseSourceId) {
                      actions.setRebaseSource(nodeId);
                    } else {
                      const sourceId = state.rebaseSourceId;
                      maybeRunDestructive(`Rebase ${sourceId.slice(0, 8)} onto ${nodeId.slice(0, 8)}?`, () => {
                        void opRebase(sourceId, nodeId);
                      }, "Rebase");
                    }
                    return;
                  }
                  if (action === "describe") {
                    const node = layoutResult().nodes.find(n => n.changeId === nodeId);
                    if (!node) return;
                    actions.startDescribe(node.descriptionFull || node.descriptionTitle || "");
                    // Select the node so describe operates on it
                    actions.selectNode(nodeId);
                    return;
                  }
                  if (action === "new") void opNew(nodeId);
                  if (action === "edit") void opEdit(nodeId);
                  if (action === "abandon") {
                    maybeRunDestructive(bookmarkAwareMessage(`Abandon ${nodeId.slice(0, 8)}?`), () => {
                      void opAbandon(nodeId);
                    }, "Abandon");
                  }
                  if (action === "duplicate") void opDuplicate(nodeId);
                  if (action === "squash") {
                    maybeRunDestructive(`Squash ${nodeId.slice(0, 8)} into parent?`, () => {
                      void opSquash(nodeId);
                    }, "Squash");
                  }
                }}
              />
            </Match>
            <Match when={state.viewMode === "oplog"}>
              <OpLogView
                entries={state.opLogEntries}
                selectedId={state.opLogSelectedId}
                onSelectEntry={(id) => actions.selectOpLogEntry(id)}
                onUndo={() => {
                  maybeRunDestructive("Undo last operation?", () => {
                    void opUndo();
                  }, "Undo");
                }}
                onRedo={() => {
                  maybeRunDestructive("Redo last operation?", () => {
                    void opRedo();
                  }, "Redo");
                }}
                onRestore={async () => {
                  if (!state.opLogSelectedId) return;
                  try {
                    await opRestoreOperation(state.opLogSelectedId);
                    await refreshOpLog(100);
                    actions.setStatusMessage("Operation restored");
                  } catch (e) {
                    actions.setStatusMessage(`Error: ${String(e)}`);
                  }
                }}
                onBackToLog={handleBackToLog}
              />
            </Match>
            <Match when={state.viewMode === "obslog"}>
              <ObslogView
                entries={state.obslogEntries}
                changeId={state.obslogChangeId}
                selectedIndex={state.obslogSelectedIndex}
                onSelectIndex={(idx) => actions.setObslogSelectedIndex(idx)}
                onBackToLog={handleBackToLog}
              />
            </Match>
          </Switch>
        </section>

        <aside class="jjv-sidebar">
          <Switch>
            <Match when={state.viewMode === "log"}>
              <Sidebar
                diffText={diffText()}
                onMergeSelected={() => void handleMergeSelected()}
                onExecuteOp={() => void handleExecuteOp()}
                onDescribeSubmit={() => void describeSubmit()}
                onRestore={(paths) => {
                  const node = selected();
                  if (!node) return;
                  maybeRunDestructive("Restore selected paths?", () => {
                    void opRestore(node.changeId, paths);
                  }, "Restore");
                }}
                onBookmarkSet={(name) => {
                  const node = selected();
                  if (!node) return;
                  void opBookmarkSet(name, node.changeId);
                }}
                onBookmarkDelete={(name) => {
                  maybeRunDestructive(`Delete bookmark ${name}?`, () => {
                    void opBookmarkDelete(name);
                  }, "Delete");
                }}
                onBookmarkRename={(oldName, newName) => {
                  void opBookmarkRename(oldName, newName);
                }}
                onBookmarkTrack={(remoteBookmark) => {
                  void opBookmarkTrack(remoteBookmark);
                }}
                onBookmarkUntrack={(remoteBookmark) => {
                  maybeRunDestructive(`Untrack ${remoteBookmark}?`, () => {
                    void opBookmarkUntrack(remoteBookmark);
                  }, "Untrack");
                }}
                onRunMutation={(kind) => {
                  const node = selected();
                  if (!node) return;
                  if (kind === "edit") void opEdit(node.changeId);
                  if (kind === "new") void opNew(node.changeId);
                  if (kind === "abandon") {
                    maybeRunDestructive(bookmarkAwareMessage(`Abandon ${node.changeId.slice(0, 8)}?`), () => {
                      void opAbandon(node.changeId);
                    }, "Abandon");
                  }
                  if (kind === "duplicate") void opDuplicate(node.changeId);
                  if (kind === "rebase") {
                    if (!state.rebaseSourceId) {
                      actions.setRebaseSource(node.changeId);
                    } else {
                      const sourceId = state.rebaseSourceId;
                      maybeRunDestructive(`Rebase ${sourceId.slice(0, 8)} onto ${node.changeId.slice(0, 8)}?`, () => {
                        void opRebase(sourceId, node.changeId);
                      }, "Rebase");
                    }
                  }
                  if (kind === "describe") {
                    actions.startDescribe(node.descriptionFull || node.descriptionTitle || "");
                  }
                }}
              />

              <Show when={multiCount() > 1}>
                <div class="jjv-toast">Multi-select: {multiCount()} commits selected</div>
              </Show>
            </Match>

            <Match when={state.viewMode === "oplog"}>
              <OpLogSidebar
                entries={state.opLogEntries}
                selectedId={state.opLogSelectedId}
                onUndo={() => {
                  maybeRunDestructive("Undo last operation?", () => {
                    void opUndo();
                  }, "Undo");
                }}
                onRedo={() => {
                  maybeRunDestructive("Redo last operation?", () => {
                    void opRedo();
                  }, "Redo");
                }}
                onRestore={async () => {
                  if (!state.opLogSelectedId) return;
                  try {
                    await opRestoreOperation(state.opLogSelectedId);
                    await refreshOpLog(100);
                    actions.setStatusMessage("Operation restored");
                  } catch (e) {
                    actions.setStatusMessage(`Error: ${String(e)}`);
                  }
                }}
                onRefresh={() => void refreshOpLog(100)}
              />
            </Match>

            <Match when={state.viewMode === "obslog"}>
              <ObslogSidebar
                entries={state.obslogEntries}
                changeId={state.obslogChangeId}
                selectedIndex={state.obslogSelectedIndex}
                onRefresh={() => {
                  if (!state.obslogChangeId) return;
                  void refreshObslog(state.obslogChangeId, 50);
                }}
              />
            </Match>
          </Switch>
        </aside>
      </main>

      <footer class="jjv-footer">
        <div class="jjv-footerLeft">
          <Show when={state.cwd}>
            <span class="jjv-footerSegment jjv-footerPath">{state.cwd}</span>
          </Show>
          <Show when={currentBookmark()}>
            <span class="jjv-footerBookmark">{currentBookmark()}</span>
          </Show>
          <Show when={wcChangeId()}>
            <span class="jjv-footerWc">{wcChangeId()}</span>
          </Show>
        </div>

        <div class="jjv-footerCenter">
          <span class="jjv-footerHints">{footerPrimaryHint()}</span>
        </div>

        <div class="jjv-footerRight">
          <span class="jjv-footerMeta">{state.layoutMode}</span>
          <span class={`jjv-footerStatus ${isError() ? "jjv-footerStatus--error" : ""}`}>
            {state.statusMessage || "ready"}
          </span>
        </div>
      </footer>

      <ConfirmModal
        open={!!pendingConfirm()}
        title={pendingConfirm()?.title || ""}
        body={pendingConfirm()?.body || ""}
        confirmLabel={pendingConfirm()?.confirmLabel || "Confirm"}
        cancelLabel={pendingConfirm()?.cancelLabel || "Cancel"}
        destructive={pendingConfirm()?.destructive || false}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const request = pendingConfirm();
          if (!request) return;
          setPendingConfirm(null);
          request.run();
        }}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(() => <App />, root);
