# jj-viz Implementation Plan

## Project Overview

jj-viz is a Bun/SolidJS visualization tool for the Jujutsu (jj) version control system with both a web UI (HTML5 Canvas) and a TUI (OpenTUI). The codebase has accumulated bugs, regressions, dead code, and architectural conflicts that require systematic cleanup.

**Current State:** Functional but brittle
**Target State:** Robust, maintainable, with live updates working
**Estimated Effort:** 2-3 weeks of focused development

---

## Phase 1: Critical Bug Fixes

> **Priority:** CRITICAL  
> **Goal:** Fix bugs that cause incorrect behavior or data corruption  
> **Estimated Time:** 1-2 days

### Phase 1 Implementation Update (2026-02-05)

- [x] **1.1 completed with keybind redesign:** removed fragile Shift+U redo path; redo is now leader-based in TUI (`Ctrl+X`, then `u`) and status/help keybind hints were updated.
- [x] **1.2 completed:** `/api/undo` and `/api/redo` now capture stderr, check exit codes, and return `{ success: false, error }` on failure.
- [x] **1.3 completed:** template constants are now exported from `src/core/jj-api.ts` and imported into `server.ts` (single source of truth).

### Key UX Follow-up Added (Cross-Frontend)

- [ ] Add confirmations for destructive operations in **both** Web and TUI (not web-only): include `abandon`, `squash`, `rebase`, `undo`, `redo`.

### 1.1 TUI Redo Double-Fire Bug

**Location:** `src/tui/App.tsx:260-348`

**Problem:** Pressing Shift+U fires BOTH undo and redo due to control flow issues:
- Switch case "u" at line 332 handles undo with `break`
- Post-switch check at line 347 handles Shift+U redo
- When Shift+U is pressed, both execute

**Files to Modify:**
- `src/tui/App.tsx`

**Tasks:**
1. [ ] Read `src/tui/App.tsx` lines 260-348 to understand current flow
2. [ ] Move Shift+U redo check BEFORE the switch statement
3. [ ] Add early return after redo handling
4. [ ] Ensure switch case "u" only handles lowercase 'u' (no shift)

**Testing:**
- [ ] Start TUI: `bun run tui`
- [ ] Make a change in jj: `jj new`
- [ ] Press 'u' → should undo the change
- [ ] Press 'U' (Shift+U) → should redo the change
- [ ] Verify only one operation executes per keypress
- [ ] Verify operation log shows correct sequence

**Proposed Fix:**
```typescript
// BEFORE the main switch statement (around line 258)
// rawName preserves case; name is lowercased
// Check for Shift+U (redo) before the switch eats it as lowercase "u" (undo)
if (!key.ctrl && !key.meta && rawName === "U") {
  handleRedo();
  return;
}

switch (name) {
  // ... existing cases ...
  case "u":
    // Now only fires for lowercase 'u' (Shift+U already returned above)
    handleUndo();
    break;
  // ... rest of cases ...
}
// REMOVE the post-switch Shift+U check at lines 346-350
```

---

### 1.2 Server Undo/Redo Missing Error Handling

**Location:** `server.ts:410-422`

**Problem:** `/api/undo` and `/api/redo` endpoints spawn jj commands but:
- Ignore exit codes
- Always return `{ success: true }`
- Every other mutation endpoint properly checks `exitCode !== 0`

**Files to Modify:**
- `server.ts` (around lines 410-422)

**Tasks:**
1. [ ] Locate `/api/undo` endpoint
2. [ ] Add exit code check after `Bun.spawn()`
3. [ ] Add stderr capture and pipe to text
4. [ ] Return error response if exit code !== 0
5. [ ] Repeat for `/api/redo` endpoint
6. [ ] Verify pattern matches other mutation endpoints

**Reference Implementation** (from working endpoint):
```typescript
const proc = Bun.spawn({
  cmd: ['jj', 'operation', 'undo'],
  cwd: repoRoot,
  stdout: 'pipe',
  stderr: 'pipe',
});

const exitCode = await proc.exited;
if (exitCode !== 0) {
  const stderr = await new Response(proc.stderr).text();
  return Response.json({ 
    success: false, 
    error: stderr || 'Undo failed' 
  }, { status: 500 });
}

return Response.json({ success: true });
```

