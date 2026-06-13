#!/usr/bin/env python3
"""Run old-JUZU vs Rust layout parity and emit JSON + HTML review artifacts."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import pathlib
import subprocess
from typing import Any

MODES = ["chronological", "mainline", "bookmark-centric", "wc-focused", "topological"]


def run(cmd: list[str], cwd: pathlib.Path) -> str:
    proc = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
    return proc.stdout


def compare_mode(old: dict[str, Any], rust: dict[str, Any]) -> dict[str, Any]:
    old_nodes = old.get("nodes", [])
    rust_nodes = rust.get("nodes", [])
    rows = []
    lane_matches = x_matches = y_matches = pinned_matches = identity_matches = 0
    for index, (o, r) in enumerate(zip(old_nodes, rust_nodes), start=1):
        old_commit = str(o.get("commitId", ""))
        rust_commit = str(r.get("commitId", ""))
        identity_ok = str(o.get("changeId", "")) == str(r.get("changeId", "")) and bool(old_commit and rust_commit and (old_commit.startswith(rust_commit) or rust_commit.startswith(old_commit)))
        lane_ok = o.get("lane") == r.get("lane")
        x_ok = o.get("x") == r.get("x")
        y_ok = o.get("y") == r.get("y")
        pinned_ok = bool(o.get("isPinned", False)) == bool(r.get("isPinned", False))
        identity_matches += int(identity_ok)
        lane_matches += int(lane_ok)
        x_matches += int(x_ok)
        y_matches += int(y_ok)
        pinned_matches += int(pinned_ok)
        rows.append({
            "index": index,
            "identityOk": identity_ok,
            "laneOk": lane_ok,
            "xOk": x_ok,
            "yOk": y_ok,
            "pinnedOk": pinned_ok,
            "oldChangeId": str(o.get("changeId", "")),
            "rustChangeId": str(r.get("changeId", "")),
            "oldCommitId": str(o.get("commitId", "")),
            "rustCommitId": str(r.get("commitId", "")),
            "oldLane": o.get("lane"),
            "rustLane": r.get("lane"),
            "oldX": o.get("x"),
            "rustX": r.get("x"),
            "oldY": o.get("y"),
            "rustY": r.get("y"),
            "oldPinned": bool(o.get("isPinned", False)),
            "rustPinned": bool(r.get("isPinned", False)),
        })
    compared = len(rows)
    pct = lambda n: round((n / compared * 100) if compared else 0, 2)
    old_layout = old.get("layout", {})
    rust_layout = rust.get("layout", {})
    layout_summary = {
        "maxLaneOk": old_layout.get("maxLane") == rust_layout.get("maxLane"),
        "textColumnXOk": old_layout.get("textColumnX") == rust_layout.get("textColumnX"),
        "totalHeightOk": old_layout.get("totalHeight") == rust_layout.get("totalHeight"),
        "old": old_layout,
        "rust": rust_layout,
    }
    return {
        "mode": old.get("mode") or rust.get("mode"),
        "compared": compared,
        "oldReturned": len(old_nodes),
        "rustReturned": len(rust_nodes),
        "identityMatchPercent": pct(identity_matches),
        "laneMatchPercent": pct(lane_matches),
        "xMatchPercent": pct(x_matches),
        "yMatchPercent": pct(y_matches),
        "pinnedMatchPercent": pct(pinned_matches),
        "layoutSummary": layout_summary,
        "rows": rows,
    }


def render_html(report: dict[str, Any], repo: pathlib.Path, limit: int, out_dir: pathlib.Path) -> str:
    cards = []
    tables = []
    for mode in report["modes"]:
        ok = all([
            mode["layoutSummary"]["maxLaneOk"],
            mode["layoutSummary"]["textColumnXOk"],
            mode["layoutSummary"]["totalHeightOk"],
            mode["laneMatchPercent"] == 100,
            mode["xMatchPercent"] == 100,
            mode["yMatchPercent"] == 100,
        ])
        cards.append(f"""
        <div class='metric {'ok' if ok else 'bad'}'><b>{html.escape(mode['mode'])}</b>
          <span>lane {mode['laneMatchPercent']}% · x {mode['xMatchPercent']}% · y {mode['yMatchPercent']}%</span>
          <small>maxLane {'✓' if mode['layoutSummary']['maxLaneOk'] else '✕'} · textX {'✓' if mode['layoutSummary']['textColumnXOk'] else '✕'} · height {'✓' if mode['layoutSummary']['totalHeightOk'] else '✕'}</small>
        </div>
        """)
        body = "".join(f"""
          <tr class='{('ok' if row['identityOk'] and row['laneOk'] and row['xOk'] and row['yOk'] and row['pinnedOk'] else 'bad')}'>
            <td>{row['index']}</td><td>{'✓' if row['identityOk'] else '✕'}</td><td>{'✓' if row['laneOk'] else '✕'}</td><td>{'✓' if row['xOk'] else '✕'}</td><td>{'✓' if row['yOk'] else '✕'}</td><td>{'✓' if row['pinnedOk'] else '✕'}</td>
            <td><code>{html.escape(row['oldChangeId'][:12])}</code></td><td><code>{html.escape(row['rustChangeId'][:12])}</code></td>
            <td>{row['oldLane']} / {row['rustLane']}</td><td>{row['oldX']} / {row['rustX']}</td><td>{row['oldY']} / {row['rustY']}</td>
          </tr>
        """ for row in mode["rows"][:30])
        tables.append(f"""
        <h2>{html.escape(mode['mode'])}</h2>
        <table><thead><tr><th>#</th><th>ID</th><th>Lane</th><th>X</th><th>Y</th><th>Pin</th><th>Old</th><th>Rust</th><th>Lane</th><th>X</th><th>Y</th></tr></thead><tbody>{body}</tbody></table>
        """)
    return f"""<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>JUZU Layout Parity</title>
