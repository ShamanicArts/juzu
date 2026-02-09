import type { JJBackend } from "../core/backend";
import { fetchCommitDescription, fetchJJLog, fetchTotalNodeCount, findJJRoot, jjAbandon, jjBookmarkDelete, jjBookmarkRename, jjBookmarkSet, jjBookmarkTrack, jjBookmarkUntrack, jjDescribe, jjDuplicate, jjEdit, jjGetDiff, jjGetDiffForPath, jjGetFiles, jjGitFetch, jjGitPush, jjInsertAfter, jjMove, jjNew, jjRebase, jjRestore, jjSplit, jjSquashPaths, jjUndo, jjRedo, runCmdText, fetchOpLog, fetchObslog, jjRestoreOperation } from "../core/jj-api";

export function createTuiBackend(): JJBackend {
  return {
    findRoot: findJJRoot,

    log: async ({ cwd, limit, revset }) => fetchJJLog(cwd, limit, revset),
    nodeCount: async ({ cwd, revset }) => fetchTotalNodeCount(cwd, revset),
    description: async ({ cwd, changeId }) => fetchCommitDescription(cwd, changeId),
    files: async ({ cwd, changeId }) => jjGetFiles(changeId, cwd),
    diff: async ({ cwd, changeId }) => jjGetDiff(changeId, cwd),
    diffFile: async ({ cwd, changeId, path }) => jjGetDiffForPath(changeId, path, cwd),

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
    restore: async ({ cwd, changeId, paths }) => jjRestore(changeId, cwd, paths),

    bookmarkSet: async ({ cwd, name, revision }) => jjBookmarkSet(name, revision, cwd),
    bookmarkDelete: async ({ cwd, name }) => jjBookmarkDelete(name, cwd),
    bookmarkRename: async ({ cwd, oldName, newName }) => jjBookmarkRename(oldName, newName, cwd),
    bookmarkTrack: async ({ cwd, remoteBookmark }) => jjBookmarkTrack(remoteBookmark, cwd),
    bookmarkUntrack: async ({ cwd, remoteBookmark }) => jjBookmarkUntrack(remoteBookmark, cwd),

    gitFetch: async ({ cwd }) => jjGitFetch(cwd),
    gitPush: async ({ cwd, bookmark }) => jjGitPush(cwd, bookmark),

    opLog: async ({ cwd, limit }) => fetchOpLog(cwd, limit),
    restoreOperation: async ({ cwd, operationId }) => jjRestoreOperation(operationId, cwd),
    obslog: async ({ cwd, changeId, limit }) => fetchObslog(changeId, cwd, limit),
  };
}
