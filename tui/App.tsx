import { render, useRenderer, useKeyboard } from "@opentui/solid";
import { createSignal, createMemo, onMount, Show } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { RGBA } from "@opentui/core";
import type { CommitNode, LayoutMode, FilesCacheEntry } from "./types";
import { fetchJJLog, fetchFilesForNodes, findJJRoot, jjNew, jjEdit, jjDescribe, jjAbandon, jjSquash, jjDuplicate, jjRebase, jjInsertAfter, jjUndo } from "./jj-api";
import { applyLayout } from "./layout";
import { GraphView } from "./components/GraphView";
import { Sidebar } from "./components/Sidebar";
import { HelpModal } from "./components/HelpModal";

const BG = RGBA.fromHex("#24283b");
const PANEL_BG = RGBA.fromHex("#1a1b26");
const CYAN = RGBA.fromHex("#00f0ff");
const FG_DIM = RGBA.fromHex("#888888");
const GREEN = RGBA.fromHex("#00ff9d");
const RED = RGBA.fromHex("#ff0055");

function App() {
  const renderer = useRenderer();
  const [cwd, setCwd] = createSignal<string>("");
  const [nodes, setNodes] = createSignal<CommitNode[]>([]);
  const [mode, setMode] = createSignal<LayoutMode>("chronological");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [scrollOffset, setScrollOffset] = createSignal(0);
  const [statusMsg, setStatusMsg] = createSignal("");
  const [filesCache, setFilesCache] = createSignal<Map<string, FilesCacheEntry>>(new Map());
  const [descExpanded, setDescExpanded] = createSignal(false);
  const [filesExpanded, setFilesExpanded] = createSignal(true);
  const [sidebarScroll, setSidebarScroll] = createSignal(0);
  const [rebaseSource, setRebaseSource] = createSignal<string | null>(null);
  const [showHelp, setShowHelp] = createSignal(false);
  const [leaderMode, setLeaderMode] = createSignal(false);
  const [termSize, setTermSize] = createSignal({ w: 80, h: 24 });
  
  // Prompt state
  const [promptMode, setPromptMode] = createSignal(false);
  const [promptValue, setPromptValue] = createSignal("");
  const [promptCb, setPromptCb] = createSignal<((val: string) => void) | null>(null);

  const laidOut = createMemo(() => applyLayout(mode(), nodes()));
  const selected = createMemo(() => laidOut()[selectedIndex()]);

  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

  onMount(async () => {
    const startDir = process.cwd();
    const repoCwd = await findJJRoot(startDir);
    if (!repoCwd) {
      setStatusMsg("No .jj directory found");
      return;
    }
    setCwd(repoCwd);

    setTermSize({ w: renderer.width, h: renderer.height });
    
    renderer.on("resize", (w: number, h: number) => {
      setTermSize({ w, h });
    });

    await refresh();
  });

  const refresh = async () => {
    const cwdVal = cwd();
    if (!cwdVal) return;
    setStatusMsg("Loading...");
    try {
      const newNodes = await fetchJJLog(cwdVal, 500);
      console.log("Loaded nodes:", newNodes.length);
      setNodes(newNodes);
      const wcIndex = newNodes.findIndex(n => n.isWorkingCopy);
      setSelectedIndex(wcIndex >= 0 ? wcIndex : 0);
      setStatusMsg(`nodes:${newNodes.length}`);

      fetchFilesForNodes(newNodes, cwdVal, (cache) => {
        setFilesCache(new Map(cache));
      });
    } catch (e) {
      setStatusMsg(`Error: ${String(e)}`);
      console.error("Refresh error:", e);
    }
  };

  const ensureSelectedVisible = (visibleRows: number) => {
    const idx = selectedIndex();
    const offset = scrollOffset();
    if (idx < offset) setScrollOffset(idx);
    const maxTop = Math.max(0, laidOut().length - visibleRows);
    const bottom = offset + (visibleRows - 1);
    if (idx > bottom) setScrollOffset(clamp(idx - (visibleRows - 1), 0, maxTop));
  };

  const startPrompt = (initial: string, onSubmit: (val: string) => void) => {
    setPromptValue(initial);
    setPromptCb(() => onSubmit);
    setPromptMode(true);
  };

  const cancelPrompt = () => {
    setPromptMode(false);
    setPromptValue("");
    setPromptCb(null);
  };

  const handleNew = async () => {
    const node = selected();
    if (!node) return;
    const cwdVal = cwd();
    if (!cwdVal) return;
    setStatusMsg("Creating new commit...");
    try {
      await jjNew(node.changeId, cwdVal);
      setStatusMsg("Created!");
      await refresh();
    } catch (e) {
      setStatusMsg(`Error: ${String(e)}`);
    }
  };

  const handleEdit = async () => {
    const node = selected();
    if (!node) return;
    const cwdVal = cwd();
    if (!cwdVal) return;
    setStatusMsg("Checking out...");
    try {
      await jjEdit(node.changeId, cwdVal);
      setStatusMsg("Checked out!");
      await refresh();
    } catch (e) {
      setStatusMsg(`Error: ${String(e)}`);
    }
  };

  const handleDescribe = () => {
    const node = selected();
    if (!node) return;
    const cwdVal = cwd();
    if (!cwdVal) return;
    
    startPrompt(node.descriptionTitle || "", async (value) => {
      setPromptMode(false);
      setStatusMsg("Describing...");
      try {
        await jjDescribe(node.changeId, value, cwdVal);
        setStatusMsg("Described!");
        await refresh();
      } catch (e) {
        setStatusMsg(`Error: ${String(e)}`);
      }
    });
  };

  const handleAbandon = async () => {
    const node = selected();
    if (!node) return;
    const cwdVal = cwd();
    if (!cwdVal) return;
    setStatusMsg("Abandoning...");
    try {
      await jjAbandon(node.changeId, cwdVal);
      setStatusMsg("Abandoned!");
      await refresh();
    } catch (e) {
      setStatusMsg(`Error: ${String(e)}`);
    }
  };

  const handleSquash = async () => {
    const node = selected();
    if (!node) return;
    const cwdVal = cwd();
    if (!cwdVal) return;
    
    const parentId = node.parents[0];
    if (!parentId) {
      setStatusMsg("Cannot squash: no parent");
      return;
    }
    
    setStatusMsg("Squashing...");
    try {
      await jjSquash(node.changeId, parentId, cwdVal);
      setStatusMsg("Squashed!");
      await refresh();
    } catch (e) {
      setStatusMsg(`Error: ${String(e)}`);
    }
  };

  const handleDuplicate = async () => {
    const node = selected();
    if (!node) return;
    const cwdVal = cwd();
    if (!cwdVal) return;
    setStatusMsg("Duplicating...");
    try {
      await jjDuplicate(node.changeId, cwdVal);
      setStatusMsg("Duplicated!");
      await refresh();
    } catch (e) {
      setStatusMsg(`Error: ${String(e)}`);
    }
  };

  const handleRebase = async () => {
    const node = selected();
    if (!node) return;
    const source = rebaseSource();
    const cwdVal = cwd();
    if (!cwdVal) return;

    if (!source) {
      setRebaseSource(node.changeId);
      setStatusMsg(`Rebase mode: ${node.changeId.slice(0, 8)} selected, choose destination`);
    } else if (source === node.changeId) {
      setRebaseSource(null);
      setStatusMsg("Rebase cancelled");
    } else {
      setStatusMsg(`Rebasing ${source.slice(0, 8)} onto ${node.changeId.slice(0, 8)}...`);
      try {
        await jjRebase(source, node.changeId, cwdVal);
        setRebaseSource(null);
        setStatusMsg("Rebased!");
        await refresh();
      } catch (e) {
        setStatusMsg(`Error: ${String(e)}`);
        setRebaseSource(null);
      }
    }
  };

  const handleInsert = async () => {
    const node = selected();
    if (!node) return;
    const cwdVal = cwd();
    if (!cwdVal) return;
    
    const child = laidOut().find(n => n.parents.includes(node.changeId));
    if (!child) {
      setStatusMsg("Insert: no child found to rebase");
      return;
    }
    
    setStatusMsg("Inserting...");
    try {
      await jjInsertAfter(node.changeId, child.changeId, cwdVal);
      setStatusMsg("Inserted!");
      await refresh();
    } catch (e) {
      setStatusMsg(`Error: ${String(e)}`);
    }
  };

  const handleUndo = async () => {
    const cwdVal = cwd();
    if (!cwdVal) return;
    setStatusMsg("Undoing...");
    try {
      await jjUndo(cwdVal);
      setStatusMsg("Undone!");
      await refresh();
    } catch (e) {
      setStatusMsg(`Error: ${String(e)}`);
    }
  };

  useKeyboard((key) => {
    const name = (key.name || key.sequence || "").toLowerCase();

    if (key.ctrl && key.name === "c") {
      renderer.destroy();
      return;
    }

    // Handle help mode
    if (showHelp()) {
      if (name === "escape" || name === "h" || name === "q") {
        setShowHelp(false);
      }
      return;
    }

    // Handle prompt mode
    if (promptMode()) {
      if (name === "return" || name === "enter") {
        const cb = promptCb();
        const val = promptValue();
        cancelPrompt();
        if (cb) cb(val);
        return;
      } else if (name === "escape") {
        cancelPrompt();
        setStatusMsg("Cancelled");
        return;
      } else if (name === "backspace") {
        setPromptValue(v => v.slice(0, -1));
        return;
      } else if (key.sequence && key.sequence.length === 1) {
        setPromptValue(v => (v + key.sequence).slice(0, 200));
        return;
      }
      return;
    }

    // Handle leader mode (Ctrl+X style)
    if (leaderMode()) {
      setLeaderMode(false);
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
          setStatusMsg("Cancelled");
          return;
        default:
          setStatusMsg(`Unknown leader key: ${name}`);
          return;
      }
    }

    switch (name) {
      case "q":
        renderer.destroy();
        return;
      case "escape":
        if (rebaseSource()) {
          setRebaseSource(null);
          setStatusMsg("Rebase cancelled");
        }
        break;
      case "up":
      case "k":
        setSelectedIndex(i => clamp(i - 1, 0, Math.max(0, laidOut().length - 1)));
        setSidebarScroll(0);
        break;
      case "down":
      case "j":
        setSelectedIndex(i => clamp(i + 1, 0, Math.max(0, laidOut().length - 1)));
        setSidebarScroll(0);
        break;
      case "pageup":
        setSidebarScroll(s => Math.max(0, s - 10));
        break;
      case "pagedown":
        setSidebarScroll(s => s + 10);
        break;
      case "r":
        refresh();
        break;
      case "f":
        setFilesExpanded(v => !v);
        break;
      case "x":
        setDescExpanded(v => !v);
        break;
      case "h":
        setShowHelp(true);
        break;
      case "1":
        setMode("chronological");
        break;
      case "2":
        setMode("mainline");
        break;
      case "3":
        setMode("bookmark-centric");
        break;
      case "4":
        setMode("wc-focused");
        break;
      case "5":
        setMode("topological");
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
        if (rebaseSource()) {
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
      setLeaderMode(true);
      setStatusMsg("Leader: a=abandon s=squash d=duplicate");
    }
  });

  const showSidebar = () => termSize().w >= 90 && termSize().h >= 16;
  const detailW = () => showSidebar() ? Math.floor(termSize().w * 0.40) : 0;
  const graphW = () => termSize().w - detailW();
  const mainHeight = () => termSize().h - 2;

  const statusText = () => {
    if (rebaseSource()) {
      return `REBASE MODE: src:${rebaseSource()?.slice(0, 8)} - select dest + Enter/b, Esc cancels`;
    }
    if (leaderMode()) {
      return "LEADER MODE: a=abandon s=squash d=duplicate";
    }
    if (promptMode()) {
      return `DESCRIBE MODE: editing description`;
    }
    if (showHelp()) {
      return `HELP MODE: h to close`;
    }
    return `layout:${mode()} j/k nav x desc f files n new e edit d desc b rebase h help`;
  };

  return (
    <box width={termSize().w} height={termSize().h} backgroundColor={BG} flexDirection="column">
      <box height={2} backgroundColor={PANEL_BG} flexDirection="row">
        <box flexGrow={1}>
          <text>jj-viz TUI  nodes:{laidOut().length}  {statusMsg()}</text>
        </box>
        <box flexGrow={1}>
          <text>{statusText()}</text>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1} height={mainHeight()}>
        <box width={graphW()} height={mainHeight()}>
          <GraphView
            nodes={laidOut()}
            selectedIndex={selectedIndex()}
            scrollOffset={scrollOffset()}
            filesCache={filesCache()}
            width={graphW()}
            height={mainHeight()}
            onEnsureVisible={ensureSelectedVisible}
          />
        </box>

        {showSidebar() && (
          <box width={detailW()} height={mainHeight()} backgroundColor={PANEL_BG}>
            <Sidebar
              selected={selected()}
              filesCache={filesCache()}
              descExpanded={descExpanded()}
              filesExpanded={filesExpanded()}
              scrollOffset={sidebarScroll()}
              width={detailW()}
              height={mainHeight()}
              showHelp={showHelp()}
              promptMode={promptMode()}
              promptValue={promptValue()}
            />
          </box>
        )}
      </box>
    </box>
  );
}

render(() => <App />);
