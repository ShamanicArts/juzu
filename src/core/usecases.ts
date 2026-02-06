import { actions, state } from "./state";
import { getBackend } from "./runtime";
import type { FileEntry } from "./backend";
import type { OpLogEntry, ObslogEntry } from "./jj-api";
import { splitDiffByFile } from "./diff";

function cwdOrEmpty() {
  return state.cwd || "";
}

async function runMutation(label: string, fn: () => Promise<void>) {
  if (state.isLoading) return;
  actions.setLoading(true);
  actions.setStatusMessage(label);
  try {
    await fn();
    await refreshLog();
  } catch (e) {
    actions.setStatusMessage(`Error: ${String(e)}`);
    throw e;
  } finally {
    actions.setLoading(false);
  }
}

export async function refreshLog(limit = 500) {
  const backend = getBackend();
  actions.setLoading(true);
  actions.setStatusMessage("Loading...");
  try {
    const nodes = await backend.log({ cwd: cwdOrEmpty(), limit, revset: state.revsetQuery || undefined });
    actions.setNodes(nodes);
    actions.setStatusMessage(`nodes:${nodes.length}`);
  } catch (e) {
    actions.setStatusMessage(`Error: ${String(e)}`);
    throw e;
  } finally {
    actions.setLoading(false);
  }
}

