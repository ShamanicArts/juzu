import { createStore } from "solid-js/store";
import type { ViewportState } from "./types";
import { getRuntimeConfig } from "./runtime-config";

export interface WebState {
  viewport: ViewportState;
  sidebarScroll: number;
  showHelp: boolean;
  navigationLock: boolean;
  focusSelectedTick: number;
  expandedFilesNodeId: string | null;
  opMode: "none" | "split" | "squash" | "move";
  opSelectedPaths: Set<string>;
  opTargetId: string | null;
}

const initialWebState: WebState = {
  viewport: {
    offsetX: 50,
    offsetY: 50,
    scale: 1,
  },
  sidebarScroll: 0,
  showHelp: false,
  navigationLock: getRuntimeConfig().web.navigationLockDefault,
  focusSelectedTick: 0,
  expandedFilesNodeId: null,
  opMode: "none",
  opSelectedPaths: new Set(),
  opTargetId: null,
};

export const [webState, setWebState] = createStore<WebState>(initialWebState);

export const webActions = {
  resetOpMode: () => {
    setWebState("opMode", "none");
    setWebState("opSelectedPaths", new Set());
    setWebState("opTargetId", null);
  },

  setOpMode: (mode: WebState["opMode"]) => {
    setWebState("opMode", mode);
    setWebState("opSelectedPaths", new Set());
    setWebState("opTargetId", null);
  },

  toggleOpFile: (path: string) => {
    const next = new Set(webState.opSelectedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setWebState("opSelectedPaths", next);
  },

  setOpTarget: (changeId: string | null) => setWebState("opTargetId", changeId),

  setExpandedFilesNode: (changeId: string | null) => setWebState("expandedFilesNodeId", changeId),

  setViewport: (viewport: Partial<ViewportState>) => {
    setWebState("viewport", (prev) => ({ ...prev, ...viewport }));
  },

  setSidebarScroll: (offset: number) => {
    setWebState("sidebarScroll", Math.max(0, offset));
  },

  setShowHelp: (show: boolean) => setWebState("showHelp", show),
  toggleHelp: () => setWebState("showHelp", (v) => !v),

  setNavigationLock: (locked: boolean) => setWebState("navigationLock", locked),
  toggleNavigationLock: () => setWebState("navigationLock", (v) => !v),
  requestFocusSelected: () => setWebState("focusSelectedTick", (n) => n + 1),

  reset: () => {
    setWebState({ ...initialWebState });
  },
};
