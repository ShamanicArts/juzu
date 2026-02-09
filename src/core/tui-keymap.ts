import type { KeyEvent } from "@opentui/core";

export const LEADER_MODE_IDS = ["revision", "history", "graph", "bookmark", "theme"] as const;
export type LeaderModeId = typeof LEADER_MODE_IDS[number];

export const COMMAND_IDS = [
  "new",
  "edit",
  "describe",
  "rebase",
  "insert",
  "abandon",
  "squash",
  "duplicate",
  "undo",
  "redo",
  "git-fetch",
  "git-push",
  "bookmark-set",
  "bookmark-delete",
  "merge-mode",
  "theme-picker",
  "oplog",
  "obslog",
  "back-log",
  "restore",
  "layout-chronological",
  "layout-mainline",
  "layout-bookmark-centric",
  "layout-wc-focused",
  "layout-topological",
  "toggle-sidebar",
  "refresh",
  "toggle-help",
  "toggle-files",
  "toggle-description",
  "revset",
  "diff-toggle",
] as const;

export type CommandId = typeof COMMAND_IDS[number];

export type BindingMap = Record<string, CommandId>;

export interface TuiKeymapConfig {
  stickyModes: boolean;
  showIdleBindingsInStatus: boolean;
  modeOrder: LeaderModeId[];
  exitKeys: string[];
  leaders: Record<LeaderModeId, string>;
  labels: Record<LeaderModeId, string>;
  badges: Record<LeaderModeId, string>;
  idleBindings: BindingMap;
  modeBindings: Record<LeaderModeId, BindingMap>;
}

const COMMAND_ID_SET = new Set<string>(COMMAND_IDS);
const LEADER_MODE_SET = new Set<string>(LEADER_MODE_IDS);

const DEFAULT_LEADERS: Record<LeaderModeId, string> = {
  revision: "ctrl+x",
  history: "ctrl+o",
  graph: "ctrl+g",
  bookmark: "ctrl+b",
  theme: "ctrl+t",
};

const DEFAULT_LABELS: Record<LeaderModeId, string> = {
  revision: "Revision",
  history: "History",
  graph: "Graph",
  bookmark: "Bookmark",
  theme: "Theme",
};

const DEFAULT_BADGES: Record<LeaderModeId, string> = {
  revision: "REV",
  history: "OPS",
  graph: "GRAPH",
  bookmark: "BOOK",
  theme: "THEME",
};

const DEFAULT_MODE_BINDINGS: Record<LeaderModeId, BindingMap> = {
  revision: {
    n: "new",
    e: "edit",
    d: "describe",
    b: "rebase",
    i: "insert",
    a: "abandon",
    s: "squash",
    y: "duplicate",
    z: "restore",
  },
  history: {
    u: "undo",
    r: "redo",
    f: "git-fetch",
    p: "git-push",
    o: "oplog",
    v: "obslog",
    g: "back-log",
  },
  graph: {
    "1": "layout-chronological",
    "2": "layout-mainline",
    "3": "layout-bookmark-centric",
    "4": "layout-wc-focused",
    "5": "layout-topological",
    m: "merge-mode",
    c: "toggle-sidebar",
    r: "refresh",
    f: "toggle-files",
    x: "toggle-description",
    h: "toggle-help",
  },
  bookmark: {
    s: "bookmark-set",
    d: "bookmark-delete",
  },
  theme: {
    t: "theme-picker",
    h: "toggle-help",
  },
};

const DEFAULT_IDLE_BINDINGS: BindingMap = {
  "/": "revset",
  "ctrl+d": "diff-toggle",
  h: "toggle-help",
};

