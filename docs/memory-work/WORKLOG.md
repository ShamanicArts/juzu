# Memory Program Worklog

## Purpose

This file is the authoritative chronological record of planning decisions, approved scopes, implemented changes, benchmark outcomes, and regressions.

Use append-only entries. Do not rewrite history except to fix obvious factual errors.

## Entry Template

### [YYYY-MM-DD HH:MM] Entry Title

- Context: what prompted this work.
- Approved scope:
  - list of approved tasks
  - explicit non-goals
- Planned files:
  - `path/to/file`
- Risks/invariants:
  - list of invariants at risk
- Actions performed:
  - concrete steps taken
- Validation:
  - tests run
  - benchmark scenarios run
- Results:
  - key metrics and outcomes
- Follow-ups:
  - next tasks
- Status: `planned` | `in_progress` | `complete` | `blocked`

## Entries

### [2026-02-10 00:00] Program initialization and artifact creation

- Context: User requested a reviewable, documentable process for reducing memory usage while preserving correctness and complete graph usability.
- Approved scope:
  - Create detailed planning artifacts before further code changes.
  - Include benchmark tooling as first-class deliverable.
  - Preserve pinning and focus on implementation quality, not feature removal.
- Explicit non-goals:
  - No broad code refactor in this step.
  - No additional behavior changes in runtime logic yet.
- Notable existing workspace state:
  - One previously made unapproved code change exists in `src/core/jj-api.ts` (count fast-path with fallback). User chose to keep it for now pending later review.
- Artifacts created:
  - `docs/memory-work/PLAN.md`
  - `docs/memory-work/INVARIANTS.md`
  - `docs/memory-work/BENCHMARKING.md`
  - `docs/memory-work/WORKLOG.md`
  - `docs/memory-work/SESSION_PROTOCOL.md`
- Validation:
  - Artifact review pending user feedback.
- Follow-ups:
  - Refine artifacts per user direction.
  - On approval, implement Phase 0 benchmark scripts and baseline runs.
- Status: `complete`

### [2026-02-10 00:10] Scope correction: TUI-first and CLI-only benchmarking

- Context: User requested removal of web automation assumptions and explicit TUI/core-first focus.
- Approved scope:
  - Rewrite planning artifacts to remove web simulation focus.
  - Keep benchmarking internal and callable from CLI.
- Explicit non-goals:
  - No Playwright/browser automation.
  - No web benchmark harness implementation in current program.
- Planned files:
  - `docs/memory-work/PLAN.md`
  - `docs/memory-work/INVARIANTS.md`
  - `docs/memory-work/BENCHMARKING.md`
  - `docs/memory-work/SESSION_PROTOCOL.md`
- Risks/invariants:
  - Avoid introducing ambiguous language that could re-expand scope.
- Actions performed:
  - Updated plan phases and deliverables to TUI/core-first.
  - Updated validation matrix to mark web as deferred.
  - Removed web automation references from benchmarking strategy.
  - Added explicit out-of-scope statements for Playwright/web simulation.
  - Added session protocol scope note for TUI/core-first execution.
- Validation:
  - Documentation edits only.
- Results:
  - Planning artifacts now align with user direction: internal CLI benchmarking and TUI-first implementation.
- Follow-ups:
  - Present revised artifacts for approval.
  - On approval, implement Phase 0 CLI benchmark scripts (`bench:tui`, `bench:compare`).
- Status: `complete`

### [2026-02-10 00:20] Phase 0 implementation start: CLI benchmark tooling

- Context: User approved proceeding with the revised TUI-first planning artifacts.
- Approved scope:
  - Implement internal CLI benchmark runner for TUI/core scenarios.
  - Implement benchmark comparison tool for baseline vs latest metrics.
  - Add package scripts to run benchmark tooling.
- Explicit non-goals:
  - No Playwright/browser automation.
  - No web benchmark harness implementation.
- Planned files:
  - `scripts/bench/tui-memory.ts`
  - `scripts/bench/compare.ts`
  - `package.json`
  - `docs/memory-work/BENCHMARKING.md`
  - `docs/memory-work/WORKLOG.md`
- Risks/invariants:
  - Benchmark scripts must not mutate repo state.
  - Scenario steps must remain deterministic and repeatable.
  - Metrics schema must be stable for compare tooling.
- Status: `complete`

### [2026-02-10 00:35] Phase 0 tooling implementation complete (TUI/core CLI)

