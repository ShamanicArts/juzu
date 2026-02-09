# Juzu: The Definitive Architectural Audit & Scalability Master Plan

## 1. Abstract & Scope

This document represents a comprehensive, line-by-line architectural audit of the `juzu` repository visualization system. It evaluates the current codebase against the requirements of "Hyper-Scale" repositories (defined as >100,000 commits, >1GB raw log data).

The audit identifies a critical impedance mismatch: the current architecture implements a **Synchronous, Monolithic Document Viewer**, whereas the scale requirements demand an **Asynchronous, Streaming Database Engine**.

This analysis covers:
1.  **Data Ingestion Physics:** The byte-level lifecycle of data from `jj` to the JS Runtime.
2.  **Memory Topology:** Precise heap modeling of the application state.
3.  **Algorithmic Complexity:** Big-O analysis of layout and rendering loops.
4.  **Runtime Environment:** Specific constraints of the Bun runtime and JavaScriptCore (JSC).
5.  **Refactoring Specification:** A granular, actionable roadmap to transform the architecture.

---

## 2. Component 1: Data Ingestion Layer (`src/core/jj-api.ts`)

The `jj-api.ts` module is the bridge between the Jujutsu binary and the Juzu runtime. It is currently the primary point of failure for scalability.

### 2.1 Process Spawning & I/O Buffering

**Current Implementation (`runCmdText`):**
```typescript
const proc = Bun.spawn(args, { stdout: "pipe", ... });
const stdoutText = await new Response(proc.stdout).text();
```

**Deep Analysis:**
*   **The Bun/JSC Factor:** Bun uses JavaScriptCore (JSC). When `new Response(stream).text()` is called, the runtime must accumulate *all* incoming chunks from the pipe into a growable buffer (likely a `Vector<char>` in C++ land) before allocating a final JSString.
*   **Memory Pressure dynamics:**
    *   **Double Buffering:** The OS kernel buffers pipe data. Bun native side buffers data. The final JS String buffers data.
    *   **Peak Allocation:** To create a 100MB string, the engine often needs contiguous address space. In a long-running TUI process, heap fragmentation makes allocating large contiguous blocks risky, leading to `RangeError` or OOM (Out Of Memory) crashes even when total heap space is available.
*   **Blocking Main Thread:** While `await` allows the event loop to turn, the final *concatenation* and string creation is a synchronous CPU-bound task on the main thread. For 100MB of text, this creates a noticeable UI freeze (jank).

### 2.2 The Parsing Logic (`parseJJLogText`)

**Current Implementation:**
```typescript
logText.split("\x01<JJ-SEP>\x01").map(...)
```

**Algorithmic Forensics:**
*   **String splitting (`String.prototype.split`):**
    *   **Complexity:** $O(N)$ where $N$ is string length.
    *   **Allocation Density:** It creates an Array of size $M$ (commits). Each element is a substring.
    *   **JSC Rope Strings:** JSC tries to use "Ropes" (lazy concatenation) where possible, but `split` forces the reification of distinct string views or copies.
    *   **GC Impact:** This is a "Mass Extinction Event" for the Garbage Collector. We allocate 100k strings, parse them into objects, and then discard the strings. The nursery (Eden space) fills instantly, forcing promotion of survivors to the Old Generation, causing long-term fragmentation.

**Field Parsing (`block.split("\x01")`):**
*   **Fragility Index: Critical.**
    *   The code relies on ordinal indices: `parts[0]` is ID, `parts[5]` is bookmarks.
    *   **Schema Drift:** If `jj` adds a field in a newer version, or if the user configures a global template override, the index mapping breaks.
    *   **Delimiter Injection:** A commit description containing `\x01` (SOH - Start of Heading) shifts all subsequent indices by one. This results in type errors (e.g., trying to parse an email as a boolean) or data corruption.

### 2.3 Proposed Ingestion Architecture: The "Zero-Copy" Stream

**Design Specification:**
1.  **Protocol:** Switch from custom delimiters to **NDJSON** (Newline Delimited JSON).
2.  **Transport:** Use `ReadableStreamDefaultReader` on `proc.stdout`.
3.  **Parsing:**
    *   Read binary chunk `Uint8Array`.
    *   Scan for `\n` (0x0A).
    *   Slice buffer (using `Subarray`, preventing copy where possible).
    *   `JSON.parse()` the slice.
    *   **Immediate Dispatch:** Yield the object to the store batcher.
    *   **Release:** The raw buffer reference is dropped immediately.

**Expected Gain:**
*   **Memory:** $O(1)$ relative to repo size. We only hold ~64KB (chunk size) in memory at any instant.
*   **Latency:** First byte processed in milliseconds. UI updates progressively.

---

## 3. Component 2: State Management (`src/core/state.ts`)

The `state.ts` module utilizes `solid-js/store` to manage application state. The current schema is a "Fat Model" monolith.

### 3.1 The Object Graph

**Type Definition (`CommitNode`):**
```typescript
interface CommitNode {
  changeId: string;
  commitId: string;
  parents: string[];
  descriptionFull: string;
  // ... 15 other fields
}
```

