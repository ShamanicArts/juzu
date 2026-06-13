# Layout Parity

Date: 2026-06-13

## What landed

Rust `juzu-core` now owns a port of the old JUZU graph layout algorithm:

- chronological
- mainline
- bookmark-centric
- wc-focused
- topological

The Rust CLI exposes it for oracle comparison:

```bash
cargo run -q -p juzu-cli -- layout --path /home/shamanic/dev/juzu --limit 20 --mode chronological
```

Reusable parity runner:

```bash
bun run parity:layout -- --repo /home/shamanic/dev/juzu --limit 20
```

## Latest artifact

`bench/results/rust-port/layout-parity/2026-06-13T20-19-57-458Z/layout-parity.html`

Generated files in each run:

- `old-layout-<mode>.json`
- `rust-layout-<mode>.json`
- `layout-parity-report.json`
- `layout-parity.html`

## Compared fields

For each mode:

- layout summary: `maxLane`, `textColumnX`, `totalHeight`
- node identity: `changeId`, `commitId` prefix
- node layout: `lane`, `x`, `y`, `isPinned`

## Latest self-repo parity at limit 20

| Mode | Lane | X | Y | Summary |
| --- | ---: | ---: | ---: | --- |
| chronological | 100% | 100% | 100% | match |
| mainline | 100% | 100% | 100% | match |
| bookmark-centric | 100% | 100% | 100% | match |
| wc-focused | 100% | 100% | 100% | match |
| topological | 100% | 100% | 100% | match |

## Verification

```bash
python3 -m py_compile scripts/rust-port-layout-parity.py
cargo test --workspace
bun run parity:layout -- --repo /home/shamanic/dev/juzu --limit 20
```

## Next expansion

- run layout parity on forked/merge-heavy fixtures, not only the mostly-linear self repo
- include pinned-node parity once Rust app state exists
- feed `juzu-tui` read-only graph rendering from `juzu-core::layout`
