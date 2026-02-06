# jj-viz Validation + Architecture Plan (v2)

## Why this plan

This plan prioritizes:
- reliable validation and regression detection first,
- UX quality fixes (in-app confirmations) second,
- larger architecture refactors (state split) only after safety rails are in place.

This reduces risk while keeping delivery velocity high.

---

## Scope

1. Build test and validation infrastructure from near-zero.
2. Replace browser `confirm()` with in-app confirmation UI in web.
3. Evaluate and (if justified) execute split-state architecture in controlled phases.

---

## Phase A - Baseline Validation Infrastructure (Highest Priority)

**Goal:** Catch regressions quickly before more refactors.

### A.1 Test Harness Setup
- [x] Add a test runner (Bun test) config and scripts in `package.json`.
- [x] Add test directory structure:
  - `src/core/__tests__/`
  - `src/web/__tests__/`
  - `server/__tests__/` (or `src/server/__tests__/`)
- [x] Add shared fixtures and helpers:
  - sample jj log/oplog/obslog outputs
  - parser fixtures
  - temporary repo helper for integration tests

Implementation update (2026-02-06):
- Added `test` and `test:watch` scripts.
- Added initial test files under core/web/server test directories.
- Added shared fixtures in `src/test-utils/fixtures/` and helpers in `src/test-utils/`.

### A.2 Core Unit Tests (First Wave)
- [x] `src/core/layout.ts`
  - [x] layout mode sanity tests (chronological/mainline/topological/wc/bookmark-centric)
  - [x] deterministic lane assignments for known fixtures
  - [x] edge cases: empty nodes, conflict nodes, many-parent merges
- [x] `src/core/jj-api.ts`
  - [x] template parser coverage for log/oplog/obslog
  - [x] malformed block handling
  - [x] git branch merge enrichment behavior

Implementation update (2026-02-06):
- Added layout unit coverage in `src/core/__tests__/layout.test.ts` for mode behavior, deterministic lanes, and merge/empty edge cases.
- Extracted and exported parser helpers in `src/core/jj-api.ts` for log/oplog/obslog parsing and branch enrichment.
- Added parser and enrichment tests in `src/core/__tests__/jj-api.test.ts`.

### A.3 Store/Usecase Tests
- [x] `src/core/state.ts`
  - [x] source-state updates for layout mode and node selection
  - [x] selection navigation behavior (oplog/obslog)
  - [x] operation mode state transitions
- [x] `src/core/usecases.ts`
  - [x] mutation wrappers trigger refresh and status updates
  - [x] error paths set failure state correctly
  - [x] file cache behavior in `ensureFiles`

Implementation update (2026-02-06):
- Added `src/core/__tests__/state.test.ts` covering selection/navigation and op-mode transitions.
- Added `src/core/__tests__/usecases.test.ts` with backend-mocked mutation success/failure assertions.
- Verified refresh/error loading state behavior and file-cache short-circuiting.

### A.4 Server API Integration Tests (Minimal but real)
- [x] Start server in test mode against temp repo.
- [x] Validate key endpoints:
  - [x] GET `/api/log`, `/api/files/:id`, `/api/diff/:id`, `/api/oplog`, `/api/obslog/:id`
  - [x] POST `/api/undo`, `/api/redo`, `/api/abandon`, `/api/describe`, `/api/rebase`
- [x] Validate error contract shape (`{ success: false, error }` or `{ error }`) consistency.

Implementation update (2026-02-06):
- Added integration smoke tests in `server/__tests__/api.integration.test.ts`.
- Test harness creates a temp JJ repo, spawns `server.ts` on a free port, and hits real HTTP endpoints.
- Added success and error-contract assertions for mutation endpoints listed in A.4.

### Exit Criteria
- Stable local test command (single entry command).
- Core parser/layout/store/usecase coverage in place.
- Endpoint smoke integration tests passing.

Status (2026-02-06):
- `bun test` is now the single local entry command and passes with core + server smoke coverage.

---

## Phase B - In-App Confirmation UX (Web)

**Decision:** Replace browser modal; do not use `window.confirm()`.

