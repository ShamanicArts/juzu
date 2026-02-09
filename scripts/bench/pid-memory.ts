#!/usr/bin/env bun

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type CliOptions = {
  pid: number;
  durationMs: number;
  intervalMs: number;
  includeChildren: boolean;
  outputRoot: string;
};

type ProcMemory = {
  rssKb: number;
  pssKb: number;
  swapKb: number;
};

type Sample = {
  at: string;
  uptimeMs: number;
  pidCount: number;
  rssMb: number;
  pssMb: number;
  swapMb: number;
};

type Result = {
  schemaVersion: 1;
  createdAt: string;
  options: CliOptions;
  rootPid: number;
  rootCommand: string;
  platform: string;
  samples: Sample[];
  summary: {
    rssMbPeak: number;
    rssMbSteady: number;
    pssMbPeak: number;
    pssMbSteady: number;
    swapMbPeak: number;
    swapMbSteady: number;
    avgPidCount: number;
    sampleCount: number;
  };
};

function printHelp() {
  console.log(`
PID memory sampler (Linux /proc based)

Usage:
  bun run scripts/bench/pid-memory.ts --pid <pid> [options]

Options:
  --pid <n>               Root process id to sample (required)
  --duration-ms <n>       Total sampling duration (default: 30000)
  --interval-ms <n>       Sampling interval (default: 250)
  --include-children      Include full descendant process tree (default: true)
  --no-include-children   Sample root pid only
  --output-root <path>    Output root dir (default: benchmarks/results/pid)
  -h, --help              Show help

Examples:
  bun run scripts/bench/pid-memory.ts --pid 2907393
  bun run scripts/bench/pid-memory.ts --pid 2907393 --duration-ms 120000 --interval-ms 500
`);
}

