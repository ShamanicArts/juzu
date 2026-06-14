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

`bench/results/rust-port/rust-tui-bench/2026-06-14T02-09-31-569Z/rust-tui-benchmark.html`

## Current headline

Current benchmark is for the Rust TUI after native `files()` hydration, lazy selected-node native `diff()` preview hydration, and the Pierre/JUZU-style structured diff sidebar renderer.

| Scenario | RSS peak | RSS steady median | PSS steady median | Header median |
| --- | ---: | ---: | ---: | ---: |
| `idle-mainline` | 10.94 MB | 10.71 MB | 8.96 MB | 131.64 ms |
| `navigate-mainline` | 35.81 MB | 35.79 MB | 34.03 MB | 131.32 ms |
| `layout-switching` | 34.66 MB | 33.95 MB | 32.20 MB | 130.78 ms |

The visual renderer itself keeps idle memory close to the earlier capped-diff baseline. Navigation/layout scenarios are heavier because selected-node diff hydration retains structured rows for large patches. The headline is still far below the old live Bun/OpenTUI TUI (~175 MB RSS steady), but this confirms the next performance task: keep the crafted renderer while avoiding large patch rows staying resident during navigation.

Use the HTML artifact as the source of truth for exact per-run values.

## Expected use going forward

Rerun this benchmark before/after:

- native `files()` hydration
- diff/sidebar rendering
- op log and obslog views
- merge/fork-heavy fixture graph rendering
- keymap/state parity additions
- any rendering hot path rewrite
