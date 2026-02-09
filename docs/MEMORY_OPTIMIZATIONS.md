# Memory Optimizations for juzu TUI

This document captures all memory optimizations applied to the juzu TUI application, explaining what was done, why, and the measured results.

## Summary

| State | RSS Memory | Notes |
|-------|------------|-------|
| Original (before all fixes) | ~350MB | Growing ~20MB every 15 minutes while idle |
| After runtime optimizations | ~180MB | Stable, no growth |
| Production build | ~115-144MB | Stable, eliminates Babel preload |

## Memory Baseline Analysis

Before optimizing, we profiled where memory was being used:

| Component | Memory Cost | Notes |
|-----------|-------------|-------|
| Bun runtime baseline | 36MB | Unavoidable runtime cost |
| Babel preload (dev mode) | +49MB | `@opentui/solid/scripts/preload.ts` for TSX compilation |
| @opentui/core | +43MB | yoga-wasm (~20MB) + Zig FFI native renderer |
| solid-js + @opentui/solid | ~2MB | Reactive runtime |
| **Dev mode floor** | ~130MB | Before any app code runs |

Key finding: The ~82MB framework floor (without Babel) is unavoidable with the Bun + @opentui stack. Optimization efforts focused on:
1. Eliminating unnecessary allocations in hot paths
2. Preventing memory growth over time
3. Removing the Babel preload in production

---

## Phase 1: Cache Management (Prior Work)

### Cap in-memory core caches (`nzzykkwk`)

**Problem:** Unbounded cache growth for files and diffs.

**Solution:**
- `filesCache`: Limited to 12 entries max
- `diffCache`: Limited to 1 entry / 3MB max
- LRU-style eviction when limits exceeded

### Trim TUI refresh and watch footprint (`mpuumrkp`)

**Problem:** File watchers and refresh cycles were allocating unnecessarily.

**Solution:**
- Debounced refresh timer (700ms) to batch rapid file system events
- Reduced watcher overhead by watching specific `.jj/` subdirectories

---

## Phase 2: Runtime Allocation Reduction

### 2.1 Cache Allocation Reduction (`src/core/usecases.ts`)

#### Replace `Buffer.byteLength` with `.length`

**Before:**
```typescript
const size = Buffer.byteLength(diff, "utf8");
```

**After:**
```typescript
const size = diff.length;
```

**Why:** `Buffer.byteLength` allocates a temporary buffer to measure UTF-8 byte length. For cache size estimation (not precision-critical), string `.length` is sufficient and allocation-free.

#### Eliminate copy-on-write Map pattern in prune functions

**Before:**
```typescript
function pruneFilesCache(cache: Map<string, FilesEntry>, maxEntries: number): Map<string, FilesEntry> {
  if (cache.size <= maxEntries) return cache;
  const entries = [...cache.entries()];
  entries.sort((a, b) => b[1].accessedAt - a[1].accessedAt);
  return new Map(entries.slice(0, maxEntries));  // Always creates new Map
}
```

**After:**
```typescript
function pruneFilesCache(cache: Map<string, FilesEntry>, maxEntries: number): Map<string, FilesEntry> {
  if (cache.size <= maxEntries) return cache;
  const entries = [...cache.entries()];
  entries.sort((a, b) => b[1].accessedAt - a[1].accessedAt);
  const toRemove = entries.slice(maxEntries);
  for (const [key] of toRemove) {
    cache.delete(key);  // Prune in-place
  }
  return cache;  // Return same Map (only create new if SolidJS reactivity needs it)
}
```

**Why:** Creating `new Map()` on every prune allocated ~1KB+ per call. In-place deletion avoids this. A new Map is only created when the store setter actually needs to trigger reactivity.

#### Add `nodesFingerprint()` to skip redundant refreshes (BIGGEST WIN)

**Problem:** File watchers trigger `refreshLog()` every 700ms. Even when `jj log` output is identical (user is idle), the entire chain ran:
1. Parse nodes
2. Call `setNodes()` 
3. Recompute `layoutResult` memo
4. Prune caches
5. Re-render

This caused ~20MB growth over 15 minutes of idle time.

**Solution:**
```typescript
let _lastNodesFingerprint: string | null = null;

function nodesFingerprint(nodes: JjNode[]): string {
  // Fast fingerprint: count + first/last changeIds + total description length
  if (nodes.length === 0) return "empty";
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const descLen = nodes.reduce((sum, n) => sum + (n.descriptionTitle?.length || 0), 0);
  return `${nodes.length}:${first.changeId}:${last.changeId}:${descLen}`;
}

export async function refreshLog(limit = 80): Promise<void> {
  const raw = await runJj(["log", ...]);
  const nodes = parseJjLog(raw);
  
  const fp = nodesFingerprint(nodes);
  if (fp === _lastNodesFingerprint) {
    return;  // Skip everything - nothing changed
  }
  _lastNodesFingerprint = fp;
  
  actions.setNodes(nodes);
  // ... rest of refresh logic
}
```

