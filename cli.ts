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
  -n, --no-open  Don't auto-open browser (web mode only)
  -h, --help     Show this help message

Examples:
  jj-viz                    # Start web server on port 3000
  jj-viz --tui              # Start TUI mode
  jj-viz --port=8080        # Web server on custom port
  jj-viz -t                 # Short flag for TUI mode
`);
  process.exit(0);
}

if (wantsTui) {
  await import("./tui/App.tsx");
} else {
  await import("./server.ts");
}