- Context: Implement internal benchmarking tools according to approved TUI-first scope.
- Actions performed:
  - Added `scripts/bench/tui-memory.ts` with scenario runners S1-S6.
  - Added `scripts/bench/compare.ts` for baseline/current threshold comparison.
  - Added package scripts in `package.json`: `bench:tui`, `bench:compare`.
  - Updated `docs/memory-work/BENCHMARKING.md` to reflect implemented commands.
  - Updated `docs/memory-work/PLAN.md` immediate next actions for baseline execution.
- Validation:
  - Ran `bun run scripts/bench/tui-memory.ts --help` successfully.
  - Ran `bun run scripts/bench/compare.ts --help` successfully.
- Results:
  - CLI benchmark harness is now in-repo and callable without web automation.
  - Benchmark compare report generation path is implemented.
- Follow-ups:
  - Execute baseline benchmark runs (`--write-baseline`) on target repos.
  - Capture baseline metrics and link artifacts in this worklog.
- Status: `complete`

### [2026-02-10 00:40] Phase 0 smoke benchmark execution

- Context: Validate new benchmark tooling end-to-end on current repository.
- Approved scope:
  - Run one scenario smoke benchmark with minimal run counts.
  - Write a baseline and run compare flow.
- Actions performed:
  - Ran `bun run bench:tui --scenario S1_SMALL_REPO_BASELINE --warmup-runs 0 --measured-runs 1 --limit 200 --sample-interval-ms 100 --sample-every-nav-steps 20`.
  - Ran `bun run bench:tui --scenario S1_SMALL_REPO_BASELINE --warmup-runs 0 --measured-runs 1 --limit 200 --write-baseline`.
  - Ran `bun run bench:compare --scenario S1_SMALL_REPO_BASELINE`.
- Validation:
  - Tooling executed without runtime errors.
  - Compare report generated successfully.
- Results:
  - Latest result dir: `benchmarks/results/2026-02-10T22-30-43-698Z`.
  - Baseline file written: `benchmarks/baselines/S1_SMALL_REPO_BASELINE.json`.
  - Sample summary: rss peak 68.12 MB, rss steady 68.12 MB, refresh p50 59.1 ms, nav p95 0 ms, zero correctness violations.
- Follow-ups:
  - Run full S1-S6 baseline suite on target repos.
  - Start Phase 1 proposal using these tools as mandatory regression gates.
- Status: `complete`

### [2026-02-10 00:50] Added process-tree PID memory sampling for total app footprint

- Context: User noted that internal RSS/heap scenario metrics do not fully represent total app memory usage.
- Approved scope:
  - Add CLI tool to sample real running TUI PID memory (including descendants).
  - Integrate command/documentation into benchmark workflow.
- Actions performed:
  - Added `scripts/bench/pid-memory.ts`.
  - Added `bench:pid` command in `package.json`.
  - Updated `docs/memory-work/BENCHMARKING.md` and `docs/memory-work/PLAN.md` to include PID sampling as a baseline requirement.
- Validation:
  - Ran `bun run scripts/bench/pid-memory.ts --help` successfully.
  - Ran `bun run bench:pid --pid 2907393 --duration-ms 5000 --interval-ms 250` successfully.
- Results:
  - Sampled PID 2907393 (single-process tree in this run).
  - rss_peak_mb: 703.46
  - rss_steady_mb: 696.77
  - pss_peak_mb: 658.36
  - pss_steady_mb: 651.67
  - output: `benchmarks/results/pid/2026-02-10T22-37-31-043Z/PID-2907393.json`
- Status: `complete`

### [2026-02-10 01:05] First fix set implemented (core/TUI memory + completeness)

- Context: User approved proceeding with first implementation fixes after baseline tooling was in place.
- Approved scope:
  - Apply low-risk, high-impact fixes in core/TUI paths.
  - Prioritize memory churn reduction and missing-node behavior.
- Actions performed:
  - Fixed `jj log --count` usage in `src/core/jj-api.ts`:
    - removed invalid `--no-graph --count` combination
    - removed expensive fallback that fetched/parses full log for node count
  - Replaced large temporary string fingerprinting with numeric incremental hashing in `src/core/usecases.ts`.
  - Updated status message to show loaded vs total node counts (`nodes:<loaded>/<total>`) in `src/core/usecases.ts`.
  - Added progressive TUI log window expansion in `src/tui/App.tsx`:
    - new `JUZU_TUI_LOG_GROWTH_CHUNK` env knob
    - automatic growth when selection approaches loaded tail
    - keeps initial cap while allowing traversal toward full history
  - Updated affected unit expectation in `src/core/__tests__/usecases.test.ts`.