**Testing:**
- [ ] Start server: `bun run server`
- [ ] Navigate to web UI
- [ ] Try undo when there's nothing to undo
- [ ] Verify error message appears in UI
- [ ] Check server logs for proper error

---

### 1.3 Template Duplication

**Location:** 
- `server.ts:67-71`
- `src/core/jj-api.ts:3-4,234-235,286-287`

**Problem:** Same JJ_TEMPLATE, OP_LOG_TEMPLATE, and OBSLOG_TEMPLATE strings defined in two places

**Files to Modify:**
- `src/core/jj-api.ts` - Export templates
- `server.ts` - Import templates

**Tasks:**
1. [ ] Identify all duplicate template strings in `src/core/jj-api.ts`
2. [ ] Add `export` keyword to template constants
3. [ ] In `server.ts`, remove inline template definitions
4. [ ] Add imports: `import { JJ_TEMPLATE, OP_LOG_TEMPLATE, OBSLOG_TEMPLATE } from './src/core/jj-api.js'`
5. [ ] Verify server still functions correctly

**Testing:**
- [ ] Start server: `bun run server` --- ASK THE USER TO DO THIS STEP 
- [ ] Load web UI
- [ ] Verify graph renders correctly (uses JJ_TEMPLATE)
- [ ] Open operation log view (uses OP_LOG_TEMPLATE)
- [ ] Open obslog view if available (uses OBSLOG_TEMPLATE)
- [ ] All should render without errors

---

## Phase 2: Auto-Refresh Implementation

> **Priority:** HIGH  
> **Goal:** Implement live updates as promised in README  
> **Estimated Time:** 2-3 days

### 2.1 TUI Auto-Refresh via Filesystem Watching

**Location:** `src/tui/App.tsx` (onMount)

**Approach:** Watch `.jj/` directory for changes using Bun's `fs.watch`

**Files to Modify:**
- `src/tui/App.tsx`

**Tasks:**
1. [x] Import watcher support in TUI app
2. [x] Find `.jj` directory path (using existing root init flow)
3. [x] Add filesystem watch setup in `onMount`
4. [x] Implement debounce mechanism (500ms) to avoid rapid-fire
5. [x] On change, trigger refresh load (`refresh()`)
6. [x] Cleanup watcher in `onCleanup`

**Implementation Update (2026-02-05):**
- Implemented `.jj` watch with recursive attempt + non-recursive fallback paths for Linux compatibility.
- Added debounced refresh scheduling to avoid repeated reloads during multi-file jj operations.

**Implementation Notes:**
- Watch `.jj/` not just `.jj/working_copy/` (jj updates multiple subdirectories)
- Use `AbortController` for cleanup
- Debounce is critical - jj makes multiple file writes per operation

**Testing:**
- [ ] Start TUI: `bun run tui` --- USER TO DO THIS STEP 
- [ ] In another terminal, run `jj new`
- [ ] Verify TUI automatically refreshes within 500ms
- [ ] Run several jj operations in quick succession
- [ ] Verify debounce works (only one refresh after operations complete)
- [ ] Exit TUI and verify no watcher errors

---

### 2.2 Web Auto-Refresh via Polling

**Location:** `src/web/App.tsx`

**Approach:** Simple polling with visibility awareness

**Files to Modify:**
- `src/web/App.tsx`
- `src/web/store.ts` (may need comparison logic)

**Tasks:**
1. [x] Add polling interval (3-5 seconds) in `onMount`
2. [x] Use `document.visibilityState` to pause when tab hidden
3. [x] On poll, fetch fresh data from `/api/log`
4. [x] Compare to current state (serialized hash of nodes payload)
5. [x] Only update store if data changed
6. [x] Cleanup interval in `onCleanup`

