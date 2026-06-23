# Native diff hydration

## Status

Rust JUZU now has a first native `diff()` slice backed by `jj-lib` tree reads instead of shelling out to `jj`.

## Landed behavior

- `juzu-jj::NativeJjBackend::diff(ChangeQuery)` opens the repo at head, resolves a change/commit id prefix, diffs the first parent tree against the selected commit tree, reads file contents through `jj-lib`, and emits git-style unified diff text.
- `juzu-cli diff --path <repo> --change <id>` emits JSON with the native diff payload.
- The read-only Rust TUI lazily hydrates a capped diff preview for the selected node and renders colored diff headers, hunks, additions, and removals in the details sidebar.
- `bun run parity:diff` compares old JUZU sidebar diff first-lines against Rust native output and writes an HTML review report.

## Current parity boundary

The Rust output intentionally omits jj's object `index ...` lines for now. The parity harness normalizes those away and gates on sidebar-visible diff header/hunk/content prefix parity. Raw byte and line counts remain visible as diagnostics in the report.

The TUI uses `NativeJjBackend::diff_preview(..., 90)` instead of caching full patches for every selected change. This keeps navigation memory bounded while preserving the full `juzu-cli diff` / backend `diff()` path for parity checks and future full-diff views.

Working-copy dirty diff parity now goes through a safe native snapshot path too. When the selected node is `@`, Rust snapshots the filesystem through `jj-lib`, diffs that ephemeral tree against the parent tree, and leaves the repo state untouched. Single-line unified hunk headers are normalized to old/JJ form (`@@ -0,0 +1,1 @@`, `@@ -1,1 +1,1 @@`) so dirty working-copy parity matches the old sidebar proof surface instead of drifting on compact `similar` header formatting.

## Review artifact

Latest report path is printed by:

```bash
bun run parity:diff -- --repo /home/shamanic/dev/juzu --limit 20 --cases 6
```

## Verification

```bash
cargo fmt --all
cargo test --workspace
bun run parity:diff -- --repo /home/shamanic/dev/juzu --limit 20 --cases 6
```
