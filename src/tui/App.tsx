import { useRenderer, useKeyboard } from "@opentui/solid";
import { createEffect, onMount } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { RGBA } from "@opentui/core";
import { state, actions, navigation, selectedNode } from "../core/state";
import { setBackend } from "../core/runtime";
import { initCwdFrom, opAbandon, opDescribe, opDuplicate, opEdit, opInsertBetween, opNew, opRebase, opSquash, opUndo, prefetchFiles, refreshLog } from "../core/usecases";
import { createTuiBackend } from "./backend";
import { GraphView } from "./components/GraphView";
import { Sidebar } from "./components/Sidebar";

const BG = RGBA.fromHex("#24283b");
const PANEL_BG = RGBA.fromHex("#1a1b26");
const FG_DIM = RGBA.fromHex("#888888");

function App() {
  const renderer = useRenderer();

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

  useKeyboard((key: KeyEvent) => {
    const name = (key.name || key.sequence || "").toLowerCase();

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
        actions.updateDescribeValue(state.describeValue.slice(0, -1));
        return;
      } else if (key.sequence && key.sequence.length === 1) {
        actions.updateDescribeValue((state.describeValue + key.sequence).slice(0, 200));
        return;
      }
      return;
    }

    // Handle leader mode
    if (state.leaderMode) {
      actions.setLeaderMode(false);
      switch (name) {
        case "a":
          handleAbandon();
          return;
        case "s":
          handleSquash();
          return;
        case "d":
          handleDuplicate();
          return;
        case "escape":
          actions.setStatusMessage("Cancelled");
          return;
        default:
          actions.setStatusMessage(`Unknown leader key: ${name}`);
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
        actions.toggleDescExpanded();
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
    }

    // Leader key: Ctrl+X
    if (key.ctrl && name === "x") {
      actions.setLeaderMode(true);
      actions.setStatusMessage("Leader: a=abandon s=squash d=duplicate");
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

  const showSidebar = () => state.termSize.width >= 90 && state.termSize.height >= 16;
  const detailW = () => showSidebar() ? Math.floor(state.termSize.width * 0.40) : 0;
  const graphW = () => state.termSize.width - detailW();
  const mainHeight = () => state.termSize.height - 2;

  const statusText = () => {
    if (state.rebaseSourceId) {
      return `REBASE MODE: src:${state.rebaseSourceId.slice(0, 8)} - select dest + Enter/b, Esc cancels`;
    }
    if (state.leaderMode) {
      return "LEADER MODE: a=abandon s=squash d=duplicate";
    }
    if (state.describeMode) {
      return `DESCRIBE MODE: editing description`;
    }
    if (state.showHelp) {
      return `HELP MODE: h to close`;
    }
    return `layout:${state.layoutMode} j/k nav x desc f files n new e edit d desc b rebase h help`;
  };

  return (
    <box width={state.termSize.width} height={state.termSize.height} backgroundColor={BG} flexDirection="column">
      <box height={2} backgroundColor={PANEL_BG} flexDirection="row">
        <box flexGrow={1}>
          <text>jj-viz TUI  nodes:{state.layoutResult.nodes.length}  {state.statusMessage}</text>
        </box>
        <box flexGrow={1}>
          <text>{statusText()}</text>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1} height={mainHeight()}>
        <box width={graphW()} height={mainHeight()}>
          <GraphView
            nodes={state.layoutResult.nodes}
            selectedId={state.selectedId}
            scrollOffset={state.scrollOffset}
            filesCache={state.filesCache}
            width={graphW()}
            height={mainHeight()}
            onEnsureVisible={ensureSelectedVisible}
          />
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
            />
          </box>
        )}
      </box>
    </box>
  );
}

export default App;
