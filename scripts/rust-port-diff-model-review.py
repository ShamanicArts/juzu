#!/usr/bin/env python3
"""Generate an HTML review artifact for the Rust Pierre-style diff model."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def run_json(cmd: list[str], cwd: Path) -> dict[str, Any]:
    proc = subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    return json.loads(proc.stdout)


def run_text(cmd: list[str], cwd: Path) -> str:
    proc = subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    return proc.stdout


def row_class(kind: str) -> str:
    return kind.replace("-", "_")


def render_rows(rows: list[dict[str, Any]], limit: int = 120) -> str:
    rendered = []
    for row in rows[:limit]:
        old_line = "" if row.get("oldLine") is None else str(row.get("oldLine"))
        new_line = "" if row.get("newLine") is None else str(row.get("newLine"))
        rendered.append(f"""
<tr class="{row_class(row['kind'])}">
  <td>{html.escape(row['kind'])}</td>
  <td>{html.escape(old_line)}</td>
  <td>{html.escape(new_line)}</td>
  <td><code>{html.escape(row['text'])}</code></td>
</tr>""")
    if len(rows) > limit:
        rendered.append(f"<tr class=collapse><td colspan=4>⋯ {len(rows) - limit} more rows omitted from review artifact</td></tr>")
    return "".join(rendered)


def render_html(report: dict[str, Any]) -> str:
    file_cards = []
    for file in report["model"]["files"]:
        path = file.get("newPath") or file.get("oldPath") or "<unknown>"
        metadata = "\n".join(file.get("metadata") or [])
        hunk_bits = []
        for hunk in file.get("hunks") or []:
            hunk_bits.append(
                f"<li><code>{html.escape(hunk['header'])}</code> · old {hunk['oldStart']},{hunk['oldCount']} → new {hunk['newStart']},{hunk['newCount']} · {len(hunk.get('lines') or [])} lines</li>"
            )
        file_cards.append(f"""
<section class=card>
  <h3>{html.escape(file['kind'])}: {html.escape(path)}</h3>
  <pre>{html.escape(metadata)}</pre>
  <ul>{''.join(hunk_bits)}</ul>
</section>""")
    raw_first = "\n".join(report["rawDiff"].splitlines()[:80])
    return f"""<!doctype html>
