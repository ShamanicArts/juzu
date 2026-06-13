# Native JJ Repo-Open Spike

Date: 2026-06-13

## What landed

`juzu-jj` now opens a JUZU workspace through `jj-lib` instead of only walking the filesystem.

Current native path:

```rust
StackedConfig::with_defaults()
  -> UserSettings::from_config(...)
  -> StoreFactories::default()
  -> default_working_copy_factories()
  -> Workspace::load(...)
```

The CLI now exposes this as:

```bash
cargo run -q -p juzu-cli -- repo --path /home/shamanic/dev/juzu
```

Output shape:

```json
{
  "schemaVersion": 1,
  "command": "repo",
  "backend": "jj-lib",
  "repoRoot": "/home/shamanic/dev/juzu",
  "workspaceRoot": "/home/shamanic/dev/juzu",
  "repoPath": "/home/shamanic/dev/juzu/.jj/repo",
  "workspaceName": "default"
}
```

## Why this matters

This is the first Rust slice that proves the port is not just shelling out to `jj`. It anchors future log/files/diff/oplog work on native JJ workspace loading.

## Verification

```bash
cargo fmt --all
cargo test --workspace
cargo run -q -p juzu-cli -- repo --path /home/shamanic/dev/juzu
```

Result:

- `cargo test --workspace` passes
- `juzu-jj::NativeJjBackend::open_workspace_info()` opens the current JUZU workspace through `jj-lib`
- `juzu-cli repo` emits backend metadata with `backend: "jj-lib"`

## Current limitations

Only repo/workspace opening is native. The following still return explicit unsupported errors:

- `log`
- `node_count`
- `description`
- `files`
- `diff`
- `op_log`
- `obslog`
- mutations

Next slice should wire read-only log data or build a direct old-vs-Rust repo-open parity report.
