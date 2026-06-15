#!/usr/bin/env python3
"""Benchmark the Rust Ratatui JUZU surface under scripted render/input scenarios."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import html
import json
import os
import pathlib
import pty
import select
import signal
import struct
import subprocess
import termios
import time
from typing import Any

MB = 1024 * 1024

SCENARIOS = {
    "idle-mainline": {
        "mode": "mainline",
        "duration_ms": 5_000,
        "keys": [],
        "note": "steady-state render loop on mainline layout",
    },
    "navigate-mainline": {
        "mode": "mainline",
        "duration_ms": 8_000,
        "keys": list("j" * 90 + "k" * 45 + "j" * 30),
        "key_interval_ms": 35,
        "note": "selection movement through the DAG rows",
    },
    "layout-switching": {
        "mode": "chronological",
        "duration_ms": 8_000,
        "keys": list(("12345jjjjj" * 12) + ("kkkkk54321" * 6)),
        "key_interval_ms": 45,
        "note": "layout mode switches plus navigation",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=".")
    parser.add_argument("--limit", type=int, default=80)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--scenario", choices=["all", *SCENARIOS.keys()], default="all")
    parser.add_argument("--sample-interval-ms", type=int, default=100)
    parser.add_argument("--cols", type=int, default=120)
    parser.add_argument("--rows", type=int, default=36)
    parser.add_argument("--output-root", default="bench/results/rust-port/rust-tui-bench")
    parser.add_argument("--no-build", action="store_true")
    return parser.parse_args()


def run(cmd: list[str], cwd: pathlib.Path) -> str:
    return subprocess.run(cmd, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def read_proc_memory(pid: int) -> dict[str, float] | None:
    try:
        body = pathlib.Path(f"/proc/{pid}/smaps_rollup").read_text()
    except OSError:
        try:
            body = pathlib.Path(f"/proc/{pid}/status").read_text()
        except OSError:
            return None

    def field(name: str) -> int:
        for line in body.splitlines():
            if line.startswith(f"{name}:"):
                parts = line.split()
                if len(parts) >= 2 and parts[1].isdigit():
                    return int(parts[1])
        return 0

    rss_kb = field("Rss") or field("VmRSS")
    pss_kb = field("Pss") or rss_kb
    swap_kb = field("Swap") or field("VmSwap")
    return {
        "rssMb": round(rss_kb / 1024, 2),
        "pssMb": round(pss_kb / 1024, 2),
        "swapMb": round(swap_kb / 1024, 2),
    }


def median(values: list[float]) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    mid = len(values) // 2
    if len(values) % 2:
        return round(values[mid], 2)
    return round((values[mid - 1] + values[mid]) / 2, 2)


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    idx = min(len(values) - 1, max(0, int((pct / 100) * len(values))))
    return round(values[idx], 2)


def steady(values: list[float]) -> float:
    if not values:
        return 0.0
    start = int(len(values) * 0.6)
    return median(values[start:])


def set_pty_size(fd: int, rows: int, cols: int) -> None:
    packed = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, packed)


def strip_ansi(text: str) -> str:
    import re

    return re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text).replace("\x1b(B", "")


def run_tui_once(binary: pathlib.Path, repo: pathlib.Path, limit: int, scenario_id: str, scenario: dict[str, Any], args: argparse.Namespace, run_no: int, out_dir: pathlib.Path) -> dict[str, Any]:
    master, slave = pty.openpty()
    set_pty_size(slave, args.rows, args.cols)
    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    cmd = [str(binary), "--path", str(repo), "--limit", str(limit), "--mode", scenario["mode"]]
    proc = subprocess.Popen(cmd, cwd=repo, stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True)
    os.close(slave)
    os.set_blocking(master, False)

    started = time.monotonic()
    first_bytes_ms = None
    first_header_ms = None
    samples: list[dict[str, Any]] = []
    captured = bytearray()
    key_times_ms: list[float] = []
    key_interval = scenario.get("key_interval_ms", 50) / 1000
    keys = scenario.get("keys", [])
    next_key_at = started + 0.5
    key_idx = 0
    next_sample_at = started
    deadline = started + scenario["duration_ms"] / 1000

    while time.monotonic() < deadline:
        now = time.monotonic()
        if now >= next_sample_at:
            mem = read_proc_memory(proc.pid)
            if mem is not None:
                samples.append({"uptimeMs": round((now - started) * 1000, 2), **mem})
            next_sample_at = now + args.sample_interval_ms / 1000

        if key_idx < len(keys) and now >= next_key_at:
            t0 = time.monotonic()
            try:
                os.write(master, keys[key_idx].encode())
                key_times_ms.append(round((time.monotonic() - t0) * 1000, 3))
            except OSError:
                break
            key_idx += 1
            next_key_at = now + key_interval

        readable, _, _ = select.select([master], [], [], 0.02)
        if readable:
            try:
                chunk = os.read(master, 65_536)
            except OSError:
                chunk = b""
            if chunk:
                if first_bytes_ms is None:
                    first_bytes_ms = round((time.monotonic() - started) * 1000, 2)
                captured.extend(chunk)
                plain = strip_ansi(captured.decode(errors="ignore"))
                if first_header_ms is None and ("dag graph" in plain or " LOG " in plain or " DIFF " in plain):
                    first_header_ms = round((time.monotonic() - started) * 1000, 2)

        if proc.poll() is not None:
            break

    try:
        os.write(master, b"q")
    except OSError:
        pass
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=1)
    try:
        os.close(master)
    except OSError:
        pass

    decoded = captured.decode(errors="ignore")
    plain = strip_ansi(decoded)
    capture_path = out_dir / f"{scenario_id}-run-{run_no}-capture.txt"
    capture_path.write_text(plain)
    rss = [sample["rssMb"] for sample in samples]
    pss = [sample["pssMb"] for sample in samples]
    return {
        "run": run_no,
        "scenario": scenario_id,
        "mode": scenario["mode"],
        "ok": first_header_ms is not None and proc.returncode in (0, None),
        "returnCode": proc.returncode,
        "durationMs": round((time.monotonic() - started) * 1000, 2),
        "firstBytesMs": first_bytes_ms,
        "firstHeaderMs": first_header_ms,
        "keysSent": key_idx,
        "keyWriteMsP50": percentile(key_times_ms, 50),
        "keyWriteMsP95": percentile(key_times_ms, 95),
        "bytesCaptured": len(captured),
        "capturePath": str(capture_path),
        "sampleCount": len(samples),
        "rssMbPeak": round(max(rss), 2) if rss else 0,
        "rssMbSteady": steady(rss),
        "pssMbPeak": round(max(pss), 2) if pss else 0,
        "pssMbSteady": steady(pss),
        "samples": samples,
    }


def summarize_runs(runs: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "okCount": sum(1 for run in runs if run["ok"]),
        "runCount": len(runs),
        "rssMbPeak": round(max((run["rssMbPeak"] for run in runs), default=0), 2),
        "rssMbSteadyMedian": median([run["rssMbSteady"] for run in runs]),
        "pssMbPeak": round(max((run["pssMbPeak"] for run in runs), default=0), 2),
        "pssMbSteadyMedian": median([run["pssMbSteady"] for run in runs]),
        "firstHeaderMsMedian": median([run["firstHeaderMs"] for run in runs if run["firstHeaderMs"] is not None]),
        "keyWriteMsP95Median": median([run["keyWriteMsP95"] for run in runs]),
        "bytesCapturedMax": max((run["bytesCaptured"] for run in runs), default=0),
    }


def render_html(report: dict[str, Any], out_dir: pathlib.Path) -> str:
    cards = []
    tables = []
    for scenario in report["scenarios"]:
        s = scenario["summary"]
        cards.append(f"""
        <div class='metric'><b>{html.escape(scenario['id'])}</b><span>{html.escape(scenario['note'])}</span>
          <strong>{s['rssMbPeak']} MB RSS peak</strong><small>{s['pssMbSteadyMedian']} MB PSS steady · header {s['firstHeaderMsMedian']} ms</small></div>
        """)
        rows = "".join(f"""
        <tr><td>{run['run']}</td><td>{'✓' if run['ok'] else '✕'}</td><td>{run['rssMbPeak']}</td><td>{run['rssMbSteady']}</td><td>{run['pssMbPeak']}</td><td>{run['pssMbSteady']}</td><td>{run['firstHeaderMs']}</td><td>{run['keysSent']}</td><td>{run['bytesCaptured']}</td></tr>
        """ for run in scenario["runs"])
        tables.append(f"""
        <h2>{html.escape(scenario['id'])}</h2><p>{html.escape(scenario['note'])}</p>
        <table><thead><tr><th>Run</th><th>OK</th><th>RSS peak MB</th><th>RSS steady MB</th><th>PSS peak MB</th><th>PSS steady MB</th><th>Header ms</th><th>Keys</th><th>Bytes</th></tr></thead><tbody>{rows}</tbody></table>
        """)
    return f"""<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>JUZU Rust TUI Benchmark</title>
