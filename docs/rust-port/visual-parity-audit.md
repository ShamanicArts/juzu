# Visual parity audit

The Rust TUI is intentionally benchmarked and parity-tested against the original Bun/OpenTUI JUZU, but visual parity now needs its own explicit loop. The old app remains the oracle for chrome, spacing, pane rhythm, graph density, and diff rendering.

## Review artifact

Generate a side-by-side Bun/Rust tmux capture audit:

```bash
bun run review:visual-parity -- --repo /home/shamanic/dev/juzu --limit 80 --width 164 --height 75
```

The artifact is written under:

```text
bench/results/rust-port/visual-parity-audit/<timestamp>/visual-parity-audit.html
```

## Current findings

- Bun uses a smoother, lower-chrome surface. Heavy Rust borders should become toggleable, not default.
- Rust still has too many boxed panels, broken edge/gutter risks, and large unused gaps.
- Diff rendering is not yet Bun `DiffView.tsx` parity. Bun uses OpenTUI's `<diff>` renderer with full-row mutation backgrounds, line number gutters, and a continuous pane. Rust currently reads more like decorated text.
- Graph and sidebar spacing need a dedicated rhythm pass: row height, blank lines, details hierarchy, and file summary placement.
- Status/footer/leader behavior is close, but exact spacing, casing, and segment shape still need comparison against captures.

## Process rule

For visual work, do not implement by taste alone:

1. Capture Bun and Rust side by side.
2. Pick one visible mismatch.
3. Add parity assertion or artifact check where practical.
4. Implement the smallest visual slice.
5. Restart or run isolated tmux proof.
6. Run tests/benchmark.
7. Commit with JJ.

## Immediate backlog

1. Add a smooth/boxed chrome mode and default to Bun-like smooth chrome.
2. Rework diff pane toward Bun `DiffView.tsx`: full pane, full-row bars, distinct line gutters, no random box scaffolding.
3. Tighten graph/sidebar layout rhythm and remove unused gaps.
4. Continue theme/status/footer polish only with side-by-side artifacts.
