# Rust TUI benchmarks

Date: 2026-06-13

## Purpose

Benchmark the current Rust/Ratatui JUZU graph surface as rendering gets more realistic. This complements the old Bun/OpenTUI baseline and should be rerun after meaningful TUI, sidebar, file, diff, or native-JJ operation slices.

Benchmark runs intentionally pass smaller explicit `--limit` values. The product Rust TUI default is `500`, matching original JUZU scale; benchmark limits must not leak back into app defaults.

## Runner

```bash
bun run bench:rust-tui -- --repo /home/shamanic/dev/juzu --limit 80 --runs 3
```

The runner:

- builds `juzu-tui` in release mode
- launches the release binary inside a PTY with a fixed terminal size
- captures startup-to-header timing
- samples `/proc/<pid>/smaps_rollup` for RSS/PSS/swap
- drives scripted key scenarios through the PTY
- writes JSON and HTML review artifacts

## Scenarios

- `idle-mainline` — steady-state render loop on mainline layout
- `navigate-mainline` — repeated `j/k` selection movement through DAG rows
- `layout-switching` — repeated `1-5` layout switches plus navigation

## Latest artifact

`bench/results/rust-port/rust-tui-bench/2026-06-23T17-04-33-761Z/rust-tui-benchmark.html`

## Current headline

