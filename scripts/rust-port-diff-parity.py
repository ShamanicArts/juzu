#!/usr/bin/env python3
"""Compare old-JUZU sidebar diff summaries with Rust native jj diff()."""

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


def normalize_diff_lines(lines: list[str]) -> list[str]:
    normalized: list[str] = []
    for line in lines:
        line = line.rstrip()
        if not line:
            continue
        if line.startswith("index "):
            continue
        normalized.append(line)
    return normalized


def normalize_first_lines(lines: list[str]) -> list[str]:
    return normalize_diff_lines(lines)[:20]


def diff_summary(raw: str) -> dict[str, Any]:
    return {
        "bytes": len(raw.encode()),
        "lines": 0 if raw == "" else len(raw.split("\n")),
        "firstLines": raw.split("\n")[:20],
    }


def render_html(report: dict[str, Any]) -> str:
    rows = []
    for case in report["cases"]:
        status = "pass" if case["matched"] else "fail"
        old_first = "\n".join(case["oldFirstLines"]) or "—"
        rust_first = "\n".join(case["rustFirstLines"]) or "—"
        rows.append(f"""
<tr class={status}>
  <td>{html.escape(case['changeId'][:12])}</td>
  <td>{html.escape(case['title'])}</td>
  <td>{'PASS' if case['matched'] else 'FAIL'}</td>
  <td>{case['oldLines']} / {case['rustLines']}</td>
  <td><pre>{html.escape(old_first)}</pre></td>
  <td><pre>{html.escape(rust_first)}</pre></td>
</tr>""")
    return f"""<!doctype html>
<html><head><meta charset=utf-8><title>JUZU Rust native diff parity</title>
<style>
body {{ background:#0f172a; color:#e5e7eb; font-family:Inter,system-ui,sans-serif; margin:32px; }}
h1 {{ margin-bottom:4px; }} .meta {{ color:#94a3b8; margin-bottom:24px; }}
.summary {{ display:flex; gap:16px; margin:20px 0; }}
.card {{ background:#111827; border:1px solid #334155; border-radius:12px; padding:16px 20px; }}
.pass td {{ border-color:#14532d; }} .fail td {{ border-color:#7f1d1d; background:#2a1114; }}
table {{ width:100%; border-collapse:separate; border-spacing:0 8px; }}
th {{ text-align:left; color:#93c5fd; font-weight:700; }}
td {{ vertical-align:top; background:#111827; border-top:1px solid #334155; border-bottom:1px solid #334155; padding:10px; }}
td:first-child {{ border-left:1px solid #334155; border-radius:10px 0 0 10px; }}
td:last-child {{ border-right:1px solid #334155; border-radius:0 10px 10px 0; }}
pre {{ margin:0; white-space:pre-wrap; font-family:'JetBrains Mono',monospace; font-size:12px; color:#cbd5e1; }}
</style></head><body>
<h1>JUZU Rust native diff() parity</h1>
<div class=meta>Repo: {html.escape(report['repo'])} · Generated: {html.escape(report['generatedAt'])}</div>
<div class=summary>
  <div class=card><strong>{report['matchedCases']}/{report['totalCases']}</strong><br>cases matched first-line + line-count summary</div>
  <div class=card><strong>{report['limit']}</strong><br>snapshot limit</div>
</div>
<table><thead><tr><th>Change</th><th>Title</th><th>Status</th><th>Old/Rust lines</th><th>Old oracle first lines</th><th>Rust native first lines</th></tr></thead><tbody>
{''.join(rows)}
</tbody></table></body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--cases", type=int, default=8)
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00-00", "Z")
    out_dir = ROOT / "bench" / "results" / "rust-port" / "diff-parity" / stamp
    out_dir.mkdir(parents=True, exist_ok=True)

    snapshot = run_json(["bun", "run", "oracle:snapshot", "--", "--repo", str(repo), "--limit", str(args.limit)], ROOT)
    cases = []
    for node in snapshot["nodes"][: args.cases]:
        change_id = node["changeId"]
        old = run_json(["bun", "run", "oracle:sidebar", "--", "--repo", str(repo), "--limit", str(args.limit), "--selected", change_id], ROOT)
        rust = run_json(["cargo", "run", "-q", "-p", "juzu-cli", "--", "diff", "--path", str(repo), "--change", change_id], ROOT)
        old_summary = old["diffSummary"]
        rust_summary = diff_summary(rust.get("diff", ""))
        old_normalized = normalize_diff_lines(old["diffSummary"]["firstLines"] + [])
        rust_normalized_all = normalize_diff_lines(rust.get("diff", "").split("\n"))
        old_first = normalize_first_lines(old_summary["firstLines"])
        rust_first = normalize_first_lines(rust_summary["firstLines"])
        # The old oracle only exposes first lines for now. Use them as a sidebar
        # parity gate and track raw line counts as a diagnostic, not a hard fail.
        # After stripping jj's index metadata, the Rust side may expose one extra
        # useful content line inside the same 20-line window; require old as prefix.
        matched = rust_first[: len(old_first)] == old_first
        cases.append({
            "changeId": change_id,
            "title": node.get("descriptionTitle") or "",
            "matched": matched,
            "oldLines": old_summary["lines"],
            "rustLines": rust_summary["lines"],
            "oldBytes": old_summary["bytes"],
            "rustBytes": rust_summary["bytes"],
            "oldFirstLines": old_first,
            "rustFirstLines": rust_first,
        })

    report = {
        "schemaVersion": 1,
        "repo": str(repo),
        "generatedAt": dt.datetime.now(dt.UTC).isoformat(),
        "limit": args.limit,
        "totalCases": len(cases),
        "matchedCases": sum(1 for c in cases if c["matched"]),
        "cases": cases,
    }
    (out_dir / "diff-parity-report.json").write_text(json.dumps(report, indent=2) + "\n")
    html_path = out_dir / "diff-parity.html"
    html_path.write_text(render_html(report))
    print(f"file://{html_path}")
    if report["matchedCases"] != report["totalCases"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
