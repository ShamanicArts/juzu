import type { JJBackend } from "../core/backend";
import type { CommitNode } from "../core/types";
import { fetchJJLog, fetchFilesForNodes, findJJRoot, jjAbandon, jjDescribe, jjDuplicate, jjEdit, jjGetDiff, jjInsertAfter, jjMove, jjNew, jjRebase, jjSplit, jjSquashPaths, jjUndo, jjRedo, runCmdText, fetchOpLog, fetchObslog, jjRestoreOperation } from "../core/jj-api";

export function createTuiBackend(): JJBackend {
  return {
    findRoot: findJJRoot,

    log: async ({ cwd, limit }) => fetchJJLog(cwd, limit),
    files: async ({ cwd, changeId }) => {
      const nodes: CommitNode[] = [{
        changeId,
        commitId: "",
        parents: [],
        author: "",
        time: "",
        bookmarks: [],
        gitBranches: [],
        descriptionTitle: "",
        descriptionFull: "",
        isEmpty: false,
        isConflict: false,
        isHidden: false,
        isRoot: false,
        isWorkingCopy: false,
      }];
      let out: Array<{ type: string; path: string }> = [];
      await fetchFilesForNodes(nodes, cwd, (cache) => {
        out = cache.get(changeId)?.files || [];
      });
      return out;
    },
    diff: async ({ cwd, changeId }) => jjGetDiff(changeId, cwd),

    new: async ({ cwd, parentId, parentIds }) => {
      if (parentIds && parentIds.length > 0) {
        // For now: best-effort, jj new supports multiple parents
        await runCmdText(["jj", "new", ...parentIds], cwd);
        return;
      }
      if (!parentId) throw new Error("Missing parentId");
      await jjNew(parentId, cwd);
    },
    edit: async ({ cwd, changeId }) => jjEdit(changeId, cwd),
    describe: async ({ cwd, changeId, description }) => jjDescribe(changeId, description, cwd),
    abandon: async ({ cwd, changeId }) => jjAbandon(changeId, cwd),
    duplicate: async ({ cwd, changeId }) => jjDuplicate(changeId, cwd),
    rebase: async ({ cwd, sourceId, destinationId }) => jjRebase(sourceId, destinationId, cwd),
    undo: async ({ cwd }) => jjUndo(cwd),
    redo: async ({ cwd }) => jjRedo(cwd),

    move: async ({ cwd, sourceId, destinationId }) => jjMove(sourceId, destinationId, cwd),
    insert: async ({ cwd, afterId, parentId, childId }) => {
      if (afterId) {
        await jjNew(afterId, cwd);
        return;
      }
      if (parentId && childId) {
        await jjInsertAfter(parentId, childId, cwd);
        return;
      }
      throw new Error("Missing afterId or (parentId, childId)");
    },
    squash: async ({ cwd, changeId, intoId, paths }) => {
      if (intoId) {
        await jjSquashPaths(changeId, { intoId, paths }, cwd);
        return;
      }
      // Match legacy behavior: squash revision into its parent.
      const args: string[] = ["jj", "squash", "-r", changeId, "--use-destination-message"];
      if (paths && paths.length > 0) args.push(...paths);
      await runCmdText(args, cwd);
    },
    split: async ({ cwd, changeId, paths, message }) => jjSplit(changeId, paths, cwd, message || "split"),

    opLog: async ({ cwd, limit }) => fetchOpLog(cwd, limit),
    restoreOperation: async ({ cwd, operationId }) => jjRestoreOperation(operationId, cwd),
    obslog: async ({ cwd, changeId, limit }) => fetchObslog(changeId, cwd, limit),
  };
}
