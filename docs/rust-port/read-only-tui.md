# Read-only Rust TUI

Date: 2026-06-13

## What landed

`crates/juzu-tui` is now a real Ratatui review surface instead of a scaffold print:

- opens repo through `juzu-jj` native backend
- defaults to a 500-node log query, not the earlier accidental 50-node prototype cap
- computes graph coordinates through `juzu-core::layout`
- renders read-only commit graph with DAG connector glyphs
- renders selected-node details sidebar
- supports selection movement with `j/k` or arrow keys
- supports live layout mode switching with `1` through `5`
- quits with `q` or `Esc`

## Run command

```bash
cargo run -q -p juzu-tui -- --path /home/shamanic/dev/juzu --mode chronological
```

The Rust TUI product default log limit is `500`, matching the original JUZU web/app scale rather than the earlier accidental Rust prototype default of `50`. Smaller `--limit` values are only for benchmarks, parity fixtures, or intentionally constrained review runs.

## tmux review

Session: `juzu`

Window: `rust-tui`

Attach:

```bash
tmux attach -t juzu
```

Before claiming the review surface is current, capture it with:

```bash
bun run review:live-tmux -- --target juzu:rust-tui --expect LOG,Selected
```

## Latest review artifact

Latest token parity swatch:

`bench/results/rust-port/token-parity/2026-06-15T01-46-16.210Z/token-parity.html`

Latest diff render review:

`bench/results/rust-port/diff-render/2026-06-15T03-30-51.347Z/diff-render-review.html`

Latest modal parity proof:

`bench/results/rust-port/tui-modal-parity/2026-06-15T18-10-34-568Z/status-token-mix-report.html`

Latest multi-state status/chrome proof:

`bench/results/rust-port/status-sequence/2026-06-15T18-11-00.228Z/status-sequence-proof.mp4`

Latest raw visual parity audit:

`bench/results/rust-port/visual-parity-audit/2026-06-15T17-47-00.545Z/visual-parity-audit.html`

Latest bundled theme review:

`bench/results/rust-port/theme-port/2026-06-15T03-51-15.876Z/theme-port-review.html`

Latest live tmux proof:

`bench/results/rust-port/live-tmux/2026-06-15T18-12-47.913Z/live-tmux-proof.html`

Static state proofs are HTML/tmux captures; MP4 is reserved for real app motion. The live review surface is the tmux window.

## DAG presentation parity progress

The Rust TUI now mirrors more of old `GraphView`'s presentation model:

- deterministic mainline branch lane assignment across redraws; branch roots are processed in node order instead of randomized `HashMap` iteration, preventing branch/merge commits from jumping horizontally while scrolling
- four-line row rhythm per visible commit (`id`, description, files/status, spacer)
- edge rendering across the full graph, clipped into the viewport, so off-screen vertical lanes continue
- mainline-mode bus spans only across connected branch/merge lanes
- lane-colored graph glyphs and id text, with selected node/connection emphasis
- selected-row indicator behavior closer to old JUZU (`>` and working-copy `@` marker)

File rows now use native `files()` hydration through `juzu-jj` for committed changes. The old placeholder has been replaced with compact file summaries in graph rows and typed file lists in the details sidebar.

Diff preview now uses native `diff()` hydration through `juzu-jj` and a structured Pierre/JUZU-style TUI renderer instead of raw line coloring. The sidebar renders strong file section dividers, compact blue/purple hunk bands, dim aligned old/new gutters, tinted add/remove rows with a continuous left mutation band, and centered collapsed-context separators. In log mode the sidebar preview shows a visible diff row range plus a full-width `STICKY ▸ ...` file/hunk context bar, supports `{ / }` previous/next hunk jumps, and keeps retained structured preview rows capped so navigation does not keep huge full patches resident.

