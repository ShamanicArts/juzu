# JUZU Rust Port Architecture Map

Date: 2026-06-13

## Principle

```text
Old JUZU = oracle/reference
Rust JUZU = native jj-lib/jj-cli app core + TUI/web adapters
```

This document records the current TypeScript/Bun JUZU boundaries before any Rust porting starts. The old app should stay runnable and gain oracle/debug emitters rather than being simplified away.

## Current repository shape

### Core domain and orchestration

| Current file | Role today | Rust-port target |
| --- | --- | --- |
| `src/core/types.ts` | Shared graph/domain structs: `CommitNode`, `LayoutMode`, `FilesCacheEntry`, `GraphConfig`, `ViewportState`, `LayoutResult`. | `crates/juzu-core`: serializable domain + viewmodel structs. |
| `src/core/backend.ts` | `JJBackend` interface covering read queries, mutations, bookmarks, git fetch/push, oplog, obslog. | `crates/juzu-core::JjBackend` trait. |
| `src/core/runtime.ts` | Global backend slot via `setBackend()` / `getBackend()`. | Dependency injection at app construction; avoid process-global backend in Rust core where possible. |
| `src/core/state.ts` | Solid store for shared state, selection/navigation, layout memo, cache maps, view mode. | `juzu-core::AppState` + reducer/actions usable by TUI, server, and oracle emitters. |
| `src/core/usecases.ts` | Async orchestration over `JJBackend`: refresh, cache pruning, lazy files/diff/description, mutation wrappers. | `juzu-core::Usecases` or app service layer over backend trait. |
| `src/core/layout.ts` | Pure graph lane/coordinate layout for 5 modes. | `juzu-core::layout`; early golden tests. |
| `src/core/diff.ts` | Diff splitting helpers. | `juzu-core::diff`. |
| `src/core/jj-api.ts` | Current shell-out implementation and parsers/templates for `jj log`, `jj diff`, `jj op log`, `jj obslog`, mutations. | `crates/juzu-jj`; native `jj-lib` first, `jj-cli` helpers only where CLI behavior is required or APIs are missing. |
| `src/core/config-loader.ts` | Layered config/theme loading from global, repo, local, env, CLI. Also bootstraps `~/.config/juzu`. | `juzu-core::config` plus adapter-specific loaders; avoid unwanted global bootstrap during tests/oracle runs. |
| `src/core/runtime-config.ts` | Runtime config singleton and defaults. | Immutable loaded config passed to app/surface constructors. |
| `src/core/tui-keymap.ts` | Leader-mode keymap config and command resolution. | `juzu-core::keymap`; shared with TUI and state-after-keys oracle. |
| `src/core/ui-tokens.ts` | Theme token defaults and mutable active token merge. | `juzu-core::theme` tokens; surfaces map tokens to Ratatui/web colors. |

### TUI surface

| Current file | Role today | Rust-port target |
| --- | --- | --- |
| `src/tui/main.ts` | OpenTUI/Solid entrypoint. | `crates/juzu-tui` binary/app runner. |
| `src/tui/App.tsx` | Main interactive TUI controller: config, backend setup, watchers, keyboard/mouse handling, confirmation prompts, theme picker, memory trace, layout sizing. | Ratatui event loop + controller; keep behavior oracle-compatible but split controller logic from rendering. |
| `src/tui/backend.ts` | Adapts shell-out helpers to `JJBackend`. | Replaced by `juzu-jj` backend implementation. |
| `src/tui/components/*` | Graph, sidebar, diff, oplog, obslog, status/footer render components. | `juzu-tui::ui::*` Ratatui widgets backed by shared viewmodels. |
| `src/tui/telemetry.ts` | Graph draw telemetry for memory debugging. | Optional TUI metrics/debug output. |
| `src/core/state-tui.ts` | TUI-only UI state: leader mode, prompts, sidebar toggles, theme picker, etc. | `juzu-tui::TuiState`, but key transitions should be testable without terminal. |

### Web/API surface

| Current file | Role today | Rust-port target |
| --- | --- | --- |
| `server.ts` | Bun HTTP adapter. Calls `jj-api.ts` directly instead of going through `JJBackend`; serves API, SSE, static/bundled app, theme endpoints. | `crates/juzu-server` HTTP/SSE adapter over Rust core/backend. |
| `src/web/api.ts` | Browser client API wrapper. | Either preserved TS client against Rust HTTP API or regenerated bindings. |
| `src/web/backend.ts` | Adapts HTTP API to `JJBackend` for web Solid app. | If preserving TS frontend, keep this shape and point it at Rust server. |
| `src/web/App.tsx` and components | Canvas graph UI and web state wiring. | Decide later: preserve TS frontend, port, or replace with static/canvas app. |
| `src/core/state-web.ts` | Web-only state: viewport, op mode, navigation lock, theme. | Web adapter state if TS frontend survives; shared viewmodel endpoints if ported. |

## Current JJ backend surface

`src/core/backend.ts` defines the contract the Rust port must match first:

### Read/query methods

- `findRoot(startDir)`
- `log({ cwd, limit, revset }) -> CommitNode[]`
- `nodeCount({ cwd, revset }) -> number`
- `description({ cwd, changeId }) -> string`
- `files({ cwd, changeId }) -> FileEntry[]`
- `diff({ cwd, changeId }) -> string`
- optional `diffFile({ cwd, changeId, path }) -> string`
- `opLog({ cwd, limit }) -> OpLogEntry[]`
- `obslog({ cwd, changeId, limit }) -> ObslogEntry[]`

### Mutations

