# Native files hydration

Date: 2026-06-13

## What landed

The Rust port now has the first native sidebar/file hydration slice:

- `juzu-jj::NativeJjBackend::files(...)` uses `jj-lib` tree diffs instead of shelling out.
- `juzu-cli files --path <repo> --change <id>` emits JSON for parity/debugging.
- `juzu-tui` preloads file lists for the visible snapshot and renders:
  - compact file summaries in each graph row
  - typed file rows in the details sidebar
- `scripts/rust-port-files-parity.py` compares old `oracle:sidebar` file lists against Rust native output and writes JSON + HTML artifacts.
- `bun run parity:files` runs the parity report.

## Current behavior

Rust file lists are compared against old JUZU's `jj diff --summary -r <change>` oracle for both committed changes and the dirty working-copy `@` change.

The backend now takes a safe native working-copy snapshot through `jj-lib` when the selected node is `@`, diffs that ephemeral tree against the parent tree, and then drops the working-copy lock without finishing the mutation. That means dirty tracked and newly added files show up in Rust parity/reporting without silently rewriting the repo state.

## Verification

```bash
cargo fmt --all
cargo test --workspace
cargo run -q -p juzu-cli -- files --path /home/shamanic/dev/juzu --change <id>
bun run parity:files -- --repo /home/shamanic/dev/juzu --limit 20 --cases 8
```

## Next work

- Tighten native snapshot config/ignore handling so dirty `@` parity matches more repo-level edge cases.
- Diff text hydration with a parity report for sidebar `diffSummary`.
- File row color/rhythm parity against old `GraphView`.
