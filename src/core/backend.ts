import type { CommitNode } from "./types";

export type FileEntry = { type: string; path: string };

export interface JJBackend {
  // Optional in some environments (e.g. browser)
  findRoot?: (startDir: string) => Promise<string | null>;

  log: (args: { cwd: string; limit: number }) => Promise<CommitNode[]>;
  files: (args: { cwd: string; changeId: string }) => Promise<FileEntry[]>;
  diff: (args: { cwd: string; changeId: string }) => Promise<string>;

  new: (args: { cwd: string; parentId?: string; parentIds?: string[] }) => Promise<void>;
  edit: (args: { cwd: string; changeId: string }) => Promise<void>;
  describe: (args: { cwd: string; changeId: string; description: string }) => Promise<void>;
  abandon: (args: { cwd: string; changeId: string }) => Promise<void>;
  duplicate: (args: { cwd: string; changeId: string }) => Promise<void>;
  rebase: (args: { cwd: string; sourceId: string; destinationId: string }) => Promise<void>;
  undo: (args: { cwd: string }) => Promise<void>;

  move: (args: { cwd: string; sourceId: string; destinationId: string }) => Promise<void>;
  insert: (args: { cwd: string; afterId?: string; parentId?: string; childId?: string }) => Promise<void>;
  squash: (args: { cwd: string; changeId: string; intoId?: string | null; paths?: string[] }) => Promise<void>;
  split: (args: { cwd: string; changeId: string; paths: string[]; message?: string }) => Promise<void>;
}
