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
- opens read-only OpLog and Obslog views from the Ops leader (`Ctrl+O`, then `o` / `v`) using an explicit CLI fallback path in `juzu-jj`
- matches the current Bun-visible leader triggers: `Ctrl+A` Actions, `Ctrl+O` Ops, `Ctrl+V` View, `Ctrl+B` Bookmarks (while keeping legacy `Ctrl+X` / `Ctrl+L` as hidden compatibility aliases)
- renders richer OpLog/Obslog row content and sidebar details from old-JUZU-compatible fallback fields: short op ids, durations, args tags, operation descriptions, authors, and conflict/working-copy badges
- performs real `jj undo` / `jj redo` from the Ops leader (`Ctrl+O`, then `u` / `r`) with immediate log reload
- performs real `jj git fetch` / `jj git push` from the Ops leader (`Ctrl+O`, then `f` / `p`) with immediate log reload
- restores the selected OpLog operation with `r` or `Enter`, reloading the log and refreshed OpLog state through explicit fallback mutation plumbing
- sets a local `wip/<change-id-prefix>` bookmark from the Bookmarks leader (`Ctrl+B`, then `s`)
- deletes the selected change's first local bookmark from the Bookmarks leader (`Ctrl+B`, then `d`)
- creates a real new child change from the Actions leader (`Ctrl+A`, then `n`)
- edits the selected change as the working copy from the Actions leader (`Ctrl+A`, then `e`)
- inserts a real empty change between the selected parent and its first visible child from the Actions leader (`Ctrl+A`, then `i`)
- opens an inline describe prompt from the Actions leader (`Ctrl+A`, then `d`) and applies `jj describe -r <change> -m ...` on `Enter`
- arms a real two-step rebase flow from the Actions leader (`Ctrl+A`, then `b`), lets selection move to a destination, confirms on `Enter`, and cancels on `Esc`
- abandons the selected change from the Actions leader (`Ctrl+A`, then `a`)
- squashes the selected non-working-copy change into its parent from the Actions leader (`Ctrl+A`, then `s`)
- duplicates the selected change from the Actions leader (`Ctrl+A`, then `y`)
- returns from OpLog/Obslog to the main log with `g`, `q`, or `Esc`
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
bun run review:live-tmux -- --target juzu:rust-tui --expect LOG,Change:
```

## Latest review artifact

Latest token parity swatch:

`bench/results/rust-port/token-parity/2026-06-15T01-46-16.210Z/token-parity.html`

Latest diff render review:

`bench/results/rust-port/diff-render/2026-06-16T17-18-52.829Z/diff-render-review.html`

Latest modal parity proof:

`bench/results/rust-port/tui-modal-parity/2026-06-17T22-48-38-490Z/bookmark-leader-report.html`

Latest OpLog restore mutation proof:

`bench/results/rust-port/op-restore/2026-06-17T21-36-49.248+00-00/op-restore-review.html`

Latest bookmark set/delete proof:

`bench/results/rust-port/bookmark-actions/2026-06-17T22-48-18.358+00-00/bookmark-actions-review.html`

Latest Action leader mutation proof:

`bench/results/rust-port/action-leader/2026-06-23T08-48-43.866+00-00/action-leader-review.html`

Latest Ops undo/redo proof:

`bench/results/rust-port/ops-undo-redo/2026-06-17T22-57-58.611+00-00/ops-undo-redo-review.html`

Latest Ops fetch/push proof:

`bench/results/rust-port/ops-fetch-push/2026-06-22T15-08-28.508+00-00/ops-fetch-push-review.html`

Latest diff scroll sequence proof:

`bench/results/rust-port/diff-scroll-sequence/2026-06-16T19-18-22.018+00-00/diff-scroll-sequence-review.html`

Latest revset sequence proof:

`bench/results/rust-port/revset-sequence/2026-06-16T20-37-01.574+00-00/revset-sequence-review.html`

Latest multi-state status/chrome proof:

`bench/results/rust-port/status-sequence/2026-06-22T12-32-28.822Z/status-sequence-proof.mp4`

Latest raw visual parity audit:

`bench/results/rust-port/visual-parity-audit/2026-06-16T19-08-37.551Z/visual-parity-audit.html`

Latest bundled theme review:

`bench/results/rust-port/theme-port/2026-06-15T03-51-15.876Z/theme-port-review.html`

Latest tmux restart stability proof:

`bench/results/rust-port/tmux-restart/2026-06-22T14-45-51.266+00-00/tmux-restart-proof.html`

Latest live tmux proof:

`bench/results/rust-port/live-tmux/2026-06-23T08-50-11.629Z/live-tmux-proof.html`

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

Diff preview now uses native `diff()` hydration through `juzu-jj` and a structured Pierre/JUZU-style TUI renderer instead of raw line coloring. The sidebar renders strong file section dividers, compact blue/purple hunk bands, Bun `DiffView`-style unified gutters (compact three-column line number, +/- sign cell, then content), full-width add/remove/context content backgrounds, and centered collapsed-context separators. In log mode the sidebar preview shows a visible diff row range plus a full-width `STICKY ▸ ...` file/hunk context bar, supports `{ / }` previous/next hunk jumps, and keeps retained structured preview rows capped so navigation does not keep huge full patches resident.

View leader behavior is now wired past visible-strip parity for the first real command set: `Ctrl+V c` collapses/expands the sidebar to an old-style compact `[ ]` rail, `Ctrl+V f` toggles file-list expansion, `Ctrl+V x` toggles description expansion, `Ctrl+V h` opens the sidebar help surface, `Ctrl+V t` opens the theme selector surface, `Ctrl+V /` opens the revset prompt surface, and `Ctrl+V Ctrl+D` enters diff view while clearing the leader mode (legacy `Ctrl+L` aliases still work behind the scenes). Theme picker keyboard behavior now supports `j/k` selection, `Enter` applying the selected theme while staying open, and `Esc/q` closing without applying; revset mode now accepts typed query text, applies on `Enter`, and cancels without mutating the stored query on `Esc`. The Rust TUI now embeds and parses all 21 bundled JUZU/Poneglyph-style TOML themes, including slate, ember, tokyo-night, catppuccin, dracula, gruvbox, kanagawa, nord, and the rest of the repository catalogue. Theme TOML parsing maps slate, semantic, and graph lane tokens into Rust `UiTokens` with contrast guards for text/muted text. Status/footer chrome, the main DAG graph, sidebar/details surfaces, and diff renderer now consume the active runtime theme instead of hard-coded slate tokens: graph lanes, selected-node text, working-copy/conflict indicators, commit ids, descriptions, bookmark text, graph file summaries, DAG panel border/background, collapsed-sidebar rail, help/theme/revset panels, details headings, details text, selected current-file rows, file badges, full diff panel border/title/status bars, file headers, hunk headers, sticky context bars, collapse rows, and add/remove/context row colors all route through `app.theme`. The theme picker is now windowed around the selected theme instead of dumping all 21 themes into the sidebar, shows above/below counts, keeps `Enter` apply-stays-open behavior, and renders a small active-token swatch plus current-theme marker. It now also includes an in-TUI preview panel for the currently highlighted theme: surface/panel colors, graph lane swatches, and add/remove diff bands are visible before applying. Selected-row rendering is closer to old Bun `GraphView`: selected graph text uses brightened foreground, selected graph file summaries retain per-file add/mod/delete colors instead of collapsing to one info color, and selected sidebar file badges brighten their active file type. The parity runner asserts these with Rust debug-state JSON and tmux captures across 120/160/206 column widths. Ops leader read-only views now consume richer old-compatible fallback payloads too: OpLog rows show current-operation markers, short ids, durations, args-tag command lines, and extra tags; Obslog rows show working-copy/conflict/hidden badges, operation ids, authors, command tags, and longer description blocks in the sidebar instead of the earlier stubby `id/time/title` placeholders. The selected OpLog row is no longer a dead-end: `r` and `Enter` now issue a real `jj op restore` fallback mutation, reload the visible log, and refresh the OpLog surface so the current operation marker follows the restored state. Bookmarks leader is no longer fake chrome either: `Ctrl+B`, then `s` now issues a real fallback `jj bookmark set wip/<change-id-prefix> -r <change>`, and `Ctrl+B`, then `d` deletes the first local bookmark on the selected change before reloading the visible log so footer/sidebar/graph bookmark state updates immediately. Ops leader now lands the first mutation shortcuts too: `Ctrl+O`, then `u` / `r` issue real fallback `jj undo` / `jj redo` mutations and reload the visible log instead of being decorative status-strip lies.

Default chrome now moves back toward Bun/OpenTUI smooth mode: graph, details, and diff surfaces no longer render Ratatui box borders by default, top and bottom bars consume one row unless the View leader needs two, and the bogus third-row `Esc/q Exit` View-leader row is gone. Boxed chrome is now an explicit optional mode through the View leader path (`Ctrl+V`, then `b`) and remains hidden from the Bun-parity View strip so the default visual contract stays smooth. The Rust debug-state emitter exposes `boxedChrome`, and modal parity covers `C-v,b` without disturbing the 120/160/206 column View leader layout. Status mode badges and action/ops/view/bookmark segments now use the same Bun/OpenTUI color-mixing formula (`mix(slate.bg2, tone, 0.42)` for item backgrounds, `mix(slate.text, tone, 0.46)` for item text, and `mix(modeTint, slate.text, 0.18)` for the mode badge) instead of hand-picked approximations. Footer rendering now follows the Bun `FooterBar` layer split more closely: repo path is its own `bg2` segment, bookmark and working-copy id sit on the panel background, layout mode is plain panel text, and only node count gets the right `bg2` success segment.

The old Bun/OpenTUI full diff behavior is now covered by `parity:tui-modal` before implementation changes: `Ctrl+D` swaps the graph pane for a diff pane while keeping the details sidebar, `[ / ]` cycles files in diff mode, `j/k` scroll diff rows without moving DAG selection, and `q`/`Esc`/`g`/`Ctrl+D` return to the log instead of quitting. The full diff pane now follows Bun `DiffView.tsx` more closely by showing the file title and then unified code rows directly; Rust-only patch scaffold rows (`VIEWPORT`, `STICKY`, decorative `◆` file headers, `╭─ @@` hunk bars, and raw `diff --git` metadata) are hidden from the full pane by default, while real diff content markers like `\\ No newline at end of file` remain visible in the code stream. That scaffold/debug presentation is not deleted: users can opt into it at launch with `--diff-scaffold` or toggle it at runtime with `Ctrl+V`, then `s` (legacy `Ctrl+L`, then `s` still works as hidden compatibility). Long full-pane code rows now wrap in a Bun/OpenTUI-like char mode with continuation lines aligned under the code-content column instead of truncating the line; gutter width is shared across the visible file rows and expands with four-plus-digit line numbers so large-file diffs align like a real `<diff>` surface instead of overflowing the pane width. The details sidebar still presents a subordinate `Current file preview  secondary` surface with capped structured preview rows for context and performance; its unified gutters now share the widest visible line-number width for the selected file instead of snapping each preview row back to a three-column gutter. Full-pane code rows use Bun `DiffView.tsx` unified gutter geometry: compact active line number first, padded +/- sign cell second, code content third. The code-content span pads to the remaining pane width so add/remove/context backgrounds read as full rows instead of only coloring the text run. Diff code-row colors follow the Bun `DiffView.tsx` palette math for line-number gutters and add/remove row backgrounds (`mix(slate.bg0, semantic.fileAdd/fileDel, 0.48)`) instead of the earlier Rust-only dark fixed palette. The Rust TUI now has the first old-style leader-mode status state: the idle strip visibly matches the Bun screenshot shape (`LOG  ^A Act  ^O Ops  ^V View  ^B Book`), `Ctrl+V` enters a multi-row `VIEW` status bar matching the Bun controls, and the visible Actions leader is no longer decorative bullshit because `Ctrl+A`, then `n` / `e` / `d` / `y` now issues real fallback `jj new` / `jj edit` / `jj describe` / `jj duplicate` mutations or prompt flow before reloading the log. Diff mode exposes old-style controls in the top status bar (`^d Log`, `[ ] File`, `j/k Move`, `{/} Hunk`, `Esc Exit`) while the bottom footer follows Bun/OpenTUI `FooterBar` parity: home-compacted repo path (`~/dev/juzu`), bookmark context, working-copy id, layout mode, and node count are split into the same visual layers as the Solid footer rather than lumped into two colored blocks. This fixes the earlier Rust inversion where controls were in the footer and repo/node information was in the header. Rust token usage now reaches beyond that chrome into graph lane colors, graph description/commit/bookmark colors, graph file-summary colors, details/dag panel borders, and sidebar file badges using old `src/core/ui-tokens.ts` values. The details sidebar has also moved closer to the Bun `Sidebar.tsx` rhythm: the redundant Rust-only `Selected` content heading is gone, metadata starts directly at `Change:`, commit ids are no longer truncated to 12 characters, empty bookmarks sections are omitted instead of showing `Bookmarks —`, section labels use the Bun dim-to-text label mix rather than saturated cyan, and file rows now avoid the Rust-only two-space prefix while truncating long paths to the sidebar width with Bun-style ellipsis. The same parity runner now calls the Rust `--debug-state --keys ...` path so modal behavior is asserted with state JSON as well as tmux screen capture, including `{` / `}` hunk-jump scenarios that must remain in diff mode, land exactly on a `HunkHeader` row, and expose the updated sticky file/hunk context in JSON. Horizontal pane sizing now follows old JUZU's 60/40 graph/sidebar split; diff mode keeps the old two-column buffer before the sidebar and truncates long file titles so the back hint remains visible. The modal parity runner now verifies that title/footer/sidebar contract across 120, 160, and 206 column terminals, covers debug-state exit scenarios for `C-d,q`, `C-d,g`, `C-d,C-d`, `C-d,],],Esc`, and `C-d,PageDown,PageUp,Esc`, asserts that diff-mode file cycling visibly marks the selected file in the sidebar file list even after wrapping to a later file beyond the compact sidebar preview window, locks that the full diff pane never shows sidebar-only `preview capped` rows, and checks that the diff-mode sidebar preview follows the selected full-diff file instead of remaining pinned to the first file. The live tmux proof script now also requires the active pane command to contain `juzu-tui`, so stale shell scrollback cannot pass just because it still contains old `LOG`/`Change:` text. Log/sidebar mode keeps the diff preview reachable by reserving sidebar space, and `PageDown/PageUp` scroll the sidebar diff preview without moving DAG selection. Sidebar/log mode keeps capped preview rows for performance, while entering the full diff pane lazily loads uncapped structured rows for the selected change. The structured row cap preserves a per-file slice, so navigating beyond the first diff file renders real rows instead of an empty `File N/N: Diff` pane. This explicitly replaces the bad abandoned fullscreen attempt.

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
- expand keyboard/status parity from the landed View/Ops/Bookmarks leader slices into the remaining Actions leader behavior plus fetch/push parity inside Ops
- wire safe native working-copy snapshot support so `@` dirty files match old `jj diff --summary`
- continue Bun `DiffView.tsx` parity: context row color/spacing, exact OpenTUI wrapping edge cases, sidebar/full-pane diff rhythm polish, and exact patch-fidelity decisions
- hydrate sidebar description through native backend
- keep live tmux proof artifacts attached to restart/checkpoint claims
