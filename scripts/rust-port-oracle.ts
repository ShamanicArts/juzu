#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { KeyEvent } from "@opentui/core";
import { createTuiBackend } from "../src/tui/backend";
import { calculateLayout } from "../src/core/layout";
import type { CommitNode, LayoutMode } from "../src/core/types";
import {
  type CommandId,
  type LeaderModeId,
  findCommandForEvent,
  findLeaderModeForEvent,
  resolveTuiKeymapConfig,
} from "../src/core/tui-keymap";

const LAYOUT_MODES: LayoutMode[] = ["chronological", "mainline", "bookmark-centric", "wc-focused", "topological"];

type CliOptions = {
  command: "snapshot" | "layout" | "sidebar" | "state-after-keys" | "help";
  repo: string;
  limit: number;
  revset?: string;
  mode: LayoutMode;
  selected?: string;
  keys: string[];
  output?: string;
};

type OracleNode = Pick<CommitNode,
  | "changeId"
  | "commitId"
  | "parents"
  | "author"
  | "time"
  | "bookmarks"
  | "gitBranches"
  | "descriptionTitle"
  | "isEmpty"
  | "isConflict"
  | "isHidden"
  | "isRoot"
  | "isWorkingCopy"
  | "lane"
  | "x"
  | "y"
  | "isPinned"
> & { descriptionFullLength: number };

type OracleState = {
  selectedIndex: number;
  selectedChangeId: string | null;
  view: "log" | "oplog" | "obslog" | "diff";
  layoutMode: LayoutMode;
  leaderMode: LeaderModeId | null;
  sidebarVisible: boolean;
  filesVisible: boolean;
  descriptionVisible: boolean;
  helpVisible: boolean;
  pendingCommand: CommandId | null;
  commandHistory: CommandId[];
};

function printHelp() {
  console.log(`
Old JUZU oracle emitters for Rust-port parity

Usage:
  bun run oracle:<command> [options]
  bun run scripts/rust-port-oracle.ts <command> [options]

Commands:
  snapshot          Emit repo, nodes, layout, and keymap summary.
  layout            Emit layout-only coordinates for a fixed mode.
  sidebar           Emit selected node sidebar data, files, and diff summary.
  state-after-keys  Replay a deterministic key script through oracle state model.

Options:
  --repo <path>       Repo/start directory (default: cwd)
  --limit <n>         Log limit (default: 200)
  --revset <expr>     Optional jj revset
  --mode <mode>       chronological | mainline | bookmark-centric | wc-focused | topological
  --selected <id>     Selected change id/commit id prefix for sidebar/state
  --keys <script>     Comma/space separated key script for state-after-keys
  --output <path>     Write JSON to path instead of stdout
  -h, --help          Show help

Key script examples:
  --keys 'ctrl+v,2,j,j,ctrl+v,f'
  --keys 'down down ctrl+d esc'
`);
}

function parseArgs(argv: string[]): CliOptions {
  const [rawCommand, ...rest] = argv;
  const command = rawCommand === "snapshot" || rawCommand === "layout" || rawCommand === "sidebar" || rawCommand === "state-after-keys"
    ? rawCommand
    : rawCommand === "help" || rawCommand === undefined || rawCommand === "--help" || rawCommand === "-h"
      ? "help"
      : null;
  if (!command) throw new Error(`Unknown oracle command: ${rawCommand}`);

  const kv = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-h") kv.set("help", true);
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      kv.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      kv.set(key, next);
      i += 1;
    } else {
      kv.set(key, true);
    }
  }
  if (kv.has("help")) return { command: "help", repo: process.cwd(), limit: 200, mode: "chronological", keys: [] };

  const mode = String(kv.get("mode") || "chronological") as LayoutMode;
  if (!LAYOUT_MODES.includes(mode)) throw new Error(`Invalid --mode ${mode}`);

  return {
    command,
    repo: resolve(String(kv.get("repo") || process.cwd())),
    limit: readPositiveInt(kv.get("limit"), 200),
    revset: typeof kv.get("revset") === "string" ? String(kv.get("revset")) : undefined,
    mode,
    selected: typeof kv.get("selected") === "string" ? String(kv.get("selected")) : undefined,
    keys: parseKeyScript(typeof kv.get("keys") === "string" ? String(kv.get("keys")) : ""),
    output: typeof kv.get("output") === "string" ? resolve(String(kv.get("output"))) : undefined,
  };
}

