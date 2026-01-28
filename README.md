# jj-viz

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
bun run /path/to/jj-viz/server.ts
```

### Option 2: Global Alias

Add to your `~/.bashrc`, `~/.zshrc`, or `~/.config/fish/config.fish`:

```bash
# Bash/Zsh
alias jjviz='bun run /path/to/jj-viz/server.ts'

# Or if you put jj-viz in ~/tools
alias jjviz='bun run ~/tools/jj-viz/server.ts'
```

Then use from any jj repository:
```bash
cd my-project
jjviz
```

### Option 3: Local Directory

```bash
# Clone or copy jj-viz to a permanent location
mkdir -p ~/tools
cp -r jj-viz ~/tools/

# Run from anywhere
cd my-project
bun run ~/tools/jj-viz/server.ts
```

## Usage

```bash
# Start server (auto-detects port 3000, opens browser)
bun run server.ts

# Custom port, don't open browser
bun run server.ts --port=8080 --no-open

# Or shorthand
bun run server.ts -p 8080 -n

# Show help
bun run server.ts --help
```

### CLI Options

| Option | Description |
|--------|-------------|
| `--port=<num>` | Port to run server on (default: 3000) |
| `-n, --no-open` | Don't auto-open browser |
| `-h, --help` | Show help message |

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
cd jj-viz

# Install dependencies (Bun handles this automatically)

# Run development server
bun run server.ts

# The server will:
# 1. Auto-detect the JJ repository root (walks up from CWD)
# 2. Start on port 3000 (or specified port)
# 3. Open your default browser
```

## License

MIT
