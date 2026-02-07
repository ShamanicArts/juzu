#!/usr/bin/env bun
// CLI entry point that routes between web and TUI modes

export {};

const args = process.argv.slice(2);

const wantsHelp = args.includes("--help") || args.includes("-h");
const wantsTui = args.includes("--tui") || args.includes("-t");
const passThroughArgs = args.filter((a) => a.startsWith("--theme=") || a.startsWith("--config="));

if (wantsHelp) {
  console.log(`
jj-viz - High-performance visualization for Jujutsu VCS

Usage: jj-viz [options]

Options:
  --tui, -t      Run in terminal UI mode (TUI)
  --port=<num>   Port for web server (default: 3000)
  -o, --open     Auto-open browser (web mode only)
  --theme=<name> Theme name (looks for themes/<name>.toml)
  --config=<path> Explicit config TOML file
  -h, --help     Get help with using jj-viz

Examples:
  jj-viz                    # Start web server on port 3000 (no auto-open)
  jj-viz --tui              # Start TUI mode
  jj-viz --port=8080        # Web server on custom port
  jj-viz --open             # Start web server and open browser
  jj-viz --theme=slate      # Use bundled theme
  jj-viz -t                 # Short flag for TUI mode
`);
  process.exit(0);
}

if (wantsTui) {
  // Prefer pre-compiled production build (saves ~36MB by skipping Babel preload).
  // Falls back to dev mode if dist/tui/ doesn't exist.
  const prodEntry = `${import.meta.dir}/dist/tui/tui/main.js`;
  const prodPreload = `${import.meta.dir}/scripts/preload-solid-client.ts`;
  const devEntry = `${import.meta.dir}/src/tui/main.ts`;
  const devPreload = `${import.meta.dir}/node_modules/@opentui/solid/scripts/preload.ts`;

  const useProd = await Bun.file(prodEntry).exists();
  const tuiEntry = useProd ? prodEntry : devEntry;
  const preloadPath = useProd ? prodPreload : devPreload;

  const proc = Bun.spawn([
    "bun",
    "--preload",
    preloadPath,
    tuiEntry,
    ...passThroughArgs,
  ], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  process.exit(code);
} else {
  await import("./server.ts");
}
