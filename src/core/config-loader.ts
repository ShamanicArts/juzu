import { join, isAbsolute } from "node:path";
import { applyRuntimeConfig, DEFAULT_RUNTIME_CONFIG, type JjVizRuntimeConfig } from "./runtime-config";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

type ResolveOptions = {
  argv?: string[];
  repoRoot?: string | null;
  appDir: string;
};

function getOption(argv: string[], name: string): string | null {
  const prefix = `${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  if (!hit) return null;
  return hit.slice(prefix.length) || null;
}

async function readTomlFile(path: string): Promise<Record<string, unknown> | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const raw = await file.text();
    if (!raw.trim()) return null;
    return Bun.TOML.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return JSON.parse(JSON.stringify(base));
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch as any)) {
    if (v === undefined) continue;
    const prev = out[k];
    if (Array.isArray(v)) out[k] = [...v];
    else if (v && typeof v === "object" && prev && typeof prev === "object" && !Array.isArray(prev)) out[k] = deepMerge(prev, v);
    else out[k] = v;
  }
  return out as T;
}

function clampConfig(config: JjVizRuntimeConfig): JjVizRuntimeConfig {
  const out = JSON.parse(JSON.stringify(config)) as JjVizRuntimeConfig;
  out.web.pollIntervalMs = Math.max(500, Math.min(60_000, out.web.pollIntervalMs || DEFAULT_RUNTIME_CONFIG.web.pollIntervalMs));
  out.tui.sidebarBreakpointWidth = Math.max(60, Math.min(220, out.tui.sidebarBreakpointWidth || DEFAULT_RUNTIME_CONFIG.tui.sidebarBreakpointWidth));
  out.tui.sidebarMinHeight = Math.max(8, Math.min(80, out.tui.sidebarMinHeight || DEFAULT_RUNTIME_CONFIG.tui.sidebarMinHeight));
  out.tui.stackedSidebarRatio = Math.max(0.2, Math.min(0.8, out.tui.stackedSidebarRatio || DEFAULT_RUNTIME_CONFIG.tui.stackedSidebarRatio));
  out.tui.prefetchDiffInLog = typeof out.tui.prefetchDiffInLog === "boolean"
    ? out.tui.prefetchDiffInLog
    : DEFAULT_RUNTIME_CONFIG.tui.prefetchDiffInLog;
  out.tui.clearDiffCacheWhenNotInDiff = typeof out.tui.clearDiffCacheWhenNotInDiff === "boolean"
    ? out.tui.clearDiffCacheWhenNotInDiff
    : DEFAULT_RUNTIME_CONFIG.tui.clearDiffCacheWhenNotInDiff;
  out.visual.nodeRadius = Math.max(2, Math.min(20, out.visual.nodeRadius || DEFAULT_RUNTIME_CONFIG.visual.nodeRadius));
  out.visual.laneWidth = Math.max(8, Math.min(80, out.visual.laneWidth || DEFAULT_RUNTIME_CONFIG.visual.laneWidth));
  out.visual.ySpacing = Math.max(24, Math.min(220, out.visual.ySpacing || DEFAULT_RUNTIME_CONFIG.visual.ySpacing));
  out.visual.canvasPadding = Math.max(0, Math.min(300, out.visual.canvasPadding || DEFAULT_RUNTIME_CONFIG.visual.canvasPadding));
  out.visual.textColumnGap = Math.max(8, Math.min(300, out.visual.textColumnGap || DEFAULT_RUNTIME_CONFIG.visual.textColumnGap));
  return out;
}

async function loadThemeByName(name: string, opts: ResolveOptions): Promise<Record<string, unknown> | null> {
  const xdg = process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, ".config") : null);
  const candidates: string[] = [];
  if (opts.repoRoot) candidates.push(join(opts.repoRoot, ".jj-viz", "themes", `${name}.toml`));
  if (xdg) candidates.push(join(xdg, "jj-viz", "themes", `${name}.toml`));
  candidates.push(join(opts.appDir, "themes", `${name}.toml`));
  for (const path of candidates) {
    const parsed = await readTomlFile(path);
    if (parsed) return parsed;
  }
  return null;
}

async function loadThemeByPath(path: string, opts: ResolveOptions): Promise<Record<string, unknown> | null> {
  const resolved = isAbsolute(path) ? path : join(opts.repoRoot || process.cwd(), path);
  return await readTomlFile(resolved);
}

async function loadThemeConfig(opts: ResolveOptions): Promise<DeepPartial<JjVizRuntimeConfig> | null> {
  const xdg = process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, ".config") : null);
  const candidates: string[] = [];
  if (opts.repoRoot) candidates.push(join(opts.repoRoot, ".jj-viz", "themes", "config.toml"));
  if (xdg) candidates.push(join(xdg, "jj-viz", "themes", "config.toml"));
  candidates.push(join(opts.appDir, "themes", "config.toml"));
  for (const path of candidates) {
    const parsed = await readTomlFile(path);
    if (parsed) return parsed as DeepPartial<JjVizRuntimeConfig>;
  }
  return null;
}

export async function resolveRuntimeConfig(opts: ResolveOptions): Promise<JjVizRuntimeConfig> {
  const argv = opts.argv || process.argv.slice(2);
  const cliTheme = getOption(argv, "--theme");
  const cliConfigPath = getOption(argv, "--config");
  const envTheme = process.env.JJVIZ_THEME || null;
  const envConfigPath = process.env.JJVIZ_CONFIG || null;

  const xdg = process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, ".config") : null);
  const globalConfigPath = xdg ? join(xdg, "jj-viz", "config.toml") : null;
  const repoConfigPath = opts.repoRoot ? join(opts.repoRoot, ".jj-viz.toml") : null;
  const repoLocalConfigPath = opts.repoRoot ? join(opts.repoRoot, ".jj-viz.local.toml") : null;

  let merged: JjVizRuntimeConfig = JSON.parse(JSON.stringify(DEFAULT_RUNTIME_CONFIG));

  const sources = [
    globalConfigPath,
    repoConfigPath,
    repoLocalConfigPath,
    envConfigPath,
    cliConfigPath,
  ].filter(Boolean) as string[];

  for (const source of sources) {
    const parsed = await readTomlFile(source);
    if (!parsed) continue;
    merged = deepMerge(merged, parsed as DeepPartial<JjVizRuntimeConfig>);
  }

  const themeName = cliTheme || envTheme || merged.theme?.name || DEFAULT_RUNTIME_CONFIG.theme.name;
  const explicitThemePath = (merged as any)?.theme?.file as string | undefined;

  // 1. Load theme config (themes/config.toml) for base visual/uiTokens defaults
  const themeConfigParsed = await loadThemeConfig(opts);
  if (themeConfigParsed) {
    merged = deepMerge(merged, themeConfigParsed);
  }

  // 2. Load specific theme file for overrides
  const themeParsed = explicitThemePath
    ? await loadThemeByPath(explicitThemePath, opts)
    : await loadThemeByName(themeName, opts);

  if (themeParsed) {
    merged = deepMerge(merged, {
      theme: { name: themeName },
      uiTokens: themeParsed,
    } as DeepPartial<JjVizRuntimeConfig>);
  } else {
    merged.theme.name = themeName;
  }

  return clampConfig(merged);
}

export async function resolveAndApplyRuntimeConfig(opts: ResolveOptions): Promise<JjVizRuntimeConfig> {
  const resolved = await resolveRuntimeConfig(opts);
  applyRuntimeConfig(resolved);
  return resolved;
}