**Why:** When the user is idle, `jj log` returns identical output. The fingerprint check short-circuits the entire recomputation chain, eliminating the primary source of memory growth.

### 2.2 Layout Allocation Reduction (`src/core/layout.ts`)

#### Replace spread copies with explicit field assignment

**Before:**
```typescript
const copy: JjNode[] = nodes.map((n) => ({ ...n }));
```

**After:**
```typescript
const copy: JjNode[] = new Array(nodes.length);
for (let i = 0; i < nodes.length; i++) {
  const n = nodes[i];
  copy[i] = {
    changeId: n.changeId,
    commitId: n.commitId,
    author: n.author,
    // ... explicit fields
  };
}
```

**Why:** Object spread (`{ ...n }`) is slower than explicit field assignment and creates intermediate objects. Pre-allocating the array with `new Array(length)` avoids array resizing.

#### Combine node copy + Map build into single loop

**Before:**
```typescript
const copy = nodes.map(n => ({ ...n }));
const byId = new Map(copy.map(n => [n.changeId, n]));
```

**After:**
```typescript
const copy: JjNode[] = new Array(nodes.length);
const byId = new Map<string, JjNode>();
for (let i = 0; i < nodes.length; i++) {
  const n = nodes[i];
  const node = { /* explicit fields */ };
  copy[i] = node;
  byId.set(node.changeId, node);
}
```

**Why:** Eliminates intermediate array from `.map()` and second iteration for Map construction.

### 2.3 Granular SolidJS Updates (`src/core/state.ts`)

#### Fix `setNodes` to avoid full state copy

**Before:**
```typescript
setNodes(nodes: JjNode[]) {
  setState((prev) => ({ ...prev, nodes }));  // Copies entire state object
}
```

**After:**
```typescript
setNodes(nodes: JjNode[]) {
  setState("nodes", nodes);  // Granular path update
}
```

**Why:** SolidJS's `setState` with a path (`"nodes"`) only updates that specific field. Using a function that spreads `prev` creates a shallow copy of the entire state object on every call.

#### Add `getNodeIndexMap()` cache for O(1) lookups

**Before:**
```typescript
export const selectedNode = createMemo(() => {
  const id = state.selectedId;
  return layoutResult().nodes.find((n) => n.changeId === id) ?? null;  // O(n) scan
});

export const selectedIndex = createMemo(() => {
  const id = state.selectedId;
  return layoutResult().nodes.findIndex((n) => n.changeId === id);  // O(n) scan
});
```

**After:**
```typescript
let _nodeIndexMap: Map<string, number> | null = null;
let _nodeIndexMapNodes: JjNode[] | null = null;

function getNodeIndexMap(nodes: JjNode[]): Map<string, number> {
  if (_nodeIndexMapNodes === nodes && _nodeIndexMap) {
    return _nodeIndexMap;  // Cache hit
  }
  _nodeIndexMap = new Map(nodes.map((n, i) => [n.changeId, i]));
  _nodeIndexMapNodes = nodes;
  return _nodeIndexMap;
}

export const selectedNode = createMemo(() => {
  const nodes = layoutResult().nodes;
  const id = state.selectedId;
  const indexMap = getNodeIndexMap(nodes);
  const idx = indexMap.get(id);
  return idx !== undefined ? nodes[idx] : null;  // O(1) lookup
});
```

**Why:** `selectedNode()` and `selectedIndex()` are called frequently (keyboard navigation, rendering). Linear scans on every call were wasteful. The Map is invalidated only when the nodes array reference changes.

### 2.4 Effect Deduplication (`src/tui/App.tsx`)

#### Add guards to prevent redundant fetches

**Before:**
```typescript
createEffect(() => {
  const node = selectedNode();
  if (!node) return;
  if (state.viewMode !== "log") return;
  void ensureFiles(node.changeId);  // Fetches on every effect run
});
```

**After:**
```typescript
let _lastFilesChangeId: string | null = null;

createEffect(() => {
  const node = selectedNode();
  if (!node) return;
  if (state.viewMode !== "log") return;
  if (node.changeId === _lastFilesChangeId) return;  // Skip if already fetched
  _lastFilesChangeId = node.changeId;
  void ensureFiles(node.changeId);
});
```