Current benchmark is for the Rust TUI after native `files()` hydration, lazy selected-node native `diff()` preview hydration, structured diff rendering, old-style diff pane navigation, View leader behavior, bundled themes, runtime theme wiring, selected-row polish, the first Bun-smooth chrome correction, the optional boxed-chrome toggle, Bun/OpenTUI-style status segment color mixing, the first FooterBar layer split pass, the Bun-style details sidebar rhythm pass, Bun-like sidebar file-row truncation, the first Bun `DiffView.tsx` color-palette pass, Bun-style unified diff gutter ordering, the full diff-pane scaffold removal pass, full-pane char wrapping for long code rows with shared large line-number gutters, opt-in diff scaffold mode via `--diff-scaffold` or `Ctrl+V`, then `s` (with legacy `Ctrl+L` hidden as compatibility), the Bun-parity diff-mode sidebar pass that hides Rust-only inline diff preview chrome from the full diff review surface, the Bun diff-status chrome pass that switches the visible controls to `[] File` and `escape Exit` while removing the Rust-only visible hunk hint from the top bar, the diff-scroll overshoot fix that clamps full-pane scroll state back to the visible viewport so one upward move from bottom immediately reveals earlier rows again, the broader revset parity slice that now parses native JJ revsets in the Rust backend and refreshes the live TUI log when the revset prompt is submitted, the richer read-only Ops leader slice that opens OpLog/Obslog views through explicit `juzu-jj` CLI fallback queries while rendering old-compatible durations, args tags, operation metadata, and sidebar detail blocks instead of the earlier thin placeholders, the OpLog restore parity slice where `r` / `Enter` now issue a real fallback `jj op restore`, reload the log, and refresh the OpLog view instead of doing nothing, the Bookmarks leader slice where `Ctrl+B`, then `s` / `d` now issue real fallback `jj bookmark set` / `jj bookmark delete` mutations and immediately reload footer/sidebar/graph bookmark state, the Ops mutation slice where `Ctrl+O`, then `u` / `r` now issue real fallback `jj undo` / `jj redo` mutations and immediately reload the visible log, and the new Actions leader slice where `Ctrl+A`, then `n` / `e` / `a` / `s` / `y` now issues real fallback `jj new` / `jj edit` / `jj abandon` / `jj squash` / `jj duplicate` mutations while the visible idle strip matches Bun's `^A Act  ^O Ops  ^V View  ^B Book` trigger contract. Ops leader now lands the remaining obvious remote actions too: `Ctrl+O`, then `f` / `p` issues real fallback `jj git fetch` / `jj git push` mutations, reloads the visible log, and is covered by dedicated temp-remote proof artifacts instead of fake chrome. Actions leader now covers a wider real mutation set instead of fake chrome: `Ctrl+A`, then `d` opens an inline describe prompt, accepts text edits, and commits a real fallback `jj describe -r <change> -m ...` on `Enter`; `Ctrl+A`, then `b` arms a rebase source, keeps the Rust TUI in a visible `REBASE` mode while selection moves, confirms on `Enter`, and issues a real fallback `jj rebase -r <source> -d <destination>`; `Ctrl+A`, then `i` inserts a real empty change between the selected parent and its first visible child by issuing fallback `jj new <parent>` plus `jj rebase -s <child> -d @` before reloading the visible log; `Ctrl+A`, then `m` opens a real merge-selection mode where `Space` toggles parent commits, `Enter` creates a new merge change with both selected parents, and `Esc` cancels cleanly; and `Ctrl+A`, then `z` now issues a real fallback `jj restore --changes-in <change>` so the selected change becomes empty again without losing its description. Graph/details/diff borders remain disabled by default, status/footer bars consume only their needed rows, the footer separates repo/bookmark/wc/layout/node-count like Bun, file rows cap to pane width with ellipsis instead of overflowing, diff add/remove rows use the same `mix(slate.bg0, semantic.fileAdd/fileDel, 0.48)` background formula as the Bun `<diff>` component, diff code rows now show a compact active line-number gutter followed by the padded +/- sign before content, sidebar preview gutters share the widest visible line-number width for the selected file, code-content backgrounds fill the remaining row width like Bun `<diff>`, the full diff pane hides Rust-only `VIEWPORT`/`STICKY`/file-header/hunk-bar scaffold rows by default so it starts with Bun-style code rows under the title, keeps `\\ No newline at end of file` markers visible as code-stream rows, long full-pane code rows wrap in char mode with continuation lines aligned under content using one shared gutter width even when line numbers expand beyond three digits, diff mode leaves the right pane focused on details/files instead of a second Rust-only inline preview, revset submit now genuinely rehydrates the visible node list instead of only storing draft text, and the visible Actions/Ops/Bookmarks leaders no longer dead-end in the Rust port. This benchmark also includes the safe native dirty-working-copy snapshot slice: selecting `@` now snapshots the filesystem through `jj-lib` without finishing the mutation, so files/diff hydration sees unsnapshotted tracked/new files while unified hunk headers normalize to old/JJ single-line form. Binary diffs now stay metadata-only in the full pane too, so cycling onto `.png`/other binary files shows `Binary files ... differ` instead of lossy garbage text. Pure unchanged renames now match old JUZU/JJ in both summary and git-patch form, so the diff pane shows `rename from ...` / `rename to ...` metadata instead of fake add/delete blocks. Rename detection now also covers renames with content modification: a similarity-based pass pairs remaining deletes with the most similar unmatched add (line-level `similar` ratio >= 0.5, mirroring old `jj diff`'s default threshold), so a renamed-and-edited file emits `rename from`/`rename to` followed by the real content hunk instead of fake add/delete blocks, while pure renames with identical content still emit metadata only. Theme persistence now matches old JUZU's repo-local behavior: selecting a theme in the Rust picker writes `[theme]\nname = "..."` to `.juzu.local.toml`, and relaunch reloads the saved theme instead of snapping back to slate. The sidebar file toggle now matches old JUZU's expand/collapse contract too (`all` vs `first 8 + more`) instead of the earlier Rust-only 3/4/12 file window, and plain `f` in the main log view now toggles that files section directly as a Rust convenience shortcut so the on-screen `Files (f collapse)` hint finally does what it says. Inline diff preview height also scales with pane height (`max(6, floor(height * 0.35))`) instead of being hardcoded to 14 rows, so taller terminals reveal more of the selected diff preview. Log/sidebar preview ordering now follows the same product-file-first rule as full diff mode, so wide proof-heavy changes surface real source files first instead of defaulting the sticky preview to generated `bench/results/...` artifacts.

| Scenario | RSS peak | RSS steady median | PSS steady median | Header median |
| --- | ---: | ---: | ---: | ---: |
| `idle-mainline` | 15.70 MB | 15.52 MB | 13.20 MB | 172.54 ms |
| `navigate-mainline` | 68.15 MB | 66.95 MB | 64.67 MB | 185.53 ms |
| `layout-switching` | 54.54 MB | 48.81 MB | 42.49 MB | 210.46 ms |

The visual renderer itself keeps idle memory close to the earlier capped-diff baseline. Hard-capping retained structured preview rows dropped navigation peak RSS from 35.81 MB to 28.52 MB and layout-switching peak RSS from 34.66 MB to 28.02 MB while preserving the crafted sidebar preview. The headline remains far below the old live Bun/OpenTUI TUI (~175 MB RSS steady).

Use the HTML artifact as the source of truth for exact per-run values.

## Expected use going forward

Rerun this benchmark before/after:

- native `files()` hydration
- diff/sidebar rendering
- op log and obslog views
- merge/fork-heavy fixture graph rendering
- keymap/state parity additions
- any rendering hot path rewrite