- Validation:
  - `bun test src/core/__tests__/jj-api.test.ts src/core/__tests__/usecases.test.ts src/core/__tests__/state.test.ts src/core/__tests__/layout.test.ts` passed.
  - Post-change smoke benchmark:
    - `bun run bench:tui --scenario S1_SMALL_REPO_BASELINE --warmup-runs 0 --measured-runs 1 --limit 200`
  - Post-change compare:
    - `bun run bench:compare --scenario S1_SMALL_REPO_BASELINE --current-root benchmarks/results/2026-02-10T22-41-45-099Z`
- Results:
  - S1 compare vs baseline showed improvement in this smoke run:
    - rss peak: 68.12 MB -> 62.2 MB
    - rss steady: 68.12 MB -> 62.2 MB
    - refresh p50: 59.1 ms -> 32.63 ms
  - Note: these are smoke numbers on a small scenario; large-repo PID baselines remain the authoritative memory target.
- Follow-ups:
  - Run full S1-S6 suite on target repos.
  - Re-sample long-running TUI PID memory after restarting app with these changes.
  - Draft next fix set focused on layout/state object footprint and pinning-safe lane computation.
- Status: `complete`

### [2026-02-10 01:20] Second fix set start: layout churn + status noise cleanup

- Context: User reported high memory still present and requested first follow-up set; also requested removal of flashing `nodes loaded/total` status message.
- Approved scope:
  - Remove transient node-count status rendering in TUI status bar.
  - Eliminate double layout pass under pinning.
  - Reduce O(n^2) traversal patterns in core layout hot paths.
  - Run tests, benchmark, and build script after changes.
- Planned files:
  - `src/tui/components/StatusBar.tsx`
  - `src/core/state.ts`
  - `src/core/layout.ts`
  - `src/core/__tests__/layout.test.ts`
  - `docs/memory-work/WORKLOG.md`
- Risks/invariants:
  - Pinning semantics must remain deterministic.
  - Layout outputs must remain stable for all modes.
  - No regressions in navigation/selection.
- Actions performed:
  - Updated `src/tui/components/StatusBar.tsx` to suppress both `nodes:<n>` and `nodes:<loaded>/<total>` status messages.
  - Removed double layout pass in `src/core/state.ts` by passing pin constraints directly into layout calculation.
  - Refactored `src/core/layout.ts`:
    - added one-pass pin lane application in `calculateLayout(..., pinnedNodes)`
    - reduced O(n^2) child traversal in `wc-focused` and `mainline` modes via precomputed child maps
    - optimized `findConnectionAt` to use id lookup map and squared-distance comparison
  - Added pinning behavior regression coverage in `src/core/__tests__/layout.test.ts`.
- Validation:
  - `bun test src/core/__tests__/layout.test.ts src/core/__tests__/state.test.ts src/core/__tests__/usecases.test.ts src/core/__tests__/jj-api.test.ts` passed.
  - Build script run: `bun run scripts/build-tui.ts` passed.
  - Smoke benchmark run: `bun run bench:tui --scenario S1_SMALL_REPO_BASELINE --warmup-runs 0 --measured-runs 1 --limit 200`.
  - Smoke compare run: `bun run bench:compare --scenario S1_SMALL_REPO_BASELINE --current-root benchmarks/results/2026-02-10T22-55-14-884Z`.
- Results:
  - Flashing node-count status line no longer rendered in status bar.
  - Pinning now stays in a single layout pass (no re-layout cloning pass).
  - Layout hot paths removed multiple full-node scans.
  - Smoke S1 snapshot: rss peak 64.04 MB, rss steady 64.04 MB.
- Follow-ups:
  - Measure long-running PID memory after restart and active interaction using `bench:pid`.
  - Next fix set should target high steady-state memory sources (cache/data residency and heavyweight node payload paths).
- Status: `complete`

### [2026-02-10 01:35] Third fix set: payload slimming via lazy commit descriptions

- Context: User selected payload slimming as next priority after reporting high live PID memory (200-300 MB).
- Approved scope:
  - Reduce retained node payload by removing full description text from bulk log fetch.
  - Keep full descriptions available via on-demand hydration for selected commit.
  - Maintain backend abstraction compatibility.
- Actions performed:
  - Updated `src/core/jj-api.ts` log template to omit full description in bulk log payload.
  - Added `fetchCommitDescription(cwd, changeId)` in `src/core/jj-api.ts`.
  - Extended `JJBackend` with `description(...)` in `src/core/backend.ts`.
  - Implemented backend support:
    - `src/tui/backend.ts`
    - `src/web/backend.ts`
    - `src/web/api.ts`
    - `server.ts` (`/api/description/:id`)
  - Added lazy description hydration path:
    - `ensureDescription(...)` with bounded cache in `src/core/usecases.ts`
    - selected-node hydration trigger in `src/tui/App.tsx`
    - node-description patch action in `src/core/state.ts`
  - Ensured refreshed node lists preserve previously hydrated descriptions when possible.
