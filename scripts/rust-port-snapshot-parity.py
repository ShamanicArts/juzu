#!/usr/bin/env python3
"""Run old-JUZU vs Rust snapshot parity and emit JSON + HTML review artifacts."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import pathlib
import re
import subprocess
import sys
from typing import Any


def run(cmd: list[str], cwd: pathlib.Path, stdout_path: pathlib.Path | None = None) -> str:
    if stdout_path:
        with stdout_path.open("w") as f:
            subprocess.run(cmd, cwd=cwd, stdout=f, stderr=subprocess.PIPE, text=True, check=True)
        return stdout_path.read_text()
    proc = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
    return proc.stdout


def load_json(path: pathlib.Path) -> Any:
    return json.loads(path.read_text())


def _as_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted(str(v) for v in value)


def _commit_prefix_match(old_value: Any, rust_value: Any) -> bool:
    old_s = str(old_value or "")
    rust_s = str(rust_value or "")
    return bool(old_s and rust_s and (old_s.startswith(rust_s) or rust_s.startswith(old_s)))


def _parent_identity_match(old_parents: Any, rust_parents: Any) -> bool:
    old_list = old_parents if isinstance(old_parents, list) else []
    rust_list = rust_parents if isinstance(rust_parents, list) else []
    if len(old_list) != len(rust_list):
        return False
    # Old JUZU currently stores parent change-id prefixes, while the native backend
    # emits full parent commit IDs. Treat this as separately tracked work instead of
    # hiding it inside identity. Commit identity can still be verified reliably.
    return all(_commit_prefix_match(o, r) for o, r in zip(old_list, rust_list))


def _normalize_author(value: Any) -> str:
    text = str(value or "").strip()
    match = re.search(r"<([^>]+)>", text)
    return (match.group(1) if match else text).lower()


def _normalize_timestamp(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    normalized = text.replace(" ", "T", 1)
    normalized = re.sub(r"\s+([+-]\d\d:\d\d)$", r"\1", normalized)
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(normalized)
    except ValueError:
        return text
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed.astimezone(dt.UTC).isoformat(timespec="seconds")


def _timestamp_delta_seconds(old_value: Any, rust_value: Any) -> float | None:
    old_norm = _normalize_timestamp(old_value)
    rust_norm = _normalize_timestamp(rust_value)
    try:
        old_dt = dt.datetime.fromisoformat(old_norm)
        rust_dt = dt.datetime.fromisoformat(rust_norm)
    except ValueError:
        return None
    return abs((old_dt - rust_dt).total_seconds())


def compare(old: dict[str, Any], rust: dict[str, Any]) -> dict[str, Any]:
    old_nodes = old.get("nodes", [])
    rust_nodes = rust.get("nodes", [])
    rows = []
    commit_matches = 0
    parent_matches = 0
    title_matches = 0
    flag_matches = 0
    bookmark_matches = 0
    git_ref_matches = 0
    author_matches = 0
    timestamp_matches = 0
    time_tolerance_seconds = 1
    for index, (o, r) in enumerate(zip(old_nodes, rust_nodes), start=1):
        commit_ok = _commit_prefix_match(o.get("commitId"), r.get("commitId"))
        parents_ok = _parent_identity_match(o.get("parents"), r.get("parents"))
        title_ok = o.get("descriptionTitle") == r.get("descriptionTitle")
        flags = ["isEmpty", "isConflict", "isHidden", "isRoot", "isWorkingCopy"]
        flags_ok = all(o.get(flag) == r.get(flag) for flag in flags)
        bookmarks_ok = _as_list(o.get("bookmarks")) == _as_list(r.get("bookmarks"))
        git_refs_ok = _as_list(o.get("gitBranches")) == _as_list(r.get("gitBranches"))
        author_ok = _normalize_author(o.get("author")) == _normalize_author(r.get("author"))
        timestamp_delta = _timestamp_delta_seconds(o.get("time"), r.get("time"))
        timestamp_ok = timestamp_delta is not None and timestamp_delta <= time_tolerance_seconds
        commit_matches += int(commit_ok)
        parent_matches += int(parents_ok)
        title_matches += int(title_ok)
        flag_matches += int(flags_ok)
        bookmark_matches += int(bookmarks_ok)
        git_ref_matches += int(git_refs_ok)
        author_matches += int(author_ok)
        timestamp_matches += int(timestamp_ok)
        rows.append(
            {
                "index": index,
                "commitOk": commit_ok,
                "parentsOk": parents_ok,
                "titleOk": title_ok,
                "flagsOk": flags_ok,
                "bookmarksOk": bookmarks_ok,
                "gitRefsOk": git_refs_ok,
                "authorOk": author_ok,
                "timestampOk": timestamp_ok,
                "timestampDeltaSeconds": timestamp_delta,
                "oldChangeId": str(o.get("changeId", "")),
                "rustChangeId": str(r.get("changeId", "")),
                "oldCommitId": str(o.get("commitId", "")),
                "rustCommitId": str(r.get("commitId", "")),
                "oldParents": [str(v) for v in (o.get("parents") if isinstance(o.get("parents"), list) else [])],
                "rustParents": [str(v) for v in (r.get("parents") if isinstance(r.get("parents"), list) else [])],
                "oldTitle": str(o.get("descriptionTitle", "")),
                "rustTitle": str(r.get("descriptionTitle", "")),
                "oldAuthor": str(o.get("author", "")),
                "rustAuthor": str(r.get("author", "")),
                "oldTime": str(o.get("time", "")),
                "rustTime": str(r.get("time", "")),
                "oldBookmarks": _as_list(o.get("bookmarks")),
                "rustBookmarks": _as_list(r.get("bookmarks")),
                "oldGitRefs": _as_list(o.get("gitBranches")),
                "rustGitRefs": _as_list(r.get("gitBranches")),
                "oldFlags": {flag: o.get(flag) for flag in flags},
                "rustFlags": {flag: r.get(flag) for flag in flags},
            }
        )
    compared = len(rows)
    pct = lambda n: round((n / compared * 100) if compared else 0, 2)
    return {
        "schemaVersion": 2,
        "compared": compared,
        "oldReturned": len(old_nodes),
        "rustReturned": len(rust_nodes),
        "timeToleranceSeconds": time_tolerance_seconds,
        "commitMatches": commit_matches,
        "commitMatchPercent": pct(commit_matches),
        "parentMatches": parent_matches,
        "parentMatchPercent": pct(parent_matches),
        "titleMatches": title_matches,
        "titleMatchPercent": pct(title_matches),
        "flagMatches": flag_matches,
        "flagMatchPercent": pct(flag_matches),
        "bookmarkMatches": bookmark_matches,
        "bookmarkMatchPercent": pct(bookmark_matches),
        "gitRefMatches": git_ref_matches,
        "gitRefMatchPercent": pct(git_ref_matches),
        "authorMatches": author_matches,
        "authorMatchPercent": pct(author_matches),
        "timestampMatches": timestamp_matches,
        "timestampMatchPercent": pct(timestamp_matches),
        "knownGaps": [
            "Old oracle emits shortest change-id prefixes; native Rust currently emits full binary change-id hex.",
            "Old oracle parent IDs are parent change-id prefixes; native Rust parent IDs are full commit IDs.",
            "Layout coordinates are intentionally excluded from snapshot parity and belong to layout parity.",
        ],
        "rows": rows,
    }


def render_html(report: dict[str, Any], out_dir: pathlib.Path, repo: pathlib.Path, limit: int) -> str:
    rows_html = "".join(
        f"""
        <tr class='{('ok' if all(row[k] for k in ['commitOk','titleOk','flagsOk','bookmarksOk','gitRefsOk','authorOk','timestampOk']) else 'bad')}'>
          <td>{row['index']}</td>
          <td>{'✓' if row['commitOk'] else '✕'}</td>
          <td>{'✓' if row['parentsOk'] else '✕'}</td>
          <td>{'✓' if row['titleOk'] else '✕'}</td>
          <td>{'✓' if row['flagsOk'] else '✕'}</td>
          <td>{'✓' if row['bookmarksOk'] else '✕'}</td>
          <td>{'✓' if row['gitRefsOk'] else '✕'}</td>
          <td>{'✓' if row['authorOk'] else '✕'}</td>
          <td>{'✓' if row['timestampOk'] else '✕'}</td>
          <td><code>{html.escape(row['oldCommitId'][:12])}</code><br><small>{html.escape(row['oldChangeId'][:12])}</small></td>
          <td><code>{html.escape(row['rustCommitId'][:12])}</code><br><small>{html.escape(row['rustChangeId'][:12])}</small></td>
          <td>{html.escape(row['oldTitle'])}<br><small>{html.escape(row['oldAuthor'])} · {html.escape(row['oldTime'])}</small></td>
          <td>{html.escape(row['rustTitle'])}<br><small>{html.escape(row['rustAuthor'])} · {html.escape(row['rustTime'])}</small></td>
        </tr>
        """
        for row in report["rows"]
    )
    gaps_html = "".join(f"<li>{html.escape(gap)}</li>" for gap in report.get("knownGaps", []))
    return f"""<!doctype html>