<html><head><meta charset=utf-8><title>JUZU Rust diff model review</title>
<style>
body {{ background:#0f172a; color:#e5e7eb; font-family:Inter,system-ui,sans-serif; margin:32px; }}
h1 {{ margin-bottom:4px; }} .meta {{ color:#94a3b8; margin-bottom:24px; }}
.grid {{ display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start; }}
.card {{ background:#111827; border:1px solid #334155; border-radius:14px; padding:16px 18px; margin-bottom:16px; }}
.statbar {{ display:flex; gap:12px; margin:18px 0; flex-wrap:wrap; }}
.stat {{ background:#172033; border:1px solid #334155; border-radius:999px; padding:8px 12px; }}
pre {{ white-space:pre-wrap; font-family:'JetBrains Mono',monospace; font-size:12px; color:#cbd5e1; overflow:auto; }}
code {{ font-family:'JetBrains Mono',monospace; }}
table {{ width:100%; border-collapse:collapse; font-family:'JetBrains Mono',monospace; font-size:12px; }}
th {{ text-align:left; color:#93c5fd; border-bottom:1px solid #334155; padding:8px; }}
td {{ border-bottom:1px solid #1e293b; padding:6px 8px; vertical-align:top; }}
.file_header td {{ color:#c4b5fd; background:#1e1b4b; }} .metadata td {{ color:#94a3b8; }} .hunk_header td {{ color:#93c5fd; background:#172554; }}
.add td {{ color:#bbf7d0; background:#052e16; }} .remove td {{ color:#fecaca; background:#450a0a; }} .context td {{ color:#cbd5e1; }} .collapse td {{ color:#facc15; background:#422006; text-align:center; }}
</style></head><body>
<h1>JUZU Rust Pierre-style diff model review</h1>
<div class=meta>Repo: {html.escape(report['repo'])} · Change: {html.escape(report['changeId'])} · Generated: {html.escape(report['generatedAt'])}</div>
<div class=statbar>
  <div class=stat><strong>{report['summary']['rawLineCount']}</strong> raw diff lines</div>
  <div class=stat><strong>{report['summary']['fileCount']}</strong> parsed files</div>
  <div class=stat><strong>{report['summary']['rowCount']}</strong> terminal rows</div>
  <div class=stat><strong>{report['summary']['collapsedRowCount']}</strong> collapsed rows</div>
</div>
<div class=grid>
  <section class=card><h2>Raw diff first section</h2><pre>{html.escape(raw_first)}</pre></section>
  <section><h2>Parsed files + hunks</h2>{''.join(file_cards)}</section>
</div>
<section class=card><h2>Generated terminal row preview</h2><table><thead><tr><th>Kind</th><th>Old</th><th>New</th><th>Text</th></tr></thead><tbody>{render_rows(report['rows'])}</tbody></table></section>
<section class=card><h2>Collapsed context preview</h2><table><thead><tr><th>Kind</th><th>Old</th><th>New</th><th>Text</th></tr></thead><tbody>{render_rows(report['collapsedRows'])}</tbody></table></section>
</body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--change")
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    change = args.change
    if not change:
        snapshot = run_json(["bun", "run", "oracle:snapshot", "--", "--repo", str(repo), "--limit", str(args.limit)], ROOT)
        nodes = [node for node in snapshot.get("nodes", []) if not node.get("isRoot")]
        if not nodes:
            raise SystemExit("no snapshot nodes available for diff model review")
        change = nodes[0]["changeId"]

    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00-00", "Z")
    out_dir = ROOT / "bench" / "results" / "rust-port" / "diff-model" / stamp
    out_dir.mkdir(parents=True, exist_ok=True)

    raw = run_json(["cargo", "run", "-q", "-p", "juzu-cli", "--", "diff", "--path", str(repo), "--change", change], ROOT)
    model = run_json(["cargo", "run", "-q", "-p", "juzu-cli", "--", "diff-model", "--path", str(repo), "--change", change], ROOT)
    report = {
        "schemaVersion": 1,
        "repo": str(repo),
        "changeId": change,
        "generatedAt": dt.datetime.now(dt.UTC).isoformat(),
        "summary": {
            "rawLineCount": model["rawLineCount"],
            "fileCount": model["fileCount"],
            "rowCount": model["rowCount"],
            "collapsedRowCount": model["collapsedRowCount"],
        },
        "rawDiff": raw.get("diff", ""),
        "model": {"files": model.get("files", [])},
        "rows": model.get("rows", []),
        "collapsedRows": model.get("collapsedRows", []),
    }
    json_report = {
        "schemaVersion": report["schemaVersion"],
        "repo": report["repo"],
        "changeId": report["changeId"],
        "generatedAt": report["generatedAt"],
        "summary": report["summary"],
        "rawFirstLines": report["rawDiff"].splitlines()[:200],
        "files": [
            {
                "oldPath": file.get("oldPath"),
                "newPath": file.get("newPath"),
                "kind": file.get("kind"),
                "metadata": (file.get("metadata") or [])[:20],
                "hunks": [
                    {
                        "header": hunk.get("header"),
                        "oldStart": hunk.get("oldStart"),
                        "oldCount": hunk.get("oldCount"),
                        "newStart": hunk.get("newStart"),
                        "newCount": hunk.get("newCount"),
                        "lineCount": len(hunk.get("lines") or []),
                    }
                    for hunk in (file.get("hunks") or [])[:20]
                ],
            }
            for file in report["model"]["files"][:80]
        ],
        "rows": report["rows"][:200],
        "collapsedRows": report["collapsedRows"][:200],
    }
    (out_dir / "diff-model-review.json").write_text(json.dumps(json_report, indent=2) + "\n")
    html_path = out_dir / "diff-model-review.html"
    html_path.write_text(render_html(report))
    print(f"file://{html_path}")


if __name__ == "__main__":
    main()
