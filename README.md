# juzu

A high-performance, interactive visualization tool for the [Jujutsu (jj)](https://github.com/martinvonz/jj) version control system.

Built with **Bun** and **HTML5 Canvas**, this tool provides a "Circuit Board" style visualization of your commit graph with inline actions for common workflows.

## Features

*   **Circuit Board Graph**: A clean, orthogonal layout for commit history with no line crossovers, making complex merges easy to follow.
*   **5 Layout Modes**: Chronological, Mainline, Bookmark-centric, WC-focused, and Topological views.
*   **Drag-to-Pin**: Alt+Click+Drag commits between lanes to customize layout.
*   **Inline Actions**: Perform operations directly from the graph view:
    *   **Edit**: Switch working copy to any revision (checkout).
    *   **New**: Create a new child commit from any node.
    *   **Desc**: Edit commit description.
    *   **Rebase**: Visual point-and-click rebase workflow.
    *   **Files**: View changed files inline within the graph layout.
*   **Shift Actions** (Hold Shift):
    *   **Abandon**: Hide/Abandon the revision.
    *   **Squash**: Squash changes into parent.
    *   **Dupe**: Duplicate the revision.
*   **Operation Modes**: Split, Squash, and Move operations with file selection.
*   **Live Updates**: The graph automatically refreshes to reflect the current state of your repository.
*   **Detailed Inspector**: Sidebar view showing full commit metadata, descriptions, and file diffs.
*   **Working Copy Indicator**: Clearly marks your current checkout (`@`) in the graph.

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
# Start web UI (default; auto-detects port 3000, opens browser)
bun run cli.ts

# Custom port, don't open browser
bun run cli.ts --port=8080 --no-open

# Start TUI (renders the graph directly in your terminal)
bun run cli.ts --tui

# Or shorthand
bun run cli.ts -p 8080 -n

# Show help
bun run cli.ts --help
```

### CLI Options

| Option | Description |
|--------|-------------|
| `--port=<num>` | Port to run server on (default: 3000) |
| `-n, --no-open` | Don't auto-open browser |
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

| Key | Action |
|-----|--------|
| `Shift` | Show alternate actions (Abandon, Squash, Dupe) |
| `Alt+Click+Drag` | Move commit between lanes |
| `Right-Click` | Pin/unpin commit to lane |
| `Escape` | Cancel rebase / drag operation |
| `Ctrl+Click` | Multi-select commits |

## Architecture

The tool follows a "Game Loop" architecture:
*   **State**: Graph topology calculated once per fetch.
*   **Render**: Entire UI drawn on single `<canvas>` element.
*   **Interaction**: Mouse events mapped to world coordinates for hit detection on virtual buttons.

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

# Run development server
bun run cli.ts

# The server will:
# 1. Auto-detect the JJ repository root (walks up from CWD)
# 2. Start on port 3000 (or specified port)
# 3. Open your default browser
```

## License

MIT