- Validation:
  - `bun test src/core/__tests__/jj-api.test.ts src/core/__tests__/usecases.test.ts src/core/__tests__/state.test.ts src/core/__tests__/layout.test.ts` passed.
  - Build script run: `bun run scripts/build-tui.ts` passed.
  - Smoke benchmark run: `bun run bench:tui --scenario S1_SMALL_REPO_BASELINE --warmup-runs 0 --measured-runs 1 --limit 200`.
  - Compare run: `bun run bench:compare --scenario S1_SMALL_REPO_BASELINE --current-root benchmarks/results/2026-02-10T23-06-49-709Z`.
- Results:
  - S1 smoke compare vs baseline improved in this run:
    - rss peak: 68.12 MB -> 61.22 MB
    - rss steady: 68.12 MB -> 61.22 MB
  - Bulk node payload now carries title-only descriptions by default; full body hydrates on demand.
- Follow-ups:
  - Re-run full S1-S6 suite and long PID soak after restart to measure real-process effect.
  - Continue with cache/data-residency fix set if live PID remains above target.
- Status: `complete`

### [2026-02-10 01:50] Fourth fix set: resident log window contraction (scroll-down/scroll-up memory)

- Context: User reported live TUI process rising from ~140 MB at startup to ~200-300 MB after scrolling deep and returning to top, with PID sample showing large transient peak (`rss_peak_mb` ~841.89, `rss_steady_mb` ~325.37).
- Approved scope:
  - Address memory retention from one-way log window expansion in TUI.
  - Keep chunked growth behavior, but add contraction when selection returns toward top.
  - Run build script after code changes.
- Actions performed:
  - Updated `src/tui/App.tsx` with dynamic resident window contraction:
    - added `maybeShrinkLogWindow(...)` alongside existing growth behavior
    - added window-adjust cooldown to avoid thrash (`JUZU_TUI_LOG_WINDOW_ADJUST_COOLDOWN_MS`)
    - added shrink buffer control (`JUZU_TUI_LOG_SHRINK_BUFFER_ROWS`)
    - shared in-flight guard for grow/shrink adjustments
  - Existing growth envs remain in place (`JUZU_TUI_LOG_GROWTH_CHUNK`, `JUZU_TUI_LOG_LIMIT`).
- Validation:
  - Build script run: `bun run scripts/build-tui.ts` passed.
  - Smoke scenario run: `bun run bench:tui --scenario S5_WINDOW_BOUNDARY_STRESS --warmup-runs 0 --measured-runs 1 --limit 200`.
- Results:
  - Contraction path implemented to release retained node window when user navigates back upward.
  - S5 smoke run completed and artifacts were written (`benchmarks/results/2026-02-10T23-16-24-726Z`).
- Follow-ups:
  - Re-run live PID sampling during down/up/down interaction to verify lower steady-state memory.
  - If steady PID remains high, proceed to cache/data-residency tightening fix set.
- Status: `complete`

### [2026-02-10 02:00] Fifth fix set: delayed sidebar/detail hydration during rapid scrolling

- Context: User reported behavior still felt the same and requested intentional delay before loading sidebar-related data while scrolling quickly.
- Approved scope:
  - Add selection-settle delays for files, diff preview hydration, and description hydration.
  - Keep functionality, but avoid eager background work for commits user scrolls past.
  - Run build script after changes.
- Actions performed:
  - Updated `src/tui/App.tsx` to debounce hydration paths:
    - selected files hydration delay (`JUZU_TUI_SELECTED_FILES_DEBOUNCE_MS`, default 320 ms)
    - selected description hydration delay (`JUZU_TUI_SELECTED_DESCRIPTION_DEBOUNCE_MS`, default 420 ms)
    - nearby files prefetch delay (`JUZU_TUI_NEARBY_FILES_PREFETCH_DEBOUNCE_MS`, default 700 ms)
    - increased selected diff prefetch debounce default (`JUZU_TUI_DIFF_PREFETCH_DEBOUNCE_MS`, default 550 ms)
  - Added stale-selection guards before executing delayed hydration calls.
  - Added cleanup for new timers on unmount.