### B.1 Confirmation Component
- Create reusable `ConfirmModal` component in web UI.
- Support title/body/confirmLabel/cancelLabel/destructive tone.
- Keyboard support:
  - `Enter` confirms (when safe)
  - `Esc` cancels
  - focus trap while open

### B.2 Hook Into Actions
- Apply modal to destructive operations:
  - `abandon`, `squash`, `rebase`, `undo`, `redo`
- Ensure it works for all trigger paths:
  - keyboard shortcuts
  - sidebar actions
  - graph inline actions
  - oplog actions

### B.3 Consistency With TUI
- Keep TUI confirmation flow as-is (sidebar prompt) for parity of behavior.
- Align copy and intent text across web/TUI.

### Exit Criteria
- No browser-native confirm usage in app flow.
- In-app modal used consistently across destructive triggers.
- Accessible keyboard behavior validated.

---

## Phase C - Split-State Architecture (Exploratory then Incremental)

**Recommendation:** Perform only after Phase A tests exist.

### C.1 Exploration Spike (Time-boxed)
- [x] Design target state split:
  - [x] shared state (repo, nodes, layout, selection, files cache)
  - [x] TUI extension state (term size, leader mode, cursor, prompt state)
  - [x] web extension state (panel modes, UI-only toggles)
- [x] Produce migration map: current field -> target store.
- [x] Define compatibility approach for incremental migration.

Migration map (implemented):
- Shared (`src/core/state.ts`): repo/data/view (`cwd`, `nodes`, `filesCache`, `viewMode`, op/obslog data), layout (`layoutMode`, `pinnedNodes`, `layoutResult`), selection (`selectedId`, `selectedIds`), shared mutation UI intent (`rebaseSourceId`, `describeMode`, `describeValue`), status/loading.
- TUI extension (`src/core/state-tui.ts`): `termSize`, `scrollOffset`, `sidebarScroll`, `showHelp`, `leaderMode`, `cursorPos`, `mergeMode`, `mergeSelectedIds`, `descExpanded`, `filesExpanded`.
- Web extension (`src/core/state-web.ts`): `viewport`, `sidebarScroll`, `showHelp`, `expandedFilesNodeId`, `opMode`, `opSelectedPaths`, `opTargetId`.

### C.2 Incremental Migration
- [x] Step 1: introduce new store modules.
- [x] Step 2: migrate TUI consumers.
- [x] Step 3: migrate web consumers.
- [x] Step 4: remove deprecated fields from shared store and complete migration.

Implementation update (2026-02-06):
- Added `state-tui.ts` and `state-web.ts` extension stores.
- Reduced `state.ts` to shared/core concerns and kept shared navigation/actions frontend-agnostic.
- Migrated TUI and web consumers to use extension stores/actions.
- Moved inline-files toggle behavior to web app layer so core usecases stay frontend-agnostic.

### C.3 Safety Rules
- One frontend migration per change stack step.
- No behavior changes mixed with structure refactors.
- Full test pass required at each migration checkpoint.

### Exit Criteria
- [x] Frontend-specific fields no longer in shared state.
- [x] Shared actions/usecases remain frontend-agnostic.
- [x] Regression tests remain green.

---

## Optional Phase D - Server-Sent Events (Post-Stabilization)

Only after A/B/C are stable.
- Server watches `.jj/` and broadcasts SSE updates.
- Web subscribes and refreshes on event instead of polling.
- Keep polling fallback for resilience.

---

## Execution Order

1. Phase A (validation infra)
2. Phase B (in-app web confirmation modal)
3. Phase C (state split exploration + migration)
4. Optional D (SSE)

---

## JJ Change Strategy

- One JJ change per major step (A1, A2, A3, A4, B1/B2, C1, C2-steps).
- Keep behavior and refactor changes separate.
- Keep change descriptions focused on intent and risk.

---

## Success Metrics

- Regressions are caught by tests before manual QA.
- Destructive operations use consistent in-app confirmation UX.
- Shared/core state is cleaner and less coupled to frontend details.
