#!/usr/bin/env python3
"""Generate an HTML review artifact for bundled Rust TUI theme port coverage."""

from __future__ import annotations

import datetime as dt
import html
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
THEMES = ROOT / "themes"


def color(data: dict, section: str, key: str, fallback: str = "#000000") -> str:
    value = data.get(section, {}).get(key, fallback)
    return value if isinstance(value, str) and value.startswith("#") else fallback


def main() -> None:
    theme_files = sorted(p for p in THEMES.glob("*.toml") if p.name != "config.toml")
    cards: list[str] = []
    for path in theme_files:
        data = tomllib.loads(path.read_text())
        name = path.stem
        bg = color(data, "slate", "bg0")
        panel = color(data, "slate", "panel")
        bg2 = color(data, "slate", "bg2")
        text = color(data, "slate", "text")
        muted = color(data, "slate", "textMuted")
        info = color(data, "semantic", "info")
        success = color(data, "semantic", "success")
        warn = color(data, "semantic", "warn")
        error = color(data, "semantic", "error")
        lanes = data.get("graph", {}).get("lanes", [])
        lane_spans = "".join(
            f"<span class='lane' style='background:{html.escape(str(lane))}'></span>"
            for lane in lanes[:8]
            if isinstance(lane, str)
        )
        cards.append(f"""
<section class='theme' style='--bg:{bg};--panel:{panel};--bg2:{bg2};--text:{text};--muted:{muted};--info:{info};--success:{success};--warn:{warn};--error:{error}'>
  <div class='bar'><span class='mode'>LOG</span><span class='key'>^L</span><span class='seg'>View</span><span class='key'>t</span><span class='seg'>Theme picker</span></div>
  <div class='body'>
    <div class='graph'>
      <h2>{html.escape(name)}</h2>
      <p>dag graph · lane tokens</p>
      <div class='lanes'>{lane_spans}</div>
    </div>
    <div class='details'>
      <b>Details</b>
      <p>Change: theme/{html.escape(name)}</p>
      <p class='muted'>Files (f collapse):</p>
      <p><span class='add'>A</span> themes/{html.escape(path.name)}</p>
      <p><span class='mod'>M</span> status/footer/sidebar chrome</p>
    </div>
  </div>
  <div class='footer'><span>~/dev/juzu</span><span>{len(lanes)} lanes · bundled</span></div>
</section>""")

    stamp = dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds").replace(":", "-").replace("+00-00", "Z")
    out_dir = ROOT / "bench/results/rust-port/theme-port" / stamp
    out_dir.mkdir(parents=True, exist_ok=True)
    html_doc = f"""<!doctype html><html><head><meta charset='utf-8'><title>JUZU Rust bundled theme port</title>
<style>
body{{margin:32px;background:#0b1017;color:#d8dee8;font-family:Inter,system-ui,sans-serif}}h1{{margin:0 0 6px}}.meta{{color:#8a95a7;margin-bottom:20px}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:18px}}.theme{{background:var(--bg);color:var(--text);border:1px solid var(--bg2);border-radius:18px;overflow:hidden;box-shadow:0 20px 70px rgba(0,0,0,.3)}}.bar,.footer{{background:var(--panel);padding:10px 12px;display:flex;gap:10px;align-items:center;justify-content:space-between}}.bar{{justify-content:flex-start}}.mode{{background:var(--info);color:var(--bg);font-weight:900;padding:2px 8px;border-radius:5px}}.key{{color:var(--info);font-weight:800}}.seg{{background:var(--bg2);padding:2px 8px;border-radius:5px}}.body{{display:grid;grid-template-columns:1.2fr .9fr;gap:14px;padding:14px}}.graph,.details{{background:var(--panel);border:1px solid var(--bg2);border-radius:14px;padding:12px}}h2{{margin:0;color:var(--info)}}p{{margin:6px 0}}.muted{{color:var(--muted)}}.lanes{{display:flex;gap:6px;margin-top:14px}}.lane{{width:24px;height:56px;border-radius:9px;border:1px solid rgba(255,255,255,.2)}}.add{{color:var(--success);font-weight:900}}.mod{{color:var(--warn);font-weight:900}}.footer{{color:var(--muted)}}
</style></head><body><h1>JUZU Rust bundled theme port</h1><div class='meta'>{len(theme_files)} bundled TOML themes, same theme catalogue as the Bun/Poneglyph-style system.</div><div class='grid'>{''.join(cards)}</div></body></html>"""
    out = out_dir / "theme-port-review.html"
    out.write_text(html_doc)
    print(f"file://{out}")


if __name__ == "__main__":
    main()