function readPositiveInt(raw: string | boolean | undefined, fallback: number): number {
  if (raw === undefined || raw === true) return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseKeyScript(raw: string): string[] {
  return raw
    .split(/[\s,]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toOracleNode(node: CommitNode): OracleNode {
  return {
    changeId: node.changeId,
    commitId: node.commitId,
    parents: [...node.parents],
    author: node.author,
    time: node.time,
    bookmarks: [...node.bookmarks],
    gitBranches: [...node.gitBranches],
    descriptionTitle: node.descriptionTitle,
    descriptionFullLength: node.descriptionFull.length,
    isEmpty: node.isEmpty,
    isConflict: node.isConflict,
    isHidden: node.isHidden,
    isRoot: node.isRoot,
    isWorkingCopy: node.isWorkingCopy,
    lane: node.lane,
    x: node.x,
    y: node.y,
    isPinned: node.isPinned,
  };
}

function findSelected(nodes: CommitNode[], selected?: string): number {
  if (!selected) return Math.max(0, nodes.findIndex((n) => n.isWorkingCopy));
  const idx = nodes.findIndex((n) => n.changeId.startsWith(selected) || n.commitId.startsWith(selected));
  return idx >= 0 ? idx : 0;
}

async function loadBase(options: CliOptions) {
  const backend = createTuiBackend();
  const root = backend.findRoot ? await backend.findRoot(options.repo) : options.repo;
  if (!root) throw new Error(`No JJ repo found from ${options.repo}`);
  const nodes = await backend.log({ cwd: root, limit: options.limit, revset: options.revset });
  const nodeCount = await backend.nodeCount({ cwd: root, revset: options.revset });
  const layout = calculateLayout(options.mode, nodes);
  return { backend, root, nodes, nodeCount, layout };
}

function keyEventFromSpec(raw: string): KeyEvent {
  const normalized = raw.trim().toLowerCase();
  const parts = normalized.split("+").filter(Boolean);
  const ctrl = parts.includes("ctrl") || parts.includes("control") || normalized.startsWith("^");
  const meta = parts.includes("meta") || parts.includes("cmd") || parts.includes("command");
  const alt = parts.includes("alt") || parts.includes("option");
  const shift = parts.includes("shift");
  let base = parts.filter((p) => !["ctrl", "control", "meta", "cmd", "command", "alt", "option", "shift"].includes(p)).pop() || normalized;
  if (normalized.startsWith("^") && normalized.length > 1) base = normalized.slice(1);
  const aliases: Record<string, string> = {
    escape: "escape",
    esc: "escape",
    space: "space",
    enter: "enter",
    return: "enter",
    down: "down",
    up: "up",
    left: "left",
    right: "right",
  };
  base = aliases[base] || base;
  return {
    name: base,
    sequence: base.length === 1 ? base : base,
    ctrl,
    meta,
    shift,
    alt,
  } as unknown as KeyEvent;
}

function applyCommand(state: OracleState, command: CommandId, nodeCount: number) {
  state.pendingCommand = command;
  state.commandHistory.push(command);
  switch (command) {
    case "layout-chronological": state.layoutMode = "chronological"; break;
    case "layout-mainline": state.layoutMode = "mainline"; break;
    case "layout-bookmark-centric": state.layoutMode = "bookmark-centric"; break;
    case "layout-wc-focused": state.layoutMode = "wc-focused"; break;
    case "layout-topological": state.layoutMode = "topological"; break;
    case "toggle-sidebar": state.sidebarVisible = !state.sidebarVisible; break;
    case "toggle-files": state.filesVisible = !state.filesVisible; break;
    case "toggle-description": state.descriptionVisible = !state.descriptionVisible; break;
    case "toggle-help": state.helpVisible = !state.helpVisible; break;
    case "diff-toggle": state.view = state.view === "diff" ? "log" : "diff"; break;
    case "oplog": state.view = "oplog"; break;
    case "obslog": state.view = "obslog"; break;
    case "back-log": state.view = "log"; break;
    case "refresh": state.pendingCommand = null; break;
    default:
      // Mutating/interactive commands intentionally stop at command selection in this oracle.
      break;
  }
  if (state.selectedIndex < 0) state.selectedIndex = 0;
  if (state.selectedIndex >= nodeCount) state.selectedIndex = Math.max(0, nodeCount - 1);
}

function replayKeys(nodes: CommitNode[], options: CliOptions): OracleState {
  const keymap = resolveTuiKeymapConfig(undefined);
  const selectedIndex = findSelected(nodes, options.selected);
  const state: OracleState = {
    selectedIndex,
    selectedChangeId: nodes[selectedIndex]?.changeId || null,
    view: "log",
    layoutMode: options.mode,
    leaderMode: null,
    sidebarVisible: true,
    filesVisible: false,
    descriptionVisible: false,
    helpVisible: false,
    pendingCommand: null,
    commandHistory: [],
  };

  for (const raw of options.keys) {
    const key = keyEventFromSpec(raw);
    const name = String((key as any).name || "").toLowerCase();
    if (name === "escape" || name === "esc") {
      state.leaderMode = null;
      state.pendingCommand = null;
      if (state.view !== "log") state.view = "log";
      continue;
    }
    if (name === "j" || name === "down") {
      state.selectedIndex = Math.min(nodes.length - 1, state.selectedIndex + 1);
      state.selectedChangeId = nodes[state.selectedIndex]?.changeId || null;
      continue;
    }
    if (name === "k" || name === "up") {
      state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      state.selectedChangeId = nodes[state.selectedIndex]?.changeId || null;
      continue;
    }

    if (state.leaderMode) {
      const command = findCommandForEvent(keymap.modeBindings[state.leaderMode], key);
      if (command) applyCommand(state, command, nodes.length);
      if (!keymap.stickyModes) state.leaderMode = null;
      continue;
    }

    const leaderMode = findLeaderModeForEvent(keymap, key);
    if (leaderMode) {
      state.leaderMode = leaderMode;
      continue;
    }

    const idleCommand = findCommandForEvent(keymap.idleBindings, key);
    if (idleCommand) applyCommand(state, idleCommand, nodes.length);
  }
  return state;
}

async function emit(options: CliOptions): Promise<unknown> {
  if (options.command === "help") {
    printHelp();
    return null;
  }
  const base = await loadBase(options);
  const selectedIndex = findSelected(base.layout.nodes, options.selected);
  const selectedNode = base.layout.nodes[selectedIndex] || null;

  if (options.command === "snapshot") {
    return {
      schemaVersion: 1,
      oracle: "old-juzu",
      command: "snapshot",
      repo: base.root,
      revset: options.revset || null,
      limit: options.limit,
      nodeCount: base.nodeCount,
      returnedNodes: base.nodes.length,
      layoutMode: options.mode,
      layout: {
        maxLane: base.layout.maxLane,
        textColumnX: base.layout.textColumnX,
        totalHeight: base.layout.totalHeight,
      },
      keymap: resolveTuiKeymapConfig(undefined),
      nodes: base.layout.nodes.map(toOracleNode),
    };
  }

  if (options.command === "layout") {
    return {
      schemaVersion: 1,
      oracle: "old-juzu",
      command: "layout",
      repo: base.root,
      mode: options.mode,
      layout: {
        maxLane: base.layout.maxLane,
        textColumnX: base.layout.textColumnX,
        totalHeight: base.layout.totalHeight,
      },
      nodes: base.layout.nodes.map((node) => ({
        changeId: node.changeId,
        commitId: node.commitId,
        parents: node.parents,
        lane: node.lane,
        x: node.x,
        y: node.y,
        isPinned: node.isPinned || false,
      })),
    };
  }

  if (options.command === "sidebar") {
    if (!selectedNode) throw new Error("No selected node available");
    const files = await base.backend.files({ cwd: base.root, changeId: selectedNode.changeId });
    const diff = await base.backend.diff({ cwd: base.root, changeId: selectedNode.changeId });
    return {
      schemaVersion: 1,
      oracle: "old-juzu",
      command: "sidebar",
      repo: base.root,
      selectedIndex,
      selected: toOracleNode(selectedNode),
      files,
      diffSummary: {
        bytes: new TextEncoder().encode(diff).length,
        lines: diff.length === 0 ? 0 : diff.split("\n").length,
        firstLines: diff.split("\n").slice(0, 20),
      },
    };
  }

  if (options.command === "state-after-keys") {
    const state = replayKeys(base.layout.nodes, options);
    const layout = calculateLayout(state.layoutMode, base.nodes);
    return {
      schemaVersion: 1,
      oracle: "old-juzu",
      command: "state-after-keys",
      repo: base.root,
      keys: options.keys,
      state,
      selected: state.selectedChangeId
        ? toOracleNode(layout.nodes.find((n) => n.changeId === state.selectedChangeId) || layout.nodes[state.selectedIndex]!)
        : null,
      layout: {
        mode: state.layoutMode,
        maxLane: layout.maxLane,
        textColumnX: layout.textColumnX,
        totalHeight: layout.totalHeight,
      },
    };
  }

  throw new Error(`Unhandled command ${options.command}`);
}

const options = parseArgs(Bun.argv.slice(2));
const value = await emit(options);
if (value !== null) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, json);
    console.log(options.output);
  } else {
    process.stdout.write(json);
  }
}
