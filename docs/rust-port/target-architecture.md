# JUZU Rust Port Target Architecture

Date: 2026-06-13

## Goal

Port JUZU to Rust without shrinking the product. The Rust app should preserve the old Bun/OpenTUI/Solid app as an oracle while replacing the heavy runtime with a native core, native JJ backend, and multiple thin surfaces.

```text
old JUZU oracle ── snapshots/tests/benchmarks ──► Rust JUZU parity target

Rust JUZU = shared app core + native jj backend + TUI/server/CLI adapters
```

## Non-negotiables

1. **Native JJ first.** Use `jj-lib` and `jj-cli` crates as the primary backend integration. Shelling out to `jj` is an explicit fallback, not the architecture.
2. **One core, many surfaces.** TUI, web/server, debug/oracle CLI, and future GUI must call the same domain/usecase/backend layer.
3. **Old JUZU stays runnable.** It remains the oracle until Rust parity is proven.
4. **No server bypass repeat.** Rust HTTP handlers must not bypass the core/backend layer the way old `server.ts` bypasses `JJBackend`.
5. **Parity is measured.** Every slice should add or reuse one of: oracle JSON, golden snapshot, benchmark result, tmux review surface, or proof artifact.

## Workspace shape

```text
/home/shamanic/dev/juzu/
  Cargo.toml
  crates/
    juzu-core/
    juzu-jj/
    juzu-tui/
    juzu-server/
    juzu-cli/
```

This keeps the Rust port beside the old oracle instead of creating a disconnected repo. If the workspace gets too disruptive, it can be split later, but the first scaffold should live here so old/new parity fixtures and docs stay together.

## Crate responsibilities

### `juzu-core`

Pure app/domain layer. No terminal, no HTTP server, no process-global mutable config, and no direct dependency on Ratatui.

Owns:

- domain structs: commits, operations, obslog entries, files, diffs, bookmarks
- app state: current view, selected node/op/file, caches, status, prompts
- reducers/actions: key-independent state transitions
- usecases: refresh graph, load files/diff/description, run mutations, prune caches
- graph layout: chronological, mainline, bookmark-centric, wc-focused, topological
- keymap command model: command IDs and leader-mode resolution
- config/theme token structs
- oracle snapshot structs

Public shape:

```rust
pub trait JjBackend: Send + Sync {
    async fn find_root(&self, start: &Path) -> Result<Option<PathBuf>>;
    async fn log(&self, query: LogQuery) -> Result<Vec<CommitNode>>;
    async fn node_count(&self, query: NodeCountQuery) -> Result<usize>;
    async fn diff(&self, query: ChangeQuery) -> Result<String>;
    async fn files(&self, query: ChangeQuery) -> Result<Vec<FileEntry>>;
    async fn op_log(&self, query: OpLogQuery) -> Result<Vec<OpLogEntry>>;
    async fn obslog(&self, query: ObslogQuery) -> Result<Vec<ObslogEntry>>;
    async fn mutate(&self, op: Mutation) -> Result<MutationResult>;
}
```

Exact Rust signatures can change during implementation, but the boundary should stay: core asks a backend for JJ data and never shells out directly.

### `juzu-jj`

Native JJ adapter implementing `juzu_core::JjBackend`.

Primary dependencies verified from Cargo registry:

- `jj-lib = "0.42.0"`
- `jj-cli = "0.42.0"`

Responsibilities:

- open repo/workspace from a start directory
- convert native JJ objects into JUZU domain structs
- expose operation log and obslog equivalents
- perform mutations through JJ APIs where available
- isolate any CLI/template fallback in `cli_fallback.rs`
- annotate each fallback with why native API was not used yet

Fallback rule:

```text
allowed: juzu-jj::cli_fallback for missing/awkward parity cases
forbidden: random shell-out from TUI/server/core
```

### `juzu-tui`

Ratatui review surface and eventual replacement for OpenTUI.

Owns:

- terminal lifecycle and panic cleanup
- crossterm event loop
- input mapping from keys/mouse to core commands
- Ratatui widgets for graph/sidebar/diff/oplog/obslog/footer
- tmux-friendly review command
- optional debug overlay for frame timing/memory counters

The TUI controller should be testable without a terminal:

```text
scripted keys -> controller -> core actions -> snapshot
```

### `juzu-server`

HTTP/SSE adapter over the same core/usecase/backend stack.

Owns:

- `/api/repo`, `/api/log`, `/api/files`, `/api/diff`, `/api/oplog`, `/api/obslog`
- mutation endpoints
- SSE repo-change events
- static web app serving if the TS web frontend survives
- JSON contracts compatible with old web client where feasible

Server handlers should be thin:

```text
HTTP request -> command/query DTO -> app service -> response DTO
```

### `juzu-cli`

Debug/oracle/bench command entrypoint.

Initial commands should be added before full UI work:

- `snapshot --repo <path> --limit <n>`
- `layout --repo <path> --mode <mode>`
- `sidebar --repo <path> --selected <change-id>`
- `state-after-keys --repo <path> --keys <script>`
- `bench-startup` once Rust binaries exist

This crate gives parity tests a stable machine-readable surface without scraping a terminal.

## Data-flow target

```text
TUI key / HTTP request / CLI command
  -> command DTO
  -> juzu-core usecase
  -> juzu-core JjBackend trait
  -> juzu-jj native backend
  -> juzu-core AppState + LayoutResult + ViewModel
  -> adapter render/serialize
```

No adapter should own a second source of truth for graph state.

## Old-to-new endpoint parity

| Old surface | Rust target | Parity strategy |
| --- | --- | --- |
| `src/core/jj-api.ts` | `juzu-jj` | Compare JSON oracle outputs first; only then render. |
| `src/core/layout.ts` | `juzu-core::layout` | Golden tests per layout mode and fixture repo. |
| `src/core/tui-keymap.ts` | `juzu-core::keymap` | Resolve current keymap drift before declaring parity. |
| `src/tui/App.tsx` | `juzu-tui` controller/widgets | Scripted key snapshots + tmux visual review. |
| `server.ts` | `juzu-server` | HTTP contract tests against old `/api/*`. |
| `scripts/bench/*` | Rust + old benchmark harness | Keep old harness for oracle, add Rust equivalents as crates exist. |

## First implementation slices

### Slice A — Rust workspace scaffold

Deliverables:

- root `Cargo.toml` workspace
- empty crates with compile-only skeletons
- `juzu-cli --version` or `juzu-cli snapshot --help`
- CI/local command documented

Proof:

- `cargo test --workspace`
- tiny proof MP4 only if the review surface benefits from it

### Slice B — native repo-open spike

Deliverables:

- `juzu-jj` opens a JJ repo from cwd/start path using `jj-lib`/`jj-cli`
- `juzu-cli repo --path <repo>` emits `{ cwd, workspace_root, repo_root }`
- tests against a temporary `jj init` fixture

Proof:

- JSON artifact in `bench/results/rust-port/native-jj-spike/...`
- JJ commit

### Slice C — old oracle emitters

Deliverables in old TS app before deeper Rust porting:

- `snapshot`
- `layout`
- `sidebar`
- `state-after-keys`

Proof:

- fixed fixture output checked into `bench/results/rust-port/oracle/...`

### Slice D — Rust read-only log parity

Deliverables:

- Rust `snapshot` emits commit nodes compatible with old oracle
- basic parser/converter coverage
- mismatch report script

Proof:

- side-by-side old/Rust JSON parity result

### Slice E — read-only Ratatui graph

Deliverables:

- tmux window `rust-tui`
- read-only graph/sidebar render
- navigation without mutations

Proof:

- visual tmux review + optional MP4 if useful

## Performance gates

Initial old-JUZU baseline floors:

| Gate | Old baseline |
| --- | ---: |
| Core/TUI scenario RSS steady on JUZU repo | ~65.90 MB |
| Live interactive TUI RSS steady | ~175.37 MB |
| Live web server RSS steady | ~88.53 MB |
| TUI startup to first header median | ~328 ms |
| Web startup to `/api/repo` ready median | ~300 ms |

Early Rust targets:

- read-only Ratatui TUI steady RSS: **under 40 MB**
- first header: **under 200 ms** if native JJ initialization permits
- server `/api/repo` ready: **under 150 ms**

These are targets, not excuses to break UX parity.

## Testing layers

1. **Unit:** layout, keymap, reducers, config merge, theme token parsing.
2. **Backend fixtures:** temp JJ repos with known commit shapes.
3. **Oracle JSON:** old Bun output vs Rust output.
4. **Scripted input:** `state-after-keys` on old and Rust surfaces.
5. **HTTP contract:** old `/api/*` vs Rust `/api/*`.
6. **TUI review:** tmux read-only and interactive slices.
7. **Benchmarks:** RSS, startup, refresh, navigation p95.

## Open questions before scaffold

1. Should the old TS package and Rust workspace share a root `package`/`Cargo` release version, or version independently until Rust is dominant?
2. Should the TS web frontend be preserved long-term against the Rust server, or replaced after Rust TUI parity?
3. Which old keymap behavior is authoritative: current source leaders or stale tests?
4. Which JJ operations require `jj-cli` command helpers versus direct `jj-lib` use?
5. How much of old theme TOML should become stable config contract for Rust surfaces?

## Immediate next move

Create the workspace scaffold only after old oracle emitters are started or explicitly deferred. The safest order is:

```text
startup baseline (done)
  -> target architecture (this doc)
  -> old oracle emitters
  -> Rust workspace scaffold
  -> native JJ repo-open spike
```