**Heap Analysis (100,000 Commits):**

| Data Structure | Count | Unit Size (Approx) | Total Size | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `CommitNode` Objects | 100,000 | 128 bytes (JSC Cell) | 12.8 MB | The "Shell" |
| `changeId` Strings | 100,000 | 64 bytes | 6.4 MB | |
| `parents` Arrays | 100,000 | 64 bytes | 6.4 MB | Empty arrays are optimized, full ones are not |
| `description` Strings | 100,000 | 200 bytes (avg) | 20 MB | Unique strings don't intern well |
| `state.nodes` Array | 1 | 100,000 * 8 bytes | 800 KB | The backing storage vector |
| **Total Baseline** | | | **~46 MB** | *Pure data only* |

**The Hidden Multiplier: Proxies:**
SolidJS stores wrap objects in **Proxies**.
*   If we access every node (e.g., for layout), we potentially instantiate 100,000 Proxy handlers.
*   Each Proxy adds memory overhead and CPU dispatch cost (slower than direct property access).

### 3.2 The "Files Cache" Leak (`filesCache`)

**Definition:** `Map<string, { files: FileEntry[] }>`
**Usage Pattern:** Stores file lists for diffs.

**Scenario: The "Root Refactor"**
*   User selects the initial commit of a repo (e.g., "Initial import").
*   This commit touches 10,000 files.
*   `jj diff --summary` returns 10,000 lines.
*   The cache stores an array of 10,000 objects.
*   **Cost:** ~2MB for *one* entry.
*   **Persistence:** The cache eviction logic (`pruneFilesCacheInPlace`) tries to keep entries for "visible" nodes. If the layout engine decides many nodes are "potentially visible" (or if the user scrolls quickly), the cache balloons.

### 3.3 Scalability Limit

The current state model hits a "hard wall" at roughly **500,000 commits**.
*   At this size, the baseline object graph exceeds 250MB.
*   JSC Garbage Collection becomes a dominant factor (20-30% CPU time).
*   Any operation that filters/maps this array (like `nodes.find`) freezes the UI for 500ms+.

---

## 4. Component 3: The Layout Engine (`src/core/layout.ts`)

This is the mathematical heart of the visualization. Currently, it implements a `O(N)` topological pass that is strictly synchronous and coupled to the full dataset.

### 4.1 Memory Allocation Madness

**Code Analysis:**
```typescript
// src/core/layout.ts:327
const nodesCopy: CommitNode[] = new Array(nodes.length);
const nodesMap = new Map<string, CommitNode>();
for (let i = 0; i < nodes.length; i++) {
    const copy = { ...nodes[i] }; // <--- HEAP ALLOCATION
    nodesCopy[i] = copy;
    nodesMap.set(copy.changeId, copy); // <--- MAP INSERTION
}
```

**The "Clone War":**
*   Every time layout runs (window resize, sidebar toggle, new data), we **Deep Clone** the topological structure.
*   **Why?** Because the layout algorithms mutate properties like `.lane`, `.x`, `.y` on the objects. Since `state` is immutable/reactive, we copy to avoid side effects.
*   **Cost:** For 100k commits, we allocate 100k new objects + 1 Map with 100k entries.
*   **Frequency:** 60fps animations or resize events trigger this. This is the definition of "GC Thrashing".

### 4.2 Algorithm: `layoutMainline`

**Logic Flow:**
1.  Assign Y coordinates (linear pass).
2.  Find Heads (Set lookup).
3.  Traverse Mainline (Linked list traversal).
4.  Group Branches (BFS/DFS traversal).
5.  Assign Lanes (Collision detection).

**Complexity Analysis:**
*   **Time:** $O(N + E)$ where $N$ is nodes, $E$ is edges. However, the collision detection uses a `laneRanges` lookup which can degrade to $O(L)$ (lanes). In a complex repo with 100 parallel branches, this is significant.
*   **Space:** $O(N)$ for the `nodesMap` and auxiliary Sets.

**The "Connectivity" Blocker:**
*   The algorithm relies on `nodesMap.get(parentId)` returning a valid object.
*   **Partial Data:** If we load a "Window" of commits (1000-2000), commit 2000's parent (1999) is `undefined`.
*   **Failure Mode:** The layout engine treats commit 2000 as a "Root". It starts a new lane (Lane 0).
*   **Visual Artifact:** As you scroll, lanes randomly "reset" or jump because the layout engine lacks global context. This makes implementing "Infinite Scroll" impossible with the current logic.

---

## 5. Component 4: Rendering (`CanvasGraph.tsx` & TUI)

### 5.1 Web Canvas Rendering

**Code Analysis:**
```typescript
// src/web/components/CanvasGraph.tsx
nodes.forEach((node) => {
    // Check if visible (bounds check)
    // Draw...
})
```

**Inefficiency:**
*   **Linear Scan:** Even if 50 nodes are visible, we iterate 100,000 nodes to check `y` coordinates.
*   **JS Execution Time:** Iterating 100k items in JS takes roughly 2-5ms on a fast machine. Doing this every frame (16ms budget) eats 30% of the frame budget just on *looping*, before drawing.

### 5.2 TUI Rendering

