# Session Protocol for Cross-Context Implementation

## Purpose

This protocol ensures continuity and accountability when implementation spans many contexts/sessions.

Follow this protocol at the start and end of every work session.

Program scope: TUI and core internals first. Web automation/simulation is out of scope for current phases.

## Session Start Checklist (Mandatory)

1. Read these artifacts in order:
   - `docs/memory-work/PLAN.md`
   - `docs/memory-work/INVARIANTS.md`
   - `docs/memory-work/BENCHMARKING.md`
   - `docs/memory-work/WORKLOG.md` (latest entries first)
2. Confirm current phase and phase gate criteria.
3. Confirm approved scope for this session.
4. Identify invariants at risk for proposed edits.
5. Add a `planned` entry to `WORKLOG.md` before coding.

## Session Execution Rules

1. Small, reviewable diffs only.
2. Keep changes within approved scope.
3. Update `WORKLOG.md` as steps complete.
4. If scope must change, pause and document before proceeding.
5. If a blocker or regression appears, document immediately with severity.

## Session End Checklist (Mandatory)

1. Record completed changes in `WORKLOG.md`.
2. Record tests run and benchmark scenarios executed.
3. Record key metrics and pass/fail against thresholds.
4. Record open issues and proposed next tasks.
5. Mark session status (`complete` or `blocked`).

## Approval Gate Protocol

Before each substantial coding step, provide:

- exact files to change
- intended behavior change
- invariants potentially affected
- tests/benchmarks to run
- rollback strategy

Do not proceed until explicit approval is received.

When preparing proposals, keep benchmark and validation methods CLI-internal.

## Regression Handling Protocol

When a regression is found:

1. Assign severity (`blocker`, `major`, `minor`, `info`).
2. Record reproduction steps.
3. Record suspected cause and impacted files.
4. Stop phase completion if severity is `blocker` or `major`.
5. Propose fix plan and verification strategy before coding fix.

## Benchmark Discipline Protocol

1. Run warmup before measured runs.
2. Collect at least three measured runs for comparison scenarios.
3. Report medians and ranges.
4. Record environment details.
5. Link generated benchmark artifacts in `WORKLOG.md`.

## Artifact Maintenance Protocol

- `PLAN.md`: update for phase scope or strategy changes.
- `INVARIANTS.md`: update when behavior contracts evolve.
- `BENCHMARKING.md`: update when scripts/metrics/scenarios evolve.
- `WORKLOG.md`: append-only execution log.

## Ownership Standard

The implementation owner is responsible for:

- preserving product intent (pinning, correctness, usability)
- proving improvements with benchmarks
- documenting decisions and trade-offs
- maintaining continuity across contexts without hidden assumptions
