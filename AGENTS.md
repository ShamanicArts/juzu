# AGENTS.md - Juzu contributor guide

## Commands

```bash
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

cargo test -p juzu-core
cargo test -p juzu-jj native_diff
cargo test -p juzu-tui theme_picker

cargo run -p juzu-tui -- --path /path/to/jj/workspace
cargo run --release -p juzu-tui -- --path . --mode mainline
cargo run -p juzu-server -- --path . --port 3000

cargo run -p juzu-cli -- snapshot --path . --limit 20
cargo run -p juzu-cli -- diff --path . --change @
```

## Rust style

- Use Rust 2021 idioms and keep the workspace compatible with Rust 1.85.
- Run `cargo fmt` after edits; do not hand-align code against rustfmt.
- Prefer explicit domain types in `juzu-core` over UI-shaped maps or tuples.
- Return contextual errors with `JuzuError` or `anyhow`; do not silently discard
  unexpected repository failures.
- Keep terminal rendering and input handling in `juzu-tui`.
- Keep HTTP routing and web-specific DTOs in `juzu-server`. Do not expose
  path-bearing core mutation types directly to browser clients.
- Keep repository access behind the `JjBackend` trait. Native `jj-lib` access
  belongs in `juzu-jj`; command fallbacks stay isolated in `cli_fallback.rs`.
- Avoid cloning full histories or diffs in render loops. Cache or window data
  needed for large repositories.
- Add focused unit tests beside the module they cover.

## Repository layout

- `crates/juzu-core/`: domain types, layout, and structured diff logic
- `crates/juzu-jj/`: native JJ repository backend and mutation fallbacks
- `crates/juzu-tui/`: canonical Ratatui application (`juzu` binary)
- `crates/juzu-cli/`: JSON diagnostics for backend and layout inspection
- `crates/juzu-server/`: local Axum server, repository executor, web API, and
  embedded browser assets in `web/` (native ES modules; no frontend build step)
- `themes/`: TOML themes embedded in the TUI at compile time
- `docs/`: current architecture and development documentation

## Configuration

The current runtime reads the theme name from global, repository, and
repository-local TOML files. `.juzu.local.toml` is machine-local and must not be
committed. Do not document unsupported settings as active configuration.
