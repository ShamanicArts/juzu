#!/usr/bin/env python3
"""Compare old-JUZU sidebar file lists with Rust native jj files()."""

from __future__ import annotations

import argparse
import html
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def run_json(cmd: list[str], cwd: Path) -> Any:
    proc = subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(f"command failed ({proc.returncode}): {' '.join(cmd)}\n{proc.stderr}")
    return json.loads(proc.stdout)


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z").replace(":", "-")


def normalize_files(files: list[dict[str, Any]]) -> list[dict[str, str]]:
    return sorted(
        [{"type": str(f.get("type", "")), "path": str(f.get("path", ""))} for f in files],
        key=lambda item: (item["path"], item["type"]),
    )


def render_html(report: dict[str, Any]) -> str:
    rows = []
    for case in report["cases"]:
        status = "PASS" if case["match"] else "FAIL"
        cls = "pass" if case["match"] else "fail"
        old_files = "\n".join(f"{f['type']} {f['path']}" for f in case["oldFiles"][:20]) or "—"
        rust_files = "\n".join(f"{f['type']} {f['path']}" for f in case["rustFiles"][:20]) or "—"
        rows.append(f"""
        <tr class=\"{cls}\">
          <td><strong>{status}</strong></td>
          <td><code>{html.escape(case['changeId'])}</code><br>{html.escape(case.get('title') or '')}</td>
          <td>{case['oldCount']}</td>
          <td>{case['rustCount']}</td>
          <td><pre>{html.escape(old_files)}</pre></td>
          <td><pre>{html.escape(rust_files)}</pre></td>
        </tr>""")
    return f"""<!doctype html>
<html>
<head>
<meta charset=\"utf-8\" />
<title>JUZU Rust files parity</title>
<style>
:root {{ color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #07111f; color: #d8e3f2; }}
body {{ margin: 0; padding: 28px; }}
h1 {{ margin: 0 0 6px; }}
.summary {{ display: flex; gap: 14px; margin: 20px 0; flex-wrap: wrap; }}
.card {{ background: #0d1b2d; border: 1px solid #233854; border-radius: 14px; padding: 14px 18px; box-shadow: 0 10px 30px #0005; }}
.card .num {{ font-size: 28px; font-weight: 800; color: #7dd3fc; }}
table {{ width: 100%; border-collapse: collapse; background: #0d1b2d; border-radius: 14px; overflow: hidden; }}
th, td {{ border-bottom: 1px solid #233854; padding: 10px; vertical-align: top; }}
th {{ text-align: left; color: #93c5fd; background: #10223a; }}
tr.pass td:first-child {{ color: #86efac; }}
tr.fail td:first-child {{ color: #fca5a5; }}
pre {{ margin: 0; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #cbd5e1; }}
code {{ color: #fde68a; }}
.small {{ color: #94a3b8; }}
</style>
</head>
<body>
<h1>JUZU Rust native files() parity</h1>
<div class=\"small\">Repo: <code>{html.escape(report['repo'])}</code> · generated {html.escape(report['generatedAt'])}</div>
<div class=\"summary\">
  <div class=\"card\"><div class=\"num\">{report['passed']}/{report['compared']}</div><div>matched cases</div></div>
  <div class=\"card\"><div class=\"num\">{report['skippedRoots']}</div><div>skipped root cases</div></div>
  <div class=\"card\"><div class=\"num\">{report['limit']}</div><div>snapshot limit</div></div>
</div>
<table>
<thead><tr><th>Status</th><th>Change</th><th>Old</th><th>Rust</th><th>Old oracle files</th><th>Rust native files</th></tr></thead>
<tbody>{''.join(rows)}</tbody>
</table>
</body>
</html>
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--cases", type=int, default=8)
    parser.add_argument("--out-dir")
    args = parser.parse_args()

    repo = str(Path(args.repo).resolve())
    out_dir = Path(args.out_dir) if args.out_dir else ROOT / "bench" / "results" / "rust-port" / "files-parity" / timestamp()
    out_dir.mkdir(parents=True, exist_ok=True)

    snapshot = run_json(["bun", "run", "oracle:snapshot", "--", "--repo", repo, "--limit", str(args.limit)], ROOT)
    cases = []
    skipped_roots = 0
    for node in snapshot["nodes"]:
        if len(cases) >= args.cases:
            break
        if node.get("isRoot"):
            skipped_roots += 1
            continue
        change = node["changeId"]
        old = run_json(["bun", "run", "oracle:sidebar", "--", "--repo", repo, "--limit", str(args.limit), "--selected", change], ROOT)
        rust = run_json(["cargo", "run", "-q", "-p", "juzu-cli", "--", "files", "--path", repo, "--change", change], ROOT)
        old_files = normalize_files(old["files"])
        rust_files = normalize_files(rust["files"])
        cases.append({
            "changeId": change,
            "title": node.get("descriptionTitle", ""),
            "match": old_files == rust_files,
            "oldCount": len(old_files),
            "rustCount": len(rust_files),
            "oldFiles": old_files,
            "rustFiles": rust_files,
        })

    report = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "repo": repo,
        "limit": args.limit,
        "compared": len(cases),
        "passed": sum(1 for c in cases if c["match"]),
        "failed": sum(1 for c in cases if not c["match"]),
        "skippedRoots": skipped_roots,
        "cases": cases,
    }
    (out_dir / "files-parity-report.json").write_text(json.dumps(report, indent=2) + "\n")
    (out_dir / "files-parity.html").write_text(render_html(report))
    print(out_dir / "files-parity.html")


if __name__ == "__main__":
    main()