<html lang='en'>
<head>
<meta charset='utf-8'>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>JUZU Snapshot Parity Report</title>
<style>
:root {{--bg:#050816;--panel:#0f172a;--line:#334155;--text:#e2e8f0;--muted:#94a3b8;--cyan:#67e8f9;--green:#86efac;--red:#fca5a5;--amber:#fbbf24}}
*{{box-sizing:border-box}}body{{margin:0;background:radial-gradient(circle at 30% -10%,#14375f 0,transparent 38%),var(--bg);color:var(--text);font:15px/1.5 Inter,system-ui,sans-serif}}main{{max-width:1300px;margin:auto;padding:44px 24px}}.shell{{border:1px solid var(--line);border-radius:28px;background:rgba(15,23,42,.94);padding:32px;box-shadow:0 24px 90px rgba(0,0,0,.35)}}h1{{font-size:40px;margin:0 0 8px;letter-spacing:-.04em}}p{{color:var(--muted)}}.metrics{{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin:24px 0}}.metric{{background:#07111f;border:1px solid var(--line);border-radius:18px;padding:16px}}.metric b{{display:block;font-size:30px;color:var(--green)}}.metric span{{color:var(--muted)}}table{{width:100%;border-collapse:collapse;margin-top:22px}}th,td{{border-bottom:1px solid var(--line);padding:9px 10px;text-align:left;vertical-align:top}}th{{background:#08111f;color:var(--cyan)}}tr.ok td:nth-child(2),tr.ok td:nth-child(3),tr.ok td:nth-child(4){{color:var(--green);font-weight:900}}tr.bad td:nth-child(2),tr.bad td:nth-child(3),tr.bad td:nth-child(4){{color:var(--red);font-weight:900}}code{{font-family:'JetBrains Mono',ui-monospace,monospace;color:#bfdbfe}}.note{{border:1px solid var(--line);border-radius:16px;background:#07111f;padding:14px 16px;color:var(--muted)}}@media(max-width:900px){{.metrics{{grid-template-columns:1fr 1fr}}}}
</style>
</head>
<body><main><section class='shell'>
<h1>JUZU Snapshot Parity Report</h1>
<p>Reusable HTML artifact comparing old Bun oracle snapshot against Rust <code>jj-lib</code> snapshot, including normalized refs, authors, and timestamps.</p>
<div class='metrics'>
  <div class='metric'><b>{report['commitMatchPercent']}%</b><span>commit prefixes</span></div>
  <div class='metric'><b>{report['titleMatchPercent']}%</b><span>titles</span></div>
  <div class='metric'><b>{report['flagMatchPercent']}%</b><span>flags</span></div>
  <div class='metric'><b>{report['bookmarkMatchPercent']}%</b><span>bookmarks</span></div>
  <div class='metric'><b>{report['gitRefMatchPercent']}%</b><span>git refs</span></div>
  <div class='metric'><b>{report['authorMatchPercent']}%</b><span>authors</span></div>
  <div class='metric'><b>{report['timestampMatchPercent']}%</b><span>timestamps</span></div>
  <div class='metric'><b>{report['parentMatchPercent']}%</b><span>parent ids</span></div>
  <div class='metric'><b>{report['oldReturned']}</b><span>old nodes</span></div>
  <div class='metric'><b>{report['rustReturned']}</b><span>Rust nodes</span></div>
</div>
<div class='note'>Repo: <code>{html.escape(str(repo))}</code> · Limit: <code>{limit}</code> · Output: <code>{html.escape(str(out_dir))}</code> · Time tolerance: <code>{report['timeToleranceSeconds']}s</code></div>
<div class='note'><strong>Known gaps tracked separately:</strong><ul>{gaps_html}</ul></div>
<table><thead><tr><th>#</th><th>Commit</th><th>Parents</th><th>Title</th><th>Flags</th><th>Bookmarks</th><th>Git refs</th><th>Author</th><th>Time</th><th>Old IDs</th><th>Rust IDs</th><th>Old summary</th><th>Rust summary</th></tr></thead><tbody>{rows_html}</tbody></table>
</section></main></body></html>"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=".")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--output-root", default="bench/results/rust-port/snapshot-parity")
    args = parser.parse_args()

    cwd = pathlib.Path.cwd()
    repo = pathlib.Path(args.repo).resolve()
    stamp = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H-%M-%S-%f")[:-3] + "Z"
    out_dir = (cwd / args.output_root / stamp).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    old_path = out_dir / "old-oracle-snapshot.json"
    rust_path = out_dir / "rust-snapshot.json"
    # Capture both snapshots before writing artifacts. When the repo under test is
    # this repo, writing result files mutates jj's working-copy commit; doing that
    # between old and Rust snapshots creates a fake first-row mismatch.
    old_json = run(["bun", "run", "oracle:snapshot", "--repo", str(repo), "--limit", str(args.limit)], cwd)
    rust_json = run(["cargo", "run", "-q", "-p", "juzu-cli", "--", "snapshot", "--path", str(repo), "--limit", str(args.limit)], cwd)
    old_path.write_text(old_json)
    rust_path.write_text(rust_json)

    report = compare(json.loads(old_json), json.loads(rust_json))
    (out_dir / "parity-report.json").write_text(json.dumps(report, indent=2) + "\n")
    (out_dir / "snapshot-parity.html").write_text(render_html(report, out_dir, repo, args.limit))
    print((out_dir / "snapshot-parity.html").resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
