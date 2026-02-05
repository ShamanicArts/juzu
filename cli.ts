#!/usr/bin/env bun
// CLI entry point that routes between web and TUI modes

export {};

const args = process.argv.slice(2);

const wantsHelp = args.includes("--help") || args.includes("-h");
const wantsTui = args.includes("--tui") || args.includes("-t");

if (wantsHelp) {
  console.log(`
jj-viz - High-performance visualization for Jujutsu VCS

Usage: jj-viz [options]

Options:
  --tui, -t      Run in terminal UI mode (TUI)
  --port=<num>   Port for web server (default: 3000)
  -o, --open     Auto-open browser (web mode only)
  -h, --help     Get help with using jj-viz

Examples:
  jj-viz                    # Start web server on port 3000 (no auto-open)
  jj-viz --tui              # Start TUI mode
  jj-viz --port=8080        # Web server on custom port
  jj-viz --open             # Start web server and open browser
  jj-viz -t                 # Short flag for TUI mode
`);
  process.exit(0);
}

if (wantsTui) {
  // OpenTUI Solid relies on a Bun plugin to compile TSX.
  // That plugin must be preloaded before modules are compiled,
  // so we run the TUI in a separate Bun process.
  const tuiEntry = `${import.meta.dir}/src/tui/main.ts`;
  const preloadPath = `${import.meta.dir}/node_modules/@opentui/solid/scripts/preload.ts`;
  const proc = Bun.spawn([
    "bun",
    "--preload",
    preloadPath,
    tuiEntry,
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
