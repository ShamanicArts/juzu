# Old JUZU oracle emitter smoke artifact

This is the first machine-readable old-JUZU oracle surface for the Rust port.

| Emitter | Artifact | Headline |
| --- | --- | --- |
| snapshot | `snapshot.json` | 20 returned nodes / 117 total nodes |
| layout | `layout-mainline.json` | mode `mainline`, max lane 0 |
| sidebar | `sidebar.json` | selected `osrquput`, 4 files, 1414 diff lines |
| state-after-keys | `state-after-keys.json` | keys `ctrl+v 2 down down ctrl+v f ctrl+d esc`, selected index 2, view `log`, layout `mainline` |

Commands used:

```bash
bun run oracle:snapshot --limit 20 --output snapshot.json
bun run oracle:layout --limit 20 --mode mainline --output layout-mainline.json
bun run oracle:sidebar --limit 20 --output sidebar.json
bun run oracle:state --limit 20 --keys 'ctrl+v 2 down down ctrl+v f ctrl+d esc' --output state-after-keys.json
```
