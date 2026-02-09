import { join, isAbsolute } from "node:path";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { applyRuntimeConfig, DEFAULT_RUNTIME_CONFIG, type JjVizRuntimeConfig } from "./runtime-config";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

type ResolveOptions = {
  argv?: string[];
  repoRoot?: string | null;
  appDir: string;
};

const DEFAULT_GLOBAL_CONFIG_TOML = `[theme]
name = "slate"

[layout]
startupMode = "chronological"

[web]
pollIntervalMs = 3000
navigationLockDefault = false

[tui]
sidebarBreakpointWidth = 90
sidebarMinHeight = 16
stackedSidebarRatio = 0.5
prefetchDiffInLog = false
clearDiffCacheWhenNotInDiff = true
`;

let didBootstrapGlobalConfig = false;

function getXdgConfigHome(): string | null {
  return process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, ".config") : null);
}

async function pathExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

async function bootstrapGlobalConfig(opts: ResolveOptions): Promise<void> {
  if (didBootstrapGlobalConfig) return;
  didBootstrapGlobalConfig = true;
  if (process.env.JUZU_DISABLE_BOOTSTRAP === "1") return;

  const xdg = getXdgConfigHome();
  if (!xdg) return;

  const globalDir = join(xdg, "juzu");
  const globalThemesDir = join(globalDir, "themes");
  const globalConfigPath = join(globalDir, "config.toml");
  const bundledThemesDir = join(opts.appDir, "themes");
  const bundledConfigPath = join(opts.appDir, "config.example.toml");

  let createdGlobalConfig = false;
  let copiedThemes = 0;

  try {
    await mkdir(globalThemesDir, { recursive: true });

    if (!(await pathExists(globalConfigPath))) {
      let defaultConfig = DEFAULT_GLOBAL_CONFIG_TOML;
      try {
        const bundledConfigFile = Bun.file(bundledConfigPath);
        if (await bundledConfigFile.exists()) {
          const raw = await bundledConfigFile.text();
          if (raw.trim()) defaultConfig = raw;
        }
      } catch {
        // Fallback to inline defaults when bundled config is unavailable.
      }
      await writeFile(globalConfigPath, defaultConfig, "utf8");
      createdGlobalConfig = true;
    }

    let bundledThemeFiles: string[] = [];
    try {
      bundledThemeFiles = (await readdir(bundledThemesDir)).filter((name) => name.endsWith(".toml"));
    } catch {
      bundledThemeFiles = [];
    }

    for (const themeFile of bundledThemeFiles) {
      const src = join(bundledThemesDir, themeFile);
      const dst = join(globalThemesDir, themeFile);
      if (await pathExists(dst)) continue;
      await copyFile(src, dst);
      copiedThemes += 1;
    }

    if (createdGlobalConfig || copiedThemes > 0) {
      const details: string[] = [];
      if (createdGlobalConfig) details.push("config.toml");
      if (copiedThemes > 0) details.push(`${copiedThemes} theme files`);
      console.log(`🧩 Initialized global juzu config at ${globalDir} (${details.join(", ")})`);
    }
  } catch (error) {
    console.warn(`⚠️ Could not initialize global juzu config: ${String(error)}`);
  }
}

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

function stripThemeConfigDiffTokens(config: DeepPartial<JjVizRuntimeConfig>): DeepPartial<JjVizRuntimeConfig> {
  // Keep diff backgrounds theme-driven unless a concrete theme or user config overrides them.
  const uiTokens = (config as { uiTokens?: Record<string, unknown> }).uiTokens;
  if (!uiTokens || typeof uiTokens !== "object" || !("diff" in uiTokens)) return config;
  const next = JSON.parse(JSON.stringify(config)) as DeepPartial<JjVizRuntimeConfig> & {
    uiTokens?: Record<string, unknown>;
  };
  if (next.uiTokens && typeof next.uiTokens === "object") {
    delete next.uiTokens.diff;
  }
  return next;
}

function clampConfig(config: JjVizRuntimeConfig): JjVizRuntimeConfig {
  const out = JSON.parse(JSON.stringify(config)) as JjVizRuntimeConfig;
  const layoutModes = new Set(["chronological", "mainline", "bookmark-centric", "wc-focused", "topological"]);
  out.layout.startupMode = layoutModes.has(out.layout.startupMode)
    ? out.layout.startupMode
    : DEFAULT_RUNTIME_CONFIG.layout.startupMode;
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
  const xdg = getXdgConfigHome();
  const candidates: string[] = [];
  if (opts.repoRoot) candidates.push(join(opts.repoRoot, ".juzu", "themes", `${name}.toml`));
  if (xdg) candidates.push(join(xdg, "juzu", "themes", `${name}.toml`));
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
  const xdg = getXdgConfigHome();
  const candidates: string[] = [];
  if (opts.repoRoot) candidates.push(join(opts.repoRoot, ".juzu", "themes", "config.toml"));
  if (xdg) candidates.push(join(xdg, "juzu", "themes", "config.toml"));
  candidates.push(join(opts.appDir, "themes", "config.toml"));
  for (const path of candidates) {
    const parsed = await readTomlFile(path);
    if (parsed) return parsed as DeepPartial<JjVizRuntimeConfig>;
  }
  return null;
}

export async function resolveRuntimeConfig(opts: ResolveOptions): Promise<JjVizRuntimeConfig> {
  await bootstrapGlobalConfig(opts);

  const argv = opts.argv || process.argv.slice(2);
  const cliTheme = getOption(argv, "--theme");
  const cliConfigPath = getOption(argv, "--config");
  const envTheme = process.env.JUZU_THEME || null;
  const envConfigPath = process.env.JUZU_CONFIG || null;

  const xdg = getXdgConfigHome();
  const globalConfigPath = xdg ? join(xdg, "juzu", "config.toml") : null;
  const repoConfigPath = opts.repoRoot ? join(opts.repoRoot, ".juzu.toml") : null;
  const repoLocalConfigPath = opts.repoRoot ? join(opts.repoRoot, ".juzu.local.toml") : null;

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
    merged = deepMerge(merged, stripThemeConfigDiffTokens(themeConfigParsed));
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
