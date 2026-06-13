# JUZU Rust Port Baseline Benchmarks

Date: 2026-06-13

## Scope

This is the pre-port baseline for old Bun/OpenTUI/Solid JUZU. It is the thing the Rust port needs to beat while preserving behavior.

No Rust port code was written for this artifact.

## Environment

- Project: `/home/shamanic/dev/juzu`
- Bun: `1.3.14-canary.1 (0d9b296a)`
- VCS: JJ working copy on top of `8c80c1b3 optimize TUI memory residency and add trace-guided diagnostics`
- Primary review surface: tmux session `juzu`, window `tui`
- Benchmark output root: `bench/results/rust-port/`

## Validation status

Command:

```bash
bun test
```

Result: **failed, existing baseline drift**

- 40 tests passed
- 3 tests failed/error

Failures:

1. `src/core/__tests__/tui-keymap.test.ts` still expects old `ctrl+x` action leader, but source defaults now use categorized leaders:
   - `ctrl+a` actions
   - `ctrl+o` operations
   - `ctrl+v` view
   - `ctrl+b` bookmarks
2. `src/tui/__tests__/compile.test.ts` errors on missing `react/jsx-dev-runtime` from `src/tui/App.tsx` during test compile.

Baseline implication: the Rust parity harness must not blindly inherit stale test expectations. First oracle work should decide whether current source behavior or old tests are authoritative for each key path.

## Core/TUI scenario benchmark

Tool:

```bash
bun run bench:tui --repo <repo> --scenario S1_SMALL_REPO_BASELINE \
  --warmup-runs 0 --measured-runs 1 --limit 200 \
  --sample-interval-ms 100 --output-root bench/results/rust-port
```

| Repo | JJ nodes | Result path | RSS peak | RSS steady | Refresh p50 | Nav p95 | Correctness errors |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| tiny fixture `/tmp/juzu-rust-port-tiny` | 2 | `bench/results/rust-port/2026-06-13T19-19-49-767Z/SUMMARY.md` | 61.77 MB | 61.77 MB | 33.17 ms | 0 ms | 0 |
| `/home/shamanic/dev/md-editor-rust` | 37 | `bench/results/rust-port/2026-06-13T19-19-49-849Z/SUMMARY.md` | 63.14 MB | 63.14 MB | 49.38 ms | 0 ms | 0 |
| `/home/shamanic/dev/juzu` | 114 | `bench/results/rust-port/2026-06-13T19-19-43-157Z/SUMMARY.md` | 65.90 MB | 65.90 MB | 62.97 ms | 0 ms | 0 |

Notes:

- This benchmark exercises core/TUI state and layout logic in-process, not the total interactive OpenTUI process tree.
- It is still useful for layout/usecase parity and regression guardrails.
- No large fixture was available in this pass. Add a large repo fixture or canonical external repo before Phase 14.

## Live process-tree RSS baseline

### Interactive TUI

Started in tmux:

```bash
tmux attach -t juzu
# window: tui
# command: cd /home/shamanic/dev/juzu && bun run cli.ts --tui
```

Sample command:

```bash
bun run bench:pid --pid 1426419 --duration-ms 5000 --interval-ms 250 \
  --output-root bench/results/rust-port/pid
```

Artifact:

`bench/results/rust-port/pid/2026-06-13T19-20-16-494Z/PID-1426419.json`

Result:

| Surface | RSS peak | RSS steady | PSS peak | PSS steady | Avg PID count |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bun/OpenTUI/Solid TUI | 179.27 MB | 175.37 MB | 99.04 MB | 94.99 MB | 2 |

### Web server

Started in tmux:

```bash
# session: juzu, window: web
cd /home/shamanic/dev/juzu && bun run server.ts --port=3997
```

Sample command:

```bash
bun run bench:pid --pid 1427505 --duration-ms 5000 --interval-ms 250 \
  --output-root bench/results/rust-port/pid
```

Artifact:

`bench/results/rust-port/pid/2026-06-13T19-20-31-151Z/PID-1427505.json`

Result:

| Surface | RSS peak | RSS steady | PSS peak | PSS steady | Avg PID count |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bun web server | 88.66 MB | 88.53 MB | 44.90 MB | 44.77 MB | 1 |

## Startup timing baseline

Tool:

```bash
bun run bench:startup --runs 3 --timeout-ms 8000 \
  --output-root bench/results/rust-port/startup
```

Artifact:

`bench/results/rust-port/startup/2026-06-13T19-37-42-909Z/SUMMARY.md`

Readiness definitions:

- Web `stdoutReadyMs`: `server.ts` printed the Bun server ready line.
- Web `httpReadyMs`: `/api/repo` returned HTTP 200 JSON.
- TUI `firstBytesMs`: terminal capture emitted first bytes beyond the `script(1)` header.
- TUI `alternateScreenMs`: OpenTUI entered the alternate screen.
- TUI `firstHeaderTokenMs`: captured rendered JUZU header token (`LOG`, `OPLOG`, or `JUZU`).

| Surface | Metric | Min | Median | Max | OK runs |
| --- | --- | ---: | ---: | ---: | ---: |
| Web | first stdout | 257 ms | 260 ms | 279 ms | 3/3 |
| Web | server stdout ready | 274 ms | 277 ms | 296 ms | 3/3 |
| Web | `/api/repo` ready | 288 ms | 300 ms | 314 ms | 3/3 |
| TUI | first terminal bytes | 285 ms | 286 ms | 290 ms | 3/3 |
| TUI | alternate screen entered | 285 ms | 286 ms | 290 ms | 3/3 |
| TUI | first rendered header token | 328 ms | 328 ms | 332 ms | 3/3 |

Baseline implication: the Rust port should initially beat ~328 ms to first TUI header and ~300 ms to web `/api/repo` readiness while keeping behavior parity.

## Current headline baseline

The Rust port should initially target these as “must beat” numbers:

| Metric | Old JUZU baseline |
| --- | ---: |
| Core/TUI scenario RSS steady on JUZU repo | ~65.90 MB |
| Live interactive TUI process-tree RSS steady | ~175.37 MB |
| Live web server RSS steady | ~88.53 MB |
| TUI startup to first rendered header median | ~328 ms |
| Web startup to `/api/repo` ready median | ~300 ms |

The more meaningful comparison for a Ratatui port is the live TUI process-tree number. The core/TUI scenario number is a lower-level regression guardrail.

## Artifacts generated

- `bench/results/rust-port/2026-06-13T19-19-43-157Z/S1_SMALL_REPO_BASELINE.json`
- `bench/results/rust-port/2026-06-13T19-19-43-157Z/SUMMARY.md`
- `bench/results/rust-port/2026-06-13T19-19-49-767Z/S1_SMALL_REPO_BASELINE.json`
- `bench/results/rust-port/2026-06-13T19-19-49-767Z/SUMMARY.md`
- `bench/results/rust-port/2026-06-13T19-19-49-849Z/S1_SMALL_REPO_BASELINE.json`
- `bench/results/rust-port/2026-06-13T19-19-49-849Z/SUMMARY.md`
- `bench/results/rust-port/pid/2026-06-13T19-20-16-494Z/PID-1426419.json`
- `bench/results/rust-port/pid/2026-06-13T19-20-31-151Z/PID-1427505.json`
- `bench/results/rust-port/startup/2026-06-13T19-37-42-909Z/startup-baseline.json`
- `bench/results/rust-port/startup/2026-06-13T19-37-42-909Z/SUMMARY.md`
- `bench/results/rust-port/startup/2026-06-13T19-37-42-909Z/tui-run-*.typescript.log`

## Review surface

Current old-JUZU review surface is running in tmux:

```bash
tmux attach -t juzu
```

Windows:

- `tui`: old JUZU TUI pointed at `/home/shamanic/dev/juzu`
- `web`: old JUZU web server on port `3997`

## Next benchmark work

1. Add one canonical large repo fixture.
2. Add oracle snapshot commands in old JUZU:
   - `snapshot`
   - `layout`
   - `sidebar`
   - `state-after-keys`
3. Re-run baseline once stale tests/keymap expectations are resolved or explicitly accepted.
