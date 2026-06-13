#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const textDecoder = new TextDecoder();

type CliOptions = {
  surface: "all" | "tui" | "web";
  runs: number;
  outputRoot: string;
  portBase: number;
  timeoutMs: number;
};

type WebRun = {
  run: number;
  port: number;
  ok: boolean;
  error?: string;
  stdoutReadyMs?: number;
  httpReadyMs?: number;
  firstStdoutMs?: number;
  repoCwd?: string;
};

type TuiRun = {
  run: number;
  ok: boolean;
  error?: string;
  logPath: string;
  firstBytesMs?: number;
  alternateScreenMs?: number;
  firstHeaderTokenMs?: number;
  bytesCaptured?: number;
};

type Result = {
  schemaVersion: 1;
  createdAt: string;
  cwd: string;
  options: CliOptions;
  web?: { runs: WebRun[]; summary: Summary };
  tui?: { runs: TuiRun[]; summary: Summary };
};

type Summary = {
  count: number;
  okCount: number;
  metrics: Record<string, { min: number; median: number; max: number }>;
};

function printHelp() {
  console.log(`
JUZU startup baseline sampler

Usage:
  bun run scripts/bench/startup.ts [options]

Options:
  --surface <all|tui|web>   Surface to measure (default: all)
  --runs <n>                Repetitions per surface (default: 3)
  --port-base <n>           First web benchmark port (default: 43990)
  --timeout-ms <n>          Per-run readiness timeout (default: 8000)
  --output-root <path>      Output root (default: bench/results/rust-port/startup)
  -h, --help                Show help

Readiness definitions:
  web stdoutReadyMs: process printed the Bun server ready line.
  web httpReadyMs: /api/repo returned HTTP 200 JSON.
  tui firstBytesMs: terminal capture emitted first bytes beyond script(1) header.
  tui alternateScreenMs: terminal entered alternate screen.
  tui firstHeaderTokenMs: captured rendered JUZU header token (LOG/OPLOG/JUZU).
`);
}

function parseArgs(argv: string[]): CliOptions {
  const kv = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") kv.set("help", true);
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) {
      kv.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      kv.set(key, next);
      i += 1;
    } else {
      kv.set(key, true);
    }
  }
  if (kv.has("help")) {
    printHelp();
    process.exit(0);
  }
  const surface = String(kv.get("surface") || "all") as CliOptions["surface"];
  if (!["all", "tui", "web"].includes(surface)) throw new Error(`Invalid --surface ${surface}`);
  return {
    surface,
    runs: readPositiveInt(kv.get("runs"), 3),
    outputRoot: resolve(String(kv.get("output-root") || join(process.cwd(), "bench", "results", "rust-port", "startup"))),
    portBase: readPositiveInt(kv.get("port-base"), 43_990),
    timeoutMs: readPositiveInt(kv.get("timeout-ms"), 8_000),
  };
}