<style>:root{{--bg:#050816;--panel:#0f172a;--line:#334155;--text:#e2e8f0;--muted:#94a3b8;--green:#86efac;--red:#fca5a5;--cyan:#67e8f9}}*{{box-sizing:border-box}}body{{margin:0;background:radial-gradient(circle at 30% -10%,#14375f 0,transparent 38%),var(--bg);color:var(--text);font:15px/1.5 Inter,system-ui,sans-serif}}main{{max-width:1400px;margin:auto;padding:44px 24px}}.shell{{border:1px solid var(--line);border-radius:28px;background:rgba(15,23,42,.94);padding:32px;box-shadow:0 24px 90px rgba(0,0,0,.35)}}h1{{font-size:40px;margin:0 0 8px;letter-spacing:-.04em}}p,small{{color:var(--muted)}}.metrics{{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin:24px 0}}.metric{{background:#07111f;border:1px solid var(--line);border-radius:18px;padding:16px}}.metric b{{display:block;font-size:22px;color:var(--cyan)}}.metric.ok b{{color:var(--green)}}.metric.bad b{{color:var(--red)}}table{{width:100%;border-collapse:collapse;margin:12px 0 28px}}th,td{{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}}th{{background:#08111f;color:var(--cyan)}}tr.ok td:nth-child(n+2):nth-child(-n+6){{color:var(--green);font-weight:900}}tr.bad td:nth-child(n+2):nth-child(-n+6){{color:var(--red);font-weight:900}}code{{font-family:'JetBrains Mono',ui-monospace,monospace;color:#bfdbfe}}.note{{border:1px solid var(--line);border-radius:16px;background:#07111f;padding:14px 16px;color:var(--muted)}}@media(max-width:900px){{.metrics{{grid-template-columns:1fr}}}}</style></head>
<body><main><section class='shell'><h1>JUZU Layout Parity</h1><p>Old Bun layout oracle vs Rust <code>juzu-core</code> layout port across all modes.</p><div class='note'>Repo: <code>{html.escape(str(repo))}</code> · Limit: <code>{limit}</code> · Output: <code>{html.escape(str(out_dir))}</code></div><div class='metrics'>{''.join(cards)}</div>{''.join(tables)}</section></main></body></html>"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=".")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--output-root", default="bench/results/rust-port/layout-parity")
    args = parser.parse_args()

    cwd = pathlib.Path.cwd()
    repo = pathlib.Path(args.repo).resolve()
    stamp = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H-%M-%S-%f")[:-3] + "Z"
    out_dir = (cwd / args.output_root / stamp).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    mode_reports = []
    for mode in MODES:
        old_json = run(["bun", "run", "oracle:layout", "--repo", str(repo), "--limit", str(args.limit), "--mode", mode], cwd)
        rust_json = run(["cargo", "run", "-q", "-p", "juzu-cli", "--", "layout", "--path", str(repo), "--limit", str(args.limit), "--mode", mode], cwd)
        (out_dir / f"old-layout-{mode}.json").write_text(old_json)
        (out_dir / f"rust-layout-{mode}.json").write_text(rust_json)
        mode_reports.append(compare_mode(json.loads(old_json), json.loads(rust_json)))

    report = {"schemaVersion": 1, "repo": str(repo), "limit": args.limit, "modes": mode_reports}
    (out_dir / "layout-parity-report.json").write_text(json.dumps(report, indent=2) + "\n")
    (out_dir / "layout-parity.html").write_text(render_html(report, repo, args.limit, out_dir))
    print((out_dir / "layout-parity.html").resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
