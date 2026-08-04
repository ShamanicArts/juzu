# Web server

`juzu-server` is Juzu's read-only browser interface and HTTP API. It binds to
`127.0.0.1`, fixes one JJ workspace at startup, and does not accept repository
paths from HTTP requests.

## Run

```bash
cargo run -p juzu-server -- --path /path/to/jj/workspace --port 3000
```

The default port is `3000`. Both `--path=value` and `--path value` forms are
accepted. The embedded commit graph is available at `/`, and `/healthz` returns
`{"status":"ok"}`.

The browser client has no separate JavaScript build. Rust embeds one native ES
module and its CSS from `crates/juzu-server/web/`. Layout is calculated by
`juzu-core` on the server, so the canvas consumes the same domain coordinates as
the other Rust surfaces.

## Browser behaviour

- Pointer drag pans the graph; the wheel and viewport buttons zoom it.
- Clicking a row selects it. `j`/`k`, the arrow keys, `Home`, and `End` provide
  keyboard selection; `f` focuses the selected change and `d` opens its diff.
- Revsets, layout modes, and history limits are fetched without a page reload.
- File summaries load on selection. Textual diffs load only when the Diff tab is
  opened and are capped at 5,000 rendered lines in the client.
- Repository update events refetch the visible history while preserving the
  selected change and viewport when that change still exists.

## API v1

All API responses set `Cache-Control: no-store`.

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/api/v1/repo` | Workspace, repo path, backend, API version, and read-only status |
| `GET` | `/api/v1/log?limit=500&revset=` | Array of commit nodes |
| `GET` | `/api/v1/layout?mode=mainline&limit=500&revset=` | Commit nodes with graph coordinates and layout bounds |
| `GET` | `/api/v1/node-count?revset=` | `{ "count": number }` |
| `GET` | `/api/v1/changes/{id}/files` | Array of typed file summaries |
| `GET` | `/api/v1/changes/{id}/diff` | Git-style diff as UTF-8 text |
| `GET` | `/api/v1/oplog?limit=100` | Operation log entries |
| `GET` | `/api/v1/changes/{id}/obslog?limit=50` | Evolution log entries |
| `GET` | `/api/v1/events` | Server-Sent Events stream |

Log and operation limits are clamped to `1..=2000`. Empty revsets are treated as
unset. Layout modes are `chronological`, `mainline`, `bookmark-centric`,
`wc-focused`, and `topological`; the browser defaults to `mainline`. Errors use
a JSON body:

```json
{"error":"descriptive message"}
```

## Events

An event connection receives `ready` first. Changes to JJ operation heads or
working-copy state produce `repo-updated`. Event data has this shape:

```json
{
  "type": "repo-updated",
  "timestampMs": 1785871029422,
  "sequence": 2
}
```

The stream sends comment heartbeats every 15 seconds. Clients should refetch the
data they display after `repo-updated`; events are invalidations, not snapshots.
On server shutdown, connected event streams close so graceful termination does
not wait indefinitely for browser reconnection channels.

## Execution model

`JjBackend` uses non-`Send` futures. Axum handlers therefore send typed commands
to one dedicated repository executor thread and await one-shot responses. This
keeps backend details out of the web layer and provides deterministic ordering
for future writes.

## Security boundary

The current server is local and read-only. It intentionally has no non-loopback
bind option and no mutation routes. Before either is added, the server needs an
explicit remote-access design covering authentication, origin validation, CSRF
protection, and transport security.
