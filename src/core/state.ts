import { createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import type { CommitNode, FilesCacheEntry, LayoutMode, LayoutResult } from "./types";
import type { OpLogEntry, ObslogEntry } from "./jj-api";
import { calculateLayout } from "./layout";
import { getRuntimeConfig } from "./runtime-config";

export type DiffCacheEntry = {
  atMs: number;
  files: Array<{ path: string; diff: string }>;
  bytes: number;
};

export type ViewMode = "log" | "oplog" | "obslog" | "diff";

export interface SharedState {
  cwd: string;
  nodes: CommitNode[];
  totalNodeCount: number;
  filesCache: Map<string, FilesCacheEntry>;
  diffCache: Map<string, DiffCacheEntry>;
  revsetQuery: string;

  viewMode: ViewMode;

  opLogEntries: OpLogEntry[];
  opLogSelectedId: string | null;

  obslogEntries: ObslogEntry[];
  obslogChangeId: string | null;
  obslogSelectedIndex: number;

  layoutMode: LayoutMode;
  pinnedNodes: Map<string, number>;

  selectedId: string | null;
  selectedIds: Set<string>;

  rebaseSourceId: string | null;

  describeMode: boolean;
  describeValue: string;

  statusMessage: string;
  isLoading: boolean;
}

const initialState: SharedState = {
  cwd: "",
  nodes: [],
  totalNodeCount: 0,
  filesCache: new Map(),
  diffCache: new Map(),
  revsetQuery: "",

  viewMode: "log",

  opLogEntries: [],
  opLogSelectedId: null,

  obslogEntries: [],
  obslogChangeId: null,
  obslogSelectedIndex: 0,

  layoutMode: getRuntimeConfig().layout.startupMode,
  pinnedNodes: new Map(),

  selectedId: null,
  selectedIds: new Set(),

  rebaseSourceId: null,

  describeMode: false,
  describeValue: "",

  statusMessage: "",
  isLoading: false,
};

export const [state, setState] = createStore<SharedState>(initialState);

export const layoutResult = createMemo<LayoutResult>(() => {
  return calculateLayout(state.layoutMode, state.nodes, {}, state.pinnedNodes);
});

// Cache a changeId→index lookup to avoid repeated linear scans.
// Invalidated whenever layoutResult changes.
let _nodeIndexCache: Map<string, number> | null = null;
let _cachedLayoutNodes: CommitNode[] | null = null;

function getNodeIndexMap(): Map<string, number> {
  const nodes = layoutResult().nodes;
  if (nodes === _cachedLayoutNodes && _nodeIndexCache) return _nodeIndexCache;
  const map = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) map.set(nodes[i].changeId, i);
  _nodeIndexCache = map;
  _cachedLayoutNodes = nodes;
  return map;
}

export const selectedNode = () => {
  if (!state.selectedId) return null;
  const nodes = layoutResult().nodes;
  const idx = getNodeIndexMap().get(state.selectedId);
  return idx !== undefined ? nodes[idx] : null;
};

export const selectedIndex = () => {
  if (!state.selectedId) return 0;
  return getNodeIndexMap().get(state.selectedId) ?? 0;
};