<style>:root{{--bg:#050816;--panel:#0f172a;--line:#334155;--text:#e2e8f0;--muted:#94a3b8;--cyan:#67e8f9;--green:#86efac}}*{{box-sizing:border-box}}body{{margin:0;background:radial-gradient(circle at 20% -10%,#12345f,transparent 40%),var(--bg);color:var(--text);font:15px/1.5 Inter,system-ui,sans-serif}}main{{max-width:1300px;margin:auto;padding:44px 24px}}.shell{{border:1px solid var(--line);border-radius:28px;background:rgba(15,23,42,.95);padding:32px;box-shadow:0 24px 90px rgba(0,0,0,.35)}}h1{{font-size:40px;margin:0 0 8px;letter-spacing:-.04em}}h2{{margin-top:34px}}p,small,span{{color:var(--muted)}}code{{color:#bfdbfe}}.metrics{{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:24px 0}}.metric{{background:#07111f;border:1px solid var(--line);border-radius:18px;padding:16px}}.metric b,.metric strong{{display:block;color:var(--cyan)}}.metric strong{{font-size:24px;color:var(--green);margin-top:10px}}table{{width:100%;border-collapse:collapse;margin-top:12px}}th,td{{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left}}th{{background:#08111f;color:var(--cyan)}}.note{{border:1px solid var(--line);border-radius:16px;background:#07111f;padding:14px 16px;color:var(--muted)}}@media(max-width:900px){{.metrics{{grid-template-columns:1fr}}}}</style></head>
<body><main><section class='shell'><h1>JUZU Rust TUI Benchmark</h1><p>Release binary benchmark for current Ratatui DAG rendering and scripted input paths.</p><div class='note'>Repo: <code>{html.escape(report['repo'])}</code> · Limit: <code>{report['limit']}</code> · Terminal: <code>{report['terminal']['cols']}x{report['terminal']['rows']}</code> · Output: <code>{html.escape(str(out_dir))}</code></div><div class='metrics'>{''.join(cards)}</div>{''.join(tables)}</section></main></body></html>"""


def main() -> int:
    args = parse_args()
    cwd = pathlib.Path.cwd().resolve()
    repo = pathlib.Path(args.repo).resolve()
    if not args.no_build:
        subprocess.run(["cargo", "build", "--release", "-p", "juzu-tui"], cwd=cwd, check=True)
    binary = cwd / "target" / "release" / "juzu-tui"
    if not binary.exists():
        raise SystemExit(f"missing binary: {binary}")

    stamp = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H-%M-%S-%f")[:-3] + "Z"
    out_dir = (cwd / args.output_root / stamp).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    scenario_ids = list(SCENARIOS) if args.scenario == "all" else [args.scenario]
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "createdAt": dt.datetime.now(dt.UTC).isoformat(),
        "repo": str(repo),
        "limit": args.limit,
        "binary": str(binary),
        "terminal": {"cols": args.cols, "rows": args.rows},
        "sampleIntervalMs": args.sample_interval_ms,
        "scenarios": [],
    }

    for scenario_id in scenario_ids:
        scenario = SCENARIOS[scenario_id]
        runs = []
        for run_no in range(1, args.runs + 1):
            print(f"{scenario_id} run {run_no}/{args.runs}")
            runs.append(run_tui_once(binary, repo, args.limit, scenario_id, scenario, args, run_no, out_dir))
        report["scenarios"].append({
            "id": scenario_id,
            "note": scenario["note"],
            "mode": scenario["mode"],
            "summary": summarize_runs(runs),
            "runs": runs,
        })

    (out_dir / "rust-tui-benchmark.json").write_text(json.dumps(report, indent=2) + "\n")
    (out_dir / "rust-tui-benchmark.html").write_text(render_html(report, out_dir))
    print((out_dir / "rust-tui-benchmark.html").resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