**Why:** SolidJS effects re-run when any tracked signal changes. Without guards, switching views or unrelated state changes would trigger redundant `ensureFiles`/`ensureDiff` calls even for the same commit.

Similar guards added for:
- `_lastDiffChangeId` — diff prefetching
- `_lastSelectedIdForDiffReset` — diff file index reset

#### Lazy-load clipboardy

**Before:**
```typescript
import clipboardy from "clipboardy";  // Loaded at startup
```

**After:**
```typescript
let _clipboardy: typeof import("clipboardy") | null = null;

const getClipboardy = async () => {
  if (!_clipboardy) _clipboardy = await import("clipboardy");
  return _clipboardy;
};
```

**Why:** `clipboardy` is only used when the user copies text. Lazy loading defers its ~1MB cost until first use.

### 2.5 Per-Frame Allocation Reduction (`src/tui/components/GraphView.tsx`)

#### Reusable Maps for frame rendering

**Before:**
```typescript
// Inside render function (called at 30fps)
const indexById = new Map(nodes.map((n, i) => [n.changeId, i]));
```

**After:**
```typescript
// Module-level reusable Map
let _indexByIdAll: Map<string, number> = new Map();

// Inside render function
_indexByIdAll.clear();
for (let i = 0; i < nodes.length; i++) {
  _indexByIdAll.set(nodes[i].changeId, i);
}
```

**Why:** Creating `new Map()` 30 times per second generates significant GC pressure. Reusing and clearing a single Map eliminates this. Same pattern applied to `_childrenById` for mainline layout.

---

## Phase 3: Production Build System

### Problem

The `@opentui/solid` preload script uses Babel to compile TSX at runtime. This adds ~49MB to RSS and slows startup.

### Solution

Created a production build system that pre-compiles everything:

#### `scripts/build-tui.ts`

Pre-compiles all TSX/TS files with the SolidJS Babel transform:
- Outputs to `dist/tui/` with plain `.js` files
- Rewrites import extensions (`.tsx` → `.js`)
- Fixes `import.meta.dir` path depths (source is 2 levels deep, dist is 3)

```bash
bun scripts/build-tui.ts
```

#### `scripts/preload-solid-client.ts`

Minimal preload that only redirects solid-js imports:

```typescript
plugin({
  name: "solid-client-redirect",
  setup(build) {
    // Redirect solid-js/dist/server.js → solid-js/dist/solid.js
    build.onLoad(
      { filter: /\/node_modules\/solid-js\/dist\/server\.js$/ },
      async (args) => {
        const path = args.path.replace("server.js", "solid.js");
        return { contents: await Bun.file(path).text(), loader: "js" };
      }
    );
  },
});
```

**Why this is needed:** Bun's "node" condition resolves `solid-js` to its SSR build (`dist/server.js`). The preload intercepts this and loads the client build instead. No Babel overhead.

#### `cli.ts` auto-detection

```typescript
const prodEntry = `${import.meta.dir}/dist/tui/tui/main.js`;
const useProd = await Bun.file(prodEntry).exists();
// Use production build if available, otherwise fall back to dev mode
```

### Results

| Mode | Preload | RSS |
|------|---------|-----|
| Dev mode | Full Babel | ~180MB |
| Production | Minimal redirect | ~115-144MB |

**Savings:** ~36MB from eliminating Babel preload.

---

## What Cannot Be Optimized Further

The remaining ~115MB is the framework floor:

| Component | Size | Notes |
|-----------|------|-------|
| Bun runtime | 36MB | Fixed cost |
| yoga-wasm | ~20MB | Layout engine, loaded by @opentui/core |
| Zig FFI renderer | ~23MB | Native terminal renderer |
| solid-js runtime | ~2MB | Reactive system |
| App code + data | ~34MB | Nodes, caches, graph layout |

Further reductions would require:
- Upstream changes to @opentui (e.g., lazy-load yoga)
- Different framework choices (losing Bun/SolidJS benefits)
- WebAssembly optimizations in yoga-wasm

---

## Verification

All optimizations verified with:
- `bun test` — 37/37 tests pass
- Manual RSS measurement via `ps -o rss=`
- 15+ minute idle stability tests (no memory growth)

---

## Quick Reference

### Build for production
```bash
bun scripts/build-tui.ts
```

### Run TUI (auto-detects production build)
```bash
bun cli.ts --tui
```

### Measure RSS
```bash
bun --preload ./scripts/preload-solid-client.ts dist/tui/tui/main.js &
sleep 4
ps -o rss= -p $!
```
