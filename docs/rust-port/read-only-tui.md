# Read-only Rust TUI

Date: 2026-06-13

## What landed

`crates/juzu-tui` is now a real Ratatui review surface instead of a scaffold print:

- opens repo through `juzu-jj` native backend
- computes graph coordinates through `juzu-core::layout`
- renders read-only commit graph table
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

`bench/results/rust-port/tui-review/2026-06-13T20-23-11-384Z/rust-tui-review.html`

This is a static tmux capture converted into HTML. The live review surface is the tmux window.

## Verification

```bash
cargo fmt --all
cargo test --workspace
cargo run -q -p juzu-tui -- --path /home/shamanic/dev/juzu --limit 30 --mode chronological
```

## Next expansion

- render actual connector lines instead of indentation-only lane hints
- port old color/theme tokens
- add keyboard parity from old JUZU modes
- hydrate sidebar files/diff/description through native backend