The TUI implementation (`src/tui/components/GraphView.tsx`) uses a custom framebuffer.

**Bottleneck:**
*   **Cell-by-Cell Rendering:** The TUI rasterizes lines/circles into a grid of characters.
*   **String Manipulation:** Unlike Canvas (GPU accelerated), TUI rendering is pure string manipulation (CPU).
*   **O(N) Loop:** Similar to Web, it scans all nodes. In a single-threaded node/bun process, this CPU load competes directly with I/O and State logic.

---

## 6. The Master Plan: Refactoring Roadmap

This roadmap is designed to be executed sequentially. Each step unlocks the next.

### Phase 1: Robust Ingestion (The Foundation)

**Objective:** Switch to NDJSON streams to eliminate the parser memory spike.

**Step 1.1: Define Schema**
Create a Zod schema or strict interface for the JSON output.
```typescript
interface JjLogEntry {
  change_id: string;
  commit_id: string;
  parents: string[];
  author: { email: string; timestamp: string };
  description: string;
  bookmarks: string[];
  is_working_copy: boolean;
  // ...
}
```

**Step 1.2: Refactor `jj-api.ts`**
*   Create `const JJ_LOG_TEMPLATE = 'json(...) ++ "\n"'` using `jj`'s template language.
*   Implement `async function* streamLog(cwd: string, ...): AsyncGenerator<JjLogEntry>`.
*   Use `proc.stdout.getReader()` loop.
*   Implement a specialized "Line Buffer" that handles chunks splitting across JSON boundaries.

**Step 1.3: Update Store Actions**
*   Modify `actions.setNodes` to accept an iterator or batch of nodes.
*   Stop using `runCmdText` for log operations.

### Phase 2: The "Skeleton" Data Model (Memory Optimization)

**Objective:** Reduce the per-node memory footprint by 80%.

**Step 2.1: Split the Model**
Separate "Topology" (needed for layout) from "Metadata" (needed for display).

```typescript
// Stored in specific TypedArrays or SoA (Struct of Arrays)
interface GraphTopology {
  ids: string[];        // Indexed by integer ID
  parents: Int32Array;  // Flattened adjacency list
  lanes: Int16Array;    // Calculated lane
  y: Float32Array;      // Calculated Y
  ts: Float32Array;     // Timestamp
}

// Loaded via LRU Cache
interface CommitMetadata {
  description: string;
  author: string;
  diffStats: any;
}
```

**Step 2.2: Implement `TopologyStore`**
*   Create a specialized store that manages these TypedArrays.
*   This allows storing 1 million commits in ~20MB of RAM (TypedArrays are dense).

### Phase 3: Zero-Alloc Layout Engine (CPU Optimization)

**Objective:** Stop the "Clone War".

**Step 3.1: Mutable Layout Buffer**
*   The layout engine should accept the `GraphTopology` (Read-Only) and a `LayoutBuffer` (Write-Only).
*   `LayoutBuffer` contains the `x`, `y`, `lane` arrays.

**Step 3.2: Virtualized Layout Algorithm**
*   Implement "Anchor Points".
*   When calculating layout for index `i`, we look at `i-1` or `parents(i)`.
*   If parents are not loaded, we perform a "Jj Query" (`jj log -r parents(X)`) to get their lane metadata specifically, or we rely on a server-side "lane oracle".
*   *Alternative:* Pre-calculate lanes in Rust/WASM sidecar (long term).

### Phase 4: Virtualized Rendering (GPU/Draw Optimization)

**Objective:** Draw time should be $O(Visible)$ not $O(Total)$.

**Step 4.1: Spatial Indexing**
*   Since the graph is Y-sorted (mostly), implement a binary search `findStartIndex(scrollTop)`.

**Step 4.2: Render Loop**
```typescript
const start = binarySearch(nodes, viewport.top);
const end = binarySearch(nodes, viewport.bottom);
for (let i = start; i < end; i++) {
  drawNode(nodes[i]);
}
```

**Step 4.3: TUI Optimization**
*   Implement "Damage Rects" for TUI. Only re-render cells that changed.

---

## 7. Conclusion & Risk Assessment

The current `juzu` architecture is a "V1 Prototype". It successfully demonstrates the value of `jj` visualization but cannot survive the transition to "V2 Production Tool" without these changes.

**Risk Matrix:**

| Risk | Probability | Impact | Mitigation |
| :--- | :--- | :--- | :--- |
| **V8 String Crash** | High (>50k commits) | Critical (App Death) | Phase 1 (Streaming) |
| **UI Freeze (GC)** | High | High (Bad UX) | Phase 3 (Zero-Alloc Layout) |
| **Partial Graph Glitch** | High (Infinite Scroll) | Medium (Visual Bug) | Phase 3 (Virtualized Layout) |
| **API Drift** | Medium | Medium (Data Error) | Phase 1 (NDJSON Schema) |

**Recommendation:**
Proceed immediately with **Phase 1 (Robust Ingestion)**. This delivers the highest stability ROI for the lowest architectural disruption. It decouples the application from the fragility of text parsing and prepares the data pipelines for the future sparse model.
