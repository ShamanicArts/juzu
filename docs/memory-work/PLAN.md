# Juzu Memory and Correctness Program Plan

## Purpose

This plan defines a review-first, benchmark-driven implementation program to:

1. Fix node completeness issues (no silent truncation or broken traversal).
2. Reduce memory usage and allocation churn with TUI-first priorities.
3. Preserve and strengthen core product behavior: pinning, layout continuity, and operation workflows.
4. Maintain a durable artifact trail that survives many implementation contexts.
5. Build internal CLI-driven benchmark tools that guide implementation and guard against regressions.

This is a living document. Every meaningful decision must be reflected here and cross-referenced in `docs/memory-work/WORKLOG.md`.

## Non-Negotiable Constraints

- Pinning remains a first-class feature. We optimize implementation, not remove capability.
- Layout continuity must remain valid across chunk/window boundaries.
- Any cap is for active/resident rendering, not hidden data loss.
- The user must always be able to traverse full history over time.
- Benchmarks and correctness checks are required for each phase before completion.

## Current Observations (Code-Grounded)

The following observations describe the current constraints and bottlenecks in this repository. Focus is TUI/core first; web observations are recorded for later alignment only:

- Limit-related behavior currently exists in multiple places (`src/tui/App.tsx`, `src/core/usecases.ts`, `server.ts`, plus web paths) and can hide graph completeness.
- Core refresh fingerprinting currently builds large concatenated strings (`src/core/usecases.ts`), creating avoidable churn.
- Layout currently performs full-node copy/mutation flows and may do extra layout work when pinned nodes are present (`src/core/state.ts`, `src/core/layout.ts`).
- Hot rendering loops still include repeated lookup patterns that can degrade with larger graphs (`src/tui/components/GraphView.tsx` and core helpers in `src/core/layout.ts`).

## Program Outcomes

By the end of this program, the application should provide:

- Transparent completeness: user can see indexed vs resident vs visible counts.
- Stable traversal: no missing nodes due to silent truncation or broken chunk transitions.
- Lower memory footprint: significantly reduced steady-state RSS and reduced peak transient allocations.
- Lower churn: fewer full-array/object recreations and fewer large string allocations.
- Benchmark discipline: repeatable tooling and comparable outputs per phase.

## Phase Structure

### Phase 0 - Benchmark and Artifact Foundation (Mandatory First)

#### Goals

- Establish reproducible performance and correctness measurement harnesses.
- Establish durable planning/logging artifacts for cross-context continuity.

#### Deliverables

- Documentation artifacts:
  - `docs/memory-work/PLAN.md` (this file)
  - `docs/memory-work/INVARIANTS.md`
  - `docs/memory-work/BENCHMARKING.md`
  - `docs/memory-work/WORKLOG.md`
  - `docs/memory-work/SESSION_PROTOCOL.md`
- Benchmark scripts and runners (to be implemented after approval):
  - `scripts/bench/tui-memory.ts`
  - `scripts/bench/compare.ts`
- Package commands (to be added after approval):
  - `bun run bench:tui`
  - `bun run bench:compare`

#### Exit Criteria

- Baseline metrics captured for target repositories/scenarios.
- Benchmark invocation and output format documented and verified.

### Phase 1 - Completeness and Limit Policy

#### Goals

- Eliminate hidden truncation semantics.
- Ensure graph completeness policy is explicit and visible.

#### Candidate Changes

- Centralize log limit policy in core/runtime config.
- Replace hard-coded limits with explicit mode:
  - `complete` mode (default for correctness work)
  - optional `windowed` mode with explicit counters and hydration rules.
- Ensure status/UI surfaces:
  - indexed node count
  - resident node count
  - visible node count

#### Potential Files

- `src/core/usecases.ts`
- `src/core/runtime-config.ts`
- `src/tui/App.tsx`
- `server.ts`

#### Exit Criteria

- No silent node loss from default flows.
- Completeness counters visible in TUI.
- Existing workflows still functional (refresh, navigation, revset filtering, operations).

### Phase 2 - Allocation and Layout Churn Reduction

#### Goals

- Reduce unnecessary large allocations and repeated full-graph passes.
- Preserve pinning behavior with a more memory-disciplined implementation.

#### Candidate Changes

