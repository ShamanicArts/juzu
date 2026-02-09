import { beforeEach, describe, expect, test } from "bun:test";
import { setBackend } from "../runtime";
import { actions, state } from "../state";
import {
  ensureDiff,
  ensureFiles,
  opEdit,
  refreshLog,
} from "../usecases";
import type { JJBackend } from "../backend";
import type { CommitNode } from "../types";

function node(overrides: Partial<CommitNode>): CommitNode {
  return {
    changeId: "",
    commitId: "",
    parents: [],
    author: "dev@example.com",
    time: "2026-02-06 00:00:00",
    bookmarks: [],
    gitBranches: [],
    descriptionTitle: "",
    descriptionFull: "",
    isEmpty: false,
    isConflict: false,
    isHidden: false,
    isRoot: false,
    isWorkingCopy: false,
    ...overrides,
  };
}

type BackendCalls = {
  edit: number;
  log: number;
  files: number;
};

function makeBackend(overrides: Partial<JJBackend> = {}) {
  const calls: BackendCalls = { edit: 0, log: 0, files: 0 };
  const nodes = [node({ changeId: "wc1", commitId: "abcd123", isWorkingCopy: true })];

  const backend: JJBackend = {
    log: async () => {
      calls.log++;
      return nodes;
    },
    nodeCount: async () => {
      return nodes.length;
    },
    files: async () => {
      calls.files++;
      return [{ type: "M", path: "src/app.ts" }];
    },
    diff: async () => "diff --git a/x b/x",
    new: async () => {},
    edit: async () => {
      calls.edit++;
    },
    describe: async () => {},
    abandon: async () => {},
    duplicate: async () => {},
    rebase: async () => {},
    undo: async () => {},
    redo: async () => {},
    move: async () => {},
    insert: async () => {},
    squash: async () => {},
    split: async () => {},
    restore: async () => {},
    bookmarkSet: async () => {},
    bookmarkDelete: async () => {},
    bookmarkRename: async () => {},
    bookmarkTrack: async () => {},
    bookmarkUntrack: async () => {},
    gitFetch: async () => {},
    gitPush: async () => {},
    opLog: async () => [],
    restoreOperation: async () => {},
    obslog: async () => [],
    ...overrides,
  };

  return { backend, calls };
}

describe("usecases mutation wrappers", () => {
  beforeEach(() => {
    actions.reset();
    actions.setCwd("/tmp/repo");
  });

  test("opEdit triggers mutation and refresh with status updates", async () => {
    const { backend, calls } = makeBackend();
    setBackend(backend);

    await opEdit("wc1");

    expect(calls.edit).toBe(1);
    expect(calls.log).toBe(1);
    expect(state.statusMessage).toBe("nodes:1");
    expect(state.isLoading).toBe(false);
    expect(state.nodes.length).toBe(1);
  });

  test("mutation wrapper sets error state on failure", async () => {
    const { backend, calls } = makeBackend({
      edit: async () => {
        calls.edit++;
        throw new Error("edit boom");
      },
    });
    setBackend(backend);

    await expect(opEdit("wc1")).rejects.toThrow("edit boom");
    expect(calls.edit).toBe(1);
    expect(calls.log).toBe(0);
    expect(state.statusMessage.startsWith("Error:")).toBe(true);
    expect(state.isLoading).toBe(false);
  });

  test("refreshLog failure reports error and clears loading", async () => {
    const { backend, calls } = makeBackend({
      log: async () => {
        calls.log++;
        throw new Error("log boom");
      },
    });
    setBackend(backend);

    await expect(refreshLog(10)).rejects.toThrow("log boom");
    expect(calls.log).toBe(1);
    expect(state.statusMessage.startsWith("Error:")).toBe(true);
    expect(state.isLoading).toBe(false);
  });

  test("ensureFiles uses cache within maxAge", async () => {
    const { backend, calls } = makeBackend();
    setBackend(backend);

    const first = await ensureFiles("wc1", 60_000);
    const second = await ensureFiles("wc1", 60_000);

    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    expect(calls.files).toBe(1);
  });

  test("ensureDiff caches parsed file diffs", async () => {
    const { backend } = makeBackend({
      diff: async () => "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
    });
    setBackend(backend);

    const first = await ensureDiff("wc1", 60_000);
    const second = await ensureDiff("wc1", 60_000);

    expect(first).toContain("diff --git");
    expect(second).toContain("diff --git");
    const cached = state.diffCache.get("wc1");
    expect(!!cached).toBe(true);
    expect((cached?.files.length || 0) > 0).toBe(true);
    expect(cached?.files[0]?.path).toBe("src/app.ts");
  });
});
