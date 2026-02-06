import type { CommitNode } from "./types";
import type { OpLogEntry, ObslogEntry } from "./jj-api";

export type FileEntry = { type: string; path: string };

export interface JJBackend {
  // Optional in some environments (e.g. browser)
  findRoot?: (startDir: string) => Promise<string | null>;

  log: (args: { cwd: string; limit: number; revset?: string }) => Promise<CommitNode[]>;
  files: (args: { cwd: string; changeId: string }) => Promise<FileEntry[]>;
  diff: (args: { cwd: string; changeId: string }) => Promise<string>;

  new: (args: { cwd: string; parentId?: string; parentIds?: string[] }) => Promise<void>;
  edit: (args: { cwd: string; changeId: string }) => Promise<void>;
  describe: (args: { cwd: string; changeId: string; description: string }) => Promise<void>;
  abandon: (args: { cwd: string; changeId: string }) => Promise<void>;
  duplicate: (args: { cwd: string; changeId: string }) => Promise<void>;
  rebase: (args: { cwd: string; sourceId: string; destinationId: string }) => Promise<void>;
  undo: (args: { cwd: string }) => Promise<void>;
  redo: (args: { cwd: string }) => Promise<void>;

  move: (args: { cwd: string; sourceId: string; destinationId: string }) => Promise<void>;
  insert: (args: { cwd: string; afterId?: string; parentId?: string; childId?: string }) => Promise<void>;
  squash: (args: { cwd: string; changeId: string; intoId?: string | null; paths?: string[] }) => Promise<void>;
  split: (args: { cwd: string; changeId: string; paths: string[]; message?: string }) => Promise<void>;
  restore: (args: { cwd: string; changeId: string; paths?: string[] }) => Promise<void>;

  bookmarkSet: (args: { cwd: string; name: string; revision: string }) => Promise<void>;
  bookmarkDelete: (args: { cwd: string; name: string }) => Promise<void>;
  bookmarkRename: (args: { cwd: string; oldName: string; newName: string }) => Promise<void>;
  bookmarkTrack: (args: { cwd: string; remoteBookmark: string }) => Promise<void>;
  bookmarkUntrack: (args: { cwd: string; remoteBookmark: string }) => Promise<void>;

  gitFetch: (args: { cwd: string }) => Promise<void>;
  gitPush: (args: { cwd: string; bookmark?: string }) => Promise<void>;

  // Operation log / obslog
  opLog: (args: { cwd: string; limit: number }) => Promise<OpLogEntry[]>;
  restoreOperation: (args: { cwd: string; operationId: string }) => Promise<void>;
  obslog: (args: { cwd: string; changeId: string; limit: number }) => Promise<ObslogEntry[]>;
}
