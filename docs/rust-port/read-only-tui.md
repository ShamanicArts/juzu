# Read-only Rust TUI

Date: 2026-06-13

## What landed

`crates/juzu-tui` is now a real Ratatui review surface instead of a scaffold print:

- opens repo through `juzu-jj` native backend
- computes graph coordinates through `juzu-core::layout`
- renders read-only commit graph with DAG connector glyphs
- renders selected-node details sidebar
- supports selection movement with `j/k` or arrow keys
- supports live layout mode switching with `1` through `5`
- quits with `q` or `Esc`

## Run command

```bash
cargo run -q -p juzu-tui -- --path /home/shamanic/dev/juzu --limit 30 --mode chronological
```

## tmux review

Session: `juzu`

Window: `rust-tui`

Attach:

```bash
tmux attach -t juzu
```

## Latest review artifact

`bench/results/rust-port/tui-review/2026-06-13T20-36-20-894Z/rust-tui-dag-review.html`

This is a static tmux capture converted into HTML. The live review surface is the tmux window.

## DAG presentation parity progress

The Rust TUI now mirrors more of old `GraphView`'s presentation model:

- four-line row rhythm per visible commit (`id`, description, files/status, spacer)
- edge rendering across the full graph, clipped into the viewport, so off-screen vertical lanes continue
- mainline-mode bus spans only across connected branch/merge lanes
- lane-colored graph glyphs and id text, with selected node/connection emphasis
- selected-row indicator behavior closer to old JUZU (`>` and working-copy `@` marker)

File rows now use native `files()` hydration through `juzu-jj` for committed changes. The old placeholder has been replaced with compact file summaries in graph rows and typed file lists in the details sidebar.

Diff preview now uses native `diff()` hydration through `juzu-jj` and a structured Pierre/JUZU-style TUI renderer instead of raw line coloring. The sidebar renders strong file section dividers, compact blue/purple hunk bands, dim aligned old/new gutters, tinted add/remove rows, and centered collapsed-context separators. In log mode the sidebar preview shows a visible diff row range plus pinned file/hunk context, supports `{ / }` previous/next hunk jumps, and keeps retained structured preview rows capped so navigation does not keep huge full patches resident.

The old Bun/OpenTUI full diff behavior is now covered by `parity:tui-modal` before implementation changes: `Ctrl+D` swaps the graph pane for a diff pane while keeping the details sidebar, `[ / ]` cycles files in diff mode, and `q`/`Esc`/`g`/`Ctrl+D` return to the log instead of quitting. This explicitly replaces the bad abandoned fullscreen attempt.

Working-copy dirty-file parity still needs the native snapshot path wired; current read-only `jj-lib` repo loading intentionally does not mutate/snapshot the working copy yet.

## Verification

```bash
cargo fmt --all
cargo test --workspace
cargo run -q -p juzu-tui -- --path /home/shamanic/dev/juzu --limit 30 --mode chronological
```

## Next expansion

- improve connector parity for off-screen edges and mainline bus behavior
- port old color/theme tokens
- add keyboard parity from old JUZU modes
- wire safe native working-copy snapshot support so `@` dirty files match old `jj diff --summary`
- continue Pierre/JUZU-style diff viewport UX: hunk/file jumping, sticky-ish file/hunk context, and exact patch-fidelity decisions
- hydrate sidebar description through native backend