const DEFAULT_CONFIG: TuiKeymapConfig = {
  stickyModes: true,
  showIdleBindingsInStatus: true,
  modeOrder: [...LEADER_MODE_IDS],
  exitKeys: ["escape", "ctrl+g"],
  leaders: { ...DEFAULT_LEADERS },
  labels: { ...DEFAULT_LABELS },
  badges: { ...DEFAULT_BADGES },
  idleBindings: { ...DEFAULT_IDLE_BINDINGS },
  modeBindings: {
    revision: { ...DEFAULT_MODE_BINDINGS.revision },
    history: { ...DEFAULT_MODE_BINDINGS.history },
    graph: { ...DEFAULT_MODE_BINDINGS.graph },
    bookmark: { ...DEFAULT_MODE_BINDINGS.bookmark },
    theme: { ...DEFAULT_MODE_BINDINGS.theme },
  },
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBase(base: string): string {
  const b = base.trim().toLowerCase();
  if (b === "return") return "enter";
  if (b === "esc") return "escape";
  if (b === "spacebar") return "space";
  if (b === "leftbracket" || b === "openbracket" || b === "bracketleft") return "[";
  if (b === "rightbracket" || b === "closebracket" || b === "bracketright") return "]";
  return b;
}

export function normalizeKeySpec(spec: string): string {
  const raw = spec.trim().toLowerCase().replace(/\s+/g, "");
  if (!raw) return "";
  const parts = raw.split("+").filter(Boolean);
  const modifiers = new Set<string>();
  let base = "";
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers.add("ctrl");
    else if (part === "alt" || part === "option") modifiers.add("alt");
    else if (part === "meta" || part === "cmd" || part === "command") modifiers.add("meta");
    else if (part === "shift") modifiers.add("shift");
    else base = part;
  }
  if (!base && parts.length > 0) base = parts[parts.length - 1] || "";
  base = normalizeBase(base);
  if (!base) return "";
  const ordered: string[] = [];
  if (modifiers.has("ctrl")) ordered.push("ctrl");
  if (modifiers.has("alt")) ordered.push("alt");
  if (modifiers.has("meta")) ordered.push("meta");
  if (modifiers.has("shift")) ordered.push("shift");
  return ordered.length ? `${ordered.join("+")}+${base}` : base;
}

function readBindingMap(value: unknown): BindingMap {
  const out: BindingMap = {};
  const obj = asObject(value);
  for (const [rawKey, rawCommand] of Object.entries(obj)) {
    const key = normalizeKeySpec(rawKey);
    const command = asString(rawCommand);
    if (!key || !command) continue;
    if (!COMMAND_ID_SET.has(command)) continue;
    out[key] = command as CommandId;
  }
  return out;
}

export function resolveTuiKeymapConfig(rawConfig: unknown): TuiKeymapConfig {
  const raw = asObject(rawConfig);
  const resolved: TuiKeymapConfig = {
    stickyModes: typeof raw.stickyModes === "boolean" ? raw.stickyModes : DEFAULT_CONFIG.stickyModes,
    showIdleBindingsInStatus: typeof raw.showIdleBindingsInStatus === "boolean"
      ? raw.showIdleBindingsInStatus
      : DEFAULT_CONFIG.showIdleBindingsInStatus,
    modeOrder: [...DEFAULT_CONFIG.modeOrder],
    exitKeys: [...DEFAULT_CONFIG.exitKeys],
    leaders: { ...DEFAULT_CONFIG.leaders },
    labels: { ...DEFAULT_CONFIG.labels },
    badges: { ...DEFAULT_CONFIG.badges },
    idleBindings: { ...DEFAULT_CONFIG.idleBindings },
    modeBindings: {
      revision: { ...DEFAULT_CONFIG.modeBindings.revision },
      history: { ...DEFAULT_CONFIG.modeBindings.history },
      graph: { ...DEFAULT_CONFIG.modeBindings.graph },
      bookmark: { ...DEFAULT_CONFIG.modeBindings.bookmark },
      theme: { ...DEFAULT_CONFIG.modeBindings.theme },
    },
  };

  if (Array.isArray(raw.modeOrder)) {
    const next: LeaderModeId[] = [];
    for (const v of raw.modeOrder) {
      if (typeof v !== "string") continue;
      const id = v.trim().toLowerCase();
      if (!LEADER_MODE_SET.has(id)) continue;
      if (!next.includes(id as LeaderModeId)) next.push(id as LeaderModeId);
    }
    if (next.length > 0) resolved.modeOrder = next;
  }

  if (Array.isArray(raw.exitKeys)) {
    const keys = raw.exitKeys
      .map((v) => (typeof v === "string" ? normalizeKeySpec(v) : ""))
      .filter(Boolean);
    if (keys.length > 0) resolved.exitKeys = keys;
  }

  const leaderObj = asObject(raw.leaders);
  for (const mode of LEADER_MODE_IDS) {
    const v = asString(leaderObj[mode]);
    if (!v) continue;
    const normalized = normalizeKeySpec(v);
    if (normalized) resolved.leaders[mode] = normalized;
  }

  const labelObj = asObject(raw.labels);
  for (const mode of LEADER_MODE_IDS) {
    const v = asString(labelObj[mode]);
    if (v) resolved.labels[mode] = v;
  }

  const badgeObj = asObject(raw.badges);
  for (const mode of LEADER_MODE_IDS) {
    const v = asString(badgeObj[mode]);
    if (v) resolved.badges[mode] = v;
  }

  const idle = readBindingMap(raw.idleBindings);
  resolved.idleBindings = { ...resolved.idleBindings, ...idle };

  const modeBindingsObj = asObject(raw.modeBindings);
  for (const mode of LEADER_MODE_IDS) {
    const modeRaw = readBindingMap(modeBindingsObj[mode]);
    resolved.modeBindings[mode] = { ...resolved.modeBindings[mode], ...modeRaw };
  }

  return resolved;
}

