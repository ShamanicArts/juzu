# juzu

`juzu` is a fast terminal interface for the [Jujutsu](https://github.com/jj-vcs/jj)
version control system. The application is written in Rust and uses `jj-lib` for
repository reads, with narrowly scoped `jj` command fallbacks for mutations that
are not yet exposed through the native backend.

## Features

- Interactive commit graph with chronological, mainline, bookmark-centric,
  working-copy-focused, and topological layouts
- File summaries, structured diffs, hunk navigation, and working-copy previews
- New, edit, describe, rebase, insert, abandon, squash, duplicate, restore, and
  merge workflows
- Bookmark management, operation log, evolution log, undo/redo, fetch, and push
- Revset filtering, collapsible details, and 21 bundled terminal themes

## Requirements

- Rust 1.85 or newer
- `jj` available on `PATH`
- A terminal with 24-bit colour support is recommended

## Install

From a checkout:

```bash
cargo install --path crates/juzu-tui
```

This installs the `juzu` executable. To run without installing:

```bash
cargo run --release -p juzu-tui -- --path /path/to/jj/workspace
```

When `--path` is omitted, juzu opens the JJ workspace containing the current
directory.

## Usage

```text
juzu [OPTIONS]

Options:
  --path <PATH>           JJ workspace to open (default: current directory)
  --limit <COUNT>         Maximum visible revisions (default: 500)
  --mode <MODE>           chronological, mainline, bookmark-centric,
                          wc-focused, or topological
  --select-prefix <ID>    Initially select a change or commit prefix
  --diff-scaffold         Show additional patch structure in diff view
  -h, --help              Print help
  -V, --version           Print version
```

### Keyboard controls

Use `j`/`k` or the arrow keys to move through revisions. `q` or `Esc` exits the
current view and then the application.

| Keys | Mode | Common actions |
| --- | --- | --- |
| `Ctrl+X` | Actions | `n` new, `e` edit, `d` describe, `b` rebase, `i` insert, `a` abandon, `s` squash, `y` duplicate, `z` restore, `m` merge |
| `Ctrl+O` | Operations | `u` undo, `r` redo, `f` fetch, `p` push, `o` operation log, `v` evolution log |
| `Ctrl+L` | View | `c` sidebar, `f` files, `x` description, `t` theme, `/` revset, `h` help |
| `Ctrl+B` | Bookmarks | `s` set, `d` delete |
| `Ctrl+D` | Diff | Toggle the full diff view |

The status bar shows the active mode and its available keys. In merge mode,
press `Space` to select revisions and `Enter` to create the merge.

## Configuration

Theme selection is read in this order:

1. `<workspace>/.juzu.local.toml`
2. `<workspace>/.juzu.toml`
3. `$XDG_CONFIG_HOME/juzu/config.toml` or `~/.config/juzu/config.toml`

```toml
[theme]
name = "slate"
```

Theme selection from the TUI is saved to `.juzu.local.toml`. Local config files
are ignored by Git. See [`config.example.toml`](config.example.toml) and
[`themes/`](themes/) for the bundled names.

## Development

```bash
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p juzu-tui -- --path .
```

The workspace structure and backend boundaries are documented in
[`docs/architecture.md`](docs/architecture.md). See
[`docs/development.md`](docs/development.md) for focused test and run commands.

## License

MIT