**Implementation Update (2026-02-05):**
- Added 3s polling loop with in-flight guard, visibility checks, and `no-store` fetch.
- Store updates only run when payload hash differs from last seen state.

**Implementation Details:**
```typescript
// In onMount
let lastDataHash: string | null = null;

const poll = async () => {
  if (document.visibilityState === 'hidden') return;
  
  const response = await fetch('/api/log');
  const data = await response.json();
  const newHash = JSON.stringify(data.nodes);
  
  if (newHash !== lastDataHash) {
    lastDataHash = newHash;
    actions.setNodes(data.nodes);
  }
};

const interval = setInterval(poll, 3000);
document.addEventListener('visibilitychange', poll);
```

**Testing:**
- [ ] Start server and web UI: `bun run server` --- USER ONLY
- [ ] Open browser, navigate to `http://localhost:3000`
- [ ] In another terminal, run `jj new`
- [ ] Verify web UI refreshes within 3-5 seconds
- [ ] Switch to another tab for 10 seconds
- [ ] Switch back - should not show missed updates (they queue)
- [ ] Make multiple changes
- [ ] Verify UI doesn't flicker unnecessarily (comparison working)

---

### 2.3 Document: Server-Side Filesystem Watch + SSE (Future)

**Not for immediate implementation** - document in comments/code for future improvement.

**Advantages over polling:**
- More efficient (no unnecessary requests)
- Near-instant updates
- Lower server load

**Approach:**
- Server watches `.jj/` directory
- On change, broadcasts SSE event to connected clients
- Clients listen for SSE instead of polling

**Leave TODO comment in code:**
```typescript
// TODO: Implement SSE-based updates for better efficiency
// See Phase 2.3 in .agent/plan.md for details
```


// USER ASKS- Why is this marked as TODO? seems lazy, if it could just be implemented 

---

## Phase 3: Consolidate Business Logic

> **Priority:** HIGH  
> **Goal:** Eliminate duplication between server and core  
> **Estimated Time:** 3-4 days

### 3.1 Make Server Delegate to Core

**Problem:** `server.ts` has its own inline `Bun.spawn()` calls for every jj operation, duplicating logic from `src/core/jj-api.ts`

**Target Architecture:**
```
HTTP Request → server.ts → jj-api.ts functions → jj CLI
```

Instead of current:
```
HTTP Request → server.ts (inline spawn) → jj CLI
              ↓
            Other files → jj-api.ts → jj CLI
```

**Files to Modify:**
- `server.ts` - Replace inline spawns with function calls
- `src/core/jj-api.ts` - Ensure all needed functions exported

**Implementation Update (2026-02-05):**
- [x] Server now imports and uses core helpers for most read/mutation endpoints (`/api/diff`, `/api/files`, `/api/oplog`, `/api/obslog`, `/api/new`, `/api/edit`, `/api/describe`, `/api/abandon`, `/api/squash`, `/api/move`, `/api/insert`, `/api/split`, `/api/duplicate`, `/api/rebase`, `/api/undo`, `/api/redo`, `/api/oplog/restore`).
- [x] `findJJRoot()` duplication removed from `server.ts`; server now imports `findJJRoot` from `src/core/jj-api.ts`.
- [x] Added missing core helpers `jjCreateNew()` and `jjGetFiles()` to support server delegation.
- [x] `/api/log` now delegates to core via `fetchJJLogWithGitBranches()`.

**Tasks:**

#### Step 1: Inventory Current Server Endpoints
1. [ ] List all endpoints in `server.ts` that use `Bun.spawn()`:
   - `/api/log`
   - `/api/oplog`
   - `/api/obslog`
   - `/api/show`
   - `/api/diff`
   - `/api/files`
   - `/api/undo`
   - `/api/redo`
   - `/api/abandon`
   - `/api/describe`
   - `/api/squash`
   - `/api/rebase`
   - `/api/edit`
   - `/api/new`
   - `/api/duplicate`
   - `/api/insert`
   - etc.

