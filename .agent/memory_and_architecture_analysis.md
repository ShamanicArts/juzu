# Deep Analysis: Juzu Architecture, Memory Management & Scalability

## 1. Introduction

This document presents a comprehensive analysis of the `juzu` codebase, focusing on memory management, architectural fragility, and scalability bottlenecks. The current implementation, while functional for small-to-medium repositories, suffers from fundamental architectural limitations that prevent it from scaling to large repositories (e.g., Linux kernel, large monorepos) without arbitrary limits.

This analysis dissects the critical paths of data flow:
1.  **Ingestion:** How data is retrieved from `jj`.
2.  **Storage:** How data is held in memory.
3.  **Processing:** How the graph layout is computed.
4.  **Rendering:** How state changes propagate to the UI.

---

## 2. Data Ingestion Analysis (`src/core/jj-api.ts`)

The ingestion layer is the single biggest bottleneck in the current system. It acts as a synchronous barrier that must buffer the entire dataset before any processing can occur.

### 2.1. The Buffering Bottleneck (`runCmdText`)

The `runCmdText` function is implemented as follows:

```typescript
// Current Implementation
export async function runCmdText(args: string[], cwd: string, timeoutMs = 15000): Promise<string> {
  const proc = Bun.spawn(args, { ... });
  // ...
  const [stdoutText, ...] = await Promise.all([
    new Response(proc.stdout).text(), // <--- CRITICAL FAILURE POINT
    // ...
  ]);
  return stdoutText;
}
```

**Impact Analysis:**
*   **Memory Multiplier:** `new Response(proc.stdout).text()` loads the entire stream into a single V8 Heap String. If `jj log` outputs 50MB of text, the process requires contiguous memory block of 50MB.
*   **String limit:** V8 has a maximum string length (historically ~512MB on 64-bit systems). A sufficiently large repo will crash the application with `RangeError: string length exceeded`.
*   **Latency:** The UI cannot show a single pixel of data until the *entire* subprocess has finished and the *entire* string has been read. This adds unnecessary latency (Time-To-First-Byte vs Time-To-Last-Byte).

### 2.2. Parsing Fragility (`parseJJLogText`)

The parsing logic relies on a custom delimiter scheme:

```typescript
export const JJ_TEMPLATE = `... ++ "\x01" ++ ... ++ "\x01<JJ-SEP>\x01"`;

// ...
return logText
  .split("\x01<JJ-SEP>\x01") // <--- MASSIVE ALLOCATION
  .map(block => {
      const parts = block.split("\x01"); // <--- FRAGILE POSITIONAL MAPPING
      // ...
      const changeId = parts[0].trim();
      const commitId = parts[1].trim();
  })
```

**Fragilities:**
1.  **Allocation Spike:** `logText.split(...)` creates an array of substrings. If the original string was 50MB, this operation momentarily requires ~100MB+ (Original + Array of pointers + Substrings) before GC can clean up the original. This causes "Stop-The-World" GC pauses.
2.  **Positional Coupling:** The parser assumes `parts[0]` is `changeId`, `parts[1]` is `commitId`, etc. If `jj`'s template engine changes behavior, or if a field is added/removed in the template definition, the parser will silently map data to the wrong fields (e.g., mapping an email to a timestamp) or crash.
3.  **Delimiter Collision:** While `\x01` is unlikely to appear in user content, it is not impossible (e.g., in binary files diffs or weird commit messages). A collision would corrupt the graph topology.

### 2.3. Type Safety Gap
There is no validation that the string coming back from `parts[x]` matches the expected type. Boolean fields are parsed by string comparison (`x === "true"`), which is safe but brittle if the template outputs "True" or "1".

---

## 3. State Management Analysis (`src/core/state.ts`)

The application uses a "World State" pattern where the entire graph is loaded into a single reactive store.

### 3.1. Object Footprint Analysis
The `CommitNode` interface is "fat". It contains all display data, layout coordinates, and topology.

