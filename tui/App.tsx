#!/usr/bin/env bun
/** @jsxImportSource solid-js */

import { render } from "@opentui/solid";
import { createSignal, createEffect, createMemo, For, onMount, onCleanup } from "solid-js";
import { RGBA, createCliRenderer, type KeyEvent } from "@opentui/core";
import type { CommitNode, LayoutMode } from "./types";
import { fetchJJLog, fetchFilesForNodes, findJJRoot } from "./jj-api";
import { applyLayout } from "./layout";
import { GraphView } from "./GraphView";
import { Sidebar } from "./Sidebar";

const BG = RGBA.fromHex("#24283b");
const PANEL_BG = RGBA.fromHex("#1a1b26");
const CYAN = RGBA.fromHex("#00f0ff");
const FG_DIM = RGBA.fromHex("#888888");

export function App() {
  const [cwd, setCwd] = createSignal<string>("");
  const [nodes, setNodes] = createSignal<CommitNode[]>([]);
  const [mode, setMode] = createSignal<LayoutMode>("chronological");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [scrollOffset, setScrollOffset] = createSignal(0);
  const [statusMsg, setStatusMsg] = createSignal("");
  const [filesCache, setFilesCache] = createSignal(new Map<string, { atMs: number; files: Array<{ type: string; path: string }> }>());
  const [descExpanded, setDescExpanded] = createSignal(false);
  const [filesExpanded, setFilesExpanded] = createSignal(true);
  const [sidebarScroll, setSidebarScroll] = createSignal(0);
  const [rebaseSource, setRebaseSource] = createSignal<string | null>(null);
  const [termSize, setTermSize] = createSignal({ w: 80, h: 24 });

  const laidOut = createMemo(() => applyLayout(mode(), nodes()));
  const selected = createMemo(() => laidOut()[selectedIndex()]);

  onMount(async () => {
    const startDir = process.cwd();
    const repoCwd = await findJJRoot(startDir);
    if (!repoCwd) {
      setStatusMsg("No .jj directory found");
      return;
    }
    setCwd(repoCwd);
    await refresh();
  });

  const refresh = async () => {
    setStatusMsg("Loading...");
    try {
      const newNodes = await fetchJJLog(cwd(), 500);
      setNodes(newNodes);
      const wcIndex = newNodes.findIndex(n => n.isWorkingCopy);
      setSelectedIndex(wcIndex >= 0 ? wcIndex : 0);
      setStatusMsg("");

      // Fetch files for all nodes in background
      fetchFilesForNodes(newNodes, cwd(), (cache) => {
        setFilesCache(cache);
      });
    } catch (e) {
      setStatusMsg(`Error: ${String(e)}`);
    }
  };

  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

  const ensureSelectedVisible = (visibleRows: number) => {
    const idx = selectedIndex();
    const offset = scrollOffset();
    if (idx < offset) setScrollOffset(idx);
    const maxTop = Math.max(0, laidOut().length - visibleRows);
    const bottom = offset + (visibleRows - 1);
    if (idx > bottom) setScrollOffset(clamp(idx - (visibleRows - 1), 0, maxTop));
  };

  // Keyboard handler
  const handleKey = (key: KeyEvent) => {
    const name = (key.name || key.sequence || "").toLowerCase();

    if (key.ctrl && key.name === "c") {
      process.exit(0);
    }

    switch (name) {
      case "q":
        process.exit(0);
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
  };

  const showSidebar = () => termSize().w >= 90 && termSize().h >= 16;
  const detailW = () => showSidebar() ? Math.floor(termSize().w * 0.40) : 0;
  const graphW = () => termSize().w - detailW();

  return (
    <box width={termSize().w} height={termSize().h} backgroundColor={BG}>
      {/* Header */}
      <box height={2} backgroundColor={PANEL_BG}>
        <text>jj-viz <span fg={FG_DIM}>TUI</span> {`nodes:${laidOut().length}`}</text>
        {statusMsg() && <text x={14} fg="#ff0055">{statusMsg()}</text>}
        <text x={2} y={1} fg={FG_DIM}>
          {rebaseSource() 
            ? `layout:${mode()} rebase src:${rebaseSource()?.slice(0, 8)} (select dest + b, esc cancels)`
            : `layout:${mode()} j/k nav x desc f files d describe b rebase r refresh q quit`
          }
        </text>
      </box>

      {/* Main content */}
      <box flexDirection="row" flexGrow={1}>
        {/* Graph view */}
        <GraphView
          nodes={laidOut()}
          selectedIndex={selectedIndex()}
          scrollOffset={scrollOffset()}
          filesCache={filesCache()}
          width={graphW()}
          height={termSize().h - 2}
          onEnsureVisible={ensureSelectedVisible}
        />

        {/* Sidebar */}
        {showSidebar() && (
          <Sidebar
            selected={selected()}
            filesCache={filesCache()}
            descExpanded={descExpanded()}
            filesExpanded={filesExpanded()}
            scrollOffset={sidebarScroll()}
            width={detailW()}
            height={termSize().h - 2}
          />
        )}
      </box>
    </box>
  );
}

// Main entry
async function main() {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  render(() => <App />, renderer.root);
}

main();