#### Step 2: Map to jj-api.ts Functions
1. [ ] Check if each operation has a corresponding function in `src/core/jj-api.ts`
2. [ ] List missing functions that need to be created:
   - `fetchJJLog()`
   - `fetchOpLog()`
   - `fetchObslog()`
   - `jjNew()`
   - `jjEdit()`
   - `jjDescribe()`
   - `jjAbandon()`
   - `jjSquash()`
   - `jjRebase()`
   - `jjDuplicate()`
   - `jjInsert()`
   - etc.

#### Step 3: Ensure Functions Export Correct Signatures
1. [ ] Each function should accept `(repoRoot: string, ...args)`
2. [ ] Each function should return `Promise<{ success: boolean, data?: any, error?: string }>`
3. [ ] Add exports if missing

#### Step 4: Replace Server Implementation
1. [ ] Import functions at top of `server.ts`:
   ```typescript
   import { 
     fetchJJLog, fetchOpLog, fetchObslog, fetchShow, fetchDiff, fetchFiles,
     jjNew, jjEdit, jjDescribe, jjAbandon, jjSquash, jjRebase, 
     jjDuplicate, jjInsert, jjUndo, jjRedo
   } from './src/core/jj-api.js';
   ```
2. [ ] Replace each endpoint's inline spawn with function call
3. [ ] Example transformation:
   ```typescript
   // BEFORE
   case '/api/log':
     const proc = Bun.spawn({
       cmd: ['jj', 'log', '--template', JJ_TEMPLATE],
       cwd: repoRoot,
       stdout: 'pipe'
     });
     const output = await new Response(proc.stdout).text();
     const nodes = parseLogOutput(output);
     return Response.json({ nodes });
   
   // AFTER
   case '/api/log':
     const result = await fetchJJLog(repoRoot);
     if (!result.success) {
       return Response.json({ error: result.error }, { status: 500 });
     }
     return Response.json({ nodes: result.data });
   ```

#### Step 5: Handle findJJRoot Duplication
1. [ ] Server has its own `findJJRoot()`
2. [ ] Check if it differs from `src/core/jj-api.ts` version
3. [ ] If same: delete from server, import from jj-api.ts
4. [ ] If different: evaluate which is better, consolidate

**Testing:**
- [ ] Start server: `bun run server`  --- USER TO DO THIS ONLY 
- [ ] Test every endpoint:
  - [ ] GET `/api/log` - returns graph data
  - [ ] GET `/api/oplog` - returns operations
  - [ ] GET `/api/obslog` - returns observations
  - [ ] GET `/api/show?id=<commit>` - returns details
  - [ ] GET `/api/diff?id=<commit>` - returns diff
  - [ ] GET `/api/files?id=<commit>` - returns files
  - [ ] POST `/api/undo` - undoes operation
  - [ ] POST `/api/redo` - redoes operation
  - [ ] POST `/api/abandon` - abandons change
  - [ ] POST `/api/describe` - updates description
  - [ ] POST `/api/squash` - squashes changes
  - [ ] POST `/api/rebase` - rebases change
  - [ ] POST `/api/edit` - edits change
  - [ ] POST `/api/new` - creates new change
  - [ ] POST `/api/duplicate` - duplicates change
  - [ ] POST `/api/insert` - inserts change
- [ ] Verify all return correct success/error responses

---

### 3.2 Evaluate: Backend Interface Usage

**Question:** Should server use the Backend interface pattern?

**Current State:**
- Backend interface defined for frontends (TUI, Web)
- Server sits outside this architecture
- Server could instantiate a Backend and use usecases

**Decision:** 
- **NO** - Keep server as thin HTTP adapter
- Backend interface adds indirection without benefit for HTTP layer
- Direct function calls from server to jj-api.ts is simpler

**Action:**
- Document decision in `server.ts` comment:
```typescript
// Architecture Note: Server does not use Backend interface
// The Backend abstraction is for frontends (TUI/Web) that need
// swappable implementations. Server is already an adapter layer,
// so it calls jj-api.ts functions directly for simplicity.
```

