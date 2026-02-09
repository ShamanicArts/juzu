# Memory Program Invariants and Test Matrix

## Purpose

This document defines the behavior that must not regress while memory and scalability work is implemented.

Every implementation phase must explicitly verify these invariants and record outcomes in `docs/memory-work/WORKLOG.md`.

## Invariant Categories

## A. Graph Semantics

1. Parent-child topology remains correct for all loaded/indexed nodes.
2. No node is silently dropped due to implicit limits.
3. Lane continuity is stable across refreshes and mode changes.
4. Merge and fork visualization remains coherent when traversing large ranges.
5. Revset filtering preserves logical correctness and does not corrupt base graph state.

## B. Pinning Guarantees

1. Pinning is preserved as a product feature in TUI and core logic.
2. A pinned node stays in its pinned lane unless explicitly unpinned.
3. Pin/unpin does not induce full-graph instability outside impacted region.
4. Pinning behavior is deterministic across repeated refresh with same inputs.
5. Drag-to-pin and context-menu pin workflows keep parity with keyboard/API-driven pinning.

## C. Windowing and Residency Guarantees

1. Resident window caps must never imply permanent node loss.
2. Traversal can eventually reach all indexed nodes.
3. Boundary transitions do not create lane resets or topological artifacts.
4. Eviction/dehydration only affects heavy metadata, not core topology integrity.
5. UI counters accurately report indexed, resident, and visible nodes.

## D. Workflow Guarantees

1. Refresh still refreshes expected state.
2. Selection, multi-selection, and navigation remain intact.
3. File summary and diff hydration remain correct and recoverable after eviction.
4. Op log and obslog behavior remain intact.
5. Mutation flows (rebase/new/edit/describe/undo/redo/etc.) remain intact.

## E. Performance and Resource Guarantees

1. Phase changes must not introduce major latency regressions in navigation.
2. Memory footprint should improve or remain neutral against baseline for targeted scenarios.
3. Transient allocations should trend downward in hot paths.
4. Benchmark runs remain reproducible.

## Validation Matrix (TUI-First)

Each row below represents a required validation class. Add concrete test IDs as they are implemented.

| Validation Class | TUI | Core | Web | Automated | Manual | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Graph topology sanity | required | required | deferred | yes | optional | parent IDs, edge consistency |
| Lane continuity across refresh | required | required | deferred | yes | optional | compare snapshots |
| Pinning deterministic behavior | required | required | deferred | yes | optional | pin/unpin/refresh cycles |
| Boundary transition continuity | required | required | deferred | yes | yes | only when windowing enabled |
| Full traversal from head to deep history | required | required | deferred | partial | required | confirms no hidden truncation |
| Navigation latency checks | required | required | deferred | yes | optional | benchmark thresholds |
| Memory plateau checks | required | required | deferred | yes | optional | benchmark scenarios |
| Workflow smoke tests | required | required | deferred | yes | optional | op flows + describe + diff |

## Scenario Definitions

Define benchmark and validation scenarios with fixed names to make logs comparable:

- `S1_SMALL_REPO_BASELINE`
- `S2_MEDIUM_REPO_HISTORY_SCAN`
- `S3_LARGE_REPO_LONG_SCROLL`
- `S4_PINNING_STRESS`
- `S5_WINDOW_BOUNDARY_STRESS`
- `S6_OPLOG_OBSLOG_SMOKE`

Each scenario should specify:

- Repository identity and revision constraints.
- Runtime (TUI in this program).
- Action script (load, navigate, pin/unpin, switch views).
- Metrics captured.

## Regression Severity Levels

- `blocker`: breaks topology, pinning guarantees, or traversal semantics.
- `major`: breaks key workflows or introduces severe memory/latency regressions.
- `minor`: non-critical behavior mismatch or small benchmark regression outside target flows.
- `info`: observations without immediate action required.

Any `blocker` or `major` regression halts phase completion.

## Decision Rules

1. If correctness and performance conflict, correctness wins; performance fix is redesigned.
2. If a change improves memory but harms pinning semantics, reject and redesign.
3. If a benchmark is noisy, rerun with standardized warmup before conclusions.
4. If behavior differs in deferred web paths, note it but do not expand scope without explicit approval.

## Change Proposal Checklist (Must Be Filled Before Coding)

- Problem statement and expected impact.
- Files targeted.
- Invariants at risk.
- Proposed test coverage.
- Benchmark scenarios to rerun.
- Rollback approach.

## Completion Checklist (Must Be Filled After Coding)

- Invariants verified:
  - Graph semantics
  - Pinning guarantees
  - Window/residency guarantees
  - Workflow guarantees
- Tests run and outcomes recorded.
- Benchmarks run and deltas recorded.
- Follow-up tasks captured in `WORKLOG.md` and `PLAN.md`.
