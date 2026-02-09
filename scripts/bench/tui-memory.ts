#!/usr/bin/env bun

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { actions, layoutResult, navigation, state } from "../../src/core/state";
import { setBackend } from "../../src/core/runtime";
import { createTuiBackend } from "../../src/tui/backend";
import { refreshLog, refreshObslog, refreshOpLog } from "../../src/core/usecases";

const MB = 1024 * 1024;

type ScenarioId =
  | "S1_SMALL_REPO_BASELINE"
  | "S2_MEDIUM_REPO_HISTORY_SCAN"
  | "S3_LARGE_REPO_LONG_SCROLL"
  | "S4_PINNING_STRESS"
  | "S5_WINDOW_BOUNDARY_STRESS"
  | "S6_OPLOG_OBSLOG_SMOKE";

const SCENARIO_IDS: ScenarioId[] = [
  "S1_SMALL_REPO_BASELINE",
  "S2_MEDIUM_REPO_HISTORY_SCAN",
  "S3_LARGE_REPO_LONG_SCROLL",
  "S4_PINNING_STRESS",
  "S5_WINDOW_BOUNDARY_STRESS",
  "S6_OPLOG_OBSLOG_SMOKE",
];

type CliOptions = {
  repo: string;
  scenario: ScenarioId | "all";
  limit: number;
  warmupRuns: number;
  measuredRuns: number;
  sampleIntervalMs: number;
  sampleEveryNavSteps: number;
  visibleWindow: number;
  outputRoot: string;
  writeBaseline: boolean;
};

type GraphIntegrity = {
  edgeMissingCount: number;
  laneDiscontinuityCount: number;
  pinViolationCount: number;
};

type RunMetrics = {
  label: string;
  durationMs: number;
  refreshDurationsMs: number[];
  navDurationsMs: number[];
  operationDurationsMs: Record<string, number>;
  rssSamplesMb: number[];
  heapSamplesMb: number[];
  rssPeakMb: number;
  rssSteadyMb: number;
  heapPeakMb: number;
  heapSteadyMb: number;
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
  workflowErrors: string[];
};

