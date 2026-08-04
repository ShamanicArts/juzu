# Architecture

Juzu is a Rust workspace with a terminal-first application and a native Jujutsu
backend.

## Crates

### `juzu-core`

Owns domain types, the `JjBackend` boundary, graph layout, and the structured diff
model. It does not depend on terminal rendering or `jj-lib`.

### `juzu-jj`

Implements `JjBackend` using `jj-lib` for repository discovery, log traversal,
working-copy snapshots, file summaries, and diff data. Mutations that require a
command fallback are isolated in `cli_fallback.rs`; callers do not invoke `jj`
directly.

### `juzu-tui`

The canonical application. It owns terminal lifecycle, input modes, cached view
state, themes, and Ratatui rendering. Its installed binary is named `juzu`.

### `juzu-cli`

A diagnostic JSON interface for inspecting repository, snapshot, layout, file,
and diff data. It is useful for tests and backend debugging but is not the main
user interface.

### `juzu-server`

Provides a local read-only HTTP adapter with Axum. Because `JjBackend` futures
are intentionally non-`Send`, handlers submit typed commands to a dedicated
repository executor thread. That thread owns backend execution and provides the
serialization point required by future mutation endpoints. A lightweight
watcher fingerprints JJ operation heads and working-copy state, then broadcasts
repository invalidations through Server-Sent Events.

## Data flow

```text
terminal input
    -> juzu-tui state/actions
    -> JjBackend trait
    -> juzu-jj (jj-lib or isolated command fallback)
    -> juzu-core domain data
    -> Ratatui rendering
```

```text
browser request
    -> Axum route and web DTO
    -> repository executor channel
    -> JjBackend trait
    -> juzu-jj
    -> JSON, text diff, or SSE invalidation
```

Keep repository-specific details out of `juzu-core` and rendering concerns out
of `juzu-jj`. New backend operations should first be expressed on `JjBackend`,
then implemented and tested in `juzu-jj`, and finally consumed by the TUI.

## Configuration

The active configuration surface is deliberately small: the TUI reads and
persists `[theme].name`. Runtime path, history limit, initial layout, and initial
selection are command-line options. Do not expose configuration in documentation
until the Rust application reads it.
