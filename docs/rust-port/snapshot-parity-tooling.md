# Snapshot Parity Tooling

Date: 2026-06-13

## What landed

Reusable old-vs-Rust snapshot parity tooling now exists:

```bash
bun run parity:snapshot -- --repo /home/shamanic/dev/juzu --limit 20
```

Under the hood it runs:

1. old Bun oracle: `bun run oracle:snapshot`
2. Rust native snapshot: `cargo run -q -p juzu-cli -- snapshot`
3. JSON comparison
4. HTML review artifact generation

## Latest artifact

`bench/results/rust-port/snapshot-parity/2026-06-13T20-16-07-966Z/snapshot-parity.html`

Generated files in each run:

- `old-oracle-snapshot.json`
- `rust-snapshot.json`
- `parity-report.json`
- `snapshot-parity.html`

## Compared fields

Current comparison:

- commit identity by old short commit prefix vs native full commit id
- parent identity by old-compatible parent change-id prefixes
- title: `descriptionTitle`
- flags: `isEmpty`, `isConflict`, `isHidden`, `isRoot`, `isWorkingCopy`
- normalized author email (`old@example.com` vs `Name <old@example.com>`)
- normalized timestamp with 1 second tolerance (`jj` text timestamp vs RFC3339)
- bookmarks
- git refs

The script captures old and Rust JSON before writing artifact files. That avoids a fake working-copy commit mismatch when benchmarking this repository itself.

This is still not full field/render parity, but it is now broader, reusable, and reviewable as HTML.

## Verification

```bash
bun run parity:snapshot -- --repo /home/shamanic/dev/juzu --limit 20
cargo test --workspace
```

Result:

- parity script runs cleanly
- HTML report generated
- Rust workspace tests pass

Latest self-repo parity at limit 20:

- commit prefixes: 100%
- titles: 100%
- flags: 100%
- authors: 100%
- timestamps: 100%
- bookmarks: 95%
- git refs: 90%
- parent ids: 100%
## Next expansion

Add normalized comparison for:

- old bookmark formatting edge cases (`master*`, remote aliases, `@git` vs `@origin`)
- layout fields once Rust layout is ported
- node count without walking all commits