type ScenarioResult = {
  schemaVersion: 1;
  createdAt: string;
  scenario: ScenarioId;
  options: Omit<CliOptions, "scenario">;
  environment: {
    bunVersion: string;
    platform: string;
    arch: string;
    commit: string;
    cwd: string;
  };
  warmups: RunMetrics[];
  measured: RunMetrics[];
  summary: {
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
};

class MemorySampler {
  private readonly rssSamplesMb: number[] = [];
  private readonly heapSamplesMb: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  start(intervalMs: number) {
    this.stop();
    this.sample();
    this.timer = setInterval(() => this.sample(), intervalMs);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  sample() {
    const mu = process.memoryUsage();
    this.rssSamplesMb.push(round2(mu.rss / MB));
    this.heapSamplesMb.push(round2(mu.heapUsed / MB));
  }

  getSamples() {
    return {
      rssSamplesMb: [...this.rssSamplesMb],
      heapSamplesMb: [...this.heapSamplesMb],
    };
  }
}

function printHelp() {
  console.log(`
TUI benchmark runner (CLI-only)

Usage:
  bun run scripts/bench/tui-memory.ts [options]

Options:
  --repo <path>                 Repository path to benchmark (default: cwd)
  --scenario <id|all>           Scenario to run (default: all)
  --limit <n>                   Refresh log limit passed to refreshLog (default: 2000)
  --warmup-runs <n>             Warmup runs per scenario (default: 1)
  --measured-runs <n>           Measured runs per scenario (default: 3)
  --sample-interval-ms <n>      Memory sample interval in ms (default: 200)
  --sample-every-nav-steps <n>  Sample memory every N nav steps (default: 25)
  --visible-window <n>          Approx visible node window for metric (default: 120)
  --output-root <path>          Output root dir (default: benchmarks/results)
  --write-baseline              Write scenario summaries to benchmarks/baselines
  -h, --help                    Show this help

Scenarios:
  ${SCENARIO_IDS.join("\n  ")}
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

  const scenarioRaw = String(kv.get("scenario") || "all");
  if (scenarioRaw !== "all" && !SCENARIO_IDS.includes(scenarioRaw as ScenarioId)) {
    throw new Error(`Unknown scenario '${scenarioRaw}'. Use --help for allowed ids.`);
  }

  return {
    repo: resolve(String(kv.get("repo") || process.cwd())),
    scenario: scenarioRaw as ScenarioId | "all",
    limit: readPositiveInt(kv.get("limit"), 2000),
    warmupRuns: readNonNegativeInt(kv.get("warmup-runs"), 1),
    measuredRuns: readPositiveInt(kv.get("measured-runs"), 3),
    sampleIntervalMs: readPositiveInt(kv.get("sample-interval-ms"), 200),
    sampleEveryNavSteps: readPositiveInt(kv.get("sample-every-nav-steps"), 25),
    visibleWindow: readPositiveInt(kv.get("visible-window"), 120),
    outputRoot: resolve(String(kv.get("output-root") || join(process.cwd(), "benchmarks", "results"))),
    writeBaseline: Boolean(kv.get("write-baseline")),
  };
}

function readPositiveInt(raw: string | boolean | undefined, fallback: number): number {
  if (raw === undefined || raw === true) return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readNonNegativeInt(raw: string | boolean | undefined, fallback: number): number {
  if (raw === undefined || raw === true) return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((pct / 100) * sorted.length)));
  return round2(sorted[idx]!);
}

function median(values: number[]): number {
  return percentile(values, 50);
}

function getSteady(samples: number[]): number {
  if (samples.length === 0) return 0;
  const start = Math.max(0, Math.floor(samples.length * 0.6));
  return median(samples.slice(start));
}

function getGitCommit(cwd: string): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) return "unknown";
  return proc.stdout.toString().trim() || "unknown";
}

function getScenarioSet(scenario: CliOptions["scenario"]): ScenarioId[] {
  if (scenario === "all") return SCENARIO_IDS;
  return [scenario];
}

function computeIntegrity(nodes = layoutResult().nodes): GraphIntegrity {
  let edgeMissingCount = 0;
  let laneDiscontinuityCount = 0;

  const byId = new Map(nodes.map((n) => [n.changeId, n]));
  for (const node of nodes) {
    for (const parentId of node.parents) {
      const parent = byId.get(parentId);
      if (!parent) {
        edgeMissingCount += 1;
        continue;
      }
      if (typeof node.y === "number" && typeof parent.y === "number" && parent.y <= node.y) {
        laneDiscontinuityCount += 1;
      }
    }
  }

  let pinViolationCount = 0;
  for (const [changeId, lane] of state.pinnedNodes) {
    const node = byId.get(changeId);
    if (!node || node.lane !== lane) pinViolationCount += 1;
  }

  return { edgeMissingCount, laneDiscontinuityCount, pinViolationCount };
}

async function validateRepo(repo: string): Promise<string> {
  const backend = createTuiBackend();
  const root = backend.findRoot ? await backend.findRoot(repo) : null;
  if (!root) throw new Error(`No jj repository found from '${repo}'.`);
  return root;
}

async function runNavigation(
  steps: number,
  direction: "down" | "up",
  navDurationsMs: number[],
  sampler: MemorySampler,
  sampleEveryNavSteps: number
) {
  for (let i = 0; i < steps; i++) {
    const t0 = performance.now();
    if (direction === "down") navigation.moveDown();
    else navigation.moveUp();
    void layoutResult();
    navDurationsMs.push(round2(performance.now() - t0));
    if (i % sampleEveryNavSteps === 0) sampler.sample();
  }
}

async function runScenario(
  scenario: ScenarioId,
  root: string,
  options: CliOptions,
  label: string
): Promise<RunMetrics> {
  actions.reset();
  actions.setCwd(root);
  setBackend(createTuiBackend());

  const sampler = new MemorySampler();
  const refreshDurationsMs: number[] = [];
  const navDurationsMs: number[] = [];
  const operationDurationsMs: Record<string, number> = {};
  const workflowErrors: string[] = [];
  let workflowErrorCount = 0;

  const timed = async (name: string, fn: () => Promise<void>) => {
    const t0 = performance.now();
    try {
      await fn();
    } catch (e) {
      workflowErrorCount += 1;
      workflowErrors.push(`${name}: ${String(e)}`);
    }
    const elapsed = round2(performance.now() - t0);
    operationDurationsMs[name] = round2((operationDurationsMs[name] || 0) + elapsed);
    return elapsed;
  };

  const doRefresh = async (limit: number) => {
    const elapsed = await timed("refresh", async () => {
      await refreshLog(limit);
      void layoutResult();
    });
    refreshDurationsMs.push(elapsed);
    sampler.sample();
  };

  const runStart = performance.now();
  sampler.start(options.sampleIntervalMs);

  await doRefresh(options.limit);

  switch (scenario) {
    case "S1_SMALL_REPO_BASELINE": {
      await runNavigation(200, "down", navDurationsMs, sampler, options.sampleEveryNavSteps);
      await runNavigation(200, "up", navDurationsMs, sampler, options.sampleEveryNavSteps);
      break;
    }

    case "S2_MEDIUM_REPO_HISTORY_SCAN": {
      await doRefresh(Math.max(options.limit, 3000));
      await runNavigation(1200, "down", navDurationsMs, sampler, options.sampleEveryNavSteps);
      await runNavigation(400, "up", navDurationsMs, sampler, options.sampleEveryNavSteps);
      break;
    }

    case "S3_LARGE_REPO_LONG_SCROLL": {
      await doRefresh(Math.max(options.limit, 6000));
      for (let cycle = 0; cycle < 3; cycle++) {
        await runNavigation(1500, "down", navDurationsMs, sampler, options.sampleEveryNavSteps);
        await timed("refresh", async () => {
          await refreshLog(Math.max(options.limit, 6000));
        });
        sampler.sample();
      }
      await runNavigation(1200, "up", navDurationsMs, sampler, options.sampleEveryNavSteps);
      break;
    }

    case "S4_PINNING_STRESS": {
      const nodes = layoutResult().nodes;
      const targetPins = Math.min(24, nodes.length);
      const stride = Math.max(1, Math.floor(nodes.length / Math.max(1, targetPins)));
      const ids: string[] = [];
      for (let i = 0; i < nodes.length && ids.length < targetPins; i += stride) ids.push(nodes[i]!.changeId);

      let idx = 0;
      for (const id of ids) {
        await timed("pin", async () => {
          const n = layoutResult().nodes.find((x) => x.changeId === id);
          const lane = n?.lane ?? 0;
          actions.pinNode(id, lane);
          void layoutResult();
        });
        idx += 1;
        if (idx % 6 === 0) await doRefresh(options.limit);
      }

      for (let i = 0; i < ids.length; i += 2) {
        const id = ids[i]!;
        await timed("unpin", async () => {
          actions.unpinNode(id);
          void layoutResult();
        });
      }

      await doRefresh(options.limit);
      await runNavigation(300, "down", navDurationsMs, sampler, options.sampleEveryNavSteps);
      break;
    }

    case "S5_WINDOW_BOUNDARY_STRESS": {
      await doRefresh(Math.max(options.limit, 4000));
      for (let cycle = 0; cycle < 8; cycle++) {
        await runNavigation(320, "down", navDurationsMs, sampler, options.sampleEveryNavSteps);
        await runNavigation(320, "up", navDurationsMs, sampler, options.sampleEveryNavSteps);
        if (cycle % 2 === 1) await doRefresh(Math.max(options.limit, 4000));
      }
      break;
    }

    case "S6_OPLOG_OBSLOG_SMOKE": {
      await timed("oplog", async () => {
        await refreshOpLog(200);
        actions.setViewMode("oplog");
        for (let i = 0; i < 80; i++) navigation.moveDown();
        for (let i = 0; i < 80; i++) navigation.moveUp();
      });
      sampler.sample();

      const pick = state.nodes[Math.min(Math.floor(state.nodes.length / 2), Math.max(0, state.nodes.length - 1))];
      if (pick) {
        await timed("obslog", async () => {
          actions.setViewMode("obslog");
          actions.setObslogChangeId(pick.changeId);
          await refreshObslog(pick.changeId, 100);
          for (let i = 0; i < 40; i++) navigation.moveDown();
          for (let i = 0; i < 40; i++) navigation.moveUp();
        });
      }
      actions.setViewMode("log");
      await runNavigation(200, "down", navDurationsMs, sampler, options.sampleEveryNavSteps);
      break;
    }
  }

  sampler.stop();
  sampler.sample();

  const durationMs = round2(performance.now() - runStart);
  const { rssSamplesMb, heapSamplesMb } = sampler.getSamples();
  const integrity = computeIntegrity();
  const indexedNodes = state.totalNodeCount > 0 ? state.totalNodeCount : state.nodes.length;
  const residentNodes = state.nodes.length;
  const visibleNodes = Math.min(state.nodes.length, options.visibleWindow);

  return {
    label,
    durationMs,
    refreshDurationsMs,
    navDurationsMs,
    operationDurationsMs,
    rssSamplesMb,
    heapSamplesMb,
    rssPeakMb: round2(Math.max(...rssSamplesMb)),
    rssSteadyMb: getSteady(rssSamplesMb),
    heapPeakMb: round2(Math.max(...heapSamplesMb)),
    heapSteadyMb: getSteady(heapSamplesMb),
    refreshMsP50: percentile(refreshDurationsMs, 50),
    refreshMsP95: percentile(refreshDurationsMs, 95),
    navStepMsP50: percentile(navDurationsMs, 50),
    navStepMsP95: percentile(navDurationsMs, 95),
    indexedNodes,
    residentNodes,
    visibleNodes,
    edgeMissingCount: integrity.edgeMissingCount,
    laneDiscontinuityCount: integrity.laneDiscontinuityCount,
    pinViolationCount: integrity.pinViolationCount,
    workflowErrorCount,
    workflowErrors,
  };
}

function summarizeMeasured(measured: RunMetrics[]) {
  return {
    rssMbPeak: round2(Math.max(...measured.map((r) => r.rssPeakMb))),
    rssMbSteady: median(measured.map((r) => r.rssSteadyMb)),
    heapMbPeak: round2(Math.max(...measured.map((r) => r.heapPeakMb))),
    heapMbSteady: median(measured.map((r) => r.heapSteadyMb)),
    refreshMsP50: median(measured.map((r) => r.refreshMsP50)),
    refreshMsP95: median(measured.map((r) => r.refreshMsP95)),
    navStepMsP50: median(measured.map((r) => r.navStepMsP50)),
    navStepMsP95: median(measured.map((r) => r.navStepMsP95)),
    indexedNodes: Math.max(...measured.map((r) => r.indexedNodes)),
    residentNodes: Math.max(...measured.map((r) => r.residentNodes)),
    visibleNodes: Math.max(...measured.map((r) => r.visibleNodes)),
    edgeMissingCount: Math.max(...measured.map((r) => r.edgeMissingCount)),
    laneDiscontinuityCount: Math.max(...measured.map((r) => r.laneDiscontinuityCount)),
    pinViolationCount: Math.max(...measured.map((r) => r.pinViolationCount)),
    workflowErrorCount: measured.reduce((acc, r) => acc + r.workflowErrorCount, 0),
  };
}

async function getLatestResultDir(root: string): Promise<string | null> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && e.name !== "pid")
      .map((e) => join(root, e.name));
    if (dirs.length === 0) return null;
    const withStats = await Promise.all(dirs.map(async (dir) => ({ dir, mtime: (await stat(dir)).mtimeMs })));
    withStats.sort((a, b) => b.mtime - a.mtime);
    return withStats[0]!.dir;
  } catch {
    return null;
  }
}

function summaryMarkdown(outDir: string, scenarioFiles: Array<{ scenario: ScenarioId; filePath: string; summary: ScenarioResult["summary"] }>) {
  const lines: string[] = [];
  lines.push("# TUI Benchmark Summary");
  lines.push("");
  lines.push(`Output dir: ${outDir}`);
  lines.push("");
  lines.push("| Scenario | RSS Peak MB | RSS Steady MB | Refresh p50 ms | Nav p95 ms | Edge Missing | Pin Violations | Workflow Errors |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const row of scenarioFiles) {
    lines.push(
      `| ${row.scenario} | ${row.summary.rssMbPeak} | ${row.summary.rssMbSteady} | ${row.summary.refreshMsP50} | ${row.summary.navStepMsP95} | ${row.summary.edgeMissingCount} | ${row.summary.pinViolationCount} | ${row.summary.workflowErrorCount} |`
    );
  }
  lines.push("");
  lines.push("Scenario JSON files:");
  for (const row of scenarioFiles) lines.push(`- ${row.filePath}`);
  lines.push("");
  return lines.join("\n");
}

async function writeBaselineIfRequested(result: ScenarioResult, enabled: boolean) {
  if (!enabled) return;
  const baselineDir = join(process.cwd(), "benchmarks", "baselines");
  await mkdir(baselineDir, { recursive: true });
  const target = join(baselineDir, `${result.scenario}.json`);
  await writeFile(target, JSON.stringify(result, null, 2) + "\n", "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = await validateRepo(options.repo);
  const scenarios = getScenarioSet(options.scenario);

  await mkdir(options.outputRoot, { recursive: true });
  const latest = await getLatestResultDir(options.outputRoot);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(options.outputRoot, runId);
  await mkdir(outDir, { recursive: true });

  if (latest) console.log(`Previous results: ${latest}`);
  console.log(`Running ${scenarios.length} scenario(s) against ${root}`);

  const scenarioFiles: Array<{ scenario: ScenarioId; filePath: string; summary: ScenarioResult["summary"] }> = [];

  for (const scenario of scenarios) {
    console.log(`\n== ${scenario} ==`);

    const warmups: RunMetrics[] = [];
    for (let i = 0; i < options.warmupRuns; i++) {
      console.log(`warmup ${i + 1}/${options.warmupRuns}`);
      warmups.push(await runScenario(scenario, root, options, `warmup-${i + 1}`));
    }

    const measured: RunMetrics[] = [];
    for (let i = 0; i < options.measuredRuns; i++) {
      console.log(`measured ${i + 1}/${options.measuredRuns}`);
      measured.push(await runScenario(scenario, root, options, `measured-${i + 1}`));
    }

    const summary = summarizeMeasured(measured);
    const result: ScenarioResult = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      scenario,
      options: {
        repo: options.repo,
        limit: options.limit,
        warmupRuns: options.warmupRuns,
        measuredRuns: options.measuredRuns,
        sampleIntervalMs: options.sampleIntervalMs,
        sampleEveryNavSteps: options.sampleEveryNavSteps,
        visibleWindow: options.visibleWindow,
        outputRoot: options.outputRoot,
        writeBaseline: options.writeBaseline,
      },
      environment: {
        bunVersion: Bun.version,
        platform: process.platform,
        arch: process.arch,
        commit: getGitCommit(root),
        cwd: root,
      },
      warmups,
      measured,
      summary,
    };

    const filePath = join(outDir, `${scenario}.json`);
    await writeFile(filePath, JSON.stringify(result, null, 2) + "\n", "utf8");
    await writeBaselineIfRequested(result, options.writeBaseline);
    scenarioFiles.push({ scenario, filePath, summary });

    console.log(
      `summary: rss_peak=${summary.rssMbPeak}MB rss_steady=${summary.rssMbSteady}MB refresh_p50=${summary.refreshMsP50}ms nav_p95=${summary.navStepMsP95}ms`
    );
  }

  const summaryPath = join(outDir, "SUMMARY.md");
  await writeFile(summaryPath, summaryMarkdown(outDir, scenarioFiles), "utf8");

  console.log(`\nSaved results in ${outDir}`);
  console.log(`Summary: ${summaryPath}`);
}

main().catch((err) => {
  console.error(`Benchmark failed: ${String(err)}`);
  process.exit(1);
});