function eventKeyCandidates(key: KeyEvent): Set<string> {
  const out = new Set<string>();
  const name = normalizeBase((key.name || "").toLowerCase());
  const seq = normalizeBase((key.sequence || "").toLowerCase());
  const hasModifiers = Boolean(key.ctrl || key.meta || key.shift || (key as any).alt);
  const base = hasModifiers ? (name || seq) : (seq || name);
  if (name) out.add(name);
  if (seq) out.add(seq);
  if (base) {
    const mods: string[] = [];
    if (key.ctrl) mods.push("ctrl");
    if (key.meta) mods.push("meta");
    if (key.shift) mods.push("shift");
    if ((key as any).alt) mods.push("alt");
    if (mods.length > 0) out.add(`${mods.join("+")}+${base}`);
  }
  return out;
}

export function matchesKeySpec(spec: string, key: KeyEvent): boolean {
  const normalized = normalizeKeySpec(spec);
  if (!normalized) return false;
  return eventKeyCandidates(key).has(normalized);
}

export function findCommandForEvent(bindings: BindingMap, key: KeyEvent): CommandId | null {
  const candidates = eventKeyCandidates(key);
  for (const [spec, command] of Object.entries(bindings)) {
    if (candidates.has(normalizeKeySpec(spec))) return command;
  }
  return null;
}

export function findLeaderModeForEvent(config: TuiKeymapConfig, key: KeyEvent): LeaderModeId | null {
  for (const mode of config.modeOrder) {
    if (matchesKeySpec(config.leaders[mode], key)) return mode;
  }
  return null;
}

export function commandLabel(command: CommandId): string {
  const map: Record<CommandId, string> = {
    new: "New",
    edit: "Edit",
    describe: "Describe",
    rebase: "Rebase",
    insert: "Insert",
    abandon: "Abandon",
    squash: "Squash",
    duplicate: "Duplicate",
    undo: "Undo",
    redo: "Redo",
    "git-fetch": "Fetch",
    "git-push": "Push",
    "bookmark-set": "BM Set",
    "bookmark-delete": "BM Del",
    "merge-mode": "Merge",
    "theme-picker": "Theme",
    oplog: "OpLog",
    obslog: "Obslog",
    "back-log": "Back",
    restore: "Restore",
    "layout-chronological": "Layout Chron",
    "layout-mainline": "Layout Main",
    "layout-bookmark-centric": "Layout BM",
    "layout-wc-focused": "Layout WC",
    "layout-topological": "Layout Topo",
    "toggle-sidebar": "Sidebar",
    refresh: "Refresh",
    "toggle-help": "Help",
    "toggle-files": "Files",
    "toggle-description": "Description",
    revset: "Revset",
    "diff-toggle": "Diff",
  };
  return map[command] || command;
}
