import { actions, state } from "./state";
import { getBackend } from "./runtime";
import type { FileEntry } from "./backend";
import type { OpLogEntry, ObslogEntry } from "./jj-api";
import { splitDiffByFile } from "./diff";

const DEFAULT_LOG_LIMIT = readPositiveIntEnv("JJVIZ_LOG_LIMIT", 500);
const FILES_CACHE_MAX_ENTRIES = readPositiveIntEnv("JJVIZ_FILES_CACHE_MAX_ENTRIES", 12);
const DIFF_CACHE_MAX_ENTRIES = readPositiveIntEnv("JJVIZ_DIFF_CACHE_MAX_ENTRIES", 1);
const DIFF_CACHE_MAX_BYTES = readPositiveIntEnv("JJVIZ_DIFF_CACHE_MAX_BYTES", 3 * 1024 * 1024);
const PREFETCH_CONCURRENCY = readPositiveIntEnv("JJVIZ_PREFETCH_CONCURRENCY", 2);
const PREFETCH_FILES_MAX_AGE_MS = readPositiveIntEnv("JJVIZ_PREFETCH_FILES_MAX_AGE_MS", 10_000);

let activeLogLimit = DEFAULT_LOG_LIMIT;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function estimateDiffEntryBytes(files: Array<{ path: string; diff: string }>): number {
  let total = 0;
  for (const f of files) {
    total += Buffer.byteLength(f.path, "utf8");
    total += Buffer.byteLength(f.diff, "utf8");
  }
  return total;
}

function selectedKeepSet(extraId?: string): Set<string> {
  const keep = new Set<string>();
  if (state.selectedId) keep.add(state.selectedId);
  if (extraId) keep.add(extraId);
  return keep;
}

function pruneFilesCache(cache: Map<string, { atMs: number; files: FileEntry[] }>, keep: Set<string>): Map<string, { atMs: number; files: FileEntry[] }> {
  if (cache.size <= FILES_CACHE_MAX_ENTRIES) return cache;
  const out = new Map(cache);
  const candidates = Array.from(out.entries())
    .filter(([changeId]) => !keep.has(changeId))
    .sort((a, b) => a[1].atMs - b[1].atMs);
  while (out.size > FILES_CACHE_MAX_ENTRIES && candidates.length > 0) {
    const oldest = candidates.shift();
    if (!oldest) break;
    out.delete(oldest[0]);
  }
  return out;
}

function pruneDiffCache(
  cache: Map<string, { atMs: number; files: Array<{ path: string; diff: string }>; bytes: number }>,
  keep: Set<string>
): Map<string, { atMs: number; files: Array<{ path: string; diff: string }>; bytes: number }> {
  if (cache.size === 0) return cache;

  const out = new Map(cache);
  const candidates = Array.from(out.entries())
    .filter(([changeId]) => !keep.has(changeId))
    .sort((a, b) => a[1].atMs - b[1].atMs);

  const totalBytes = () => {
    let total = 0;
    for (const entry of out.values()) total += entry.bytes;
    return total;
  };

  while ((out.size > DIFF_CACHE_MAX_ENTRIES || totalBytes() > DIFF_CACHE_MAX_BYTES) && candidates.length > 0) {
    const oldest = candidates.shift();
    if (!oldest) break;
    out.delete(oldest[0]);
  }

  return out;
}

function pruneCachesForVisibleNodes(nodes: Array<{ changeId: string }>) {
  const visibleIds = new Set(nodes.map((n) => n.changeId));
  const keep = selectedKeepSet();

  const filesSubset = new Map<string, { atMs: number; files: FileEntry[] }>();
  for (const [changeId, entry] of state.filesCache) {
    if (visibleIds.has(changeId) || keep.has(changeId)) filesSubset.set(changeId, entry);
  }
  actions.setFilesCache(pruneFilesCache(filesSubset, keep));

  const diffSubset = new Map(state.diffCache);
  for (const changeId of diffSubset.keys()) {
    if (!visibleIds.has(changeId) && !keep.has(changeId)) diffSubset.delete(changeId);
  }
  actions.setDiffCache(pruneDiffCache(diffSubset, keep));
}

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

export async function refreshLog(limit = activeLogLimit) {
  activeLogLimit = Math.max(1, limit);
  const backend = getBackend();
  actions.setLoading(true);
  actions.setStatusMessage("Loading...");
  try {
    const nodes = await backend.log({ cwd: cwdOrEmpty(), limit: activeLogLimit, revset: state.revsetQuery || undefined });
    actions.setNodes(nodes);
    pruneCachesForVisibleNodes(nodes);
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

export async function prefetchFiles(
  changeIds: string[],
  maxAgeMs = PREFETCH_FILES_MAX_AGE_MS,
  concurrency = PREFETCH_CONCURRENCY
) {
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, PREFETCH_CONCURRENCY));
  const effectiveMaxAgeMs = maxAgeMs > 0 ? maxAgeMs : PREFETCH_FILES_MAX_AGE_MS;
  const ids = Array.from(new Set(changeIds)).filter(Boolean);
  if (ids.length === 0) return;
  await mapLimit(ids, effectiveConcurrency, async (id) => {
    try {
      await ensureFiles(id, effectiveMaxAgeMs);
    } catch {
      // Keep going
    }
  });
}

export async function ensureFiles(changeId: string, maxAgeMs = 30_000): Promise<FileEntry[]> {
  const now = Date.now();
  const cached = state.filesCache.get(changeId);
  if (cached && now - cached.atMs < maxAgeMs) return cached.files;

  const backend = getBackend();
  const files = await backend.files({ cwd: cwdOrEmpty(), changeId });
  const next = new Map(state.filesCache);
  next.set(changeId, { atMs: now, files });
  actions.setFilesCache(pruneFilesCache(next, selectedKeepSet(changeId)));
  return files;
}

export async function fetchDiff(changeId: string): Promise<string> {
  const backend = getBackend();
  return backend.diff({ cwd: cwdOrEmpty(), changeId });
}

export async function ensureDiff(changeId: string, maxAgeMs = 30_000): Promise<string> {
  const now = Date.now();
  const cached = state.diffCache.get(changeId);
  if (cached && now - cached.atMs < maxAgeMs) return cached.files[0]?.diff || "";

  const backend = getBackend();
  const diff = await backend.diff({ cwd: cwdOrEmpty(), changeId });
  const files = splitDiffByFile(diff);
  const bytes = estimateDiffEntryBytes(files);
  const next = new Map(state.diffCache);
  next.set(changeId, { atMs: now, files, bytes });
  actions.setDiffCache(pruneDiffCache(next, selectedKeepSet(changeId)));
  return files[0]?.diff || diff;
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