```typescript
export interface CommitNode {
  changeId: string;      // ~64 bytes (string + cons)
  commitId: string;      // ~64 bytes
  parents: string[];     // ~100 bytes (array overhead + strings)
  author: string;        // ~50-100 bytes
  descriptionFull: string; // Varies, avg 100 bytes
  // ... plus ~15 other fields
}
```

**Memory Math:**
*   Average object size (conservative): ~500 bytes per node (including V8 object overhead).
*   **5,000 commits:** ~2.5 MB (Trivial)
*   **50,000 commits:** ~25 MB (Manageable)
*   **500,000 commits (Linux Kernel scale):** ~250 MB (Heavy, but fits in RAM)

However, the **Strings** are the killer. In V8, strings are often interned, but unique descriptions and diffs are not.
If we load the diff summaries (file paths) for 50k commits, and each commit touches 5 files (avg path 40 chars):
*   50,000 * 5 * 40 bytes = **10 MB of raw path data**.
*   In V8 objects (`{type: 'M', path: '...'}`), this explodes to **~100MB**.

### 3.2. Reactivity Cost (SolidJS)
`createStore` proxies the state.
*   `setState("nodes", nodes)` performs a diff. If the reference changes, it triggers subscribers.
*   **The Problem:** We replace the *entire array* on every refresh. Even if 49,999 nodes are identical, if the array reference changes, downstream computations (Layout) usually re-run for everything unless strictly memoized with `index` keyed caching.

### 3.3. Cache Leaks (`filesCache` / `diffCache`)
The cache eviction policy in `usecases.ts` (`pruneCachesForVisibleNodes`) is tightly coupled to the *current* visibility.
*   **Scenario:** User scrolls rapidly.
*   **Behavior:**
    1.  Load nodes 1-50. Fetch diffs. Cache size: 50.
    2.  Scroll to 51-100. Prune 1-50. Cache size: 50.
*   **Issue:** This "Thrashing" forces re-fetching data if the user scrolls back up. It generates network/process IO traffic for every scroll direction change.
*   **Missing:** A proper LRU (Least Recently Used) cache that keeps, say, 500 entries regardless of visibility, to allow smooth localized browsing.

---

## 4. Layout Engine Analysis (`src/core/layout.ts`)

The layout engine is designed for **Complete, In-Memory Graphs**.

### 4.1. Algorithmic Complexity
The `layoutChronological` and `layoutMainline` algorithms are roughly `O(N)` in the best case, but they iterate over the node list multiple times.

```typescript
// layoutMainline
nodes.forEach(...) // 1. Y-position calc
nodes.forEach(...) // 2. Find heads
for (const head of heads) { ... } // 3. Build mainline (Graph Traversal)
nodes.forEach(...) // 4. Group branches
branchCommits.forEach(...) // 5. Assign lanes (Nested loops for collision detection)
```

For 50k nodes, this is acceptable for CPU (~50ms), but it blocks the main thread.

### 4.2. Memory Allocations during Layout
`calculateLayout` creates a **Shallow Copy** of every node:

```typescript
const nodesCopy: CommitNode[] = new Array(nodes.length);
for (let i = 0; i < nodes.length; i++) {
  // ... copies every field ...
}
```

*   **Impact:** Every time the layout runs (e.g., window resize, or new log fetch), it allocates `N` new objects. For 50k nodes, that's 50k objects allocated and 50k objects discarded (the previous layout result).
*   **GC Pressure:** This generates significant "garbage" for the collector, leading to frame drops in the UI during updates.

### 4.3. The "Complete Graph" Assumption
The layout functions (`nodesMap.get(parentId)`) assume that if a node declares a parent, that parent **exists in the `nodes` array**.
*   **Scalability Blocker:** This prevents "Infinite Scrolling" or "Partial Loading". If we only load the last 100 commits, the bottom-most commit's parent is missing. The layout engine treats it as a root or crashes, breaking the visual continuity of lanes.