- Validation:
  - Build script run: `bun run scripts/build-tui.ts` passed.
  - Smoke benchmark run: `bun run bench:tui --scenario S5_WINDOW_BOUNDARY_STRESS --warmup-runs 0 --measured-runs 1 --limit 200`.
- Results:
  - Hydration work is now intentionally deferred and skipped for transient/fast-scrolled selections.
  - S5 smoke artifact written (`benchmarks/results/2026-02-10T23-21-05-347Z`).
- Follow-ups:
  - User to re-run live down/up scroll repro and PID sampling to validate reduced spike and quicker post-spike decay.
  - If needed, tighten with adaptive delay escalation under rapid selection churn.
- Status: `complete`

### [2026-02-10 02:10] Sixth fix set: disable log-mode diff auto-loading (true on-demand diffs)

- Context: User observed startup jump to very high memory and suspected delayed auto-loading still fetched heavy diff data without explicit request.
- Approved scope:
  - Stop automatic diff loading in log mode by default.
  - Keep diff loading on explicit request paths only.
  - Preserve sidebar file click UX by loading selected commit diff on demand.
- Actions performed:
  - Updated `src/tui/App.tsx` diff hydration effect:
    - in `log` mode, only prefetch when `runtimeConfig.tui.prefetchDiffInLog` is true
    - default config remains false, so no automatic selected diff hydration in log mode
  - Updated `handleFileClick` in `src/tui/App.tsx`:
    - if diff is missing, now fetches it on demand (`ensureDiff(..., 0)`) instead of failing
    - keeps file-index selection behavior after load
- Validation:
  - Build script run: `bun run scripts/build-tui.ts` passed.
  - Smoke benchmark run: `bun run bench:tui --scenario S1_SMALL_REPO_BASELINE --warmup-runs 0 --measured-runs 1 --limit 200`.
- Results:
  - Diffs are no longer loaded in log view unless explicitly requested.
  - S1 smoke artifact written (`benchmarks/results/2026-02-10T23-25-34-530Z`).
- Follow-ups:
  - User to re-check startup memory and down/up spike behavior with live PID sampling.
  - If large spikes persist, proceed to parser/render allocation profiling in graph draw path.
- Status: `complete`

### [2026-02-10 02:25] Seventh fix set: configurable single-file diff auto-load (not full commit)

- Context: User requested config-driven middle ground: keep default click-to-load behavior, but when auto-load is enabled it should load only one file diff for the active file, not the entire commit diff payload.
- Approved scope:
  - Keep default (`prefetchDiffInLog = false`) behavior as on-demand.
  - When enabled (`prefetchDiffInLog = true`), auto-load only selected file diff.
  - Preserve explicit full diff loading for diff view mode.
- Actions performed:
  - Added path-scoped diff command in core jj API:
    - `jjGetDiffForPath(changeId, path, cwd)` in `src/core/jj-api.ts`.
  - Extended backend abstraction with optional path-scoped diff:
    - `diffFile(...)` in `src/core/backend.ts`.
  - Wired diff-file backend support:
    - `src/tui/backend.ts` via `jjGetDiffForPath`
    - `src/web/api.ts`, `src/web/backend.ts`, `server.ts` (`/api/diff-file/:id?path=...`)
  - Added `ensureDiffForFile(...)` in `src/core/usecases.ts`:
    - caches per-file diff content for a commit
    - preserves file ordering from `filesCache`
    - avoids loading full commit diff for sidebar preview paths
  - Updated `src/tui/App.tsx`:
    - log-mode prefetch now targets active file path only (when enabled)
    - queued prefetch key now includes changeId + path
    - file click now ensures per-file diff on demand
    - sidebar preview now derives file index/total from `filesCache` and uses loaded per-file diff only when available
- Validation:
  - Tests: `bun test src/core/__tests__/usecases.test.ts src/core/__tests__/jj-api.test.ts src/core/__tests__/state.test.ts src/core/__tests__/layout.test.ts` passed.
  - Build: `bun run scripts/build-tui.ts` passed.
  - Smoke benchmark: `bun run bench:tui --scenario S5_WINDOW_BOUNDARY_STRESS --warmup-runs 0 --measured-runs 1 --limit 200`.
- Results:
  - Config now supports both modes:
    - `prefetchDiffInLog = false` -> click/on-demand only (default)
    - `prefetchDiffInLog = true` -> delayed single-file auto-load for current file
  - Full-commit diff hydration remains explicit (`diff` view open).
  - New smoke artifact written (`benchmarks/results/2026-02-10T23-35-16-125Z`).
