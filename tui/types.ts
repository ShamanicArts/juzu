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
  lane?: number;
}

export type LayoutMode = "chronological" | "mainline" | "bookmark-centric" | "wc-focused" | "topological";

export interface FilesCacheEntry {
  atMs: number;
  files: Array<{ type: string; path: string }>;
}