---

## 5. Proposed Architecture: The "Sparse Streaming" Model

To achieve the goal of handling arbitrarily large graphs without limits, the architecture must shift from **Monolithic** to **Streaming & Sparse**.

### 5.1. Protocol Shift: NDJSON (Newline Delimited JSON)

**Format:**
```json
{"changeId": "k", "parents": ["p"], "desc": "fix: bug", ...}
{"changeId": "p", "parents": ["r"], "desc": "feat: feature", ...}
```

**Implementation:**
*   Refactor `jj-api.ts` to spawn `jj log -T json_template`.
*   Implement a `StreamingJSONParser` that reads chunks from `stdout`, splits on `\n`, parses `line`, and emits objects.
*   **Benefit:** Memory usage becomes $O(1)$ relative to repo size. We only hold the current line in memory.

### 5.2. Data Structure Shift: Sparse Graph (Skeleton)

Split the `CommitNode` into two tiers:

**Tier 1: Skeleton (Keep in Memory)**
*   `changeId` (string)
*   `parents` (string[])
*   `lane` (int) - Calculated or cached
*   `y` (int) - Calculated
*   `timestamp` (int)

**Tier 2: Details (Load on Demand)**
*   `description`
*   `author`
*   `bookmarks`
*   `diffStat`

**Strategy:**
1.  Load **Skeleton** for the entire graph (or a very large window, e.g., 20k commits). This is cheap (~10MB for 20k commits).
2.  Render the graph topology using only Skeleton data.
3.  Use an `IntersectionObserver` in the UI to detect which nodes are visible.
4.  Async fetch **Details** for visible nodes and hydrate the store.
5.  Evict Details when nodes leave the viewport (LRU).

### 5.3. Layout Virtualization

To support infinite scrolling, the layout engine must handle **Partial Graphs**.

*   **Boundary Handling:** When a node's parent is missing from the current dataset (because it's deeper in history than we've loaded), the layout engine must assign a "virtual lane" or "connector" indicating continuity.
*   **Incremental Layout:** Instead of recalculating the whole graph, append new nodes to the bottom and calculate their lanes based on the *boundary state* of the previous batch.

---

## 6. Implementation Roadmap

### Phase 1: Robustness (The "No-Brainer")
*   **Task:** Switch `jj-api.ts` to use `jj log -T ...` with `json()` output.
*   **Why:** Removes fragile delimiter parsing. Fixes "weird characters breaking the graph" bugs.
*   **Cost:** Low.

### Phase 2: Streaming Ingestion
*   **Task:** Replace `Promise.all([text()])` with `stdoud.getReader()` loop.
*   **Why:** Eliminates the memory spike. Prevents crashes on large repos.
*   **Cost:** Medium.

### Phase 3: Layout Optimization
*   **Task:** Modify `calculateLayout` to mutate a persistent Float32Array for X/Y coordinates instead of allocating objects.
*   **Why:** Eliminates GC thrashing during resizing/updates.
*   **Cost:** High complexity, high performance gain.

### Phase 4: Virtualization (The "Infinite" Goal)
*   **Task:** Implement the Skeleton/Detail split and `IntersectionObserver` hydration.
*   **Why:** Allows viewing the Linux Kernel repo in the browser with minimal RAM.
*   **Cost:** Very High. Requires rewriting `state.ts` and UI components.

## 7. Conclusion

The current `juzu` architecture is a "Proof of Concept" implementation suitable for moderate repositories. It trades memory efficiency for implementation simplicity (monolithic arrays, simple parsing). To mature into a professional-grade tool capable of replacing CLI usage for power users, it must adopt the **Streaming/Sparse** patterns detailed above. The most critical immediate step is abandoning the text-based delimiter parsing in favor of streaming NDJSON.