**Implementation Update (2026-02-05):**
- [x] Added architecture note comment in `server.ts` documenting why server remains a thin HTTP adapter and does not use the frontend Backend interface.

---

## Phase 4: Dead Code Removal

> **Priority:** MEDIUM  
> **Goal:** Remove unused files, reduce confusion  
> **Estimated Time:** 1 day

### 4.1 Remove `public/client.ts`

**Location:** `public/client.ts` (2007 lines)

**Context:** Original monolithic canvas app, not loaded by `index.html` anymore

**Tasks:**
1. [ ] Verify `public/index.html` does not reference `client.ts`
2. [ ] Verify no other file imports from `client.ts`
3. [ ] Delete `public/client.ts`
4. [ ] Commit with message noting it can be recovered from git history

**Testing:**
- [ ] Build web: `bun run build:web`
- [ ] Verify no build errors
- [ ] Start server, verify web UI loads
- [ ] Verify all graph features work

---

### 4.2 Remove `tui/` Root Directory

**Location:** 
- `tui/main.ts`
- `tui/App.tsx`
- `tui/layout.ts`
- `tui/components/GraphView.tsx`
- `tui/components/Sidebar.tsx`
- `tui/components/HelpModal.tsx`
- `tui/jj-api.ts`
- `tui/types.ts`

**Context:** Old TUI implementation, replaced by `src/tui/`

**Tasks:**
1. [ ] Verify `cli.ts` points to `src/tui/main.ts` (line 37)
2. [ ] Delete entire `tui/` directory
3. [ ] Remove `"tui:old"` script from `package.json`
4. [ ] Verify `package.json` still has correct TUI script

**Testing:**
- [ ] Run TUI: `bun run tui`  --- USER ONLY
- [ ] Verify it starts (confirms correct entry point)
- [ ] Test basic navigation
- [ ] Verify no references to old files in build

---

### 4.3 Remove `src/shared/renderers.ts`

**Location:** `src/shared/renderers.ts` (546 lines)

**Context:** RenderContext/GraphRenderer abstraction designed to share rendering between web and TUI, but neither uses it

**Tasks:**
1. [ ] Verify no imports of `renderers.ts` in web or TUI
2. [ ] Verify no imports of `RenderContext` or `GraphRenderer`
3. [ ] Delete `src/shared/renderers.ts`
4. [ ] If `src/shared/` becomes empty, consider removing directory

**Testing:**
- [ ] Build TUI: `bun run build:tui`
- [ ] Build web: `bun run build:web`
- [ ] Verify both build successfully
- [ ] Run both, verify rendering works

---

### 4.4 Clean up `dist/` Directory

**Location:** `dist/`

**Context:** Build artifacts committed despite `.gitignore` listing `dist/`

**Tasks:**
1. [ ] Remove from git tracking: `git rm -r --cached dist/`
2. [ ] Verify `.gitignore` contains `dist/`
3. [ ] Commit the removal
4. [ ] Optionally add to `.gitignore` if missing

**Testing:**
- [ ] Run `git status`
- [ ] Verify `dist/` shows as deleted
- [ ] Verify not tracked anymore
- [ ] Build project, verify `dist/` recreated locally but not in git

---

### 4.5 Audit `bunfig.toml`

**Location:** `bunfig.toml`

**Context:** Contains jsx configuration that may be vestigial

**Tasks:**
1. [ ] Read current `bunfig.toml`
2. [ ] Identify jsx configuration:
   ```toml
   jsx = "react-jsx"
   jsxImportSource = "solid-js"
   ```
3. [ ] Check if TUI uses this config (uses Bun preload plugin)
4. [ ] Check if web uses this config (uses custom Babel plugin)
5. [ ] Test build without the config
6. [ ] If both work without it, remove from `bunfig.toml`

**Testing:**
- [ ] Save copy of `bunfig.toml`
- [ ] Comment out jsx config
- [ ] Build TUI: `bun run build:tui`
- [ ] Build web: `bun run build:web`
- [ ] If both succeed, commit removal
- [ ] If either fails, restore config and document why it's needed

