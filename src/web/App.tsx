import { render } from "solid-js/web";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { actions, navigation, selectedNode, state } from "../core/state";
import { api } from "./api";
import { CanvasGraph } from "./components/CanvasGraph";
import { Sidebar } from "./components/Sidebar";

type PersistedLayout = {
  layoutMode?: string;
  pinned?: Array<[string, number]>;
  viewport?: { offsetX: number; offsetY: number; scale: number };
};

function App() {
  const [diffText, setDiffText] = createSignal<string>("");
  const [isBusy, setIsBusy] = createSignal(false);

  const selected = createMemo(() => selectedNode());
  const multiCount = createMemo(() => state.selectedIds.size);

  const persistKey = "jj-viz-layout";

  onMount(() => {
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
          actions.setViewport(parsed.viewport);
        }
      }
    } catch {
      // ignore
    }

    void refresh();
  });

  createEffect(() => {
    // Persist layout + pinned nodes + viewport (best-effort)
    try {
      const payload: PersistedLayout = {
        layoutMode: state.layoutMode,
        pinned: Array.from(state.pinnedNodes.entries()),
        viewport: state.viewport,
      };
      localStorage.setItem(persistKey, JSON.stringify(payload));
    } catch {
      // ignore
    }
  });

  const setFilesCacheEntry = (changeId: string, files: Array<{ type: string; path: string }>) => {
    const next = new Map(state.filesCache);
    next.set(changeId, { atMs: Date.now(), files });
    actions.setFilesCache(next);
  };

  const ensureFiles = async (changeId: string) => {
    const cached = state.filesCache.get(changeId);
    if (cached && Date.now() - cached.atMs < 30_000) return cached.files;
    const files = await api.files(changeId);
    setFilesCacheEntry(changeId, files);
    return files;
  };

  const refresh = async () => {
    if (isBusy()) return;
    setIsBusy(true);
    actions.setStatusMessage("Loading...");
    try {
      const nodes = await api.log(500);
      actions.setNodes(nodes);
      actions.setStatusMessage(`nodes:${nodes.length}`);
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const isError = createMemo(() => (state.statusMessage || "").toLowerCase().startsWith("error"));

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
        setFilesCacheEntry(node.changeId, []);
      }
    })();

    void (async () => {
      try {
        const diff = await api.diff(node.changeId);
        setDiffText(diff);
      } catch (e) {
        setDiffText(String(e));
      }
    })();
  });

  const toggleExpandedFilesForSelected = async () => {
    const node = selected();
    if (!node) return;

    const prev = state.expandedFilesNodeId;
    if (prev && prev !== node.changeId) {
      actions.setNodeExtraHeight(prev, 0);
    }

    if (state.expandedFilesNodeId === node.changeId) {
      actions.setExpandedFilesNode(null);
      actions.setNodeExtraHeight(node.changeId, 0);
      return;
    }

    actions.setExpandedFilesNode(node.changeId);
    try {
      const files = await ensureFiles(node.changeId);
      // Match the legacy UI's spacing heuristics
      actions.setNodeExtraHeight(node.changeId, files.length * 14 + 10);
    } catch {
      actions.setNodeExtraHeight(node.changeId, 0);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (state.describeMode) {
      if (e.key === "Enter") {
        void describeSubmit();
      } else if (e.key === "Escape") {
        actions.cancelDescribe();
      }
      return;
    }

    if (e.key === "Escape") {
      actions.setRebaseSource(null);
      actions.resetOpMode();
      return;
    }

    switch (e.key.toLowerCase()) {
      case "j":
      case "arrowdown":
        navigation.moveDown();
        break;
      case "k":
      case "arrowup":
        navigation.moveUp();
        break;
      case "r":
        void refresh();
        break;
      case "f":
        void toggleExpandedFilesForSelected();
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
      case "b": {
        const node = selected();
        if (!node) break;
        if (!state.rebaseSourceId) {
          actions.setRebaseSource(node.changeId);
          actions.setStatusMessage(`Rebase: source ${node.changeId.slice(0, 8)} selected`);
        } else {
          void doRebase(state.rebaseSourceId, node.changeId);
        }
        break;
      }
      case "n": {
        const node = selected();
        if (!node) break;
        void runMutation(() => api.new({ parentId: node.changeId }));
        break;
      }
      case "e": {
        const node = selected();
        if (!node) break;
        void runMutation(() => api.edit({ changeId: node.changeId }));
        break;
      }
      case "d": {
        const node = selected();
        if (!node) break;
        actions.startDescribe(node.descriptionFull || node.descriptionTitle || "");
        break;
      }
      case "u":
        void runMutation(() => api.undo());
        break;
      case "i": {
        const node = selected();
        if (!node) break;
        void runMutation(() => api.insert({ afterId: node.changeId }));
        break;
      }
    }
  };

  const runMutation = async (fn: () => Promise<unknown>) => {
    if (isBusy()) return;
    setIsBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      actions.setStatusMessage(`Error: ${String(e)}`);
    } finally {
      setIsBusy(false);
    }
  };

  const doRebase = async (sourceId: string, destinationId: string) => {
    if (sourceId === destinationId) return;
    actions.setStatusMessage(`Rebasing ${sourceId.slice(0, 8)} onto ${destinationId.slice(0, 8)}...`);
    await runMutation(() => api.rebase({ sourceId, destinationId }));
    actions.setRebaseSource(null);
  };

  const describeSubmit = async () => {
    const node = selected();
    if (!node) return;
    const value = state.describeValue;
    actions.cancelDescribe();
    await runMutation(() => api.describe({ changeId: node.changeId, description: value }));
  };

  const handleMergeSelected = async () => {
    const parents = Array.from(state.selectedIds);
    if (parents.length < 2) return;
    await runMutation(() => api.new({ parentIds: parents }));
  };

  const handleExecuteOp = async () => {
    const node = selected();
    if (!node) return;
    const paths = Array.from(state.opSelectedPaths);

    if (state.opMode === "split") {
      if (paths.length === 0) {
        actions.setStatusMessage("Split: select at least one file");
        return;
      }
      await runMutation(() => api.split({ changeId: node.changeId, paths }));
      actions.resetOpMode();
      return;
    }

    if (state.opMode === "squash") {
      // Squash selected paths (or all if none) into parent
      await runMutation(() => api.squash({ changeId: node.changeId, paths: paths.length > 0 ? paths : undefined }));
      actions.resetOpMode();
      return;
    }

    if (state.opMode === "move") {
      if (!state.opTargetId) {
        actions.setStatusMessage("Move: click a target node in the graph");
        return;
      }
      await runMutation(() => api.squash({ changeId: node.changeId, intoId: state.opTargetId, paths: paths.length > 0 ? paths : undefined }));
      actions.resetOpMode();
      return;
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
        <div class="jjv-brand">
          <span class="jjv-title">jj-viz</span>
          <span class="jjv-sub">web</span>
          <span class={`jjv-meta ${isError() ? "jjv-meta--error" : ""}`}>{state.statusMessage}</span>
        </div>

        <div class="jjv-controls">
          <button class="jjv-btn jjv-btn--ghost" disabled={isBusy() || !selected()} onClick={() => {
            const node = selected();
            if (!node) return;
            void runMutation(() => api.edit({ changeId: node.changeId }));
          }}>
            Edit
          </button>
          <button class="jjv-btn jjv-btn--ghost" disabled={isBusy() || !selected()} onClick={() => {
            const node = selected();
            if (!node) return;
            void runMutation(() => api.new({ parentId: node.changeId }));
          }}>
            New
          </button>
          <button class="jjv-btn jjv-btn--ghost" disabled={isBusy() || !selected()} onClick={() => {
            const node = selected();
            if (!node) return;
            actions.startDescribe(node.descriptionFull || node.descriptionTitle || "");
          }}>
            Desc
          </button>
          <button class="jjv-btn jjv-btn--ghost" disabled={isBusy() || !selected()} onClick={() => {
            const node = selected();
            if (!node) return;
            if (!state.rebaseSourceId) actions.setRebaseSource(node.changeId);
            else void doRebase(state.rebaseSourceId, node.changeId);
          }}>
            Rebase
          </button>
          <button class="jjv-btn jjv-btn--ghost" disabled={!selected()} onClick={() => void toggleExpandedFilesForSelected()}>
            Files
          </button>

          <button class="jjv-btn" disabled={isBusy()} onClick={() => void refresh()}>
            Refresh
          </button>

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
        </div>
      </header>

      <main class="jjv-main">
        <section class="jjv-canvasPane">
          <CanvasGraph
            onMoveCommit={(sourceId, destinationId) => runMutation(() => api.move({ sourceId, destinationId }))}
            onInsertBetween={(parentId, childId) => runMutation(() => api.insert({ parentId, childId }))}
            onInsertAfter={(afterId) => runMutation(() => api.insert({ afterId }))}
            onRebase={(sourceId, destinationId) => doRebase(sourceId, destinationId)}
            onToggleInlineFiles={() => void toggleExpandedFilesForSelected()}
            onInlineAction={(action) => {
              const node = selected();
              if (!node) return;
              if (action === "files") {
                void toggleExpandedFilesForSelected();
                return;
              }
              if (action === "rebase") {
                if (!state.rebaseSourceId) actions.setRebaseSource(node.changeId);
                else void doRebase(state.rebaseSourceId, node.changeId);
                return;
              }
              if (action === "describe") {
                actions.startDescribe(node.descriptionFull || node.descriptionTitle || "");
                return;
              }
              if (action === "new") void runMutation(() => api.new({ parentId: node.changeId }));
              if (action === "edit") void runMutation(() => api.edit({ changeId: node.changeId }));
              if (action === "abandon") void runMutation(() => api.abandon({ changeId: node.changeId }));
              if (action === "duplicate") void runMutation(() => api.duplicate({ changeId: node.changeId }));
              if (action === "squash") void runMutation(() => api.squash({ changeId: node.changeId }));
            }}
          />
        </section>

        <aside class="jjv-sidebar">
          <Sidebar
            diffText={diffText()}
            onMergeSelected={() => void handleMergeSelected()}
            onExecuteOp={() => void handleExecuteOp()}
            onDescribeSubmit={() => void describeSubmit()}
            onRunMutation={(kind) => {
              const node = selected();
              if (!node) return;
              if (kind === "edit") void runMutation(() => api.edit({ changeId: node.changeId }));
              if (kind === "new") void runMutation(() => api.new({ parentId: node.changeId }));
              if (kind === "abandon") void runMutation(() => api.abandon({ changeId: node.changeId }));
              if (kind === "duplicate") void runMutation(() => api.duplicate({ changeId: node.changeId }));
              if (kind === "undo") void runMutation(() => api.undo());
              if (kind === "rebase") {
                if (!state.rebaseSourceId) actions.setRebaseSource(node.changeId);
                else void doRebase(state.rebaseSourceId, node.changeId);
              }
              if (kind === "describe") {
                actions.startDescribe(node.descriptionFull || node.descriptionTitle || "");
              }
            }}
          />

          <Show when={multiCount() > 1}>
            <div class="jjv-toast">Multi-select: {multiCount()} commits selected</div>
          </Show>
        </aside>
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(() => <App />, root);
