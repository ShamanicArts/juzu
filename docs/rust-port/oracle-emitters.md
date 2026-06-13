# Old JUZU Oracle Emitters

Date: 2026-06-13

## Purpose

These emitters make the old Bun/OpenTUI/Solid JUZU app usable as a machine-readable oracle for the Rust port. They are intentionally JSON-first so the Rust workspace can compare behavior without scraping the terminal.

Entrypoint:

```bash
bun run scripts/rust-port-oracle.ts <command> [options]
```

Package aliases:

```bash
bun run oracle:snapshot
bun run oracle:layout
bun run oracle:sidebar
bun run oracle:state
```

## Commands

### `snapshot`

Emits repo metadata, node count, returned commit nodes, default keymap, and layout summary.

```bash
bun run oracle:snapshot --limit 200 --output /tmp/juzu-snapshot.json
```

Use for:

- Rust `CommitNode` field parity
- keymap/default leader snapshot parity
- basic graph/layout smoke checks

### `layout`

Emits deterministic layout coordinates for a fixed layout mode.

```bash
bun run oracle:layout --limit 200 --mode mainline --output /tmp/juzu-layout.json
```

Supported modes:

- `chronological`
- `mainline`
- `bookmark-centric`
- `wc-focused`
- `topological`

Use for:

- Rust graph layout golden tests
- lane/x/y coordinate parity checks
- max-lane/text-column/height parity checks

### `sidebar`

Emits selected commit summary, file list, and a compact diff summary.

```bash
bun run oracle:sidebar --limit 50 --selected @ --output /tmp/juzu-sidebar.json
```

`--selected` accepts a change-id or commit-id prefix. If omitted, the working copy is selected when present.

Use for:

- sidebar/details parity
- file list parity
- diff loading smoke checks

### `state-after-keys`

Replays a deterministic key script through a lightweight old-JUZU state model using the current keymap resolver.

```bash
bun run oracle:state --limit 50 \
  --keys 'ctrl+v 2 down down ctrl+v f ctrl+d esc' \
  --output /tmp/juzu-state.json
```

Use for:

- leader-key parity
- layout switch parity
- selection movement parity
- toggle/view-state parity

Current limitation: mutating and prompt-heavy commands stop at `pendingCommand`; they do not mutate the repo. That is intentional for the first oracle slice.

## First smoke artifact

Generated at:

`bench/results/rust-port/oracle/2026-06-13T19-43-51-933Z/`

Files:

- `snapshot.json`
- `layout-mainline.json`
- `sidebar.json`
- `state-after-keys.json`
- `SUMMARY.md`

## Rust-port usage

The first Rust parity harness should run old and Rust commands side by side:

```text
old oracle JSON -> normalized expected JSON
rust CLI JSON   -> normalized actual JSON
diff/report     -> parity score + mismatches
```

Start with read-only commands before mutating operations.
