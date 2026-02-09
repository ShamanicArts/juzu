# juzu

A high-performance interface for the [Jujutsu (jj)](https://github.com/jj-vcs/jj) version control system.

Built with **Bun** and TypeScript, juzu provides a rich terminal UI (TUI) and web experience featuring a "Circuit Board" style visualization with powerful commit workflow tools.

## Features

**Terminal UI (TUI)**

*   **Rich Interactive Interface**: Full-featured terminal visualization with leader modes, keyboard-driven workflows, and live diff viewing.
*   **Persistent Leader Modes**: Action categories (Actions, Operations, View, Bookmarks) that stay active until dismissed—no timeout pressure.
*   **Complete Workflow Support**: New commits, edit revisions, describe changes, rebase operations, split/squash/move, abandon, duplicate, file operations, bookmarks, undo/redo, fetch/push.
*   **Live Diffs**: View file changes directly in the terminal with syntax-aware coloring.
*   **Oplog & Obslog**: Navigate and inspect operation logs and obscured revisions.
*   **Merge & Conflict Resolution**: Interactive conflict handling with status context tracking.
*   **5 Layout Modes**: Chronological, Mainline, Bookmark-centric, WC-focused, and Topological views.
*   **Configurable Keymaps**: Customize leaders, mode order, bindings, and hint display via TOML config.
*   **Theme Support**: Multiple bundled themes with full customization support.

**Web UI**

*   **Circuit Board Graph**: Clean, orthogonal layout for commit history with no line crossovers.
*   **Drag-to-Pin**: Alt+Click+Drag commits between lanes to customize layout.
*   **Inline Actions**: Edit checkout, create commits, describe changes, visual rebase, view files inline.
*   **Live Updates**: Auto-refreshing graph reflecting repository state.
*   **Detailed Inspector**: Sidebar with commit metadata and file diffs.

**Shared Features**

*   **Live Repository Detection**: Auto-detects JJ repository root from current working directory.
*   **Working Copy Indicator**: Clearly marks your current checkout (`@`) in the graph.
*   **Layered Configuration**: Global, repo, and local TOML config files with flexible precedence.

## Tech Stack

*   **Backend**: [Bun](https://bun.sh) (wrapping `jj` CLI commands)
*   **Frontend**: Native HTML5 Canvas + TypeScript (60fps rendering)
*   **Communication**: REST API (JSON)

## Prerequisites

*   [Jujutsu (jj)](https://github.com/martinvonz/jj) installed and in your PATH.
*   [Bun](https://bun.sh) runtime installed.

## Installation

### Option 1: Direct Usage (No Install)

```bash
# From any jj repository
cd /path/to/your/jj-repo
bun run /path/to/juzu/cli.ts
```

### Option 2: Global Alias

Add to your `~/.bashrc`, `~/.zshrc`, or `~/.config/fish/config.fish`:

```bash
# Bash/Zsh
alias juzu='bun run /path/to/juzu/cli.ts'

# Or if you put juzu in ~/tools
alias juzu='bun run ~/tools/juzu/cli.ts'
```

Then use from any jj repository:
```bash
cd my-project
juzu
```

### Option 3: Local Directory

```bash
# Clone or copy juzu to a permanent location
mkdir -p ~/tools
cp -r juzu ~/tools/

# Run from anywhere
cd my-project
bun run ~/tools/juzu/cli.ts

# Or TUI
# bun run ~/tools/juzu/cli.ts --tui
```

## Usage

```bash
# Start TUI (default; renders directly in your terminal)
bun run cli.ts

# Start web UI (opens browser on port 3000)
bun run cli.ts --web

# Custom port, don't open browser
bun run cli.ts --web --port=8080 --no-open

# Shorthands
bun run cli.ts -p 8080 -n          # web with custom port
bun run cli.ts --tui -t ember     # TUI with specific theme

# Show help
bun run cli.ts --help
```

### CLI Options

| Option | Description |
|--------|-------------|
| `--web` | Launch web UI instead of TUI |
| `--tui` | Launch TUI (default) |
| `--port=<num>` | Port to run web server on (default: 3000) |
| `-n, --no-open` | Don't auto-open browser for web UI |
| `--theme=<name>` | Select theme by name (`themes/<name>.toml`) |
| `--config=<path>` | Use explicit TOML config file |
| `-h, --help` | Show help message |

## Configuration and Themes

juzu supports layered TOML config for both TUI and Web.

On first real run (web or TUI), juzu bootstraps missing global config files:

- `~/.config/juzu/config.toml`
- `~/.config/juzu/themes/*.toml`

It only creates missing files and never overwrites existing user edits.

To promote your repo/dev config to global config:

```bash
bun run config:export
```

Default source priority for export is:

1. `<repo>/.juzu.local.toml`
2. `<repo>/.juzu.toml`
3. `<repo>/config.example.toml`

Optional flags:

- `--source=/absolute/or/relative/path.toml`
- `--target=/absolute/or/relative/path.toml`
- `--no-backup` (by default, existing global config is backed up first)

Config load order (low to high priority):

1. `~/.config/juzu/config.toml`
2. `<repo>/.juzu.toml`
3. `<repo>/.juzu.local.toml`
4. `JUZU_CONFIG=/path/to/config.toml`
5. `--config=/path/to/config.toml`

Theme selection precedence:

1. `theme.name` in config
2. `JUZU_THEME=<name>`
3. `--theme=<name>`

Layout startup mode:

- Set `layout.startupMode` in config to choose default graph layout on launch.
- Allowed values: `chronological`, `mainline`, `bookmark-centric`, `wc-focused`, `topological`.

Theme lookup paths (in order):

1. `<repo>/.juzu/themes/<name>.toml`
2. `~/.config/juzu/themes/<name>.toml`
3. bundled `themes/<name>.toml`

To push the repo's bundled themes into your global theme folder for quick testing:

```bash
bun run themes:export
```

Bundled themes:

- `slate` (default)
- `ember`
- `oceanic`
- `moss`
- `nocturne`

Quick test:

```bash
bun run cli.ts --theme=slate
bun run cli.ts --theme=ember
bun run cli.ts --tui --theme=ember
```

See `config.example.toml` for all first-pass options.

### TUI Details

The TUI now defaults to persistent leader modes (no timeout):

- Press a leader key (for example `Ctrl+a`) to enter that action category.
- The status bar shows mode badges for all leaders, with the active one highlighted.
- In a leader mode, key actions stay active until you exit with `Esc` or `q`.

Default mode leaders:

- `Ctrl+a` -> Actions (new, edit, describe, rebase, etc.)
- `Ctrl+o` -> Operations (undo, redo, fetch, push, oplog, obslog)
- `Ctrl+v` -> View (layout, sidebar, theme, help, revset)
- `Ctrl+b` -> Bookmarks (set, delete)

You can customize leaders, mode order, mode bindings, badge labels, hint display, and command labels via `[tui.keymap]` in config.

**Hint Display Control:**

```toml
[tui.keymap]
# Hide hints for specific leader modes
hideHintsForModes = ["marks"]

# Hide hints in idle/base log view (cleaner interface)
hideHintsInIdle = false

# Show badges only (ACT OPS VIEW BOOK) instead of key hints (^a ACT ^o OPS ^v VIEW ^b BOOK)
showMinimalHints = false
```

Status-context chips (oplog/obslog/diff/merge/etc.) are also configurable through `[tui.keymap.statusContexts.*]` and `[tui.keymap.statusContextLabels]`.

Status bar mode/button coloring is theme-driven via `uiTokens.semantic.modeAction`, `modeOps`, `modeView`, and `modeMarks` (override in user config if you want custom emphasis).

Note: `Ctrl+s` is often intercepted by terminal flow control unless you disable XON/XOFF (`stty -ixon`), so it is not used by default.

Diff colors are theme-driven. You can optionally override diff rendering colors via:

```toml
[uiTokens.diff]
addedBg = "#1f3a2a"
removedBg = "#47252b"
addedContentBg = "#2a5b3d"
removedContentBg = "#69333a"
addedSignColor = "#50fa7b"
removedSignColor = "#ff5555"
contextBg = "#111318"
contextContentBg = "#111318"
```

### Keyboard Shortcuts

**TUI Leader Modes (default leaders):**

| Leader | Mode | Description |
|--------|------|-------------|
| `Ctrl+a` | Actions | New, edit, describe, rebase, split/squash/move |
| `Ctrl+o` | Operations | Undo, redo, fetch, push, oplog, obslog |
| `Ctrl+v` | View | Layout, sidebar, theme, help, revset |
| `Ctrl+b` | Bookmarks | Set, delete |

Press a leader to enter the mode, then use the mode-specific keys. Press `Esc` or `q` to exit.

**Web UI:**

| Key | Action |
|-----|--------|
| `Shift` | Show alternate actions (Abandon, Squash, Dupe) |
| `Alt+Click+Drag` | Move commit between lanes |
| `Right-Click` | Pin/unpin commit to lane |
| `Escape` | Cancel rebase / drag operation |
| `Ctrl+Click` | Multi-select commits |

## Architecture

**TUI:** Terminal-native rendering with virtual button semantics, semantic tokens for themeability, and persistent leader mode state management.

**Web UI:** "Game Loop" architecture with state-driven rendering on HTML5 Canvas, world coordinate hit detection, and interactive drag-to-pin workflows.

**Shared:** Repository detection, graph topology calculation, commit management backend, and layered configuration system.

### Layout Strategies

1. **Chronological** - Time-based ordering
2. **Mainline** - Clean trunk with branches left-aligned
3. **Bookmark-Centric** - Bookmarks anchor lanes
4. **WC-Focused** - BFS from working copy
5. **Topological** - Depth from root

## Development

```bash
# Clone repository
cd juzu

# Install dependencies (Bun handles this automatically)

# Run TUI (default)
bun run cli.ts

# Run web UI
bun run cli.ts --web

# The tool will:
# 1. Auto-detect the JJ repository root (walks up from CWD)
# 2. Launch the selected interface
# 3. Load configuration layers (global → repo → local)
```

## License

MIT
