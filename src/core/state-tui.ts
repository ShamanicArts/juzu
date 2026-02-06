import { createStore } from "solid-js/store";

export interface TuiState {
  termSize: { width: number; height: number };
  scrollOffset: number;
  sidebarScroll: number;
  showHelp: boolean;
  leaderMode: boolean;
  cursorPos: number;
  mergeMode: boolean;
  mergeSelectedIds: Set<string>;
  descExpanded: boolean;
  filesExpanded: boolean;
  revsetMode: boolean;
  revsetValue: string;
}

const initialTuiState: TuiState = {
  termSize: { width: 80, height: 24 },
  scrollOffset: 0,
  sidebarScroll: 0,
  showHelp: false,
  leaderMode: false,
  cursorPos: 0,
  mergeMode: false,
  mergeSelectedIds: new Set(),
  descExpanded: false,
  filesExpanded: true,
  revsetMode: false,
  revsetValue: "",
};

export const [tuiState, setTuiState] = createStore<TuiState>(initialTuiState);

export const tuiActions = {
  setTermSize: (width: number, height: number) => {
    setTuiState("termSize", { width, height });
  },

  setScrollOffset: (offset: number) => {
    setTuiState("scrollOffset", Math.max(0, offset));
  },

  setSidebarScroll: (offset: number) => {
    setTuiState("sidebarScroll", Math.max(0, offset));
  },

  setShowHelp: (show: boolean) => setTuiState("showHelp", show),
  toggleHelp: () => setTuiState("showHelp", (v) => !v),

  setLeaderMode: (active: boolean) => setTuiState("leaderMode", active),

  setCursorPos: (pos: number) => setTuiState("cursorPos", Math.max(0, pos)),

  setMergeMode: (active: boolean) => {
    setTuiState("mergeMode", active);
    if (!active) setTuiState("mergeSelectedIds", new Set());
  },

  toggleMergeSelection: (changeId: string) => {
    const next = new Set(tuiState.mergeSelectedIds);
    if (next.has(changeId)) next.delete(changeId);
    else next.add(changeId);
    setTuiState("mergeSelectedIds", next);
  },

  clearMergeSelection: () => setTuiState("mergeSelectedIds", new Set()),

  toggleDescExpanded: () => setTuiState("descExpanded", (v) => !v),
  toggleFilesExpanded: () => setTuiState("filesExpanded", (v) => !v),

  startRevset: (initial: string) => {
    setTuiState("revsetMode", true);
    setTuiState("revsetValue", initial);
  },
  updateRevset: (value: string) => setTuiState("revsetValue", value),
  cancelRevset: () => {
    setTuiState("revsetMode", false);
    setTuiState("revsetValue", "");
  },
  submitRevset: (): string => {
    const value = tuiState.revsetValue;
    setTuiState("revsetMode", false);
    setTuiState("revsetValue", value);
    return value;
  },

  reset: () => {
    setTuiState({ ...initialTuiState });
  },
};
