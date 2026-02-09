#!/usr/bin/env bun

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

function getXdgConfigHome(): string | null {
  return process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, ".config") : null);
}

function getOption(name: string): string | null {
  const prefix = `${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  if (!hit) return null;
  return hit.slice(prefix.length) || null;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function timestampForFileName(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function getPath(obj: unknown, path: string[]): unknown {
  let cur: any = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

const KEYMAP_DEFAULTS_BLOCK = `
[tui.keymap]
stickyModes = true
showIdleBindingsInStatus = false
showLeaderTriggersInStatus = true
modeOrder = ["action", "ops", "view", "marks"]
statusContextOrder = ["oplog", "obslog", "diff", "merge", "rebase", "describe", "revset", "themePicker"]
exitKeys = ["escape", "q"]

[tui.keymap.leaders]
action = "ctrl+x"
ops = "ctrl+o"
view = "ctrl+l"
marks = "ctrl+b"

[tui.keymap.modeBindings.action]
n = "new"
e = "edit"
d = "describe"
b = "rebase"
i = "insert"
a = "abandon"
s = "squash"
y = "duplicate"
z = "restore"
m = "merge-mode"

[tui.keymap.modeBindings.ops]
u = "undo"
r = "redo"
f = "git-fetch"
p = "git-push"
o = "oplog"
v = "obslog"
g = "back-log"

[tui.keymap.modeBindings.view]
"1" = "layout-chronological"
"2" = "layout-mainline"
"3" = "layout-bookmark-centric"
"4" = "layout-wc-focused"
"5" = "layout-topological"
c = "toggle-sidebar"
t = "theme-picker"
r = "refresh"
f = "toggle-files"
x = "toggle-description"
h = "toggle-help"
"/" = "revset"
"ctrl+d" = "diff-toggle"

[tui.keymap.modeBindings.marks]
s = "bookmark-set"
d = "bookmark-delete"

[tui.keymap.statusContextLabels]
oplog = "OPLOG"
obslog = "OBSLOG"
diff = "DIFF"
merge = "MERGE"
rebase = "REBASE"
describe = "DESCRIBE"
revset = "REVSET"
themePicker = "THEME"
`;

const MODE_COLOR_DEFAULTS_LINES = [
  "uiTokens.semantic.modeAction = \"#c9a86a\"",
  "uiTokens.semantic.modeOps = \"#7f9fbf\"",
  "uiTokens.semantic.modeView = \"#6f89ad\"",
  "uiTokens.semantic.modeMarks = \"#74b88c\"",
];

function withConfigEnhancements(sourceRaw: string): string {
  let out = ensureTrailingNewline(sourceRaw.trimEnd());
  let parsed: any = null;
  try {
    parsed = Bun.TOML.parse(out);
  } catch {
    return out;
  }

  if (!getPath(parsed, ["tui", "keymap"])) {
    out += `\n${KEYMAP_DEFAULTS_BLOCK.trim()}\n`;
  }

  const missingModeColorKeys = ["modeAction", "modeOps", "modeView", "modeMarks"]
    .filter((k) => getPath(parsed, ["uiTokens", "semantic", k]) === undefined);

  if (missingModeColorKeys.length > 0) {
    out += `\n# Status mode color defaults\n`;
    for (const line of MODE_COLOR_DEFAULTS_LINES) {
      const key = line.match(/mode\w+/)?.[0];
      if (!key || missingModeColorKeys.includes(key)) out += `${line}\n`;
    }
  }

  return ensureTrailingNewline(out);
}

const repoRoot = join(import.meta.dir, "..");
const xdg = getXdgConfigHome();

if (!xdg) {
  console.error("Could not resolve XDG config directory (XDG_CONFIG_HOME/HOME missing).");
  process.exit(1);
}

const sourceOption = getOption("--source");
const targetOption = getOption("--target");
const noBackup = hasFlag("--no-backup");

const sourceCandidates = sourceOption
  ? [sourceOption]
  : [".juzu.local.toml", ".juzu.toml", "config.example.toml"];

let sourcePath: string | null = null;
for (const candidate of sourceCandidates) {
  const resolved = isAbsolute(candidate) ? candidate : join(repoRoot, candidate);
  if (await Bun.file(resolved).exists()) {
    sourcePath = resolved;
    break;
  }
}

if (!sourcePath) {
  console.error(`No source config file found. Tried: ${sourceCandidates.join(", ")}`);
  process.exit(1);
}

const targetPath = targetOption
  ? (isAbsolute(targetOption) ? targetOption : join(process.cwd(), targetOption))
  : join(xdg, "juzu", "config.toml");

const sourceRaw = await Bun.file(sourcePath).text();
if (!sourceRaw.trim()) {
  console.error(`Source config is empty: ${sourcePath}`);
  process.exit(1);
}

const exportRaw = withConfigEnhancements(sourceRaw);

await mkdir(dirname(targetPath), { recursive: true });

let backupPath: string | null = null;
if (!noBackup && await Bun.file(targetPath).exists()) {
  backupPath = `${targetPath}.backup-${timestampForFileName()}`;
  await copyFile(targetPath, backupPath);
}

await writeFile(targetPath, exportRaw, "utf8");

console.log(`Exported config to ${targetPath}`);
console.log(`Source: ${sourcePath}`);
if (exportRaw !== sourceRaw) console.log("Applied config enhancements for keymap/status defaults");
if (backupPath) console.log(`Backup: ${backupPath}`);
