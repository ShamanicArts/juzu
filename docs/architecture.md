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

## Data flow

```text
terminal input
    -> juzu-tui state/actions
    -> JjBackend trait
    -> juzu-jj (jj-lib or isolated command fallback)
    -> juzu-core domain data
    -> Ratatui rendering
```

Keep repository-specific details out of `juzu-core` and rendering concerns out
of `juzu-jj`. New backend operations should first be expressed on `JjBackend`,
then implemented and tested in `juzu-jj`, and finally consumed by the TUI.

## Configuration

The active configuration surface is deliberately small: the TUI reads and
persists `[theme].name`. Runtime path, history limit, initial layout, and initial
selection are command-line options. Do not expose configuration in documentation
until the Rust application reads it.