- Follow-ups:
  - Re-run live PID repro to verify reduced spikes under optional auto-load mode.
  - Continue optimization toward target floor with graph/render allocation profiling and further residency tightening.
- Status: `complete`

### [2026-02-10 02:35] Bracket navigation regression fix for per-file diff loading

- Context: User reported `[` / `]` navigation still moved selection but did not load the newly selected file diff.
- Actions performed:
  - Updated `cycleSidebarDiffFile` in `src/tui/App.tsx` to:
    - source file count from `filesCache` (not diff cache)
    - ensure file list is loaded (`ensureFiles`) if needed
    - load next file diff on demand via `ensureDiffForFile(..., 0)` when missing
- Validation:
  - Build script run: `bun run scripts/build-tui.ts` passed.
  - Smoke run: `bun run bench:tui --scenario S1_SMALL_REPO_BASELINE --warmup-runs 0 --measured-runs 1 --limit 200`.
- Status: `complete`

### [2026-02-10 02:50] Fix Set 8: aggressive files residency controls + configurable log prefetch

- Context: User approved next step to reduce steady-state memory after down/up traversal (~220 MB) and requested continued push toward 100-150 MB steady range.
- Approved scope:
  - Make files prefetch in log view configurable and default-off.
  - Add byte-aware files cache limits with aggressive eviction.
  - Keep per-file diff strategy and avoid full-file placeholder retention.
- Actions performed:
  - Runtime config additions (`src/core/runtime-config.ts`, `src/core/config-loader.ts`, `config.example.toml`):
    - `tui.prefetchFilesInLog` (default `false`)
    - `tui.filesCacheMaxEntries` (default `12`)
    - `tui.filesCacheMaxBytes` (default `1500000`)
  - TUI behavior update (`src/tui/App.tsx`):
    - nearby files prefetch effect now gated by `tui.prefetchFilesInLog`
  - Files cache residency tightening (`src/core/usecases.ts`):
    - added byte estimation for file summaries
    - added byte-aware and count-aware file cache pruning
    - wrote per-entry bytes into files cache entries
  - Diff residency tightening (`src/core/usecases.ts`):
    - `ensureDiffForFile` now stores only loaded diff files (bounded by `JUZU_DIFF_FILE_RESIDENT_PER_COMMIT`, default `2`)
    - removed full-file placeholder arrays in per-file diff path
  - Type update (`src/core/types.ts`): optional `bytes` on `FilesCacheEntry`.
- Validation:
  - Tests: `bun test src/core/__tests__/usecases.test.ts src/core/__tests__/state.test.ts src/core/__tests__/layout.test.ts src/core/__tests__/jj-api.test.ts` passed.
  - Build: `bun run scripts/build-tui.ts` passed.
  - Smoke benchmark: `bun run bench:tui --scenario S5_WINDOW_BOUNDARY_STRESS --warmup-runs 0 --measured-runs 1 --limit 200`.
- Results:
  - S5 smoke artifact written (`benchmarks/results/2026-02-11T00-18-06-814Z`).
  - Files/diff memory residency now significantly more bounded in log-mode idle/scroll workflows.
- Follow-ups:
  - Re-run live PID down/up repro to validate reduced steady footprint and lower spike persistence.
  - If still above target, next step is graph/render allocation profiling and reducing in-memory node annotation footprint.
- Status: `complete`

### [2026-02-10 03:00] Live PID checkpoint + Fix Set 9 (selected-only files cache in log)

- Context: User reported new live PID sample after Fix Set 8:
  - rss_peak_mb: 262.88
  - rss_steady_mb: 212.19
  - pss_peak_mb: 222.47
  - pss_steady_mb: 171.78
  - sample artifact: `benchmarks/results/pid/2026-02-11T00-26-13-532Z/PID-3882736.json`
  - User also noted slow long-run memory growth persisted.
- Actions performed:
  - Implemented stronger default files-residency behavior in `src/core/usecases.ts`:
    - when `tui.prefetchFilesInLog = false`, files cache is reduced to selected commit only
    - nearby files prefetch is hard-disabled in usecases guard when config is false
    - `ensureFiles` now evicts non-selected entries immediately in no-prefetch mode
  - Preserved existing configurable behavior for users who enable `prefetchFilesInLog = true`.
- Validation:
  - Tests: `bun test src/core/__tests__/usecases.test.ts src/core/__tests__/state.test.ts src/core/__tests__/layout.test.ts src/core/__tests__/jj-api.test.ts` passed.
  - Build: `bun run scripts/build-tui.ts` passed.
  - Smoke benchmark: `bun run bench:tui --scenario S5_WINDOW_BOUNDARY_STRESS --warmup-runs 0 --measured-runs 1 --limit 200`.
