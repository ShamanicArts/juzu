#!/usr/bin/env bun

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

type ScenarioId =
  | "S1_SMALL_REPO_BASELINE"
  | "S2_MEDIUM_REPO_HISTORY_SCAN"
  | "S3_LARGE_REPO_LONG_SCROLL"
  | "S4_PINNING_STRESS"
  | "S5_WINDOW_BOUNDARY_STRESS"
  | "S6_OPLOG_OBSLOG_SMOKE";

type ScenarioSummary = {
  rssMbPeak: number;
  rssMbSteady: number;
  heapMbPeak: number;
  heapMbSteady: number;
  refreshMsP50: number;
  refreshMsP95: number;
  navStepMsP50: number;
  navStepMsP95: number;
  indexedNodes: number;
  residentNodes: number;
  visibleNodes: number;
  edgeMissingCount: number;
  laneDiscontinuityCount: number;
  pinViolationCount: number;
  workflowErrorCount: number;
};

type ScenarioResult = {
  schemaVersion: number;
  createdAt: string;
  scenario: ScenarioId;
  summary: ScenarioSummary;
};

type CliOptions = {
  baselineRoot: string;
  currentRoot: string;
  scenario?: ScenarioId;
  outputFile?: string;
};

function printHelp() {
  console.log(`
Benchmark compare tool (CLI-only)

Usage:
  bun run scripts/bench/compare.ts [options]

Options:
  --baseline-root <path>  Baseline dir with scenario JSON files (default: benchmarks/baselines)
  --current-root <path>   Current results dir or root (default: latest in benchmarks/results)
  --scenario <id>         Compare a single scenario
  --output-file <path>    Write markdown report to path (default: <current>/COMPARE.md)
  -h, --help              Show this help
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

  const scenario = kv.get("scenario");
  return {
    baselineRoot: resolve(String(kv.get("baseline-root") || join(process.cwd(), "benchmarks", "baselines"))),
    currentRoot: resolve(String(kv.get("current-root") || join(process.cwd(), "benchmarks", "results"))),
    scenario: scenario ? (String(scenario) as ScenarioId) : undefined,
    outputFile: kv.get("output-file") ? resolve(String(kv.get("output-file"))) : undefined,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pctDelta(current: number, baseline: number): number {
  if (baseline === 0) return current === 0 ? 0 : 100;
  return round2(((current - baseline) / baseline) * 100);
}

function statusFor(metric: string, baseline: number, current: number): "PASS" | "FAIL" {
  if (metric === "edgeMissingCount" || metric === "pinViolationCount" || metric === "workflowErrorCount") {
    return current === 0 ? "PASS" : "FAIL";
  }

  const delta = pctDelta(current, baseline);
  if (metric === "rssMbPeak") return delta <= 10 ? "PASS" : "FAIL";
  if (metric === "rssMbSteady") return delta <= 8 ? "PASS" : "FAIL";
  if (metric === "navStepMsP95") return delta <= 15 ? "PASS" : "FAIL";
  return "PASS";
}

async function resolveCurrentDir(input: string): Promise<string> {
  try {
    const s = await stat(input);
    if (!s.isDirectory()) throw new Error(`${input} is not a directory.`);
  } catch {
    throw new Error(`Current root '${input}' does not exist.`);
  }

  const entries = await readdir(input, { withFileTypes: true });
  const hasScenarioFiles = entries.some((e) => e.isFile() && e.name.endsWith(".json") && e.name.startsWith("S"));
  if (hasScenarioFiles) return input;

  const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(input, e.name));
  if (dirs.length === 0) throw new Error(`No scenario directory found under '${input}'.`);

  const withStats = await Promise.all(dirs.map(async (dir) => ({ dir, mtime: (await stat(dir)).mtimeMs })));
  withStats.sort((a, b) => b.mtime - a.mtime);
  return withStats[0]!.dir;
}

async function readScenario(path: string): Promise<ScenarioResult> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as ScenarioResult;
  if (!parsed?.scenario || !parsed?.summary) throw new Error(`Invalid scenario file '${path}'.`);
  return parsed;
}

async function listScenarioFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json") && e.name.startsWith("S"))
    .map((e) => join(dir, e.name))
    .sort();
}

function renderScenarioBlock(scenario: ScenarioId, baseline: ScenarioSummary, current: ScenarioSummary) {
  const rows = [
    ["rssMbPeak", baseline.rssMbPeak, current.rssMbPeak],
    ["rssMbSteady", baseline.rssMbSteady, current.rssMbSteady],
    ["refreshMsP50", baseline.refreshMsP50, current.refreshMsP50],
    ["navStepMsP95", baseline.navStepMsP95, current.navStepMsP95],
    ["edgeMissingCount", baseline.edgeMissingCount, current.edgeMissingCount],
    ["pinViolationCount", baseline.pinViolationCount, current.pinViolationCount],
    ["workflowErrorCount", baseline.workflowErrorCount, current.workflowErrorCount],
  ] as const;

  const markdown: string[] = [];
  markdown.push(`## ${scenario}`);
  markdown.push("");
  markdown.push("| Metric | Baseline | Current | Delta % | Status |");
  markdown.push("| --- | ---: | ---: | ---: | --- |");

  for (const [metric, b, c] of rows) {
    const delta = pctDelta(c, b);
    const status = statusFor(metric, b, c);
    markdown.push(`| ${metric} | ${b} | ${c} | ${delta}% | ${status} |`);
  }
  markdown.push("");

  return {
    markdown: markdown.join("\n"),
    hasFailure: rows.some(([metric, b, c]) => statusFor(metric, b, c) === "FAIL"),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const currentDir = await resolveCurrentDir(options.currentRoot);
  const baselineDir = options.baselineRoot;

  const currentFiles = await listScenarioFiles(currentDir);
  if (currentFiles.length === 0) throw new Error(`No scenario JSON files found in '${currentDir}'.`);

  const selectedCurrentFiles = options.scenario
    ? currentFiles.filter((f) => basename(f) === `${options.scenario}.json`)
    : currentFiles;

  if (selectedCurrentFiles.length === 0) throw new Error(`No matching scenario files for '${options.scenario}'.`);

  const report: string[] = [];
  report.push("# Benchmark Compare Report");
  report.push("");
  report.push(`Baseline dir: ${baselineDir}`);
  report.push(`Current dir: ${currentDir}`);
  report.push(`Generated: ${new Date().toISOString()}`);
  report.push("");

  let failureCount = 0;

  for (const currentFile of selectedCurrentFiles) {
    const file = basename(currentFile);
    const baselineFile = join(baselineDir, file);

    const current = await readScenario(currentFile);
    let baseline: ScenarioResult;
    try {
      baseline = await readScenario(baselineFile);
    } catch {
      report.push(`## ${current.scenario}`);
      report.push("");
      report.push(`- Missing baseline file: ${baselineFile}`);
      report.push("");
      failureCount += 1;
      continue;
    }

    const block = renderScenarioBlock(current.scenario, baseline.summary, current.summary);
    report.push(block.markdown);
    if (block.hasFailure) failureCount += 1;
  }

  const outPath = options.outputFile || join(currentDir, "COMPARE.md");
  await writeFile(outPath, report.join("\n"), "utf8");

  console.log(report.join("\n"));
  console.log(`\nSaved compare report: ${outPath}`);

  if (failureCount > 0) {
    console.log(`Comparison completed with ${failureCount} scenario(s) failing thresholds.`);
    process.exitCode = 2;
  } else {
    console.log("Comparison passed all configured thresholds.");
  }
}

main().catch((err) => {
  console.error(`Compare failed: ${String(err)}`);
  process.exit(1);
});
