import { render, useRenderer, useKeyboard } from "@opentui/solid";
import { createSignal, createMemo, onMount } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { RGBA } from "@opentui/core";
import type { CommitNode, LayoutMode, FilesCacheEntry } from "./types";
import { fetchJJLog, fetchFilesForNodes, findJJRoot } from "./jj-api";
import { applyLayout } from "./layout";
import { GraphView } from "./components/GraphView";
import { Sidebar } from "./components/Sidebar";

const BG = RGBA.fromHex("#24283b");
const PANEL_BG = RGBA.fromHex("#1a1b26");
const CYAN = RGBA.fromHex("#00f0ff");
const FG_DIM = RGBA.fromHex("#888888");

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
  const [termSize, setTermSize] = createSignal({ w: 80, h: 24 });

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

  useKeyboard((key) => {
    const name = (key.name || key.sequence || "").toLowerCase();

    if (key.ctrl && key.name === "c") {
      renderer.destroy();
      return;
    }

    switch (name) {
      case "q":
        renderer.destroy();
        return;
      case "escape":
        setRebaseSource(null);
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
    }
  });

  const showSidebar = () => termSize().w >= 90 && termSize().h >= 16;
  const detailW = () => showSidebar() ? Math.floor(termSize().w * 0.40) : 0;
  const graphW = () => termSize().w - detailW();

  const statusText = () => {
    if (rebaseSource()) {
      return `layout:${mode()} rebase src:${rebaseSource()?.slice(0, 8)} (select dest + b, esc cancels)`;
    }
    return `layout:${mode()} j/k nav x desc f files d describe b rebase r refresh q quit`;
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

      <box flexDirection="row" flexGrow={1} height={termSize().h - 2}>
        <box width={graphW()} height={termSize().h - 2}>
          <GraphView
            nodes={laidOut()}
            selectedIndex={selectedIndex()}
            scrollOffset={scrollOffset()}
            filesCache={filesCache()}
            width={graphW()}
            height={termSize().h - 2}
            onEnsureVisible={ensureSelectedVisible}
          />
        </box>

        {showSidebar() && (
          <box width={detailW()} height={termSize().h - 2} backgroundColor={PANEL_BG}>
            <Sidebar
              selected={selected()}
              filesCache={filesCache()}
              descExpanded={descExpanded()}
              filesExpanded={filesExpanded()}
              scrollOffset={sidebarScroll()}
              width={detailW()}
              height={termSize().h - 2}
            />
          </box>
        )}
      </box>
    </box>
  );
}

render(() => <App />);