---

## Phase 5: Web UI Regressions

> **Priority:** MEDIUM  
> **Goal:** Restore missing safety features  
> **Estimated Time:** 2-3 days

### 5.1 Add Confirmation Dialogs for Destructive Operations

**Context:** Original had `confirm()` before destructive operations. New Solid web app has none.

**Operations needing confirmation:**
- abandon
- squash
- rebase
- undo
- redo
- (optional: new, edit, duplicate, insert)

**Files to Modify:**
- `src/web/components/Sidebar.tsx` (or wherever action buttons are)

**Tasks:**
1. [ ] Identify all destructive operation buttons in web UI
2. [ ] Create lightweight modal component (or use browser `confirm()` as MVP)
3. [ ] Wrap destructive operations with confirmation
4. [ ] Style modal to match app theme

**MVP Approach:**
```typescript
const handleAbandon = async (changeId: string) => {
  if (!confirm('Abandon this change? This cannot be undone.')) {
    return;
  }
  await api.abandon(changeId);
  await refreshData();
};
```

**Better Approach:**
- Create `ConfirmModal` component
- Use it consistently across all destructive actions

**Testing:**
- [ ] Start web UI
- [ ] Select a change
- [ ] Click "Abandon"
- [ ] Verify confirmation dialog appears
- [ ] Click "Cancel" - operation should not execute
- [ ] Click "Abandon" again, then "Confirm" - operation should execute
- [ ] Repeat for squash and rebase operations

---

### 5.2 Consider Restoring Single-View Sidebar


// User says: intent matters here. regardless of displaying all in one tab or many tab, care should be taken to present all necessary key information in clean accessible easy to navigate UI . Diff rendering in general is porly implemented and could be overhauled, better to show diffs per file ? 

**Context:** Original showed files + diff + metadata in scrollable panel. New version uses tabs requiring clicks.

**Current:**
- Tabs: Details | Files | Diff
- User must click to see each section

**Original:**
- Single scrollable panel
- All information visible at once
- Better information density

**Decision:** Evaluate after other fixes

**Tasks (if proceeding):**
1. [ ] Modify `src/web/components/Sidebar.tsx`
2. [ ] Replace tabbed interface with scrollable sections
3. [ ] Use collapsible sections for each category
4. [ ] Ensure responsive design works

**Testing:**
- [ ] Select a change with files and diff
- [ ] Verify all sections visible without clicking
- [ ] Test scrolling behavior
- [ ] Test on different screen sizes

---

## Phase 6: State Architecture Improvement

> **Priority:** LOW  
> **Goal:** Improve code quality and maintainability  
> **Estimated Time:** 2-3 days (can be deferred)

### 6.1 Separate Derived State from Source State

**Problem:** `layoutResult` stored in store but is derived from `nodes` + `layoutMode`

**Current Pattern:**
```typescript
// In actions
setNodes(nodes) {
  state.nodes = nodes;
  // Imperatively recalculates and sets
  state.layoutResult = calculateLayout(nodes, state.layoutMode);
}
```

**Better Pattern:**
```typescript
// In store - source state only
const [state, setState] = createStore({
  nodes: [],
  layoutMode: 'compact',
  // NO layoutResult here
});

// Derived via memo
const layoutResult = createMemo(() => 
  calculateLayout(state.nodes, state.layoutMode)
);
```

**Files to Modify:**
- `src/core/state.ts` - Remove `layoutResult` from AppState, make it a createMemo
- Components using `state.layoutResult` - Use derived memo instead

**Tasks:**
1. [ ] Identify all places that read `state.layoutResult`
2. [ ] Create `createMemo` for layout calculation
3. [ ] Remove `layoutResult` from store state
4. [ ] Update all consumers to use memo
5. [ ] Remove `recalculateLayout()` calls scattered in actions

**Testing:**
- [ ] Start TUI and web  -- you already know this, but this is a user action 
- [ ] Load graph
- [ ] Change layout mode
- [ ] Verify layout updates automatically
- [ ] Add/remove nodes
- [ ] Verify layout recalculates
- [ ] Check performance (should be faster without manual updates)

