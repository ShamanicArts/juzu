// Shared types for jj-viz - used by both TUI and Web UI

export interface CommitNode {
  changeId: string;
  commitId: string;
  parents: string[];
  author: string;
  time: string;
  bookmarks: string[];
  gitBranches: string[];
  descriptionTitle: string;
  descriptionFull: string;
  isEmpty: boolean;
  isConflict: boolean;
  isHidden: boolean;
  isRoot: boolean;
  isWorkingCopy: boolean;
  // Layout props
  x?: number;
  y?: number;
  lane?: number;
  extraHeight?: number;
  isPinned?: boolean;
}

export type LayoutMode = 'chronological' | 'mainline' | 'bookmark-centric' | 'wc-focused' | 'topological';

export interface FilesCacheEntry {
  atMs: number;
  files: Array<{ type: string; path: string }>;
}

export interface GraphConfig {
  nodeRadius: number;
  laneWidth: number;
  ySpacing: number;
  canvasPadding: number;
  textColumnGap: number;
  colors: {
    node: string;
    nodeSelected: string;
    nodeConflict: string;
    text: string;
    textDesc: string;
    nodeBorder: string;
    lanes: string[];
  };
}

export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  nodeRadius: 5,
  laneWidth: 24,
  ySpacing: 45,
  canvasPadding: 50,
  textColumnGap: 60,
  colors: {
    node: '#444',
    nodeSelected: '#ffffff',
    nodeConflict: '#ff0055',
    text: '#888',
    textDesc: '#bbb',
    nodeBorder: '#666',
    lanes: [
      '#00f0ff', // Cyan
      '#ff0055', // Red/Pink
      '#00ff9d', // Green
      '#ffaa00', // Orange
      '#aa00ff', // Purple
      '#00aaff', // Blue
      '#ffff00', // Yellow
      '#ff00aa', // Magenta
    ],
  },
};

export interface ViewportState {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export interface LayoutResult {
  nodes: CommitNode[];
  maxLane: number;
  textColumnX: number;
  totalHeight: number;
}
