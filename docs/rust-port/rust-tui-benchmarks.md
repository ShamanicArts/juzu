# Rust TUI benchmarks

Date: 2026-06-13

## Purpose

Benchmark the current Rust/Ratatui JUZU graph surface as rendering gets more realistic. This complements the old Bun/OpenTUI baseline and should be rerun after meaningful TUI, sidebar, file, diff, or native-JJ operation slices.

## Runner

```bash
bun run bench:rust-tui -- --repo /home/shamanic/dev/juzu --limit 80 --runs 3
```

The runner:

- builds `juzu-tui` in release mode
- launches the release binary inside a PTY with a fixed terminal size
- captures startup-to-header timing
- samples `/proc/<pid>/smaps_rollup` for RSS/PSS/swap
- drives scripted key scenarios through the PTY
- writes JSON and HTML review artifacts

## Scenarios

- `idle-mainline` — steady-state render loop on mainline layout
- `navigate-mainline` — repeated `j/k` selection movement through DAG rows
- `layout-switching` — repeated `1-5` layout switches plus navigation

## Latest artifact

`bench/results/rust-port/rust-tui-bench/2026-06-14T04-12-18-527Z/rust-tui-benchmark.html`

## Current headline

Current benchmark is for the Rust TUI after native `files()` hydration, lazy selected-node native `diff()` preview hydration, the Pierre/JUZU-style structured diff sidebar renderer, the TDD-rebuilt old-style diff pane toggle, fixed diff navigation parity in both diff-pane and log/sidebar views, per-file retained diff row capping so later files render, old-style diff-mode footer/status hints, the Rust `--debug-state` modal state emitter, and old JUZU 60/40 pane split parity.

| Scenario | RSS peak | RSS steady median | PSS steady median | Header median |
| --- | ---: | ---: | ---: | ---: |
| `idle-mainline` | 10.80 MB | 10.77 MB | 9.02 MB | 159.25 ms |
| `navigate-mainline` | 29.20 MB | 28.93 MB | 27.17 MB | 141.82 ms |
| `layout-switching` | 28.94 MB | 28.72 MB | 26.97 MB | 139.78 ms |

The visual renderer itself keeps idle memory close to the earlier capped-diff baseline. Hard-capping retained structured preview rows dropped navigation peak RSS from 35.81 MB to 28.52 MB and layout-switching peak RSS from 34.66 MB to 28.02 MB while preserving the crafted sidebar preview. The headline remains far below the old live Bun/OpenTUI TUI (~175 MB RSS steady).

Use the HTML artifact as the source of truth for exact per-run values.

## Expected use going forward

Rerun this benchmark before/after:

- native `files()` hydration
- diff/sidebar rendering
- op log and obslog views
- merge/fork-heavy fixture graph rendering
- keymap/state parity additions
- any rendering hot path rewrite