View leader behavior is now wired past visible-strip parity for the first real command set: `Ctrl+L c` collapses/expands the sidebar to an old-style compact `[ ]` rail, `Ctrl+L f` toggles file-list expansion, `Ctrl+L x` toggles description expansion, `Ctrl+L h` opens the sidebar help surface, `Ctrl+L t` opens the theme selector surface, `Ctrl+L /` opens the revset prompt surface, and `Ctrl+L Ctrl+D` enters diff view while clearing the leader mode. Theme picker keyboard behavior now supports `j/k` selection, `Enter` applying the selected theme while staying open, and `Esc/q` closing without applying; revset mode now accepts typed query text, applies on `Enter`, and cancels without mutating the stored query on `Esc`. The Rust TUI now embeds and parses all 21 bundled JUZU/Poneglyph-style TOML themes, including slate, ember, tokyo-night, catppuccin, dracula, gruvbox, kanagawa, nord, and the rest of the repository catalogue. Theme TOML parsing maps slate, semantic, and graph lane tokens into Rust `UiTokens` with contrast guards for text/muted text. Status/footer chrome, the main DAG graph, sidebar/details surfaces, and diff renderer now consume the active runtime theme instead of hard-coded slate tokens: graph lanes, selected-node text, working-copy/conflict indicators, commit ids, descriptions, bookmark text, graph file summaries, DAG panel border/background, collapsed-sidebar rail, help/theme/revset panels, details headings, details text, selected current-file rows, file badges, full diff panel border/title/status bars, file headers, hunk headers, sticky context bars, collapse rows, and add/remove/context row colors all route through `app.theme`. The theme picker is now windowed around the selected theme instead of dumping all 21 themes into the sidebar, shows above/below counts, keeps `Enter` apply-stays-open behavior, and renders a small active-token swatch plus current-theme marker. It now also includes an in-TUI preview panel for the currently highlighted theme: surface/panel colors, graph lane swatches, and add/remove diff bands are visible before applying. Selected-row rendering is closer to old Bun `GraphView`: selected graph text uses brightened foreground, selected graph file summaries retain per-file add/mod/delete colors instead of collapsing to one info color, and selected sidebar file badges brighten their active file type. The parity runner asserts these with Rust debug-state JSON and tmux captures across 120/160/206 column widths.

Default chrome now moves back toward Bun/OpenTUI smooth mode: graph, details, and diff surfaces no longer render Ratatui box borders by default, top and bottom bars consume one row unless the View leader needs two, and the bogus third-row `Esc/q Exit` View-leader row is gone. Boxed chrome is now an explicit optional mode through the View leader path (`Ctrl+L`, then `b`) and remains hidden from the Bun-parity View strip so the default visual contract stays smooth. The Rust debug-state emitter exposes `boxedChrome`, and modal parity covers `C-l,b` without disturbing the 120/160/206 column View leader layout. Status mode badges and action/ops/view/bookmark segments now use the same Bun/OpenTUI color-mixing formula (`mix(slate.bg2, tone, 0.42)` for item backgrounds, `mix(slate.text, tone, 0.46)` for item text, and `mix(modeTint, slate.text, 0.18)` for the mode badge) instead of hand-picked approximations. Footer rendering now follows the Bun `FooterBar` layer split more closely: repo path is its own `bg2` segment, bookmark and working-copy id sit on the panel background, layout mode is plain panel text, and only node count gets the right `bg2` success segment.