function parseArgs(argv: string[]): CliOptions {
  const kv = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
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

  const pidRaw = kv.get("pid");
  if (!pidRaw || pidRaw === true) throw new Error("Missing required --pid <n>.");

  const includeChildren = kv.has("no-include-children")
    ? false
    : kv.has("include-children")
      ? true
      : true;

  return {
    pid: readPositiveInt(String(pidRaw), 0),
    durationMs: readPositiveInt(kv.get("duration-ms"), 30_000),
    intervalMs: readPositiveInt(kv.get("interval-ms"), 250),
    includeChildren,
    outputRoot: resolve(String(kv.get("output-root") || join(process.cwd(), "benchmarks", "results", "pid"))),
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
  if (sorted.length % 2 === 1) return round2(sorted[mid]!);
  return round2((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function steady(values: number[]): number {
  if (values.length === 0) return 0;
  const start = Math.floor(values.length * 0.6);
  return median(values.slice(start));
}

async function processExists(pid: number): Promise<boolean> {
  try {
    await readFile(`/proc/${pid}/status`, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function readCommand(pid: number): Promise<string> {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
    const cleaned = cmdline.replace(/\u0000/g, " ").trim();
    if (cleaned) return cleaned;
  } catch {
    // ignore
  }
  try {
    const comm = await readFile(`/proc/${pid}/comm`, "utf8");
    return comm.trim();
  } catch {
    return "unknown";
  }
}

async function listPidPpidPairs(): Promise<Array<{ pid: number; ppid: number }>> {
  const entries = await readdir("/proc", { withFileTypes: true });
  const out: Array<{ pid: number; ppid: number }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\d+$/.test(entry.name)) continue;
    const pid = Number.parseInt(entry.name, 10);
    if (!Number.isFinite(pid)) continue;
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const ppidLine = status.split("\n").find((line) => line.startsWith("PPid:"));
      if (!ppidLine) continue;
      const ppid = Number.parseInt(ppidLine.replace("PPid:", "").trim(), 10);
      if (!Number.isFinite(ppid)) continue;
      out.push({ pid, ppid });
    } catch {
      // Process may exit while scanning.
    }
  }

  return out;
}

function descendants(rootPid: number, pairs: Array<{ pid: number; ppid: number }>): number[] {
  const byParent = new Map<number, number[]>();
  for (const pair of pairs) {
    const arr = byParent.get(pair.ppid);
    if (arr) arr.push(pair.pid);
    else byParent.set(pair.ppid, [pair.pid]);
  }

  const out: number[] = [];
  const queue: number[] = [rootPid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    const kids = byParent.get(pid);
    if (!kids) continue;
    for (const kid of kids) queue.push(kid);
  }
  return out;
}

function parseKbField(text: string, field: string): number {
  const line = text.split("\n").find((l) => l.startsWith(`${field}:`));
  if (!line) return 0;
  const m = line.match(/(\d+)/);
  if (!m?.[1]) return 0;
  const value = Number.parseInt(m[1], 10);
  return Number.isFinite(value) ? value : 0;
}

async function readProcMemory(pid: number): Promise<ProcMemory | null> {
  try {
    const smaps = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
    return {
      rssKb: parseKbField(smaps, "Rss"),
      pssKb: parseKbField(smaps, "Pss"),
      swapKb: parseKbField(smaps, "Swap"),
    };
  } catch {
    // Fallback for environments without smaps access.
  }

  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const rssKb = parseKbField(status, "VmRSS");
    const swapKb = parseKbField(status, "VmSwap");
    return { rssKb, pssKb: rssKb, swapKb };
  } catch {
    return null;
  }
}

async function sampleTree(rootPid: number, includeChildren: boolean): Promise<{ pidCount: number; rssKb: number; pssKb: number; swapKb: number }> {
  const pids = includeChildren ? descendants(rootPid, await listPidPpidPairs()) : [rootPid];

  let rssKb = 0;
  let pssKb = 0;
  let swapKb = 0;
  let alive = 0;

  for (const pid of pids) {
    const mem = await readProcMemory(pid);
    if (!mem) continue;
    alive += 1;
    rssKb += mem.rssKb;
    pssKb += mem.pssKb;
    swapKb += mem.swapKb;
  }

  return { pidCount: alive, rssKb, pssKb, swapKb };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!(await processExists(options.pid))) {
    throw new Error(`PID ${options.pid} does not exist.`);
  }

  const rootCommand = await readCommand(options.pid);
  console.log(`Sampling PID ${options.pid} (${rootCommand})`);
  console.log(`Duration=${options.durationMs}ms Interval=${options.intervalMs}ms IncludeChildren=${options.includeChildren}`);

  const startedAt = Date.now();
  const samples: Sample[] = [];

  while (Date.now() - startedAt <= options.durationMs) {
    if (!(await processExists(options.pid))) {
      console.log(`PID ${options.pid} exited during sampling.`);
      break;
    }
    const tree = await sampleTree(options.pid, options.includeChildren);
    const now = Date.now();
    samples.push({
      at: new Date(now).toISOString(),
      uptimeMs: now - startedAt,
      pidCount: tree.pidCount,
      rssMb: round2(tree.rssKb / 1024),
      pssMb: round2(tree.pssKb / 1024),
      swapMb: round2(tree.swapKb / 1024),
    });
    await wait(options.intervalMs);
  }

  if (samples.length === 0) throw new Error("No samples captured.");

  const rssSeries = samples.map((s) => s.rssMb);
  const pssSeries = samples.map((s) => s.pssMb);
  const swapSeries = samples.map((s) => s.swapMb);
  const pidCounts = samples.map((s) => s.pidCount);

  const result: Result = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    options,
    rootPid: options.pid,
    rootCommand,
    platform: process.platform,
    samples,
    summary: {
      rssMbPeak: round2(Math.max(...rssSeries)),
      rssMbSteady: steady(rssSeries),
      pssMbPeak: round2(Math.max(...pssSeries)),
      pssMbSteady: steady(pssSeries),
      swapMbPeak: round2(Math.max(...swapSeries)),
      swapMbSteady: steady(swapSeries),
      avgPidCount: round2(pidCounts.reduce((a, b) => a + b, 0) / pidCounts.length),
      sampleCount: samples.length,
    },
  };

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(options.outputRoot, runId);
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `PID-${options.pid}.json`);
  await writeFile(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");

  console.log(`\nSummary:`);
  console.log(`- rss_peak_mb:   ${result.summary.rssMbPeak}`);
  console.log(`- rss_steady_mb: ${result.summary.rssMbSteady}`);
  console.log(`- pss_peak_mb:   ${result.summary.pssMbPeak}`);
  console.log(`- pss_steady_mb: ${result.summary.pssMbSteady}`);
  console.log(`- swap_peak_mb:  ${result.summary.swapMbPeak}`);
  console.log(`- avg_pid_count: ${result.summary.avgPidCount}`);
  console.log(`- sample_count:  ${result.summary.sampleCount}`);
  console.log(`\nSaved: ${outPath}`);
}

main().catch((err) => {
  console.error(`PID sampler failed: ${String(err)}`);
  process.exit(1);
});
