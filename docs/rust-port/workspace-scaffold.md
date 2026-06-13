# Rust Workspace Scaffold

Date: 2026-06-13

## What landed

A Rust workspace now lives inside the old JUZU repo so the Bun app can remain the oracle while Rust crates grow beside it.

```text
Cargo.toml
crates/
  juzu-core/
  juzu-jj/
  juzu-cli/
  juzu-tui/
  juzu-server/
```

## Crates

| Crate | Current role | Next role |
| --- | --- | --- |
| `juzu-core` | Shared domain types, `JjBackend` trait, scaffold errors/queries/mutations. | App state, reducers, layout, keymap, theme, oracle structs. |
| `juzu-jj` | `NativeJjBackend` scaffold with repo-root discovery and unsupported stubs. | Native `jj-lib`/`jj-cli` repo open, log, files, diff, oplog, obslog, mutations. |
| `juzu-cli` | Minimal CLI with `repo`, `snapshot`, and `--version`. | Rust oracle/debug/bench command surface. |
| `juzu-tui` | Placeholder binary. | Ratatui review surface. |
| `juzu-server` | Placeholder binary. | HTTP/SSE adapter over shared core. |

## Verification

```bash
cargo fmt --all
cargo test --workspace
cargo run -q -p juzu-cli -- repo --path /home/shamanic/dev/juzu
```

Current result:

- workspace compiles
- `cargo test --workspace` passes
- `juzu-cli repo` resolves `/home/shamanic/dev/juzu` as a JJ repo root

## Important boundary

`juzu-core` has no terminal, HTTP, or native-JJ dependency. That is deliberate. Surfaces and backend implementations depend on the core; the core does not depend on them.

## Next slice

Wire `juzu-jj` to native `jj-lib` / `jj-cli` repo-open APIs. The scaffold currently finds `.jj` by walking ancestors, which is good enough as a smoke test but not the real native backend implementation.
