import { createStore } from "solid-js/store";
import type { CommitNode, LayoutMode, FilesCacheEntry, ViewportState, LayoutResult } from "./types";
import { calculateLayout } from "./layout";

export interface AppState {
  // Repository
  cwd: string;
  
  // Data
  nodes: CommitNode[];
  filesCache: Map<string, FilesCacheEntry>;
  
  // Layout
  layoutMode: LayoutMode;
  layoutResult: LayoutResult;
  pinnedNodes: Map<string, number>; // changeId -> lane
  
  // Selection
  selectedId: string | null;
  selectedIds: Set<string>;
  
  // Viewport
  viewport: ViewportState;
  scrollOffset: number; // For TUI-style scrolling
  sidebarScroll: number;
  
  // UI State
  descExpanded: boolean;
  filesExpanded: boolean;
  showHelp: boolean;

  // Inline graph expansion (web + tui may use differently)
  expandedFilesNodeId: string | null;

  // Operation modes (shared)
  opMode: "none" | "split" | "squash" | "move";
  opSelectedPaths: Set<string>;
  opTargetId: string | null;
  
  // Modes
  rebaseSourceId: string | null;
  leaderMode: boolean;
  describeMode: boolean;
  describeValue: string;
  
  // Status
  statusMessage: string;
  isLoading: boolean;
  
  // Terminal size (TUI only)
  termSize: { width: number; height: number };
}

const initialState: AppState = {
  cwd: "",
  nodes: [],
  filesCache: new Map(),
  layoutMode: "chronological",
  layoutResult: {
    nodes: [],
    maxLane: 0,
    textColumnX: 0,
    totalHeight: 0,
  },
  pinnedNodes: new Map(),
  selectedId: null,
  selectedIds: new Set(),
  viewport: {
    offsetX: 50,
    offsetY: 50,
    scale: 1,
  },
  scrollOffset: 0,
  sidebarScroll: 0,
  descExpanded: false,
  filesExpanded: true,
  showHelp: false,
  expandedFilesNodeId: null,
  opMode: "none",
  opSelectedPaths: new Set(),
  opTargetId: null,
  rebaseSourceId: null,
  leaderMode: false,
  describeMode: false,
  describeValue: "",
  statusMessage: "",
  isLoading: false,
  termSize: { width: 80, height: 24 },
};

// Create the store
export const [state, setState] = createStore<AppState>(initialState);

// Computed getters
export const selectedNode = () => {
  if (!state.selectedId) return null;
  return state.layoutResult.nodes.find((n) => n.changeId === state.selectedId) || null;
};

export const selectedIndex = () => {
  if (!state.selectedId) return 0;
  return state.layoutResult.nodes.findIndex((n) => n.changeId === state.selectedId);
};

