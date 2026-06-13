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

File rows currently show an explicit native-hydration placeholder. The next backend slice should replace that placeholder with real `files()` data.

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
- hydrate sidebar files/diff/description through native backend