export async function initCwdFrom(startDir: string): Promise<string | null> {
  const backend = getBackend();
  if (!backend.findRoot) return null;
  const root = await backend.findRoot(startDir);
  if (root) actions.setCwd(root);
  return root;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function prefetchFiles(changeIds: string[], maxAgeMs = 30_000, concurrency = 16) {
  const ids = Array.from(new Set(changeIds)).filter(Boolean);
  if (ids.length === 0) return;
  await mapLimit(ids, concurrency, async (id) => {
    try {
      await ensureFiles(id, maxAgeMs);
    } catch {
      // Keep going
    }
  });
}

export async function ensureFiles(changeId: string, maxAgeMs = 30_000): Promise<FileEntry[]> {
  const cached = state.filesCache.get(changeId);
  if (cached && Date.now() - cached.atMs < maxAgeMs) return cached.files;

  const backend = getBackend();
  const files = await backend.files({ cwd: cwdOrEmpty(), changeId });
  const next = new Map(state.filesCache);
  next.set(changeId, { atMs: Date.now(), files });
  actions.setFilesCache(next);
  return files;
}

export async function fetchDiff(changeId: string): Promise<string> {
  const backend = getBackend();
  return backend.diff({ cwd: cwdOrEmpty(), changeId });
}

export async function ensureDiff(changeId: string, maxAgeMs = 30_000): Promise<string> {
  const cached = state.diffCache.get(changeId);
  if (cached && Date.now() - cached.atMs < maxAgeMs) return cached.diff;

  const backend = getBackend();
  const diff = await backend.diff({ cwd: cwdOrEmpty(), changeId });
  const files = splitDiffByFile(diff);
  const next = new Map(state.diffCache);
  next.set(changeId, { atMs: Date.now(), diff, files });
  actions.setDiffCache(next);
  return diff;
}

export async function opNew(parentId: string) {
  const backend = getBackend();
  await runMutation("Creating new commit...", () => backend.new({ cwd: cwdOrEmpty(), parentId }));
}

export async function opMerge(parentIds: string[]) {
  const backend = getBackend();
  await runMutation("Creating merge commit...", () => backend.new({ cwd: cwdOrEmpty(), parentIds }));
}

export async function opEdit(changeId: string) {
  const backend = getBackend();
  await runMutation("Editing revision...", () => backend.edit({ cwd: cwdOrEmpty(), changeId }));
}

export async function opDescribe(changeId: string, description: string) {
  const backend = getBackend();
  await runMutation("Saving description...", () => backend.describe({ cwd: cwdOrEmpty(), changeId, description }));
}

export async function opAbandon(changeId: string) {
  const backend = getBackend();
  await runMutation("Abandoning...", () => backend.abandon({ cwd: cwdOrEmpty(), changeId }));
}

export async function opDuplicate(changeId: string) {
  const backend = getBackend();
  await runMutation("Duplicating...", () => backend.duplicate({ cwd: cwdOrEmpty(), changeId }));
}

export async function opRebase(sourceId: string, destinationId: string) {
  const backend = getBackend();
  await runMutation(`Rebasing ${sourceId.slice(0, 8)}...`, () =>
    backend.rebase({ cwd: cwdOrEmpty(), sourceId, destinationId })
  );
  actions.setRebaseSource(null);
}

export async function opUndo() {
  const backend = getBackend();
  await runMutation("Undoing...", () => backend.undo({ cwd: cwdOrEmpty() }));
}

export async function opRedo() {
  const backend = getBackend();
  await runMutation("Redoing...", () => backend.redo({ cwd: cwdOrEmpty() }));
}

export async function opMove(sourceId: string, destinationId: string) {
  const backend = getBackend();
  await runMutation("Moving...", () => backend.move({ cwd: cwdOrEmpty(), sourceId, destinationId }));
}

export async function opInsertAfter(afterId: string) {
  const backend = getBackend();
  await runMutation("Inserting commit...", () => backend.insert({ cwd: cwdOrEmpty(), afterId }));
}

export async function opInsertBetween(parentId: string, childId: string) {
  const backend = getBackend();
  await runMutation("Inserting commit...", () => backend.insert({ cwd: cwdOrEmpty(), parentId, childId }));
}

export async function opSquash(changeId: string, opts: { intoId?: string | null; paths?: string[] } = {}) {
  const backend = getBackend();
  await runMutation("Squashing...", () => backend.squash({ cwd: cwdOrEmpty(), changeId, ...opts }));
}

export async function opSplit(changeId: string, paths: string[], message?: string) {
  const backend = getBackend();
  await runMutation("Splitting...", () => backend.split({ cwd: cwdOrEmpty(), changeId, paths, message }));
}

export async function opRestoreOperation(operationId: string) {
  const backend = getBackend();
  await runMutation("Restoring operation...", () => backend.restoreOperation({ cwd: cwdOrEmpty(), operationId }));
}

export async function opRestore(changeId: string, paths?: string[]) {
  const backend = getBackend();
  await runMutation("Restoring files...", () => backend.restore({ cwd: cwdOrEmpty(), changeId, paths }));
}

export async function opBookmarkSet(name: string, revision: string) {
  const backend = getBackend();
  await runMutation(`Setting bookmark ${name}...`, () => backend.bookmarkSet({ cwd: cwdOrEmpty(), name, revision }));
}

export async function opBookmarkDelete(name: string) {
  const backend = getBackend();
  await runMutation(`Deleting bookmark ${name}...`, () => backend.bookmarkDelete({ cwd: cwdOrEmpty(), name }));
}

export async function opBookmarkRename(oldName: string, newName: string) {
  const backend = getBackend();
  await runMutation(`Renaming bookmark ${oldName}...`, () => backend.bookmarkRename({ cwd: cwdOrEmpty(), oldName, newName }));
}

export async function opBookmarkTrack(remoteBookmark: string) {
  const backend = getBackend();
  await runMutation(`Tracking ${remoteBookmark}...`, () => backend.bookmarkTrack({ cwd: cwdOrEmpty(), remoteBookmark }));
}

export async function opBookmarkUntrack(remoteBookmark: string) {
  const backend = getBackend();
  await runMutation(`Untracking ${remoteBookmark}...`, () => backend.bookmarkUntrack({ cwd: cwdOrEmpty(), remoteBookmark }));
}

export async function opGitFetch() {
  const backend = getBackend();
  await runMutation("Fetching from remote...", () => backend.gitFetch({ cwd: cwdOrEmpty() }));
}

export async function opGitPush(bookmark?: string) {
  const backend = getBackend();
  await runMutation("Pushing to remote...", () => backend.gitPush({ cwd: cwdOrEmpty(), bookmark }));
}

// Op log operations
export async function refreshOpLog(limit = 100): Promise<OpLogEntry[]> {
  const backend = getBackend();
  const entries = await backend.opLog({ cwd: cwdOrEmpty(), limit });
  actions.setOpLogEntries(entries);
  return entries;
}

// Obslog operations
export async function refreshObslog(changeId: string, limit = 50): Promise<ObslogEntry[]> {
  const backend = getBackend();
  const entries = await backend.obslog({ cwd: cwdOrEmpty(), changeId, limit });
  actions.setObslogEntries(entries);
  return entries;
}