- change ops: `new`, `edit`, `describe`, `abandon`, `duplicate`, `rebase`, `undo`, `redo`
- structural/content ops: `move`, `insert`, `squash`, `split`, `restore`
- bookmarks: `bookmarkSet`, `bookmarkDelete`, `bookmarkRename`, `bookmarkTrack`, `bookmarkUntrack`
- git remotes: `gitFetch`, `gitPush`
- operation log mutation: `restoreOperation`

The Rust backend should expose this as an async trait or command service while keeping domain structs serde-friendly for snapshot/oracle reports.

## Current model contracts to preserve

### `CommitNode`

Fields: `changeId`, `commitId`, `parents`, `author`, `time`, `bookmarks`, `gitBranches`, `descriptionTitle`, `descriptionFull`, booleans for empty/conflict/hidden/root/working-copy, plus layout fields `x`, `y`, `lane`, `extraHeight`, `isPinned`.

Rust split recommendation:

- `CommitNode`: immutable JJ/domain data.
- `LayoutNode`: domain data + layout coordinates.
- `CommitViewModel`: render-ready strings/badges/files/diff summaries.

### Operation and obslog entries

`OpLogEntry` and `ObslogEntry` currently live in `src/core/jj-api.ts`; they should move to Rust core domain types and be emitted by both native backend and oracle harness.

### Layout modes

Must preserve all five layout modes:

1. `chronological`
2. `mainline`
3. `bookmark-centric`
4. `wc-focused`
5. `topological`

The current layout code is mostly pure and should be ported before Ratatui UI work.

## Current state/usecase boundaries

The strongest existing boundary is:

```text
surface event -> command/keymap -> usecase -> JJBackend -> state update -> layout/view render
```

Keep this. The weak spots to fix in Rust are:

1. `server.ts` bypasses `JJBackend` and calls `jj-api.ts` directly.
2. Core state is tied to Solid stores/memos.
3. Runtime config and UI tokens use process-global mutable singletons.
4. TUI `App.tsx` mixes backend setup, rendering, input, process watchers, theme picker, tracing, and mutation orchestration.

## Config/keymap/theme behavior

### Config layers today

`resolveRuntimeConfig()` merges, in order:

1. default runtime config
2. global config: `$XDG_CONFIG_HOME/juzu/config.toml`
3. repo config: `<repo>/.juzu.toml`
4. repo-local config: `<repo>/.juzu.local.toml`
5. env config path: `JUZU_CONFIG`
6. CLI config path: `--config=...`
7. theme config: `themes/config.toml`
8. named or explicit theme file
9. CLI/env selected theme via `--theme` / `JUZU_THEME`

Important gotcha: the current loader bootstraps global config/themes unless `JUZU_DISABLE_BOOTSTRAP=1`.

### Keymap today

Default leader modes in source are currently:

- `ctrl+a` => Actions
- `ctrl+o` => Operations
- `ctrl+v` => View
- `ctrl+b` => Bookmarks

There is existing test drift expecting old `ctrl+x` behavior. Baseline tests currently catch this drift and must be resolved in either old JUZU or the Rust oracle expectations before parity is declared.

### Theme tokens today

Themes are TOML files under `themes/`. Runtime tokens live in `UI_TOKENS` and include slate backgrounds, semantic colors, graph colors, spacing, radius, and separators.

Rust should parse the same bundled theme files and expose token snapshots for parity testing.

## Web bypass note

The web frontend uses `src/web/backend.ts` to satisfy the shared `JJBackend` interface in the browser, but `server.ts` itself bypasses that interface and calls the shell-out `jj-api.ts` helpers directly. The Rust server should not repeat that split: HTTP handlers should call the same app/service layer the TUI uses.

## Initial target Rust workspace mapping

```text
crates/juzu-core
  domain.rs        CommitNode, OperationEntry, ObslogEntry, FileChange
  state.rs         AppState, ViewMode, selection/navigation reducers
  usecases.rs      refresh/cache/mutation orchestration over JjBackend
  layout.rs        5 graph layout modes
  keymap.rs        command ids + state-after-keys support
  theme.rs         config/theme tokens
  oracle.rs        serializable snapshots

crates/juzu-jj
  backend.rs       Native jj-lib/jj-cli backend implementing JjBackend
  cli_fallback.rs  Explicit shell-out fallback only where needed

crates/juzu-tui
  main.rs          Ratatui runner
  ui/              graph/sidebar/diff/oplog/obslog/footer widgets
  controller.rs    input/event handling around juzu-core

crates/juzu-server
  main.rs          HTTP/SSE adapter over juzu-core services

crates/juzu-cli
  main.rs          debug/oracle/bench command entrypoint
```

## Immediate parity risks

1. Native `jj-lib` APIs may not expose every CLI template convenience directly; keep CLI fallback isolated and documented.
2. Current tests are not all green: keymap drift and a missing `react/jsx-dev-runtime` TUI compile dependency surfaced during baseline.
3. Old JUZU currently has strong memory benchmark tools, but limited oracle/debug emitters. Add emitters before porting graph/UI behavior.
4. Config bootstrap touches user config unless disabled. Rust tests/oracle runs should default to no bootstrap.
5. Layout and UI state are currently coupled to Solid reactivity; Rust needs pure reducers to make `state-after-keys` deterministic.

## Phase 0 status

Phase 0 is now a real baseline map, not vibes. Current architecture boundaries are documented, the backend contract is enumerated, and Rust crate mapping is sketched. The next architecture artifact should be `docs/rust-port/target-architecture.md` after the baseline benchmark doc is committed.