export const actions = {
  setCwd: (cwd: string) => setState("cwd", cwd),

  setNodes: (nodes: CommitNode[]) => {
    const prevDescriptionById = new Map<string, string>();
    for (let i = 0; i < state.nodes.length; i++) {
      const prev = state.nodes[i]!;
      if (prev.descriptionFull) prevDescriptionById.set(prev.changeId, prev.descriptionFull);
    }

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node.descriptionFull) continue;
      const prev = prevDescriptionById.get(node.changeId);
      if (prev) node.descriptionFull = prev;
    }

    setState("nodes", nodes);
    if (!state.selectedId && nodes.length > 0) {
      const wc = nodes.find((n) => n.isWorkingCopy);
      actions.selectNode(wc?.changeId || nodes[0]?.changeId || null);
    }
  },

  setNodeDescriptionFull: (changeId: string, descriptionFull: string) => {
    const idx = state.nodes.findIndex((n) => n.changeId === changeId);
    if (idx < 0) return;
    setState("nodes", idx, "descriptionFull", descriptionFull);
  },

  setLayoutMode: (mode: LayoutMode) => setState("layoutMode", mode),

  selectNode: (changeId: string | null) => {
    if (!changeId) {
      setState("selectedId", null);
      setState("selectedIds", new Set());
      return;
    }
    setState("selectedId", changeId);
    setState("selectedIds", new Set([changeId]));
  },

  toggleSelection: (changeId: string) => {
    const next = new Set(state.selectedIds);
    if (next.has(changeId)) next.delete(changeId);
    else next.add(changeId);
    setState("selectedIds", next);
    if (next.size === 1) setState("selectedId", Array.from(next)[0] || null);
  },

  setFilesCache: (cache: Map<string, FilesCacheEntry>) => setState("filesCache", cache),
  setDiffCache: (cache: Map<string, DiffCacheEntry>) => setState("diffCache", cache),
  setRevsetQuery: (revset: string) => setState("revsetQuery", revset),

  setNodeExtraHeight: (changeId: string, extraHeight: number) => {
    setState("nodes", (n) => n.changeId === changeId, "extraHeight", Math.max(0, extraHeight));
  },

  setRebaseSource: (changeId: string | null) => setState("rebaseSourceId", changeId),

  startDescribe: (initialValue: string) => {
    setState("describeMode", true);
    setState("describeValue", initialValue);
  },

  updateDescribeValue: (value: string) => setState("describeValue", value),

  cancelDescribe: () => {
    setState("describeMode", false);
    setState("describeValue", "");
  },

  submitDescribe: (): string | null => {
    const value = state.describeValue;
    setState("describeMode", false);
    setState("describeValue", "");
    return value;
  },

  setStatusMessage: (msg: string) => setState("statusMessage", msg),
  setLoading: (loading: boolean) => setState("isLoading", loading),
  setTotalNodeCount: (count: number) => setState("totalNodeCount", count),

  pinNode: (changeId: string, lane: number) => {
    const next = new Map(state.pinnedNodes);
    next.set(changeId, lane);
    setState("pinnedNodes", next);
  },

  unpinNode: (changeId: string) => {
    const next = new Map(state.pinnedNodes);
    next.delete(changeId);
    setState("pinnedNodes", next);
  },

  setPinnedNodes: (pinned: Map<string, number>) => setState("pinnedNodes", new Map(pinned)),

  setViewMode: (mode: ViewMode) => setState("viewMode", mode),

  setOpLogEntries: (entries: OpLogEntry[]) => {
    setState("opLogEntries", entries);
    const current = entries.find((e) => e.isCurrent);
    if (current) setState("opLogSelectedId", current.id);
    else if (entries.length > 0) setState("opLogSelectedId", entries[0]!.id);
    else setState("opLogSelectedId", null);
  },

  selectOpLogEntry: (id: string | null) => setState("opLogSelectedId", id),

  setObslogEntries: (entries: ObslogEntry[]) => {
    setState("obslogEntries", entries);
    const maxIdx = Math.max(0, entries.length - 1);
    setState("obslogSelectedIndex", (idx) => Math.max(0, Math.min(idx, maxIdx)));
  },

  setObslogChangeId: (changeId: string | null) => {
    setState("obslogChangeId", changeId);
    setState("obslogEntries", []);
    setState("obslogSelectedIndex", 0);
  },

  setObslogSelectedIndex: (idx: number) => {
    const maxIdx = Math.max(0, state.obslogEntries.length - 1);
    setState("obslogSelectedIndex", Math.max(0, Math.min(idx, maxIdx)));
  },

  reset: () => {
    setState({ ...initialState });
  },
};

export const navigation = {
  moveUp: () => {
    if (state.viewMode === "oplog") {
      const entries = state.opLogEntries;
      const currentIdx = entries.findIndex((e) => e.id === state.opLogSelectedId);
      if (currentIdx > 0) actions.selectOpLogEntry(entries[currentIdx - 1]?.id || null);
      return;
    }
    if (state.viewMode === "obslog") {
      const currentIdx = state.obslogSelectedIndex;
      if (currentIdx > 0) actions.setObslogSelectedIndex(currentIdx - 1);
      return;
    }
    const nodes = layoutResult().nodes;
    const currentIdx = selectedIndex();
    if (currentIdx > 0) actions.selectNode(nodes[currentIdx - 1]?.changeId || null);
  },

  moveDown: () => {
    if (state.viewMode === "oplog") {
      const entries = state.opLogEntries;
      const currentIdx = entries.findIndex((e) => e.id === state.opLogSelectedId);
      if (currentIdx < entries.length - 1) actions.selectOpLogEntry(entries[currentIdx + 1]?.id || null);
      return;
    }
    if (state.viewMode === "obslog") {
      const maxIdx = Math.max(0, state.obslogEntries.length - 1);
      const currentIdx = state.obslogSelectedIndex;
      if (currentIdx < maxIdx) actions.setObslogSelectedIndex(currentIdx + 1);
      return;
    }
    const nodes = layoutResult().nodes;
    const currentIdx = selectedIndex();
    if (currentIdx < nodes.length - 1) actions.selectNode(nodes[currentIdx + 1]?.changeId || null);
  },

  moveToParent: () => {
    if (state.viewMode !== "log") return;
    const node = selectedNode();
    if (!node || node.parents.length === 0) return;
    const parentId = node.parents[0];
    const parent = layoutResult().nodes.find((n) => n.changeId === parentId);
    if (parent) actions.selectNode(parent.changeId);
  },

  moveToChild: () => {
    if (state.viewMode !== "log") return;
    const node = selectedNode();
    if (!node) return;
    const child = layoutResult().nodes.find((n) => n.parents.includes(node.changeId));
    if (child) actions.selectNode(child.changeId);
  },
};