- Replace large string fingerprinting with numeric hash/fingerprint approach.
- Remove extra layout pass patterns tied to pinning implementation.
- Refactor lookup-heavy loops to index maps where needed.
- Keep layout output deterministic and compatible with existing renderers.

#### Potential Files

- `src/core/usecases.ts`
- `src/core/state.ts`
- `src/core/layout.ts`
- `src/tui/components/GraphView.tsx`

#### Exit Criteria

- Memory and latency benchmarks show improvement from Phase 1 baseline.
- Pinning regression suite passes.
- Layout snapshot/behavior tests pass.

### Phase 3 - Windowed Residency without Semantic Loss

#### Goals

- Introduce bounded resident/render window while preserving full graph traversal semantics.
- Keep topology/layout continuity across chunk boundaries.

#### Candidate Changes

- Introduce graph index vs resident payload separation in core state.
- Add hydrate/dehydrate policy for heavy node fields.
- Add boundary-aware layout support for partially resident ranges.
- Integrate resident window movement with keyboard and pointer navigation.

#### Potential Files

- `src/core/types.ts`
- `src/core/state.ts`
- `src/core/layout.ts`
- `src/core/usecases.ts`
- `src/tui/components/GraphView.tsx`

#### Exit Criteria

- Explicit window counters shown and accurate.
- No lane resets/artifacts at window boundaries.
- Scrolling/navigation can traverse the full indexed graph.
- Benchmark gains demonstrated against prior phase.

### Phase 4 - Optional Transport Streaming Upgrade

#### Goals

- Add streaming ingest path to further reduce peak memory and improve responsiveness on huge repos.

#### Notes

- This phase is optional and should only proceed once Phases 1-3 are stable and benchmarked.
- This phase does not supersede earlier memory wins; it layers on top.

#### Candidate Changes

- Introduce stream-based log ingestion path in `src/core/jj-api.ts`.
- Add parser invariants and fallback behavior.
- Integrate with index/residency model from Phase 3.

#### Exit Criteria

- Streaming path benchmarked and validated.
- No correctness regressions in operation workflows and layout continuity.

## Correctness Gates (All Phases)

Each phase must satisfy all gates below:

1. Graph correctness:
   - parent-child continuity preserved
   - lane assignment stable under repeated refresh
   - pinned nodes remain pinned and deterministic
2. Workflow integrity:
   - refresh, selection, undo/redo, op log, obslog, describe, and file/diff flows remain functional
3. Platform scope discipline:
   - TUI and core behavior are primary gates in this program
   - web alignment is deferred and explicitly planned later
4. Benchmark evidence:
   - before/after metrics committed to `WORKLOG.md`
5. Reviewability:
   - planned edits listed before implementation
   - implementation summary recorded after implementation

## Execution Rhythm Per Change Set

For each approved change set:

1. Record intent in `WORKLOG.md` (pre-change entry).
2. Implement the smallest coherent diff.
3. Run relevant tests and benchmarks.
4. Record results and observations in `WORKLOG.md` (post-change entry).
5. Update this plan if scope or assumptions changed.

## Risks and Mitigations

- Risk: windowing introduces layout discontinuities.
  - Mitigation: boundary invariants, snapshot tests, visible boundary diagnostics.
- Risk: pinning regressions during layout refactor.
  - Mitigation: dedicated pinning test suite and deterministic lane assertions.
- Risk: benchmark noise masks real regressions.
  - Mitigation: standardized warmup, multiple runs, median reporting.
- Risk: complexity creep.
  - Mitigation: phase gating, small diffs, explicit rollback strategy per phase.

## Rollback Strategy

- Every phase should be decomposed into revertable commits.
- Keep behavior flags where practical to isolate new paths.
- If correctness gate fails, revert phase-specific commits and document failure mode in `WORKLOG.md`.

## Immediate Next Approved Actions

1. Execute baseline benchmark runs with the implemented CLI tooling.
2. Record baseline artifacts and key metrics in `docs/memory-work/WORKLOG.md`.
3. Capture real TUI process-tree memory baselines via PID sampling (`bench:pid`).
4. Propose Phase 1 code-change diff plan with benchmark guardrails.

## Deferred Scope (Do Not Execute In This Program Yet)

- Browser automation, Playwright-based simulation, and web benchmark harnesses.
- Web-specific optimization tasks that are not required for TUI/core correctness and memory targets.
- GUI packaging work (Tauri/Electron) beyond preserving core compatibility for future adoption.
