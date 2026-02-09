# Benchmarking Strategy for Memory and Scalability Work

## Purpose

This document defines how we measure memory, responsiveness, and correctness while implementing the memory program. Benchmarking is mandatory for each phase gate.

Scope for this program is TUI/core only. All benchmark tooling must be internal and CLI-driven.

## Benchmark Principles

1. Reproducibility over vanity numbers.
2. Comparable scenarios across phases.
3. Medians over single runs.
4. Separate correctness checks from performance checks.
5. Track both peak and steady-state memory.

## Metrics

## Core Metrics

- `rss_mb_peak`: peak resident memory.
- `rss_mb_steady`: median RSS after warmup stabilization.
- `heap_used_mb`: runtime heap usage if accessible.
- `pss_mb_peak`: peak proportional set size for process-tree sampling.
- `pss_mb_steady`: steady proportional set size for process-tree sampling.
- `refresh_ms`: end-to-end refresh duration.
- `nav_step_ms_p50/p95`: per-navigation latency.
- `indexed_nodes`: total indexed nodes in current graph model.
- `resident_nodes`: currently hydrated/resident nodes.
- `visible_nodes`: currently rendered nodes.

Notes:

- `bench:tui` is a deterministic CLI scenario harness over TUI/core logic.
- `bench:pid` measures real process-tree memory for a running TUI PID (recommended for total app footprint).

## Correctness Metrics (from benchmark harness)

- `edge_missing_count`: count of unresolved parent links in active view/index.
- `lane_discontinuity_count`: count of detected lane continuity breaks in scripted traversals.
- `pin_violation_count`: count of pinned node lane mismatches.
- `workflow_error_count`: scripted operation failures.

## Benchmark Scenarios

Use scenario IDs from `docs/memory-work/INVARIANTS.md`.

### S1_SMALL_REPO_BASELINE

- Load app against small repository.
- Run refresh and 200 navigation steps.
- Capture memory plateau and nav latency.

### S2_MEDIUM_REPO_HISTORY_SCAN

- Load medium repository.
- Traverse deep history via keyboard/scripted selection.
- Capture counts and continuity checks.

### S3_LARGE_REPO_LONG_SCROLL

- Load large repository with long traversal.
- Exercise resident window movement.
- Capture peak RSS and boundary correctness.

### S4_PINNING_STRESS

- Pin/unpin repeated across distributed commits.
- Refresh after each set and validate lane constraints.

### S5_WINDOW_BOUNDARY_STRESS

- Move viewport/selection repeatedly across chunk boundaries.
- Validate continuity and hydration/dehydration behavior.

### S6_OPLOG_OBSLOG_SMOKE

- Exercise operation log and obslog transitions under loaded graph.
- Validate no regressions in workflow and memory spikes.

## Data Capture Format

Each benchmark run should generate:

- JSON artifact: machine-readable detailed metrics.
- Markdown summary: human-readable report with deltas against baseline.

Proposed structure:

- `benchmarks/results/<timestamp>/<scenario>.json`
- `benchmarks/results/<timestamp>/SUMMARY.md`
- `benchmarks/baselines/<scenario>.json`

## Implemented Script Plan

## `scripts/bench/tui-memory.ts`

Responsibilities:

- Execute deterministic TUI/core scenario logic from CLI.
- Script navigation/pinning/oplog/obslog operations where possible.
- Sample process RSS at fixed intervals.
- Emit per-scenario JSON.

Inputs:

- repo path
- scenario id
- warmup duration
- sample interval ms
- step count

Outputs:

- metrics JSON + summary block.

## `scripts/bench/compare.ts`

Responsibilities:

- Compare latest run against baseline.
- Compute deltas, regression flags, and threshold breaches.
- Emit CLI summary and markdown report.

## `scripts/bench/pid-memory.ts`

Responsibilities:

- Attach to a running PID and sample memory from `/proc`.
- Optionally include full descendant process tree.
- Capture RSS, PSS, and swap over time.
- Emit JSON artifact with peaks and steady-state metrics.

## `scripts/bench/analyze-mem-trace.ts`

Responsibilities:

- Analyze internal TUI memory trace JSONL emitted by runtime instrumentation.
- Report slopes for RSS/heap inside process memory usage.
- Correlate draw activity and cache/counter growth.
- Optionally compare internal trace against `bench:pid` JSON.

## Proposed package scripts

- `bench:tui`
- `bench:pid`
- `bench:trace`
- `bench:compare`

## Primary Commands

- Run all scenarios: `bun run bench:tui --scenario all`
- Run one scenario: `bun run bench:tui --scenario S4_PINNING_STRESS`
- Write baselines: `bun run bench:tui --scenario all --write-baseline`
- Compare latest results vs baselines: `bun run bench:compare`
- Sample real TUI PID: `bun run bench:pid --pid <PID> --duration-ms 60000 --interval-ms 250`
- Analyze runtime trace: `bun run bench:trace --trace-file /tmp/juzu-mem-trace-<pid>.jsonl --pid-json benchmarks/results/pid/<run>/PID-<pid>.json`

## Runtime Trace Workflow (Idle Creep Root Cause)

1. Start TUI with trace env vars:
   - `JUZU_MEM_TRACE=1`
   - `JUZU_MEM_TRACE_FILE=/tmp/juzu-mem-trace-<pid>.jsonl`
   - optional `JUZU_MEM_TRACE_INTERVAL_MS=1000`
2. Reproduce idle or scroll scenario.
3. Run `bench:pid` for external process-level memory.
4. Run `bench:trace` to determine whether growth correlates with:
   - graph redraw activity (`graph_draw_delta`)
   - repeated refresh/load counters
   - cache byte growth

## Run Protocol

For each scenario:

1. Warmup run (ignored for final metrics).
2. Three measured runs.
3. Report median and range.

Do not compare one-off runs against baseline.

## Noise Control

- Use stable machine conditions where possible.
- Avoid unrelated heavy workloads during runs.
- Keep repository state fixed for baseline comparison.
- Record system context (CPU model, memory, OS, Bun version, date).

## Regression Thresholds (Initial)

These are initial defaults and can be tuned per scenario:

- `rss_mb_peak`: no more than +10% regression unless approved.
- `rss_mb_steady`: no more than +8% regression unless approved.
- `pss_mb_peak`: no more than +10% regression unless approved.
- `pss_mb_steady`: no more than +8% regression unless approved.
- `nav_step_ms_p95`: no more than +15% regression unless approved.
- correctness metrics (`edge_missing_count`, `pin_violation_count`): must remain zero for passing scenarios.

## Phase Gate Benchmark Requirements

- Phase 0: establish baseline and verify harness output.
- Phase 1: rerun S1, S2, S6.
- Phase 2: rerun S1, S2, S4, S6.
- Phase 3: rerun all scenarios S1-S6.
- Phase 4: rerun S2, S3, S5 plus targeted streaming scenario.

## Reporting Requirements

Every benchmark report should include:

- commit hash / branch
- scenario id
- run timestamp
- command used
- summary metrics table
- pass/fail against thresholds
- notes on anomalies

Summaries must be linked in `docs/memory-work/WORKLOG.md`.

## Open Questions (To Resolve During Implementation)

1. Best internal method for repeatable RSS/heap sampling in Bun for long-running TUI scenarios.
2. Best approach to script deterministic TUI navigation and pinning sequences from CLI.
3. Whether to include optional CPU profile snapshots in heavy scenarios.

## Out-of-Scope for This Benchmark Program

- Playwright/browser automation.
- Web simulation harnesses.
- Web-only rendering metrics not needed for TUI/core decisions.
