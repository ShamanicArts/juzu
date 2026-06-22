# Rust TUI benchmarks

Date: 2026-06-13

## Purpose

Benchmark the current Rust/Ratatui JUZU graph surface as rendering gets more realistic. This complements the old Bun/OpenTUI baseline and should be rerun after meaningful TUI, sidebar, file, diff, or native-JJ operation slices.

Benchmark runs intentionally pass smaller explicit `--limit` values. The product Rust TUI default is `500`, matching original JUZU scale; benchmark limits must not leak back into app defaults.

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

`bench/results/rust-port/rust-tui-bench/2026-06-22T15-36-40-706Z/rust-tui-benchmark.html`

## Current headline

Current benchmark is for the Rust TUI after native `files()` hydration, lazy selected-node native `diff()` preview hydration, structured diff rendering, old-style diff pane navigation, View leader behavior, bundled themes, runtime theme wiring, selected-row polish, the first Bun-smooth chrome correction, the optional boxed-chrome toggle, Bun/OpenTUI-style status segment color mixing, the first FooterBar layer split pass, the Bun-style details sidebar rhythm pass, Bun-like sidebar file-row truncation, the first Bun `DiffView.tsx` color-palette pass, Bun-style unified diff gutter ordering, the full diff-pane scaffold removal pass, full-pane char wrapping for long code rows with shared large line-number gutters, opt-in diff scaffold mode via `--diff-scaffold` or `Ctrl+V`, then `s` (with legacy `Ctrl+L` hidden as compatibility), the Bun-parity diff-mode sidebar pass that hides Rust-only inline diff preview chrome from the full diff review surface, the Bun diff-status chrome pass that switches the visible controls to `[] File` and `escape Exit` while removing the Rust-only visible hunk hint from the top bar, the diff-scroll overshoot fix that clamps full-pane scroll state back to the visible viewport so one upward move from bottom immediately reveals earlier rows again, the broader revset parity slice that now parses native JJ revsets in the Rust backend and refreshes the live TUI log when the revset prompt is submitted, the richer read-only Ops leader slice that opens OpLog/Obslog views through explicit `juzu-jj` CLI fallback queries while rendering old-compatible durations, args tags, operation metadata, and sidebar detail blocks instead of the earlier thin placeholders, the OpLog restore parity slice where `r` / `Enter` now issue a real fallback `jj op restore`, reload the log, and refresh the OpLog view instead of doing nothing, the Bookmarks leader slice where `Ctrl+B`, then `s` / `d` now issue real fallback `jj bookmark set` / `jj bookmark delete` mutations and immediately reload footer/sidebar/graph bookmark state, the Ops mutation slice where `Ctrl+O`, then `u` / `r` now issue real fallback `jj undo` / `jj redo` mutations and immediately reload the visible log, and the new Actions leader slice where `Ctrl+A`, then `n` / `e` / `a` / `s` / `y` now issues real fallback `jj new` / `jj edit` / `jj abandon` / `jj squash` / `jj duplicate` mutations while the visible idle strip matches Bun's `^A Act  ^O Ops  ^V View  ^B Book` trigger contract. Ops leader now lands the remaining obvious remote actions too: `Ctrl+O`, then `f` / `p` issues real fallback `jj git fetch` / `jj git push` mutations, reloads the visible log, and is covered by dedicated temp-remote proof artifacts instead of fake chrome. Actions leader now covers the low-risk text mutation too: `Ctrl+A`, then `d` opens an inline describe prompt, accepts text edits, and commits a real fallback `jj describe -r <change> -m ...` on `Enter` instead of leaving describe as dead chrome. Graph/details/diff borders remain disabled by default, status/footer bars consume only their needed rows, the footer separates repo/bookmark/wc/layout/node-count like Bun, file rows cap to pane width with ellipsis instead of overflowing, diff add/remove rows use the same `mix(slate.bg0, semantic.fileAdd/fileDel, 0.48)` background formula as the Bun `<diff>` component, diff code rows now show a compact active line-number gutter followed by the padded +/- sign before content, sidebar preview gutters share the widest visible line-number width for the selected file, code-content backgrounds fill the remaining row width like Bun `<diff>`, the full diff pane hides Rust-only `VIEWPORT`/`STICKY`/file-header/hunk-bar scaffold rows by default so it starts with Bun-style code rows under the title, keeps `\\ No newline at end of file` markers visible as code-stream rows, long full-pane code rows wrap in char mode with continuation lines aligned under content using one shared gutter width even when line numbers expand beyond three digits, diff mode leaves the right pane focused on details/files instead of a second Rust-only inline preview, revset submit now genuinely rehydrates the visible node list instead of only storing draft text, and the visible Actions/Ops/Bookmarks leaders no longer dead-end in the Rust port.

| Scenario | RSS peak | RSS steady median | PSS steady median | Header median |
| --- | ---: | ---: | ---: | ---: |
| `idle-mainline` | 12.32 MB | 12.25 MB | 9.95 MB | 174.74 ms |
| `navigate-mainline` | 79.96 MB | 79.30 MB | 76.96 MB | 164.79 ms |
| `layout-switching` | 64.84 MB | 61.37 MB | 59.03 MB | 161.99 ms |

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
