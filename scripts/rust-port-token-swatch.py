#!/usr/bin/env python3
"""Generate an HTML review artifact for old JUZU UI token parity in Rust TUI chrome."""

from __future__ import annotations

import datetime as dt
import html
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TS = ROOT / "src/core/ui-tokens.ts"
RS = ROOT / "crates/juzu-tui/src/main.rs"

TOKENS = [
    ("slate.bg0", "slate_bg0", "#111318"),
    ("slate.panel", "slate_panel", "#1a2029"),
    ("slate.bg2", "slate_bg2", "#1d2530"),
    ("slate.text", "slate_text", "#d8dee8"),
    ("semantic.info", "semantic_info", "#7f9fbf"),
    ("semantic.success", "semantic_success", "#74b88c"),
    ("semantic.modeLog", "semantic_mode_log", "#6f89ad"),
]


def rust_hex(name: str, src: str) -> str:
    pattern = rf"{re.escape(name)}:\s*Color::Rgb\(0x([0-9a-fA-F]{{2}}),\s*0x([0-9a-fA-F]{{2}}),\s*0x([0-9a-fA-F]{{2}})\)"
    match = re.search(pattern, src)
    if not match:
        return "missing"
    return "#" + "".join(part.lower() for part in match.groups())


def main() -> None:
    ts_src = TS.read_text()
    rs_src = RS.read_text()
    rows = []
    all_match = True
    for ts_name, rust_name, expected in TOKENS:
        actual = rust_hex(rust_name, rs_src)
        ts_found = expected in ts_src
        ok = actual == expected and ts_found
        all_match = all_match and ok
        rows.append((ts_name, rust_name, expected, actual, ts_found, ok))

    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00-00", "Z")
    out_dir = ROOT / "bench/results/rust-port/token-parity" / stamp
    out_dir.mkdir(parents=True, exist_ok=True)
    table = "".join(
        f"<tr class={'ok' if ok else 'bad'}><td>{html.escape(ts_name)}</td><td><code>{html.escape(rust_name)}</code></td><td><span class=swatch style='background:{expected}'></span><code>{expected}</code></td><td><span class=swatch style='background:{actual if actual.startswith('#') else '#000'}'></span><code>{html.escape(actual)}</code></td><td>{'yes' if ts_found else 'no'}</td><td>{'PASS' if ok else 'FAIL'}</td></tr>"
        for ts_name, rust_name, expected, actual, ts_found, ok in rows
    )
    html_doc = f"""<!doctype html>
<html><head><meta charset='utf-8'><title>JUZU Rust token parity</title>
<style>
:root {{ color-scheme: dark; --bg:#111318; --panel:#1a2029; --bg2:#1d2530; --text:#d8dee8; --muted:#8a95a7; --line:#2a3442; }}
body {{ margin:32px; background:radial-gradient(circle at top left,#1d2530 0,#111318 42rem); color:var(--text); font-family:Inter,system-ui,sans-serif; }}
h1 {{ margin:0 0 6px; }} .meta {{ color:var(--muted); margin-bottom:20px; }}
.card {{ background:rgba(26,32,41,.96); border:1px solid var(--line); border-radius:16px; padding:18px; box-shadow:0 18px 60px rgba(0,0,0,.26); }}
table {{ width:100%; border-collapse:collapse; }} th,td {{ border-bottom:1px solid #2a3442; padding:10px; text-align:left; }} th {{ color:#7f9fbf; }} code {{ color:#d8dee8; }}
.swatch {{ display:inline-block; width:34px; height:18px; border-radius:6px; border:1px solid rgba(255,255,255,.22); vertical-align:middle; margin-right:8px; }}
.ok td:last-child {{ color:#74b88c; font-weight:700; }} .bad td:last-child {{ color:#ce6f7c; font-weight:700; }}
.preview {{ margin-top:18px; background:#1a2029; padding:12px; border-radius:12px; }} .pill {{ display:inline-block; background:#6f89ad; color:#111318; font-weight:800; padding:2px 8px; margin-right:10px; }} .key {{ color:#7f9fbf; }} .seg {{ background:#1d2530; padding:2px 8px; margin-right:8px; }} .foot {{ margin-top:10px; background:#1a2029; }} .path {{ background:#1d2530; color:#7f9fbf; padding:2px 8px; }} .nodes {{ float:right; background:#1d2530; color:#74b88c; padding:2px 8px; }}
</style></head><body>
<h1>JUZU Rust token parity</h1><div class='meta'>Old Bun/OpenTUI token source: <code>src/core/ui-tokens.ts</code>. Rust consumer: <code>crates/juzu-tui/src/main.rs</code>. Overall: <strong>{'PASS' if all_match else 'FAIL'}</strong></div>
<section class='card'><table><thead><tr><th>Old token</th><th>Rust token</th><th>Expected</th><th>Rust</th><th>Found in TS</th><th>Status</th></tr></thead><tbody>{table}</tbody></table>
<div class='preview'><div><span class='pill'>LOG</span><span class='key'>j/k</span><span class='seg'>Select</span><span class='key'>1-5</span><span class='seg'>Layout</span><span class='key'>^d</span><span class='seg'>Diff</span></div><div class='foot'><span class='path'>~/dev/juzu @working</span><span class='nodes'>mainline 80 nodes</span></div></div></section>
</body></html>"""
    path = out_dir / "token-parity.html"
    path.write_text(html_doc)
    print(f"file://{path}")
    if not all_match:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
