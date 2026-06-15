# Read-only Rust TUI

Date: 2026-06-13

## What landed

`crates/juzu-tui` is now a real Ratatui review surface instead of a scaffold print:

- opens repo through `juzu-jj` native backend
- computes graph coordinates through `juzu-core::layout`
- renders read-only commit graph with DAG connector glyphs
- renders selected-node details sidebar
- supports selection movement with `j/k` or arrow keys
- supports live layout mode switching with `1` through `5`
- quits with `q` or `Esc`

## Run command

```bash
cargo run -q -p juzu-tui -- --path /home/shamanic/dev/juzu --limit 30 --mode chronological
```

## tmux review

Session: `juzu`

Window: `rust-tui`

Attach:

```bash
tmux attach -t juzu
```

Before claiming the review surface is current, capture it with:

```bash
bun run review:live-tmux -- --target juzu:rust-tui --expect LOG,dag
```

## Latest review artifact

Latest token parity swatch:

`bench/results/rust-port/token-parity/2026-06-15T01-20-33.363Z/token-parity.html`

Latest diff render review:

`bench/results/rust-port/diff-render/2026-06-15T00-45-20.631Z/diff-render-review.html`

Latest modal parity proof:

`bench/results/rust-port/tui-modal-parity/2026-06-15T00-44-01-603Z/status-footer-parity-report.html`

This is a static tmux capture converted into HTML. The live review surface is the tmux window.

## DAG presentation parity progress

The Rust TUI now mirrors more of old `GraphView`'s presentation model:

- four-line row rhythm per visible commit (`id`, description, files/status, spacer)
- edge rendering across the full graph, clipped into the viewport, so off-screen vertical lanes continue
- mainline-mode bus spans only across connected branch/merge lanes
- lane-colored graph glyphs and id text, with selected node/connection emphasis
- selected-row indicator behavior closer to old JUZU (`>` and working-copy `@` marker)

File rows now use native `files()` hydration through `juzu-jj` for committed changes. The old placeholder has been replaced with compact file summaries in graph rows and typed file lists in the details sidebar.

Diff preview now uses native `diff()` hydration through `juzu-jj` and a structured Pierre/JUZU-style TUI renderer instead of raw line coloring. The sidebar renders strong file section dividers, compact blue/purple hunk bands, dim aligned old/new gutters, tinted add/remove rows with a continuous left mutation band, and centered collapsed-context separators. In log mode the sidebar preview shows a visible diff row range plus a full-width `STICKY ▸ ...` file/hunk context bar, supports `{ / }` previous/next hunk jumps, and keeps retained structured preview rows capped so navigation does not keep huge full patches resident.

The old Bun/OpenTUI full diff behavior is now covered by `parity:tui-modal` before implementation changes: `Ctrl+D` swaps the graph pane for a diff pane while keeping the details sidebar, `[ / ]` cycles files in diff mode, `j/k` scroll diff rows without moving DAG selection, and `q`/`Esc`/`g`/`Ctrl+D` return to the log instead of quitting. Diff mode now renders inside a real bordered `diff` panel with a filled title row and a full-width `VIEWPORT diff rows ... SCROLL [...]` status bar, so the full pane has a stronger old-JUZU/Pierre-style surface and visible scroll affordance instead of floating text. The details sidebar switches from generic `Diff` labeling to `Current file preview  secondary` in diff mode, making the sidebar read as a subordinate preview tied to the selected full-pane file. Hunk rows now span like capped bars with a right-side cap, and add/remove code rows now begin with `▌+` / `▌-` mutation bands, so file/hunk/code separators feel less like loose text and more like panelized diff structure. Diff mode now exposes old-style controls in the top status bar (`^d Log`, `[ ] File`, `j/k Move`, `{/} Hunk`, `Esc Exit`) while the bottom footer follows Bun/OpenTUI `FooterBar` parity: repo path, working-copy id/bookmark context, layout mode, and node count. This fixes the earlier Rust inversion where controls were in the footer and repo/node information was in the header. The same parity runner now calls the Rust `--debug-state --keys ...` path so modal behavior is asserted with state JSON as well as tmux screen capture, including `{` / `}` hunk-jump scenarios that must remain in diff mode, land exactly on a `HunkHeader` row, and expose the updated sticky file/hunk context in JSON. Horizontal pane sizing now follows old JUZU's 60/40 graph/sidebar split; diff mode keeps the old two-column buffer before the sidebar and truncates long file titles so the back hint remains visible. The modal parity runner now verifies that title/footer/sidebar contract across 120, 160, and 206 column terminals, covers debug-state exit scenarios for `C-d,q`, `C-d,g`, `C-d,C-d`, `C-d,],],Esc`, and `C-d,PageDown,PageUp,Esc`, asserts that diff-mode file cycling visibly marks the selected file in the sidebar file list even after wrapping to a later file beyond the compact sidebar preview window, locks that the full diff pane never shows sidebar-only `preview capped` rows, and checks that the diff-mode sidebar preview follows the selected full-diff file instead of remaining pinned to the first file. Log/sidebar mode keeps the diff preview reachable by reserving sidebar space, and `PageDown/PageUp` scroll the sidebar diff preview without moving DAG selection. Sidebar/log mode keeps capped preview rows for performance, while entering the full diff pane lazily loads uncapped structured rows for the selected change. The structured row cap preserves a per-file slice, so navigating beyond the first diff file renders real rows instead of an empty `File N/N: Diff` pane. This explicitly replaces the bad abandoned fullscreen attempt.

Working-copy dirty-file parity still needs the native snapshot path wired; current read-only `jj-lib` repo loading intentionally does not mutate/snapshot the working copy yet.

## Verification

```bash
cargo fmt --all
cargo test --workspace
cargo run -q -p juzu-tui -- --path /home/shamanic/dev/juzu --limit 30 --mode chronological
bun run parity:tui-modal -- --repo /home/shamanic/dev/juzu --limit 40 --widths 120,160,206
```

## Next expansion

- improve connector parity for off-screen edges and mainline bus behavior
- expand old color/theme token parity beyond the status/footer chrome into graph lanes, diff rows, panels, and sidebar surfaces
- add keyboard parity from old JUZU modes
- wire safe native working-copy snapshot support so `@` dirty files match old `jj diff --summary`
- continue Pierre/JUZU-style diff viewport UX: hunk/file jumping, sticky-ish file/hunk context, and exact patch-fidelity decisions
- hydrate sidebar description through native backend
- keep live tmux proof artifacts attached to restart/checkpoint claims