- Results:
  - S5 smoke artifact written (`benchmarks/results/2026-02-11T00-28-51-210Z`).
  - Files summary residency now clamps much harder in default log mode, aimed directly at slow growth.
- Follow-ups:
  - User to rerun long PID sample for down/up traversal and idle period comparison.
  - If growth persists, next pass targets render-layer allocations and potential OpenTUI buffer retention patterns.
- Status: `complete`

### [2026-02-10 03:15] Live idle PID report + Fix Set 10 (GraphView allocation reduction)

- Context: User provided long idle PID sample showing improved but still creeping memory:
  - rss_peak_mb: 219.99
  - rss_steady_mb: 178.95
  - pss_peak_mb: 174.62
  - pss_steady_mb: 133.6
  - artifact: `benchmarks/results/pid/2026-02-11T00-35-25-040Z/PID-3946313.json`
- Actions performed:
  - Reduced per-draw allocations in `src/tui/components/GraphView.tsx` by caching color objects inside draw pass:
    - removed repeated `RGBA.fromHex(...)` calls from per-node and per-cell hot paths
    - replaced repeated `BG()` allocations with one `bgColor` per draw
    - reused precomputed selected/non-selected color variants
  - Updated frame buffer clear calls to reuse memoized view background color.
- Validation:
  - Tests: `bun test src/core/__tests__/layout.test.ts src/core/__tests__/state.test.ts src/core/__tests__/usecases.test.ts src/core/__tests__/jj-api.test.ts` passed.
  - Build: `bun run scripts/build-tui.ts` passed.
  - Smoke benchmark: `bun run bench:tui --scenario S5_WINDOW_BOUNDARY_STRESS --warmup-runs 0 --measured-runs 1 --limit 200`.
- Results:
  - S5 smoke artifact written (`benchmarks/results/2026-02-11T00-42-44-358Z`).
  - Draw-path object churn reduced in the most frequent rendering component.
- Follow-ups:
  - Re-run idle PID sample after this pass to measure slope change.
  - If creep persists, instrument refresh/watch activity and optional idle GC guardrails.
- Status: `complete`

### [2026-02-10 03:30] Fix Set 11: instrumentation for idle memory creep root-cause analysis

- Context: User reported continued long-run idle growth and requested exact causality instead of guesswork.
- Actions performed:
  - Added runtime telemetry module `src/tui/telemetry.ts` for graph draw counters.
  - Wired graph draw reporting from `src/tui/components/GraphView.tsx`.
  - Added TUI runtime memory tracing in `src/tui/App.tsx` (env-gated):
    - `JUZU_MEM_TRACE=1`
    - `JUZU_MEM_TRACE_FILE=/tmp/juzu-mem-trace-<pid>.jsonl`
    - `JUZU_MEM_TRACE_INTERVAL_MS` (default 1000ms)
  - Trace includes:
    - process memory (`rss`, `heapUsed`, `heapTotal`, `external`, `arrayBuffers`)
    - app state sizes (nodes, files/diff cache entries and bytes)
    - graph draw activity (`drawCount`, `drawDelta`, visible rows/nodes)
    - operation counters (`ensureFiles`, `ensureDiff`, refresh expand/shrink, etc.)
    - timer/in-flight flags
  - Added analysis tool `scripts/bench/analyze-mem-trace.ts` and package command `bench:trace`.
  - Updated benchmark docs with trace workflow and command usage.
- Validation:
  - Build: `bun run scripts/build-tui.ts` passed.
  - Core tests: `bun test src/core/__tests__/layout.test.ts src/core/__tests__/state.test.ts src/core/__tests__/usecases.test.ts src/core/__tests__/jj-api.test.ts` passed.
- Follow-ups:
  - Capture one idle trace + matching PID sample and analyze with `bench:trace` to isolate whether creep is driven by redraws, cache growth, or backend refresh churn.
- Status: `complete`

### [2026-02-10 03:40] Live long-running PID confirmation (creep persists)

- Context: User requested immediate verification on long-lived idle process.
- Commands:
  - `ps -p 4048640 -o pid,ppid,comm,%mem,rss,vsz,etime,args`
  - `bun run bench:pid --pid 4048640 --duration-ms 10000 --interval-ms 250`
- Results:
  - Point-in-time RSS from `ps`: 427132 KB (~417 MB)
  - Short PID sample:
    - rss_peak_mb: 446.71
    - rss_steady_mb: 442.13
    - pss_peak_mb: 406.38
    - pss_steady_mb: 401.82
    - artifact: `benchmarks/results/pid/2026-02-11T00-57-13-584Z/PID-4048640.json`