The old Bun/OpenTUI full diff behavior is now covered by `parity:tui-modal` before implementation changes: `Ctrl+D` swaps the graph pane for a diff pane while keeping the details sidebar, `[ / ]` cycles files in diff mode, `j/k` scroll diff rows without moving DAG selection, and `q`/`Esc`/`g`/`Ctrl+D` return to the log instead of quitting. Diff mode now renders inside a real bordered `diff` panel with a filled title row and a full-width `VIEWPORT diff rows ... SCROLL [...]` status bar, so the full pane has a stronger old-JUZU/Pierre-style surface and visible scroll affordance instead of floating text. The details sidebar switches from generic `Diff` labeling to `Current file preview  secondary` in diff mode, making the sidebar read as a subordinate preview tied to the selected full-pane file. Hunk rows now span like capped bars with a right-side cap, and add/remove code rows now begin with `▌+` / `▌-` mutation bands, so file/hunk/code separators feel less like loose text and more like panelized diff structure. Diff code-row colors now follow the Bun `DiffView.tsx` palette math for line-number gutters and add/remove row backgrounds (`mix(slate.bg0, semantic.fileAdd/fileDel, 0.48)`) instead of the earlier Rust-only dark fixed palette. The Rust TUI now has the first old-style leader-mode status state: the idle strip visibly matches the Bun screenshot shape (`LOG  ^X Act  ^O Ops  ^L View  ^B Book`), and `Ctrl+L` enters a multi-row `VIEW` status bar matching the Bun controls: layout chronological/mainline/bookmark/wc/topological, toggle sidebar, theme picker, toggle files, toggle description, toggle help, revset filter, diff view, and `Esc/q Exit`; `q` exits the leader mode without quitting. Diff mode exposes old-style controls in the top status bar (`^d Log`, `[ ] File`, `j/k Move`, `{/} Hunk`, `Esc Exit`) while the bottom footer follows Bun/OpenTUI `FooterBar` parity: home-compacted repo path (`~/dev/juzu`), bookmark context, working-copy id, layout mode, and node count are split into the same visual layers as the Solid footer rather than lumped into two colored blocks. This fixes the earlier Rust inversion where controls were in the footer and repo/node information was in the header. Rust token usage now reaches beyond that chrome into graph lane colors, graph description/commit/bookmark colors, graph file-summary colors, details/dag panel borders, and sidebar file badges using old `src/core/ui-tokens.ts` values. The details sidebar has also moved closer to the Bun `Sidebar.tsx` rhythm: the redundant Rust-only `Selected` content heading is gone, metadata starts directly at `Change:`, commit ids are no longer truncated to 12 characters, empty bookmarks sections are omitted instead of showing `Bookmarks —`, section labels use the Bun dim-to-text label mix rather than saturated cyan, and file rows now avoid the Rust-only two-space prefix while truncating long paths to the sidebar width with Bun-style ellipsis. The same parity runner now calls the Rust `--debug-state --keys ...` path so modal behavior is asserted with state JSON as well as tmux screen capture, including `{` / `}` hunk-jump scenarios that must remain in diff mode, land exactly on a `HunkHeader` row, and expose the updated sticky file/hunk context in JSON. Horizontal pane sizing now follows old JUZU's 60/40 graph/sidebar split; diff mode keeps the old two-column buffer before the sidebar and truncates long file titles so the back hint remains visible. The modal parity runner now verifies that title/footer/sidebar contract across 120, 160, and 206 column terminals, covers debug-state exit scenarios for `C-d,q`, `C-d,g`, `C-d,C-d`, `C-d,],],Esc`, and `C-d,PageDown,PageUp,Esc`, asserts that diff-mode file cycling visibly marks the selected file in the sidebar file list even after wrapping to a later file beyond the compact sidebar preview window, locks that the full diff pane never shows sidebar-only `preview capped` rows, and checks that the diff-mode sidebar preview follows the selected full-diff file instead of remaining pinned to the first file. Log/sidebar mode keeps the diff preview reachable by reserving sidebar space, and `PageDown/PageUp` scroll the sidebar diff preview without moving DAG selection. Sidebar/log mode keeps capped preview rows for performance, while entering the full diff pane lazily loads uncapped structured rows for the selected change. The structured row cap preserves a per-file slice, so navigating beyond the first diff file renders real rows instead of an empty `File N/N: Diff` pane. This explicitly replaces the bad abandoned fullscreen attempt.

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
- continue old color/theme token parity into exact Bun spacing/shape polish, richer in-TUI theme preview panels, and selected row treatments
- refine boxed/smooth chrome UX after the hidden toggle: decide whether to surface a non-Bun hint, add persistence/config, and keep smooth as default
- expand keyboard/status parity from the first `Ctrl+L` View leader into Actions, Operations, and Bookmarks leader behavior
- wire safe native working-copy snapshot support so `@` dirty files match old `jj diff --summary`
- continue Pierre/JUZU-style diff viewport UX: hunk/file jumping, sticky-ish file/hunk context, and exact patch-fidelity decisions
- hydrate sidebar description through native backend
- keep live tmux proof artifacts attached to restart/checkpoint claims
