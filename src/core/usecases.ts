import { actions, state } from "./state";
import { getBackend } from "./runtime";
import type { FileEntry } from "./backend";
import type { OpLogEntry, ObslogEntry } from "./jj-api";
import { splitDiffByFile } from "./diff";

const DEFAULT_LOG_LIMIT = readPositiveIntEnv("JUZU_LOG_LIMIT", 500);
const FILES_CACHE_MAX_ENTRIES = readPositiveIntEnv("JUZU_FILES_CACHE_MAX_ENTRIES", 12);
const DIFF_CACHE_MAX_ENTRIES = readPositiveIntEnv("JUZU_DIFF_CACHE_MAX_ENTRIES", 1);
const DIFF_CACHE_MAX_BYTES = readPositiveIntEnv("JUZU_DIFF_CACHE_MAX_BYTES", 3 * 1024 * 1024);
const PREFETCH_CONCURRENCY = readPositiveIntEnv("JUZU_PREFETCH_CONCURRENCY", 2);
const PREFETCH_FILES_MAX_AGE_MS = readPositiveIntEnv("JUZU_PREFETCH_FILES_MAX_AGE_MS", 10_000);

let activeLogLimit = DEFAULT_LOG_LIMIT;
const inFlightFilesById = new Map<string, Promise<FileEntry[]>>();
const inFlightDiffById = new Map<string, Promise<string>>();

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function estimateDiffEntryBytes(files: Array<{ path: string; diff: string }>): number {
  let total = 0;
  for (const f of files) {
    // Approximate byte length without Buffer.byteLength overhead for ASCII-heavy diffs
    total += f.path.length + f.diff.length;
  }
  return total;
}

/**
 * Prune files cache in-place on the provided map. Returns true if anything was deleted.
 * Avoids creating intermediate Map copies.
 */
function pruneFilesCacheInPlace(cache: Map<string, { atMs: number; files: FileEntry[] }>, keepId: string | null): boolean {
  if (cache.size <= FILES_CACHE_MAX_ENTRIES) return false;
  // Build sorted eviction list — only allocate the candidate array
  const candidates: Array<[string, number]> = [];
  for (const [changeId, entry] of cache) {
    if (changeId === keepId) continue;
    candidates.push([changeId, entry.atMs]);
  }
  if (candidates.length === 0) return false;
  candidates.sort((a, b) => a[1] - b[1]);
  let deleted = false;
  while (cache.size > FILES_CACHE_MAX_ENTRIES && candidates.length > 0) {
    cache.delete(candidates.shift()![0]);
    deleted = true;
  }
  return deleted;
}

/**
 * Prune diff cache in-place. Returns true if anything was deleted.
 */
function pruneDiffCacheInPlace(
  cache: Map<string, { atMs: number; files: Array<{ path: string; diff: string }>; bytes: number }>,
  keepId: string | null
): boolean {
  if (cache.size === 0) return false;

  let totalBytes = 0;
  for (const entry of cache.values()) totalBytes += entry.bytes;

  if (cache.size <= DIFF_CACHE_MAX_ENTRIES && totalBytes <= DIFF_CACHE_MAX_BYTES) return false;

  const candidates: Array<[string, number]> = [];
  for (const [changeId, entry] of cache) {
    if (changeId === keepId) continue;
    candidates.push([changeId, entry.atMs]);
  }
  if (candidates.length === 0) return false;
  candidates.sort((a, b) => a[1] - b[1]);

  let deleted = false;
  while ((cache.size > DIFF_CACHE_MAX_ENTRIES || totalBytes > DIFF_CACHE_MAX_BYTES) && candidates.length > 0) {
    const key = candidates.shift()![0];
    const entry = cache.get(key);
    if (entry) totalBytes -= entry.bytes;
    cache.delete(key);
    deleted = true;
  }
  return deleted;
}

/**
 * Prune caches after a refresh, removing entries for nodes no longer visible.
 * Mutates in-place and only triggers a store update if something actually changed.
 */
