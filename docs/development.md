# Development

## Toolchain

Juzu requires Rust 1.85 or newer and `jj` on `PATH`. The default workspace build
contains the TUI, core domain crate, native JJ backend, and diagnostic CLI.

## Checks

```bash
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Focused examples:

```bash
cargo test -p juzu-core diff::
cargo test -p juzu-jj native_diff
cargo test -p juzu-tui theme_picker
```

## Running locally

```bash
cargo run -p juzu-tui -- --path .
cargo run --release -p juzu-tui -- --path /path/to/workspace --mode mainline
```

Run the local read-only web server:

```bash
cargo run -p juzu-server -- --path /path/to/workspace --port 3000
```

Install the canonical `juzu` binary from the checkout:

```bash
cargo install --path crates/juzu-tui
```

The diagnostic CLI emits JSON suitable for inspection or fixtures:

```bash
cargo run -p juzu-cli -- repo --path .
cargo run -p juzu-cli -- snapshot --path . --limit 20
cargo run -p juzu-cli -- diff-model --path . --change @
```

## Optional tmux helper

Build a release binary, then recreate a persistent review window:

```bash
cargo build --release -p juzu-tui
python3 scripts/restart-tui-window.py --repo /path/to/workspace
```

## Adding backend behaviour

1. Add or refine the domain request/result types and `JjBackend` method in
   `juzu-core`.
2. Implement the native operation in `juzu-jj` and keep command fallbacks inside
   `cli_fallback.rs`.
3. Add backend tests using temporary JJ repositories.
4. Wire the operation into TUI state and input handling.
5. Add a focused rendering or state test when visible behaviour changes.

## Server tests

`crates/juzu-server/tests/api.rs` creates real temporary JJ repositories and
drives the Axum router in memory. Keep API tests at that boundary so they cover
request extraction, executor dispatch, backend serialization, response types,
and errors together. Watcher tests must prove a JJ operation produces a
`repo-updated` event instead of only testing the broadcast channel directly.
