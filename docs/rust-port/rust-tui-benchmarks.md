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

`bench/results/rust-port/rust-tui-bench/2026-06-15T01-14-47-698Z/rust-tui-benchmark.html`

## Current headline

Current benchmark is for the Rust TUI after native `files()` hydration, lazy selected-node native `diff()` preview hydration, the Pierre/JUZU-style structured diff sidebar renderer, the TDD-rebuilt old-style diff pane toggle, fixed diff navigation parity in both diff-pane and log/sidebar views, per-file retained diff row capping so later files render, old-style diff-mode controls in the top status bar including `{/} Hunk`, Bun-like bottom footer info parity, the Rust `--debug-state` modal state emitter, old JUZU 60/40 pane split parity, width-variant modal parity coverage at 120/160/206 columns, selected diff-file marking/windowing in the sidebar, lazy uncapped full-row loading only for the active diff pane, diff-mode sidebar preview following the selected file, the full diff pane's bordered panel/title/viewport status surface with an updating `SCROLL` handle, diff-mode sidebar labeling as a secondary current-file preview, right-capped hunk bars, continuous `▌+` / `▌-` mutation bands for add/remove rows, an explicit full-width `STICKY ▸ ...` file/hunk context bar while scrolling, and debug-state assertions that `{` / `}` hunk jumps land on hunk headers with updated sticky context.

| Scenario | RSS peak | RSS steady median | PSS steady median | Header median |
| --- | ---: | ---: | ---: | ---: |
| `idle-mainline` | 11.07 MB | 10.82 MB | 9.07 MB | 138.53 ms |
| `navigate-mainline` | 42.66 MB | 42.37 MB | 40.62 MB | 143.97 ms |
| `layout-switching` | 42.96 MB | 42.57 MB | 40.81 MB | 138.53 ms |

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