function pruneCachesForVisibleNodes(nodes: Array<{ changeId: string }>) {
  const visibleIds = new Set(nodes.map((n) => n.changeId));
  const keepId = state.selectedId;

  // Prune files cache: remove entries for invisible, non-selected nodes
  const filesCache = state.filesCache;
  let filesChanged = false;
  const filesToDelete: string[] = [];
  for (const changeId of filesCache.keys()) {
    if (!visibleIds.has(changeId) && changeId !== keepId) filesToDelete.push(changeId);
  }
  if (filesToDelete.length > 0) {
    // Must create a new Map to trigger SolidJS reactivity, but only copy once
    const next = new Map(filesCache);
    for (const id of filesToDelete) next.delete(id);
    pruneFilesCacheInPlace(next, keepId);
    actions.setFilesCache(next);
    filesChanged = true;
  } else if (pruneFilesCacheInPlace(filesCache as Map<string, { atMs: number; files: FileEntry[] }>, keepId)) {
    // Entries were pruned by count — trigger reactivity
    actions.setFilesCache(new Map(filesCache));
    filesChanged = true;
  }

  // Prune diff cache
  const diffCache = state.diffCache;
  const diffToDelete: string[] = [];
  for (const changeId of diffCache.keys()) {
    if (!visibleIds.has(changeId) && changeId !== keepId) diffToDelete.push(changeId);
  }
  if (diffToDelete.length > 0) {
    const next = new Map(diffCache);
    for (const id of diffToDelete) next.delete(id);
    pruneDiffCacheInPlace(next, keepId);
    actions.setDiffCache(next);
  } else if (pruneDiffCacheInPlace(diffCache as Map<string, { atMs: number; files: Array<{ path: string; diff: string }>; bytes: number }>, keepId)) {
    actions.setDiffCache(new Map(diffCache));
  }
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

/**
 * Fingerprint a node list so we can skip no-op state updates.
 * Uses changeId + commitId + description + files (covers rebases, describes, amends, file changes).
 */
function nodesFingerprint(nodes: Array<{ changeId: string; commitId: string; descriptionTitle: string; isEmpty: boolean; isConflict: boolean; bookmarks: string[]; files?: Array<{ path: string; type: string }> }>): string {
  // Fast hash: concatenate key fields with a separator
  let fp = "";
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    fp += n.changeId;
    fp += n.commitId;
    fp += n.descriptionTitle;
    fp += n.isEmpty ? "1" : "0";
    fp += n.isConflict ? "1" : "0";
    fp += n.bookmarks.length > 0 ? n.bookmarks.join(",") : "";
    // Include file changes in fingerprint so file modifications trigger re-render
    if (n.files && n.files.length > 0) {
      fp += "F";
      for (const f of n.files) {
        fp += f.path;
        fp += f.type;
      }
    }
    fp += "|";
  }
  return fp;
}

let _lastLogFingerprint = "";

export async function refreshLog(limit = activeLogLimit) {
  activeLogLimit = Math.max(1, limit);
  const backend = getBackend();
  actions.setLoading(true);
  actions.setStatusMessage("Loading...");
  try {
    const nodes = await backend.log({ cwd: cwdOrEmpty(), limit: activeLogLimit, revset: state.revsetQuery || undefined });

    // Skip the entire state update + layout recomputation if nothing changed.
    // This prevents the idle memory growth from watcher-triggered no-op refreshes.
    const fp = nodesFingerprint(nodes);
    if (fp === _lastLogFingerprint && nodes.length === state.nodes.length) {
      actions.setStatusMessage(`nodes:${nodes.length}`);
      return;
    }
    _lastLogFingerprint = fp;

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

  const pending = inFlightFilesById.get(changeId);
  if (pending) return pending;

  const task = (async () => {
    const backend = getBackend();
    const files = await backend.files({ cwd: cwdOrEmpty(), changeId });
    const next = new Map(state.filesCache);
    next.set(changeId, { atMs: Date.now(), files });
    pruneFilesCacheInPlace(next, state.selectedId);
    actions.setFilesCache(next);
    return files;
  })();

  inFlightFilesById.set(changeId, task);
  try {
    return await task;
  } finally {
    if (inFlightFilesById.get(changeId) === task) inFlightFilesById.delete(changeId);
  }
}

export async function fetchDiff(changeId: string): Promise<string> {
  const backend = getBackend();
  return backend.diff({ cwd: cwdOrEmpty(), changeId });
}

export async function ensureDiff(changeId: string, maxAgeMs = 30_000): Promise<string> {
  const now = Date.now();
  const cached = state.diffCache.get(changeId);
  if (cached && now - cached.atMs < maxAgeMs) return cached.files[0]?.diff || "";

  const pending = inFlightDiffById.get(changeId);
  if (pending) return pending;

  const task = (async () => {
    const backend = getBackend();
    const diff = await backend.diff({ cwd: cwdOrEmpty(), changeId });
    const files = splitDiffByFile(diff);
    const bytes = estimateDiffEntryBytes(files);
    const next = new Map(state.diffCache);
    next.set(changeId, { atMs: Date.now(), files, bytes });
    pruneDiffCacheInPlace(next, state.selectedId);
    actions.setDiffCache(next);
    return files[0]?.diff || diff;
  })();

  inFlightDiffById.set(changeId, task);
  try {
    return await task;
  } finally {
    if (inFlightDiffById.get(changeId) === task) inFlightDiffById.delete(changeId);
  }
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
