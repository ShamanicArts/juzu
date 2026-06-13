# Native JJ Read-only Log Snapshot

Date: 2026-06-13

## What landed

`juzu-jj` now emits a first read-only commit snapshot through native `jj-lib` APIs.

Native path:

```text
Workspace::load
  -> repo_loader.load_at_head()
  -> RevsetExpression::all().evaluate(repo)
  -> revset stream -> CommitNode JSON
```

The Rust CLI now supports:

```bash
cargo run -q -p juzu-cli -- snapshot --path /home/shamanic/dev/juzu --limit 20
```

## Parity artifact

HTML review report:

`bench/results/rust-port/native-log/2026-06-13T19-59-50-346Z/native-log-parity.html`

Generated files:

- `old-oracle-snapshot.json`
- `rust-snapshot.json`
- `parity-report.json`
- `native-log-parity.html`

## Current parity result

The first comparison checks identity fields for the first 20 topological log entries:

- change id
- commit id
- parent ids

Result: see HTML report. This is not full field parity yet; formatting and viewmodel details still need normalization.

## Verification

```bash
cargo fmt --all
cargo test --workspace
cargo run -q -p juzu-cli -- snapshot --path /home/shamanic/dev/juzu --limit 5
bun run oracle:snapshot --limit 20 --output old-oracle-snapshot.json
```

## Known limitations

- Custom revset parsing is not wired natively yet.
- `node_count` currently counts through the native log path and is not optimized.
- `description`, `files`, `diff`, `oplog`, `obslog`, and mutations still return explicit unsupported errors.
- Field-level parity is partial; identity parity came first.
- `async_trait(?Send)` is currently required because `jj-lib` revset streams and repo loading expose non-`Send` futures. This should be revisited when the app/runtime threading model is finalized.

## Next slice

Normalize old/Rust snapshot fields into a reusable parity script, then expand comparison beyond identity fields.
