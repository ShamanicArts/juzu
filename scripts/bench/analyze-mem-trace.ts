#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type TraceSample = {
  type: "sample";
  seq: number;
  at: string;
  uptimeMs: number;
  mem: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
    arrayBuffersMb: number;
  };
  app: {
    viewMode: string;
    isLoading: boolean;
    nodes: number;
    totalNodes: number;
    selectedId: string | null;
    filesCacheEntries: number;
    filesCacheBytes: number;
    diffCacheEntries: number;
    diffCacheBytes: number;
    pinnedNodes: number;
  };
  graph: {
    drawCount: number;
    drawDelta: number;
    lastDrawAtMs: number;
    width: number;
    height: number;
    totalNodes: number;
    visibleNodes: number;
    visibleRows: number;
    scrollOffset: number;
    hasSelection: boolean;
  };
  counters: Record<string, number>;
  timers: Record<string, boolean | number>;
};

type PidResult = {
  samples: Array<{ uptimeMs: number; rssMb: number; pssMb: number }>;
};

type CliOptions = {
  traceFile: string;
  pidJson?: string;
};

function printHelp() {
  console.log(`
Analyze TUI memory trace

Usage:
  bun run scripts/bench/analyze-mem-trace.ts --trace-file <path> [--pid-json <path>]

Options:
  --trace-file <path>   JSONL output from JUZU_MEM_TRACE_FILE (required)
  --pid-json <path>     Optional bench:pid JSON to correlate process-level memory
  -h, --help            Show help
`);
}

function parseArgs(argv: string[]): CliOptions {
  const kv = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      kv.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
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

  const traceFile = kv.get("trace-file");
  if (!traceFile || traceFile === true) {
    throw new Error("Missing required --trace-file <path>");
  }

  const pidJson = kv.get("pid-json");
  return {
    traceFile: resolve(String(traceFile)),
    pidJson: pidJson && pidJson !== true ? resolve(String(pidJson)) : undefined,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function slopePerMinute(values: number[], stepMs: number): number {
  const n = values.length;
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = values[i]!;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const den = n * sxx - sx * sx;
  if (den === 0) return 0;
  const slopePerSample = (n * sxy - sx * sy) / den;
  return round2(slopePerSample * (60_000 / Math.max(1, stepMs)));
}

function summarizeTrace(samples: TraceSample[]) {
  const rss = samples.map((s) => s.mem.rssMb);
  const heap = samples.map((s) => s.mem.heapUsedMb);
  const filesBytes = samples.map((s) => s.app.filesCacheBytes);
  const diffBytes = samples.map((s) => s.app.diffCacheBytes);
  const drawDelta = samples.map((s) => s.graph.drawDelta);

  const stepMs = samples.length > 1 ? Math.max(1, samples[1]!.uptimeMs - samples[0]!.uptimeMs) : 1000;
  const busyDrawSamples = drawDelta.filter((d) => d > 0).length;

  const firstCounters = samples[0]!.counters;
  const lastCounters = samples[samples.length - 1]!.counters;
  const counterDelta: Record<string, number> = {};
  for (const key of Object.keys(lastCounters)) {
    const a = Number(firstCounters[key] || 0);
    const b = Number(lastCounters[key] || 0);
    counterDelta[key] = b - a;
  }

  return {
    samples: samples.length,
    durationSec: round2((samples[samples.length - 1]!.uptimeMs - samples[0]!.uptimeMs) / 1000),
    rssStartMb: rss[0],
    rssEndMb: rss[rss.length - 1],
    rssSlopeMbPerMin: slopePerMinute(rss, stepMs),
    heapStartMb: heap[0],
    heapEndMb: heap[heap.length - 1],
    heapSlopeMbPerMin: slopePerMinute(heap, stepMs),
    filesBytesStart: filesBytes[0],
    filesBytesEnd: filesBytes[filesBytes.length - 1],
    filesBytesDelta: filesBytes[filesBytes.length - 1]! - filesBytes[0]!,
    diffBytesStart: diffBytes[0],
    diffBytesEnd: diffBytes[diffBytes.length - 1],
    diffBytesDelta: diffBytes[diffBytes.length - 1]! - diffBytes[0]!,
    avgDrawDelta: round2(drawDelta.reduce((a, b) => a + b, 0) / Math.max(1, drawDelta.length)),
    busyDrawPct: round2((busyDrawSamples / Math.max(1, drawDelta.length)) * 100),
    counterDelta,
  };
}

async function loadTrace(path: string): Promise<TraceSample[]> {
  const raw = await readFile(path, "utf8");
  const out: TraceSample[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    if (parsed?.type === "sample") out.push(parsed as TraceSample);
  }
  if (out.length === 0) throw new Error(`No sample rows found in trace file '${path}'.`);
  return out;
}

async function loadPid(path: string) {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as PidResult;
  if (!parsed.samples || parsed.samples.length < 2) return null;
  const stepMs = Math.max(1, parsed.samples[1]!.uptimeMs - parsed.samples[0]!.uptimeMs);
  const rss = parsed.samples.map((s) => s.rssMb);
  const pss = parsed.samples.map((s) => s.pssMb);
  return {
    rssStartMb: rss[0],
    rssEndMb: rss[rss.length - 1],
    rssSlopeMbPerMin: slopePerMinute(rss, stepMs),
    pssStartMb: pss[0],
    pssEndMb: pss[pss.length - 1],
    pssSlopeMbPerMin: slopePerMinute(pss, stepMs),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const samples = await loadTrace(opts.traceFile);
  const traceSummary = summarizeTrace(samples);

  console.log("Trace summary:");
  console.log(`- samples: ${traceSummary.samples}`);
  console.log(`- duration_sec: ${traceSummary.durationSec}`);
  console.log(`- rss_start_mb: ${traceSummary.rssStartMb}`);
  console.log(`- rss_end_mb: ${traceSummary.rssEndMb}`);
  console.log(`- rss_slope_mb_per_min: ${traceSummary.rssSlopeMbPerMin}`);
  console.log(`- heap_start_mb: ${traceSummary.heapStartMb}`);
  console.log(`- heap_end_mb: ${traceSummary.heapEndMb}`);
  console.log(`- heap_slope_mb_per_min: ${traceSummary.heapSlopeMbPerMin}`);
  console.log(`- files_cache_bytes_delta: ${traceSummary.filesBytesDelta}`);
  console.log(`- diff_cache_bytes_delta: ${traceSummary.diffBytesDelta}`);
  console.log(`- graph_busy_draw_pct: ${traceSummary.busyDrawPct}`);
  console.log(`- graph_avg_draw_delta: ${traceSummary.avgDrawDelta}`);
  console.log("- counter_deltas:");
  for (const [key, value] of Object.entries(traceSummary.counterDelta)) {
    console.log(`  - ${key}: ${value}`);
  }

  if (opts.pidJson) {
    const pidSummary = await loadPid(opts.pidJson);
    if (pidSummary) {
      console.log("\nPID summary:");
      console.log(`- rss_start_mb: ${pidSummary.rssStartMb}`);
      console.log(`- rss_end_mb: ${pidSummary.rssEndMb}`);
      console.log(`- rss_slope_mb_per_min: ${pidSummary.rssSlopeMbPerMin}`);
      console.log(`- pss_start_mb: ${pidSummary.pssStartMb}`);
      console.log(`- pss_end_mb: ${pidSummary.pssEndMb}`);
      console.log(`- pss_slope_mb_per_min: ${pidSummary.pssSlopeMbPerMin}`);
    }
  }
}

main().catch((err) => {
  console.error(`Trace analysis failed: ${String(err)}`);
  process.exit(1);
});
