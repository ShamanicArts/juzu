import { render } from "solid-js/web";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { actions, navigation, selectedNode, state } from "../core/state";
import { setBackend } from "../core/runtime";
import { ensureFiles, fetchDiff, opAbandon, opDescribe, opDuplicate, opEdit, opInsertAfter, opInsertBetween, opMerge, opMove, opNew, opRebase, opSquash, opSplit, opUndo, refreshLog, toggleInlineFilesForSelected } from "../core/usecases";
import { createWebBackend } from "./backend";
import { CanvasGraph } from "./components/CanvasGraph";
import { Sidebar } from "./components/Sidebar";

type PersistedLayout = {
  layoutMode?: string;
  pinned?: Array<[string, number]>;
  viewport?: { offsetX: number; offsetY: number; scale: number };
};

function App() {
  const [diffText, setDiffText] = createSignal<string>("");

  const selected = createMemo(() => selectedNode());
  const multiCount = createMemo(() => state.selectedIds.size);

  const persistKey = "jj-viz-layout";

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

  const refresh = async () => {
    try {
      await refreshLog(500);
    } catch (e) {
      // status already set
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
      case "b": {
        const node = selected();
        if (!node) break;
        if (!state.rebaseSourceId) {
          actions.setRebaseSource(node.changeId);
          actions.setStatusMessage(`Rebase: source ${node.changeId.slice(0, 8)} selected`);
        } else {
          void opRebase(state.rebaseSourceId, node.changeId);
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
        void opUndo();
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
    const paths = Array.from(state.opSelectedPaths);

    if (state.opMode === "split") {
      if (paths.length === 0) {
        actions.setStatusMessage("Split: select at least one file");
        return;
      }
      await opSplit(node.changeId, paths);
      actions.resetOpMode();
      return;
    }

    if (state.opMode === "squash") {
      // Squash selected paths (or all if none) into parent
      await opSquash(node.changeId, { paths: paths.length > 0 ? paths : undefined });
      actions.resetOpMode();
      return;
    }

    if (state.opMode === "move") {
      if (!state.opTargetId) {
        actions.setStatusMessage("Move: click a target node in the graph");
        return;
      }
      await opSquash(node.changeId, { intoId: state.opTargetId, paths: paths.length > 0 ? paths : undefined });
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
          <button class="jjv-btn jjv-btn--ghost" disabled={state.isLoading || !selected()} onClick={() => {
            const node = selected();
            if (!node) return;
            void opEdit(node.changeId);
          }}>
            Edit
          </button>
          <button class="jjv-btn jjv-btn--ghost" disabled={state.isLoading || !selected()} onClick={() => {
            const node = selected();
            if (!node) return;
            void opNew(node.changeId);
          }}>
            New
          </button>
          <button class="jjv-btn jjv-btn--ghost" disabled={state.isLoading || !selected()} onClick={() => {
            const node = selected();
            if (!node) return;
            actions.startDescribe(node.descriptionFull || node.descriptionTitle || "");
          }}>
            Desc
          </button>
          <button class="jjv-btn jjv-btn--ghost" disabled={state.isLoading || !selected()} onClick={() => {
            const node = selected();
            if (!node) return;
            if (!state.rebaseSourceId) actions.setRebaseSource(node.changeId);
            else void opRebase(state.rebaseSourceId, node.changeId);
          }}>
            Rebase
          </button>
          <button class="jjv-btn jjv-btn--ghost" disabled={!selected()} onClick={() => void toggleInlineFilesForSelected()}>
            Files
          </button>

          <button class="jjv-btn" disabled={state.isLoading} onClick={() => void refresh()}>
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
            onMoveCommit={(sourceId, destinationId) => void opMove(sourceId, destinationId)}
            onInsertBetween={(parentId, childId) => void opInsertBetween(parentId, childId)}
            onInsertAfter={(afterId) => void opInsertAfter(afterId)}
            onRebase={(sourceId, destinationId) => void opRebase(sourceId, destinationId)}
            onToggleInlineFiles={() => void toggleInlineFilesForSelected()}
            onInlineAction={(action) => {
              const node = selected();
              if (!node) return;
              if (action === "files") {
                void toggleInlineFilesForSelected();
                return;
              }
              if (action === "rebase") {
                if (!state.rebaseSourceId) actions.setRebaseSource(node.changeId);
                else void opRebase(state.rebaseSourceId, node.changeId);
                return;
              }
              if (action === "describe") {
                actions.startDescribe(node.descriptionFull || node.descriptionTitle || "");
                return;
              }
              if (action === "new") void opNew(node.changeId);
              if (action === "edit") void opEdit(node.changeId);
              if (action === "abandon") void opAbandon(node.changeId);
              if (action === "duplicate") void opDuplicate(node.changeId);
              if (action === "squash") void opSquash(node.changeId);
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
              if (kind === "edit") void opEdit(node.changeId);
              if (kind === "new") void opNew(node.changeId);
              if (kind === "abandon") void opAbandon(node.changeId);
              if (kind === "duplicate") void opDuplicate(node.changeId);
              if (kind === "undo") void opUndo();
              if (kind === "rebase") {
                if (!state.rebaseSourceId) actions.setRebaseSource(node.changeId);
                else void opRebase(state.rebaseSourceId, node.changeId);
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
