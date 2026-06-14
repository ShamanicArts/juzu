#!/usr/bin/env python3
"""Generate an HTML review artifact for Pierre/JUZU-style Rust TUI diff rendering."""

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


def choose_change(repo: Path, limit: int) -> str:
    snapshot = run_json(["bun", "run", "oracle:snapshot", "--", "--repo", str(repo), "--limit", str(limit)], ROOT)
    nodes = [node for node in snapshot.get("nodes", []) if not node.get("isRoot")]
    if not nodes:
        raise SystemExit("no snapshot nodes available for diff render review")
    for node in nodes:
        if not node.get("isWorkingCopy"):
            return node["changeId"]
    return nodes[0]["changeId"]


def row_class(kind: str) -> str:
    return kind.replace("-", "_")


def terminal_row(row: dict[str, Any], width: int) -> str:
    kind = row["kind"]
    text = row.get("text") or ""
    if kind == "file-header":
        label = f"◆ {text}"
        return f"╭ {label[: max(0, width - 4)]:<{max(0, width - 4)}} ╮"
    if kind == "metadata":
        return f"  · {text}"[:width]
    if kind == "hunk-header":
        return f"╭─ {text}"[:width]
    if kind == "collapse":
        label = f" ⋯ {text.lstrip('⋯').strip()} "
        pad = max(0, width - len(label))
        return "─" * (pad // 2) + label + "─" * (pad - pad // 2)

    old_line = "" if row.get("oldLine") is None else str(row.get("oldLine"))
    new_line = "" if row.get("newLine") is None else str(row.get("newLine"))
    sign = "+" if kind == "add" else "-" if kind == "remove" else " "
    band = "▌" if kind in {"add", "remove"} else "│"
    body = text[1:] if text.startswith(("+", "-", " ")) else text
    return f"{band}{sign} {old_line:>4} {new_line:>4} {body}"[:width]


def render_terminal(rows: list[dict[str, Any]], width: int, limit: int) -> str:
    bits = []
    for row in rows[:limit]:
        bits.append(f"<div class='term-row {row_class(row['kind'])}'>{html.escape(terminal_row(row, width))}</div>")
    if len(rows) > limit:
        bits.append(f"<div class='term-row collapse'>⋯ {len(rows) - limit} more rows omitted</div>")
    return "\n".join(bits)


def render_model_table(rows: list[dict[str, Any]], limit: int) -> str:
    out = []
    for row in rows[:limit]:
        old_line = "" if row.get("oldLine") is None else str(row.get("oldLine"))
        new_line = "" if row.get("newLine") is None else str(row.get("newLine"))
        out.append(f"""
<tr class='{row_class(row['kind'])}'>
  <td>{html.escape(row['kind'])}</td><td>{html.escape(old_line)}</td><td>{html.escape(new_line)}</td><td><code>{html.escape(row.get('text') or '')}</code></td>
</tr>""")
    return "".join(out)


def render_html(report: dict[str, Any]) -> str:
    raw_first = "\n".join(report["rawDiff"].splitlines()[:100])
    rows = report["collapsedRows"]
    return f"""<!doctype html>
<html><head><meta charset='utf-8'><title>JUZU Rust diff render review</title>
<style>
:root {{ color-scheme: dark; --bg:#0b1020; --panel:#111827; --panel2:#0f172a; --line:#334155; --text:#dbeafe; --muted:#94a3b8; --cyan:#67e8f9; --blue:#93c5fd; --purple:#c4b5fd; --green:#bbf7d0; --green-bg:#052e16; --green-sign:#14532d; --red:#fecaca; --red-bg:#450a0a; --red-sign:#7f1d1d; --amber:#facc15; --amber-bg:#422006; }}
body {{ margin:32px; background:radial-gradient(circle at top left,#111f3d 0,#0b1020 42rem); color:var(--text); font-family:Inter,system-ui,sans-serif; }}
h1 {{ margin:0 0 6px; letter-spacing:-0.03em; }} h2 {{ margin:0 0 12px; font-size:16px; color:var(--cyan); }}
.meta {{ color:var(--muted); margin-bottom:22px; }} .grid {{ display:grid; grid-template-columns:1.05fr .95fr; gap:16px; align-items:start; }}
.card {{ background:linear-gradient(180deg,rgba(17,24,39,.96),rgba(15,23,42,.96)); border:1px solid var(--line); border-radius:16px; padding:16px 18px; box-shadow:0 18px 60px rgba(0,0,0,.24); margin-bottom:16px; }}
.statbar {{ display:flex; gap:10px; flex-wrap:wrap; margin:18px 0; }} .stat {{ border:1px solid var(--line); border-radius:999px; padding:7px 11px; background:#111827; color:var(--muted); }} .stat strong {{ color:var(--text); }}
pre, code, .terminal, table {{ font-family:'JetBrains Mono','SFMono-Regular',ui-monospace,monospace; }} pre {{ white-space:pre-wrap; font-size:12px; color:#cbd5e1; overflow:auto; }}
.terminal {{ background:#050816; border:1px solid #273449; border-radius:14px; padding:12px; font-size:12px; line-height:1.45; overflow:auto; }} .term-row {{ white-space:pre; min-height:1.45em; }}
.file_header {{ color:var(--cyan); background:#111827; font-weight:700; }} .metadata {{ color:var(--muted); }} .hunk_header {{ color:var(--blue); background:#1e1b4b; font-weight:700; }} .context {{ color:#9ca3af; }} .add {{ color:var(--green); background:var(--green-bg); }} .remove {{ color:var(--red); background:var(--red-bg); }} .collapse {{ color:var(--amber); background:var(--amber-bg); text-align:center; }}
table {{ width:100%; border-collapse:collapse; font-size:12px; }} th {{ text-align:left; color:var(--blue); border-bottom:1px solid var(--line); padding:8px; }} td {{ border-bottom:1px solid #1e293b; padding:6px 8px; vertical-align:top; }}
.notes li {{ margin:8px 0; color:#cbd5e1; }} .mapping {{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }} .mapping div {{ border:1px solid #273449; border-radius:12px; padding:10px; background:#0f172a; }}
</style></head><body>
<h1>JUZU Rust diff render review</h1>
<div class='meta'>Repo: {html.escape(report['repo'])} · Change: {html.escape(report['changeId'])} · Generated: {html.escape(report['generatedAt'])}</div>
<div class='statbar'><div class='stat'><strong>{report['summary']['fileCount']}</strong> files</div><div class='stat'><strong>{report['summary']['rawLineCount']}</strong> raw lines</div><div class='stat'><strong>{report['summary']['collapsedRowCount']}</strong> rendered rows</div><div class='stat'><strong>{report['summary']['terminalWidth']}</strong> terminal columns</div></div>
<div class='grid'>
<section class='card'><h2>Terminal-style rendered preview</h2><div class='terminal'>{render_terminal(rows, report['summary']['terminalWidth'], 160)}</div></section>
<section class='card'><h2>Pierre/JUZU design mapping</h2><ul class='notes'><li>File headers are section dividers, closer to Pierre's file-level hierarchy than a plain row.</li><li>Hunks render as compact blue/purple bands so scan position is obvious without wasting vertical space.</li><li>Old/new gutters are dim and aligned, borrowing Pierre's code-column discipline while keeping JUZU's dense terminal feel.</li><li>Add/remove rows use tinted full-row backgrounds plus a continuous left mutation band, making blocks readable in tmux, not just technically colored.</li><li>Collapse rows are centered separators, not inert text.</li></ul><div class='mapping'><div><strong>From Pierre</strong><br>file/hunk hierarchy, gutters, collapsed regions, patch reading rhythm.</div><div><strong>From JUZU</strong><br>sharp terminal density, low chrome, high information per line.</div></div></section>
</div>
<div class='grid'>
<section class='card'><h2>Raw native diff first section</h2><pre>{html.escape(raw_first)}</pre></section>
<section class='card'><h2>Parsed rows behind the rendering</h2><table><thead><tr><th>Kind</th><th>Old</th><th>New</th><th>Text</th></tr></thead><tbody>{render_model_table(rows, 120)}</tbody></table></section>
</div>
</body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--change")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--width", type=int, default=46)
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    change = args.change or choose_change(repo, args.limit)
    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00-00", "Z")
    out_dir = ROOT / "bench" / "results" / "rust-port" / "diff-render" / stamp
    out_dir.mkdir(parents=True, exist_ok=True)

    raw = run_json(["cargo", "run", "-q", "-p", "juzu-cli", "--", "diff", "--path", str(repo), "--change", change], ROOT)
    model = run_json(["cargo", "run", "-q", "-p", "juzu-cli", "--", "diff-model", "--path", str(repo), "--change", change], ROOT)
    report = {
        "schemaVersion": 1,
        "repo": str(repo),
        "changeId": change,
        "generatedAt": dt.datetime.now(dt.UTC).isoformat(),
        "summary": {
            "rawLineCount": model.get("rawLineCount", 0),
            "fileCount": model.get("fileCount", 0),
            "rowCount": model.get("rowCount", 0),
            "collapsedRowCount": model.get("collapsedRowCount", 0),
            "terminalWidth": args.width,
        },
        "rawDiff": raw.get("diff", ""),
        "collapsedRows": model.get("collapsedRows", []),
    }
    json_report = {k: v for k, v in report.items() if k not in {"rawDiff", "collapsedRows"}}
    json_report["collapsedRows"] = report["collapsedRows"][:300]
    json_report["omittedCollapsedRows"] = max(0, len(report["collapsedRows"]) - 300)
    (out_dir / "diff-render-review.json").write_text(json.dumps(json_report, indent=2) + "\n")
    html_path = out_dir / "diff-render-review.html"
    html_path.write_text(render_html(report))
    print(f"file://{html_path}")


if __name__ == "__main__":
    main()