---

### 6.2 Consider Splitting TUI-Only and Web-Only State

**Problem:** Single store contains fields only used by one frontend

**TUI-Only Fields:**
- `termSize`
- `leaderMode`
- `cursorPos`

**Web-Only Fields:**
- `expandedFilesNodeId` (used differently)

**Options:**

**Option A: Discriminated Union**
```typescript
type TUIState = { type: 'tui'; termSize: Size; /* ... */ };
type WebState = { type: 'web'; /* ... */ };
type AppState = TUIState | WebState;
```

**Option B: Separate Extension Stores**
```typescript
// core/store.ts - shared state
// tui/store.ts - TUI-specific state  
// web/store.ts - Web-specific state
```

**Decision:** Document as future improvement, not urgent

**Action:**
- Add TODO comment in `src/core/state.ts`:
```typescript
// TODO: Consider splitting frontend-specific state
// See Phase 6.2 in .agent/plan.md
```

---

## Summary Table

| Phase | Task | Priority | Effort | Status |
|-------|------|----------|--------|--------|
| 1.1 | TUI Redo Double-Fire | CRITICAL | 2-4 hrs | ✅ |
| 1.2 | Server Error Handling | CRITICAL | 2-4 hrs | ✅ |
| 1.3 | Template Deduplication | CRITICAL | 2 hrs | ✅ |
| 2.1 | TUI Auto-Refresh | HIGH | 1 day | 🔄 |
| 2.2 | Web Auto-Refresh | HIGH | 1 day | 🔄 |
| 3.1 | Server Delegation | HIGH | 3-4 days | ✅ |
| 4.1 | Remove public/client.ts | MEDIUM | 1 hr | ⬜ |
| 4.2 | Remove tui/ directory | MEDIUM | 1 hr | ⬜ |
| 4.3 | Remove renderers.ts | MEDIUM | 1 hr | ⬜ |
| 4.4 | Clean dist/ | MEDIUM | 1 hr | ⬜ |
| 4.5 | Audit bunfig.toml | MEDIUM | 2 hrs | ⬜ |
| 5.1 | Confirmation Dialogs | MEDIUM | 1-2 days | ⬜ |
| 5.2 | Single-View Sidebar | MEDIUM | 1-2 days | ⬜ |
| 6.1 | Derived State | LOW | 2-3 days | ⬜ |
| 6.2 | Split State | LOW | 2-3 days | ⬜ |

**Legend:**
- ⬜ Not Started
- 🔄 In Progress
- ✅ Complete
- ⏸️ Deferred

---

## Testing Checklist

### Pre-Change Baseline
- [ ] Record current behavior of all features
- [ ] Note any existing bugs or quirks
- [ ] Document reproduction steps

### Per-Phase Testing
- [ ] Run full test suite after each phase
- [ ] Manual testing of TUI on real repo
- [ ] Manual testing of web UI on real repo
- [ ] Test error conditions

### Regression Testing
- [ ] Undo/redo operations work correctly
- [ ] All jj operations complete successfully
- [ ] Graph renders correctly for various repo states
- [ ] File/diff views work
- [ ] Both frontends launch and function

### Edge Cases
- [ ] Empty repository
- [ ] Repository with conflicts
- [ ] Repository with many changes (100+)
- [ ] Rapid operations (stress test)
- [ ] Network errors (web only)

---

## Development Notes

### JJ Workflow

// USER SAYS:  Git Workflow?? this is a JJ repo? use JJ for all actions. disregard any git advice its clear the agent that wrote this was on crack at the time . USE THE JJ SKILL 

1. Create a new change for each phase/task with `jj new`
2. Keep changes atomic per plan item (e.g. 2.1 separate from 2.2)
3. Add clear change descriptions with `jj describe`
4. Use `jj op log` and `jj undo`/`jj redo` as safety net while iterating

