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

`bench/results/rust-port/rust-tui-bench/2026-06-13T21-26-58-408Z/rust-tui-benchmark.html`

## Current headline

Current benchmark is for the Rust TUI after native `files()` hydration plus lazy selected-node native `diff()` hydration in the details sidebar.

| Scenario | RSS peak | RSS steady median | PSS steady median | Header median |
| --- | ---: | ---: | ---: | ---: |
| `idle-mainline` | 11.89 MB | 11.86 MB | 10.12 MB | 130.96 ms |
| `navigate-mainline` | 17.31 MB | 17.31 MB | 15.52 MB | 134.43 ms |
| `layout-switching` | 17.20 MB | 16.99 MB | 15.24 MB | 130.43 ms |

A first eager-diff attempt pushed header time to ~350 ms; this was a bad direction, so diff hydration was changed to lazy/on-select. Header latency is back near the files-only range while navigation scenarios show the cost of loading large selected diffs. Next optimization target: cap/cache sidebar diff previews and/or background hydrate without blocking key handling.

Use the HTML artifact as the source of truth for exact per-run values.

## Expected use going forward

Rerun this benchmark before/after:

- native `files()` hydration
- diff/sidebar rendering
- op log and obslog views
- merge/fork-heavy fixture graph rendering
- keymap/state parity additions
- any rendering hot path rewrite