function readPositiveInt(raw: string | boolean | undefined, fallback: number): number {
  if (raw === undefined || raw === true) return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? round2(sorted[mid]!)
    : round2((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function summarize<T extends Record<string, unknown>>(runs: T[], metricKeys: string[]): Summary {
  const metrics: Summary["metrics"] = {};
  for (const key of metricKeys) {
    const values = runs
      .map((run) => run[key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (values.length > 0) {
      metrics[key] = { min: round2(Math.min(...values)), median: median(values), max: round2(Math.max(...values)) };
    }
  }
  return {
    count: runs.length,
    okCount: runs.filter((run) => run.ok === true).length,
    metrics,
  };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFileMetric(logPath: string, start: number, timeoutMs: number, predicate: (body: string, size: number) => boolean): Promise<number | undefined> {
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const raw = await readFile(logPath);
      const body = textDecoder.decode(raw);
      if (predicate(body, raw.byteLength)) return Date.now() - start;
    }
    await sleep(20);
  }
  return undefined;
}

async function runWeb(run: number, port: number, timeoutMs: number): Promise<WebRun> {
  const started = Date.now();
  const proc = Bun.spawn(["bun", "run", "server.ts", `--port=${port}`], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdout = "";
  let stderr = "";
  let firstStdoutMs: number | undefined;
  let stdoutReadyMs: number | undefined;
  const stdoutReader = proc.stdout.getReader();
  const stderrReader = proc.stderr.getReader();

  void (async () => {
    while (true) {
      const chunk = await stdoutReader.read();
      if (chunk.done) break;
      if (firstStdoutMs === undefined) firstStdoutMs = Date.now() - started;
      stdout += textDecoder.decode(chunk.value);
      if (stdoutReadyMs === undefined && stdout.includes("juzu running at")) stdoutReadyMs = Date.now() - started;
    }
  })();
  void (async () => {
    while (true) {
      const chunk = await stderrReader.read();
      if (chunk.done) break;
      stderr += textDecoder.decode(chunk.value);
    }
  })();

  let httpReadyMs: number | undefined;
  let repoCwd: string | undefined;
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/repo`, { signal: AbortSignal.timeout(500) });
      if (resp.ok) {
        const json = await resp.json() as { cwd?: string };
        httpReadyMs = Date.now() - started;
        repoCwd = json.cwd;
        break;
      }
    } catch {
      // keep polling
    }
    await sleep(25);
  }

  proc.kill("SIGTERM");
  await Promise.race([proc.exited, sleep(1_000)]);
  if (!proc.killed) proc.kill("SIGKILL");

  const ok = httpReadyMs !== undefined && stdoutReadyMs !== undefined;
  return {
    run,
    port,
    ok,
    error: ok ? undefined : ["startup timeout", stderr.trim()].filter(Boolean).join(": "),
    firstStdoutMs,
    stdoutReadyMs,
    httpReadyMs,
    repoCwd,
  };
}

async function runTui(run: number, outputDir: string, timeoutMs: number): Promise<TuiRun> {
  const logPath = join(outputDir, `tui-run-${run}.typescript.log`);
  const started = Date.now();
  const proc = Bun.spawn(["script", "-qfec", "bun run cli.ts --tui", logPath], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  let stderr = "";
  const stderrReader = proc.stderr.getReader();
  void (async () => {
    while (true) {
      const chunk = await stderrReader.read();
      if (chunk.done) break;
      stderr += textDecoder.decode(chunk.value);
    }
  })();

  const firstBytesMs = await waitForFileMetric(logPath, started, timeoutMs, (_body, size) => size > 180);
  const alternateScreenMs = await waitForFileMetric(logPath, started, timeoutMs, (body) => body.includes("\x1b[?1049h"));
  const firstHeaderTokenMs = await waitForFileMetric(logPath, started, timeoutMs, (body) => /\b(LOG|OPLOG|JUZU)\b/.test(body.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")));

  proc.kill("SIGTERM");
  await Promise.race([proc.exited, sleep(1_000)]);
  if (!proc.killed) proc.kill("SIGKILL");

  let bytesCaptured = 0;
  if (existsSync(logPath)) bytesCaptured = (await readFile(logPath)).byteLength;
  const ok = firstBytesMs !== undefined && alternateScreenMs !== undefined && firstHeaderTokenMs !== undefined;
  return {
    run,
    ok,
    error: ok ? undefined : ["startup timeout", stderr.trim()].filter(Boolean).join(": "),
    logPath,
    firstBytesMs,
    alternateScreenMs,
    firstHeaderTokenMs,
    bytesCaptured,
  };
}

async function writeSummaryMarkdown(path: string, result: Result) {
  const lines: string[] = [];
  lines.push("# JUZU startup baseline");
  lines.push("");
  lines.push(`Created: ${result.createdAt}`);
  lines.push(`CWD: \`${result.cwd}\``);
  lines.push("");
  if (result.web) {
    lines.push("## Web startup to `/api/repo`");
    lines.push("");
    lines.push("| Run | Port | OK | First stdout | Server stdout ready | HTTP ready | Repo cwd |");
    lines.push("| ---: | ---: | :--: | ---: | ---: | ---: | --- |");
    for (const run of result.web.runs) {
      lines.push(`| ${run.run} | ${run.port} | ${run.ok ? "yes" : "no"} | ${fmtMs(run.firstStdoutMs)} | ${fmtMs(run.stdoutReadyMs)} | ${fmtMs(run.httpReadyMs)} | ${run.repoCwd ? `\`${run.repoCwd}\`` : ""} |`);
    }
    lines.push("");
    lines.push(summaryLines(result.web.summary).join("\n"));
    lines.push("");
  }
  if (result.tui) {
    lines.push("## TUI startup to first rendered header");
    lines.push("");
    lines.push("| Run | OK | First bytes | Alt screen | Header token | Bytes captured | Capture log |");
    lines.push("| ---: | :--: | ---: | ---: | ---: | ---: | --- |");
    for (const run of result.tui.runs) {
      lines.push(`| ${run.run} | ${run.ok ? "yes" : "no"} | ${fmtMs(run.firstBytesMs)} | ${fmtMs(run.alternateScreenMs)} | ${fmtMs(run.firstHeaderTokenMs)} | ${run.bytesCaptured ?? 0} | \`${run.logPath}\` |`);
    }
    lines.push("");
    lines.push(summaryLines(result.tui.summary).join("\n"));
    lines.push("");
  }
  await writeFile(path, `${lines.join("\n")}\n`);
}

function fmtMs(n: number | undefined): string {
  return typeof n === "number" ? `${round2(n)} ms` : "";
}

function summaryLines(summary: Summary): string[] {
  const lines = [`OK runs: ${summary.okCount}/${summary.count}`, "", "| Metric | Min | Median | Max |", "| --- | ---: | ---: | ---: |"];
  for (const [metric, values] of Object.entries(summary.metrics)) {
    lines.push(`| ${metric} | ${values.min} ms | ${values.median} ms | ${values.max} ms |`);
  }
  return lines;
}

const options = parseArgs(Bun.argv.slice(2));
const createdAt = new Date().toISOString();
const stamp = createdAt.replace(/[:.]/g, "-");
const outputDir = join(options.outputRoot, stamp);
await mkdir(outputDir, { recursive: true });

const result: Result = {
  schemaVersion: 1,
  createdAt,
  cwd: process.cwd(),
  options,
};

if (options.surface === "all" || options.surface === "web") {
  const runs: WebRun[] = [];
  for (let i = 1; i <= options.runs; i++) {
    runs.push(await runWeb(i, options.portBase + i - 1, options.timeoutMs));
  }
  result.web = { runs, summary: summarize(runs, ["firstStdoutMs", "stdoutReadyMs", "httpReadyMs"]) };
}

if (options.surface === "all" || options.surface === "tui") {
  const runs: TuiRun[] = [];
  for (let i = 1; i <= options.runs; i++) {
    runs.push(await runTui(i, outputDir, options.timeoutMs));
  }
  result.tui = { runs, summary: summarize(runs, ["firstBytesMs", "alternateScreenMs", "firstHeaderTokenMs"]) };
}

await writeFile(join(outputDir, "startup-baseline.json"), `${JSON.stringify(result, null, 2)}\n`);
await writeSummaryMarkdown(join(outputDir, "SUMMARY.md"), result);
console.log(join(outputDir, "SUMMARY.md"));