### Before Major Changes
1. Run tests: `bun test` (if available)
2. Build both targets: `bun run build:tui && bun run build:web`
3. Verify no TypeScript errors
4. Run linting if available

### Communication
- Update status table in this plan as work progresses
- Document any deviations from plan
- Note any discovered bugs or new issues

### Completion Criteria
This plan is complete when:
- [ ] All CRITICAL priority items are done
- [ ] All HIGH priority items are done
- [ ] Tests pass for all completed items
- [ ] README is updated if behavior changed
- [ ] Status table shows all completed items

---

## Appendix: File Reference Map

### Core Files (src/core/)
- `src/core/types.ts` - Shared type definitions (CommitNode, LayoutMode, GraphConfig, etc.)
- `src/core/state.ts` - SolidJS store with AppState, actions, navigation helpers
- `src/core/jj-api.ts` - JJ CLI interface (templates, parsing, all jj operations)
- `src/core/layout.ts` - Graph layout algorithms (5 modes: chronological, mainline, etc.)
- `src/core/usecases.ts` - Use case orchestration (runMutation, refreshLog, op* functions)
- `src/core/backend.ts` - JJBackend interface (contract for TUI/Web backends)
- `src/core/runtime.ts` - Backend DI (setBackend/getBackend singleton)

### TUI Files (src/tui/)
- `src/tui/main.ts` - Entry point (renders SolidJS App via @opentui/solid)
- `src/tui/App.tsx` - Main app: keyboard handling, layout, views
- `src/tui/backend.ts` - TUI backend (direct jj CLI calls via jj-api.ts)
- `src/tui/components/GraphView.tsx` - FrameBuffer-based commit graph renderer
- `src/tui/components/Sidebar.tsx` - Detail panel (help, commit info, files)
- `src/tui/components/StatusBar.tsx` - Top bar with mode badge + keybinds
- `src/tui/components/FooterBar.tsx` - Bottom bar with repo info
- `src/tui/components/OpLogView.tsx` - Operation log view
- `src/tui/components/ObslogView.tsx` - Observation log view

### Web Files (src/web/)
- `src/web/App.tsx` - Main app + entry point (renders into #root)
- `src/web/api.ts` - HTTP client (fetch wrappers for all server endpoints)
- `src/web/backend.ts` - Web backend (delegates to api.ts HTTP calls)
- `src/web/bun-plugin-solid-dom.ts` - Babel plugin for Solid JSX in browser builds
- `src/web/components/CanvasGraph.tsx` - HTML5 Canvas commit graph with interactions
- `src/web/components/Sidebar.tsx` - Inspector panel (tabbed: Details/Files/Diff)
- `src/web/components/OpLogView.tsx` - Operation log list view
- `src/web/components/OpLogSidebar.tsx` - Op log detail sidebar
- `src/web/components/ObslogView.tsx` - Observation log list view
- `src/web/components/ObslogSidebar.tsx` - Obslog detail sidebar

### Server & Entry Points
- `cli.ts` - CLI entry point (routes between --tui and web server)
- `server.ts` - Bun HTTP server (API endpoints + static files + Solid bundling)
- `public/index.html` - Web app HTML shell + all CSS styles
- `public/style.css` - Additional styles (if any)

### Dead Code (to be removed)
- `public/client.ts` - Original 2007-line monolithic canvas app (DEAD)
- `tui/` - Old TUI implementation (DEAD, replaced by src/tui/)
- `src/shared/renderers.ts` - Unused rendering abstraction (DEAD)
- `dist/` - Build artifacts tracked in git (should be untracked)

### Configuration
- `package.json` - Dependencies, scripts, bin entry
- `bunfig.toml` - Bun JSX config (possibly vestigial)
- `src/tui/tsconfig.json` - TUI TypeScript config
- `src/web/tsconfig.json` - Web TypeScript config
- `.gitignore` - Git ignore rules

---

*Plan created: 2026-02-05*  
*Last updated: 2026-02-05 (Phase 1 complete, Phase 2 implementation in progress)*  
*Status: Ready for implementation*