- Conclusion:
  - Slow long-run creep is real and reproducible on idle process lifetime, and requires root-cause tracing (not further guesswork tuning).
- Status: `complete`

### [2026-02-10 03:50] Root-cause trace analysis + Fix Set 12 (watch-refresh churn throttling)

- Context: User provided fresh 120s PID sample and trace path mismatch was resolved by locating the generated trace file in `/tmp`.
- Trace analysis command:
  - `bun run bench:trace --trace-file /tmp/juzu-mem-trace-3115361.jsonl --pid-json benchmarks/results/pid/2026-02-11T01-04-48-956Z/PID-4156887.json`
- Key findings:
  - Internal trace RSS slope: `+22.67 MB/min` over ~415s.
  - `graph_busy_draw_pct: 100` (continuous redraw activity while "idle").
  - Counter deltas over same interval:
    - `refreshCalls: +577`
    - `ensureFilesCalls: +578`
  - Cache growth was not primary driver (`files_cache_bytes_delta: +73`, `diff_cache_bytes_delta: 0`).
  - Conclusion: idle creep is primarily driven by frequent watch-triggered refresh cycles and associated redraw/process churn, not diff/files cache accumulation.
- Actions performed:
  - Updated `src/tui/App.tsx` watch refresh path:
    - removed forced selected-commit `ensureFiles` call on every watch debounce
    - added minimum watch refresh interval `JUZU_TUI_WATCH_REFRESH_MIN_MS` (default `2500` ms)
  - Extended telemetry counters:
    - `watchEvents`
    - `watchRefreshSkipped`
  - Included new counters in mem-trace sample payload.
- Validation:
  - Tests: `bun test src/core/__tests__/layout.test.ts src/core/__tests__/state.test.ts src/core/__tests__/usecases.test.ts src/core/__tests__/jj-api.test.ts` passed.
  - Build: `bun run scripts/build-tui.ts` passed.
- Follow-ups:
  - Run new idle trace+PID sample to compare slopes and verify refresh counter reduction.
  - If redraw stays high despite reduced refresh events, investigate renderer invalidation loop boundaries.
- Status: `complete`

### [2026-02-10 04:00] Fix Set 13: restore selected-file watch updates without broad refresh churn

- Context: User reported file watch behavior regression: sidebar/files did not refresh until moving selection.
- Goal:
  - Keep memory-safe throttled watch behavior.
  - Restore immediate selected-commit file summary updates on watch events.
- Actions performed:
  - Updated `src/tui/App.tsx` `scheduleRefresh()`:
    - retained global watch refresh throttle (`JUZU_TUI_WATCH_REFRESH_MIN_MS`)
    - reintroduced targeted `ensureFiles(selected.changeId, 0)` for selected commit only
    - reset `_lastFilesChangeId` to force selected summary refresh
  - This avoids broad cache churn while restoring expected live-update UX.
- Validation:
  - Tests: `bun test src/core/__tests__/layout.test.ts src/core/__tests__/state.test.ts src/core/__tests__/usecases.test.ts src/core/__tests__/jj-api.test.ts` passed.
  - Build: `bun run scripts/build-tui.ts` passed.
- Status: `complete`

### [2026-02-10 04:10] Fix Set 14: configurable sidebar diff preview toggle (enabled locally)

- Context: User requested explicit config support to turn DiffU sidebar preview mode on and have it enabled.
- Actions performed:
  - Added runtime config key: `tui.sidebarDiffPreview` (`true | false`) in `src/core/runtime-config.ts`.
  - Added config parsing and clamping in `src/core/config-loader.ts`.
  - Added backward-compat mapping from legacy `sidebarDiffPreviewMode` and `prefetchDiffInLog` when boolean toggle is not explicitly set.
  - Added key to `config.example.toml`.
  - Updated TUI behavior:
    - `src/tui/App.tsx` now uses `sidebarDiffPreview` for log-mode inline diff auto-load decision.
    - `src/tui/components/Sidebar.tsx` now respects `sidebarDiffPreview` when rendering inline diff block.
  - Enabled mode in local config `/.juzu.local.toml`:
    - `sidebarDiffPreview = true`
- Validation:
  - Tests: `bun test src/core/__tests__/usecases.test.ts src/core/__tests__/layout.test.ts src/core/__tests__/state.test.ts src/core/__tests__/jj-api.test.ts` passed.
  - Build: `bun run scripts/build-tui.ts` passed.
- Status: `complete`
