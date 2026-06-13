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

For non-working-copy commits, Rust file lists are compared against old JUZU's `jj diff --summary -r <change>` oracle.

The working-copy commit is intentionally skipped in the parity report for now. Old JUZU shells out to `jj`, which snapshots working-copy filesystem changes before diffing. The current native read-only backend loads repo head without committing a working-copy snapshot, so dirty `@` file parity needs a dedicated safe snapshot slice.

## Verification

```bash
cargo fmt --all
cargo test --workspace
cargo run -q -p juzu-cli -- files --path /home/shamanic/dev/juzu --change <id>
bun run parity:files -- --repo /home/shamanic/dev/juzu --limit 20 --cases 8
```

## Next work

- Native working-copy snapshot support for accurate dirty `@` files.
- Diff text hydration with a parity report for sidebar `diffSummary`.
- File row color/rhythm parity against old `GraphView`.