// Actions
export const actions = {
  setCwd: (cwd: string) => setState("cwd", cwd),
  
  setNodes: (nodes: CommitNode[]) => {
    setState((prev) => ({ ...prev, nodes }));
    
    // Calculate layout with new nodes
    const result = calculateLayout(state.layoutMode, nodes);
    setState((prev) => ({ ...prev, layoutResult: result }));
    
    // Auto-select working copy if nothing selected
    if (!state.selectedId && nodes.length > 0) {
      const wc = nodes.find((n) => n.isWorkingCopy);
      actions.selectNode(wc?.changeId || nodes[0]?.changeId);
    }
  },
  
  recalculateLayout: () => {
    const result = calculateLayout(state.layoutMode, state.nodes);
    
    // Apply pinned nodes
    result.nodes.forEach((node) => {
      if (state.pinnedNodes.has(node.changeId)) {
        node.lane = state.pinnedNodes.get(node.changeId)!;
        node.isPinned = true;
      }
    });
    
    // Recalculate with pinned positions
    const finalResult = calculateLayout(state.layoutMode, result.nodes);
    setState((prev) => ({ ...prev, layoutResult: finalResult }));
  },
  
  setLayoutMode: (mode: LayoutMode) => {
    setState("layoutMode", mode);
    actions.recalculateLayout();
  },
  
  selectNode: (changeId: string | null) => {
    if (!changeId) {
      setState("selectedId", null);
      setState("selectedIds", new Set());
      actions.resetOpMode();
      return;
    }
    setState("selectedId", changeId);
    setState("selectedIds", new Set([changeId]));
    setState("sidebarScroll", 0);
    actions.resetOpMode();
  },
  
  toggleSelection: (changeId: string) => {
    const newSet = new Set(state.selectedIds);
    if (newSet.has(changeId)) {
      newSet.delete(changeId);
    } else {
      newSet.add(changeId);
    }
    setState("selectedIds", newSet);
    if (newSet.size === 1) {
      setState("selectedId", Array.from(newSet)[0]);
    }
    actions.resetOpMode();
  },

  resetOpMode: () => {
    setState("opMode", "none");
    setState("opSelectedPaths", new Set());
    setState("opTargetId", null);
  },

  setOpMode: (mode: AppState["opMode"]) => {
    // Require a single selected node for op modes
    if (mode !== "none" && state.selectedIds.size !== 1) return;
    setState("opMode", mode);
    setState("opSelectedPaths", new Set());
    setState("opTargetId", null);
  },

  toggleOpFile: (path: string) => {
    const next = new Set(state.opSelectedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setState("opSelectedPaths", next);
  },

  setOpTarget: (changeId: string | null) => {
    setState("opTargetId", changeId);
  },

  setExpandedFilesNode: (changeId: string | null) => {
    setState("expandedFilesNodeId", changeId);
  },

  setNodeExtraHeight: (changeId: string, extraHeight: number) => {
    setState(
      "nodes",
      (n) => n.changeId === changeId,
      "extraHeight",
      Math.max(0, extraHeight)
    );
    actions.recalculateLayout();
  },
  
  setScrollOffset: (offset: number) => {
    setState("scrollOffset", Math.max(0, offset));
  },
  
  scrollToSelected: (visibleRows: number) => {
    const idx = selectedIndex();
    const offset = state.scrollOffset;
    if (idx < offset) {
      setState("scrollOffset", idx);
    } else if (idx >= offset + visibleRows) {
      setState("scrollOffset", Math.max(0, idx - visibleRows + 1));
    }
  },
  
  setSidebarScroll: (offset: number) => {
    setState("sidebarScroll", Math.max(0, offset));
  },
  
  setViewport: (viewport: Partial<ViewportState>) => {
    setState("viewport", (prev) => ({ ...prev, ...viewport }));
  },
  
  setFilesCache: (cache: Map<string, FilesCacheEntry>) => {
    setState("filesCache", cache);
  },
  
  toggleDescExpanded: () => setState("descExpanded", (v) => !v),
  toggleFilesExpanded: () => setState("filesExpanded", (v) => !v),
  
  setShowHelp: (show: boolean) => setState("showHelp", show),
  toggleHelp: () => setState("showHelp", (v) => !v),
  
  setRebaseSource: (changeId: string | null) => setState("rebaseSourceId", changeId),
  
  setLeaderMode: (active: boolean) => setState("leaderMode", active),
  
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
  
  setTermSize: (width: number, height: number) => {
    setState("termSize", { width, height });
  },
  
  pinNode: (changeId: string, lane: number) => {
    const newPinned = new Map(state.pinnedNodes);
    newPinned.set(changeId, lane);
    setState("pinnedNodes", newPinned);
    actions.recalculateLayout();
  },
  
  unpinNode: (changeId: string) => {
    const newPinned = new Map(state.pinnedNodes);
    newPinned.delete(changeId);
    setState("pinnedNodes", newPinned);
    actions.recalculateLayout();
  },

  setPinnedNodes: (pinned: Map<string, number>) => {
    setState("pinnedNodes", new Map(pinned));
    actions.recalculateLayout();
  },
  
  reset: () => {
    setState({ ...initialState });
  },
};

// Keyboard navigation helpers
export const navigation = {
  moveUp: () => {
    const nodes = state.layoutResult.nodes;
    const currentIdx = selectedIndex();
    if (currentIdx > 0) {
      actions.selectNode(nodes[currentIdx - 1]?.changeId || null);
    }
  },
  
  moveDown: () => {
    const nodes = state.layoutResult.nodes;
    const currentIdx = selectedIndex();
    if (currentIdx < nodes.length - 1) {
      actions.selectNode(nodes[currentIdx + 1]?.changeId || null);
    }
  },
  
  moveToParent: () => {
    const node = selectedNode();
    if (!node || node.parents.length === 0) return;
    
    // Find first parent
    const parentId = node.parents[0];
    const parent = state.layoutResult.nodes.find((n) => n.changeId === parentId);
    if (parent) {
      actions.selectNode(parent.changeId);
    }
  },
  
  moveToChild: () => {
    const node = selectedNode();
    if (!node) return;
    
    // Find first child (node that has current as parent)
    const child = state.layoutResult.nodes.find((n) => n.parents.includes(node.changeId));
    if (child) {
      actions.selectNode(child.changeId);
    }
  },
};
