import { createStore } from "solid-js/store";
import type { LeaderModeId } from "./tui-keymap";

export interface TuiState {
  termSize: { width: number; height: number };
  scrollOffset: number;
  sidebarScroll: number;
  showHelp: boolean;
  activeLeaderMode: LeaderModeId | null;
  sidebarCollapsed: boolean;
  cursorPos: number;
  mergeMode: boolean;
  mergeSelectedIds: Set<string>;
  descExpanded: boolean;
  filesExpanded: boolean;
  revsetMode: boolean;
  revsetValue: string;
  themePickerMode: boolean;
  themePickerIndex: number;
  themeVersion: number;
  diffFileIndex: number;
}

const initialTuiState: TuiState = {
  termSize: {
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24,
  },
  scrollOffset: 0,
  sidebarScroll: 0,
  showHelp: false,
  activeLeaderMode: null,
  sidebarCollapsed: false,
  cursorPos: 0,
  mergeMode: false,
  mergeSelectedIds: new Set(),
  descExpanded: false,
  filesExpanded: true,
  revsetMode: false,
  revsetValue: "",
  themePickerMode: false,
  themePickerIndex: 0,
  themeVersion: 0,
  diffFileIndex: 0,
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

  setActiveLeaderMode: (mode: LeaderModeId | null) => setTuiState("activeLeaderMode", mode),

  toggleSidebarCollapsed: () => setTuiState("sidebarCollapsed", (v) => !v),

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

  startThemePicker: (initialIndex = 0) => {
    setTuiState("themePickerMode", true);
    setTuiState("themePickerIndex", Math.max(0, initialIndex));
  },
  stopThemePicker: () => setTuiState("themePickerMode", false),
  setThemePickerIndex: (idx: number) => setTuiState("themePickerIndex", Math.max(0, idx)),
  bumpThemeVersion: () => setTuiState("themeVersion", (n) => n + 1),
  setDiffFileIndex: (idx: number) => setTuiState("diffFileIndex", Math.max(0, idx)),

  reset: () => {
    setTuiState({ ...initialTuiState });
  },
};
