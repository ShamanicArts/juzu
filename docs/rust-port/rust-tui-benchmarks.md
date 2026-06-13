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

`bench/results/rust-port/rust-tui-bench/2026-06-13T21-37-33-315Z/rust-tui-benchmark.html`

## Current headline

Current benchmark is for the Rust TUI after native `files()` hydration plus lazy selected-node native `diff()` preview hydration capped to 90 lines in the details sidebar.

| Scenario | RSS peak | RSS steady median | PSS steady median | Header median |
| --- | ---: | ---: | ---: | ---: |
| `idle-mainline` | 11.36 MB | 11.27 MB | 9.53 MB | 129.36 ms |
| `navigate-mainline` | 12.24 MB | 12.12 MB | 10.35 MB | 126.53 ms |
| `layout-switching` | 12.29 MB | 12.08 MB | 10.31 MB | 127.70 ms |

A first eager-diff attempt pushed header time to ~350 ms; changing diff hydration to lazy/on-select brought header latency back near the files-only range. Capping cached sidebar previews then cut navigation peak RSS from ~17.31 MB to ~12.24 MB while preserving full `juzu-cli diff` for parity and future full-diff surfaces.

Use the HTML artifact as the source of truth for exact per-run values.

## Expected use going forward

Rerun this benchmark before/after:

- native `files()` hydration
- diff/sidebar rendering
- op log and obslog views
- merge/fork-heavy fixture graph rendering
- keymap/state parity additions
- any rendering hot path rewrite
