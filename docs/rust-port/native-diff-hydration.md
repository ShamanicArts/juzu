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

Working-copy dirty diff parity now goes through a safe native snapshot path too. When the selected node is `@`, Rust snapshots the filesystem through `jj-lib`, diffs that ephemeral tree against the parent tree, and leaves the repo state untouched. Single-line unified hunk headers are normalized to old/JJ form (`@@ -0,0 +1,1 @@`, `@@ -1,1 +1,1 @@`) so dirty working-copy parity matches the old sidebar proof surface instead of drifting on compact `similar` header formatting. Binary files no longer get lossy UTF-8 garbage in Rust diff mode; native output now emits metadata-style lines like `Binary files /dev/null and b/image.png differ`, which the TUI renders directly in the full diff pane. Pure renames now also match old JUZU/JJ git-patch shape: instead of faking a delete-plus-add block, Rust emits `diff --git a/old b/new`, `rename from ...`, and `rename to ...` for unchanged renames. Rename detection now also covers renames **with** content modification: a second similarity-based pass pairs remaining deletes with the most similar unmatched add (line-level `similar` ratio >= 0.5, mirroring old `jj diff`'s default threshold), so a renamed-and-edited file emits `rename from`/`rename to` metadata followed by the real content hunk (`-world`/`+world CHANGED`, `+NEW LINE`) instead of degenerating into separate add/delete blocks. Pure renames with identical content still emit metadata only, with no content hunk.

## Review artifact

Latest report paths are printed by:

```bash
bun run parity:diff -- --repo /home/shamanic/dev/juzu --limit 20 --cases 6
bun run review:rename-parity
bun run review:rename-modify-parity
```

Latest rename proof artifacts:

- `bench/results/rust-port/rename-parity/2026-06-23T16-13-21.762+00-00/rename-parity-review.html` (pure rename)
- `bench/results/rust-port/rename-modify-parity/2026-06-23T16-13-15.351+00-00/rename-parity-review.html` (rename + modify)

## Verification

```bash
cargo fmt --all
cargo test --workspace
bun run parity:diff -- --repo /home/shamanic/dev/juzu --limit 20 --cases 6
```
