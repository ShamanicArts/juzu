import type { KeyEvent } from "@opentui/core";

export const LEADER_MODE_IDS = ["action", "ops", "view", "marks"] as const;
export type LeaderModeId = typeof LEADER_MODE_IDS[number];
export type ToneId = LeaderModeId | "neutral";

export const STATUS_CONTEXT_IDS = ["oplog", "obslog", "diff", "merge", "rebase", "describe", "revset", "themePicker"] as const;
export type StatusContextId = typeof STATUS_CONTEXT_IDS[number];

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

export interface StatusHintItem {
  key: string;
  label: string;
  tone: ToneId;
}

export interface TuiKeymapConfig {
  stickyModes: boolean;
  showIdleBindingsInStatus: boolean;
  showLeaderTriggersInStatus: boolean;
  modeOrder: LeaderModeId[];
  statusContextOrder: StatusContextId[];
  exitKeys: string[];
  leaders: Record<LeaderModeId, string>;
  labels: Record<LeaderModeId, string>;
  badges: Record<LeaderModeId, string>;
  idleBindings: BindingMap;
  modeBindings: Record<LeaderModeId, BindingMap>;
  commandLabels: Partial<Record<CommandId, string>>;
  statusContextLabels: Record<StatusContextId, string>;
  statusContexts: Record<StatusContextId, StatusHintItem[]>;
}

const COMMAND_ID_SET = new Set<string>(COMMAND_IDS);
const LEADER_MODE_SET = new Set<string>(LEADER_MODE_IDS);
const STATUS_CONTEXT_SET = new Set<string>(STATUS_CONTEXT_IDS);

const DEFAULT_LEADERS: Record<LeaderModeId, string> = {
  action: "ctrl+x",
  ops: "ctrl+o",
  view: "ctrl+l",
  marks: "ctrl+b",
};

const DEFAULT_LABELS: Record<LeaderModeId, string> = {
  action: "Actions",
  ops: "Operations",
  view: "View",
  marks: "Marks",
};

const DEFAULT_BADGES: Record<LeaderModeId, string> = {
  action: "ACT",
  ops: "OPS",
  view: "VIEW",
  marks: "MARK",
};

const DEFAULT_MODE_BINDINGS: Record<LeaderModeId, BindingMap> = {
  action: {
    n: "new",
    e: "edit",
    d: "describe",
    b: "rebase",
    i: "insert",
    a: "abandon",
    s: "squash",
    y: "duplicate",
    z: "restore",
    m: "merge-mode",
  },
  ops: {
    u: "undo",
    r: "redo",
    f: "git-fetch",
    p: "git-push",
    o: "oplog",
    v: "obslog",
    g: "back-log",
  },
  view: {
    "1": "layout-chronological",
    "2": "layout-mainline",
    "3": "layout-bookmark-centric",
    "4": "layout-wc-focused",
    "5": "layout-topological",
    c: "toggle-sidebar",
    t: "theme-picker",
    r: "refresh",
    f: "toggle-files",
    x: "toggle-description",
    h: "toggle-help",
    "/": "revset",
    "ctrl+d": "diff-toggle",
  },
  marks: {
    s: "bookmark-set",
    d: "bookmark-delete",
  },
};

const DEFAULT_IDLE_BINDINGS: BindingMap = {
  h: "toggle-help",
  "ctrl+d": "diff-toggle",
};

const DEFAULT_COMMAND_LABELS: Record<CommandId, string> = {
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

const DEFAULT_STATUS_CONTEXTS: Record<StatusContextId, StatusHintItem[]> = {
  oplog: [
    { key: "r", label: "Restore", tone: "ops" },
    { key: "g", label: "Log", tone: "ops" },
    { key: "j/k", label: "Move", tone: "neutral" },
    { key: "Esc", label: "Exit", tone: "neutral" },
  ],
  obslog: [
    { key: "g", label: "Log", tone: "ops" },
    { key: "j/k", label: "Move", tone: "neutral" },
    { key: "Esc", label: "Exit", tone: "neutral" },
  ],
  diff: [
    { key: "^d", label: "Log", tone: "view" },
    { key: "[ ]", label: "File", tone: "view" },
    { key: "j/k", label: "Move", tone: "neutral" },
    { key: "Esc", label: "Exit", tone: "neutral" },
  ],
  merge: [
    { key: "Space", label: "Select", tone: "action" },
    { key: "Enter", label: "Confirm", tone: "action" },
    { key: "Esc", label: "Cancel", tone: "neutral" },
  ],
  rebase: [
    { key: "Enter", label: "Confirm", tone: "action" },
    { key: "Esc", label: "Cancel", tone: "neutral" },
  ],
  describe: [
    { key: "Enter", label: "Apply", tone: "neutral" },
    { key: "Esc", label: "Cancel", tone: "neutral" },
  ],
  revset: [
    { key: "Enter", label: "Apply", tone: "neutral" },
    { key: "Esc", label: "Cancel", tone: "neutral" },
  ],
  themePicker: [
    { key: "j/k", label: "Select", tone: "view" },
    { key: "Enter", label: "Apply", tone: "view" },
    { key: "Esc", label: "Cancel", tone: "neutral" },
  ],
};

const DEFAULT_STATUS_CONTEXT_ORDER: StatusContextId[] = [
  "oplog",
  "obslog",
  "diff",
  "merge",
  "rebase",
  "describe",
  "revset",
  "themePicker",
];

const DEFAULT_STATUS_CONTEXT_LABELS: Record<StatusContextId, string> = {
  oplog: "OPLOG",
  obslog: "OBSLOG",
  diff: "DIFF",
  merge: "MERGE",
  rebase: "REBASE",
  describe: "DESCRIBE",
  revset: "REVSET",
  themePicker: "THEME",
};

const DEFAULT_CONFIG: TuiKeymapConfig = {
  stickyModes: true,
  showIdleBindingsInStatus: false,
  showLeaderTriggersInStatus: true,
  modeOrder: [...LEADER_MODE_IDS],
  statusContextOrder: [...DEFAULT_STATUS_CONTEXT_ORDER],
  exitKeys: ["escape", "q"],
  leaders: { ...DEFAULT_LEADERS },
  labels: { ...DEFAULT_LABELS },
  badges: { ...DEFAULT_BADGES },
  idleBindings: { ...DEFAULT_IDLE_BINDINGS },
  modeBindings: {
    action: { ...DEFAULT_MODE_BINDINGS.action },
    ops: { ...DEFAULT_MODE_BINDINGS.ops },
    view: { ...DEFAULT_MODE_BINDINGS.view },
    marks: { ...DEFAULT_MODE_BINDINGS.marks },
  },
  commandLabels: { ...DEFAULT_COMMAND_LABELS },
  statusContextLabels: { ...DEFAULT_STATUS_CONTEXT_LABELS },
  statusContexts: {
    oplog: [...DEFAULT_STATUS_CONTEXTS.oplog],
    obslog: [...DEFAULT_STATUS_CONTEXTS.obslog],
    diff: [...DEFAULT_STATUS_CONTEXTS.diff],
    merge: [...DEFAULT_STATUS_CONTEXTS.merge],
    rebase: [...DEFAULT_STATUS_CONTEXTS.rebase],
    describe: [...DEFAULT_STATUS_CONTEXTS.describe],
    revset: [...DEFAULT_STATUS_CONTEXTS.revset],
    themePicker: [...DEFAULT_STATUS_CONTEXTS.themePicker],
  },
};

function canonicalModeId(raw: string): LeaderModeId | null {
  const id = raw.trim().toLowerCase();
  if (LEADER_MODE_SET.has(id)) return id as LeaderModeId;
  const aliases: Record<string, LeaderModeId> = {
    revision: "action",
    history: "ops",
    graph: "view",
    bookmark: "marks",
    theme: "view",
  };
  return aliases[id] || null;
}

function canonicalStatusContextId(raw: string): StatusContextId | null {
  const id = raw.trim();
  if (!id) return null;
  const normalized = id.toLowerCase();
  if (STATUS_CONTEXT_SET.has(normalized)) return normalized as StatusContextId;
  const aliases: Record<string, StatusContextId> = {
    theme: "themePicker",
    themepicker: "themePicker",
    "theme-picker": "themePicker",
  };
  return aliases[normalized] || null;
}

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

function readTone(value: unknown): ToneId | null {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  if (lowered === "neutral") return "neutral";
  const mode = canonicalModeId(lowered);
  return mode || null;
}

function readStatusHintItems(value: unknown): StatusHintItem[] {
  const out: StatusHintItem[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      const obj = asObject(item);
      const key = asString(obj.key);
      const label = asString(obj.label);
      if (!key || !label) continue;
      const tone = readTone(obj.tone) || "neutral";
      out.push({ key, label, tone });
    }
    return out;
  }

  const obj = asObject(value);
  for (const [key, rawLabel] of Object.entries(obj)) {
    const label = asString(rawLabel);
    if (!label) continue;
    out.push({ key, label, tone: "neutral" });
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
    showLeaderTriggersInStatus: typeof raw.showLeaderTriggersInStatus === "boolean"
      ? raw.showLeaderTriggersInStatus
      : DEFAULT_CONFIG.showLeaderTriggersInStatus,
    modeOrder: [...DEFAULT_CONFIG.modeOrder],
    statusContextOrder: [...DEFAULT_CONFIG.statusContextOrder],
    exitKeys: [...DEFAULT_CONFIG.exitKeys],
    leaders: { ...DEFAULT_CONFIG.leaders },
    labels: { ...DEFAULT_CONFIG.labels },
    badges: { ...DEFAULT_CONFIG.badges },
    idleBindings: { ...DEFAULT_CONFIG.idleBindings },
    modeBindings: {
      action: { ...DEFAULT_CONFIG.modeBindings.action },
      ops: { ...DEFAULT_CONFIG.modeBindings.ops },
      view: { ...DEFAULT_CONFIG.modeBindings.view },
      marks: { ...DEFAULT_CONFIG.modeBindings.marks },
    },
    commandLabels: { ...DEFAULT_CONFIG.commandLabels },
    statusContextLabels: { ...DEFAULT_CONFIG.statusContextLabels },
    statusContexts: {
      oplog: [...DEFAULT_CONFIG.statusContexts.oplog],
      obslog: [...DEFAULT_CONFIG.statusContexts.obslog],
      diff: [...DEFAULT_CONFIG.statusContexts.diff],
      merge: [...DEFAULT_CONFIG.statusContexts.merge],
      rebase: [...DEFAULT_CONFIG.statusContexts.rebase],
      describe: [...DEFAULT_CONFIG.statusContexts.describe],
      revset: [...DEFAULT_CONFIG.statusContexts.revset],
      themePicker: [...DEFAULT_CONFIG.statusContexts.themePicker],
    },
  };

  if (Array.isArray(raw.modeOrder)) {
    const next: LeaderModeId[] = [];
    for (const v of raw.modeOrder) {
      if (typeof v !== "string") continue;
      const id = canonicalModeId(v);
      if (!id) continue;
      if (!next.includes(id)) next.push(id);
    }
    if (next.length > 0) resolved.modeOrder = next;
  }

  if (Array.isArray(raw.statusContextOrder)) {
    const next: StatusContextId[] = [];
    for (const v of raw.statusContextOrder) {
      if (typeof v !== "string") continue;
      const id = canonicalStatusContextId(v);
      if (!id) continue;
      if (!next.includes(id)) next.push(id);
    }
    if (next.length > 0) resolved.statusContextOrder = next;
  }

  if (Array.isArray(raw.exitKeys)) {
    const keys = raw.exitKeys
      .map((v) => (typeof v === "string" ? normalizeKeySpec(v) : ""))
      .filter(Boolean);
    if (keys.length > 0) resolved.exitKeys = keys;
  }

  const leaderObj = asObject(raw.leaders);
  for (const [rawMode, rawValue] of Object.entries(leaderObj)) {
    const mode = canonicalModeId(rawMode);
    if (!mode) continue;
    const v = asString(rawValue);
    if (!v) continue;
    const normalized = normalizeKeySpec(v);
    if (normalized) resolved.leaders[mode] = normalized;
  }

  const labelObj = asObject(raw.labels);
  for (const [rawMode, rawValue] of Object.entries(labelObj)) {
    const mode = canonicalModeId(rawMode);
    if (!mode) continue;
    const v = asString(rawValue);
    if (v) resolved.labels[mode] = v;
  }

  const badgeObj = asObject(raw.badges);
  for (const [rawMode, rawValue] of Object.entries(badgeObj)) {
    const mode = canonicalModeId(rawMode);
    if (!mode) continue;
    const v = asString(rawValue);
    if (v) resolved.badges[mode] = v;
  }

  const commandLabelObj = asObject(raw.commandLabels);
  for (const [rawCommand, rawLabel] of Object.entries(commandLabelObj)) {
    const command = asString(rawCommand);
    const label = asString(rawLabel);
    if (!command || !label) continue;
    if (!COMMAND_ID_SET.has(command)) continue;
    resolved.commandLabels[command as CommandId] = label;
  }

  const statusContextLabelObj = asObject(raw.statusContextLabels);
  for (const [rawContext, rawLabel] of Object.entries(statusContextLabelObj)) {
    const context = canonicalStatusContextId(rawContext);
    const label = asString(rawLabel);
    if (!context || !label) continue;
    resolved.statusContextLabels[context] = label;
  }

  const idle = readBindingMap(raw.idleBindings);
  resolved.idleBindings = { ...resolved.idleBindings, ...idle };

  const modeBindingsObj = asObject(raw.modeBindings);
  for (const [rawMode, modeValue] of Object.entries(modeBindingsObj)) {
    const mode = canonicalModeId(rawMode);
    if (!mode) continue;
    const modeRaw = readBindingMap(modeValue);
    resolved.modeBindings[mode] = { ...resolved.modeBindings[mode], ...modeRaw };
  }

  const statusContextsObj = asObject(raw.statusContexts);
  for (const [rawContext, rawItems] of Object.entries(statusContextsObj)) {
    const context = canonicalStatusContextId(rawContext);
    if (!context) continue;
    const parsed = readStatusHintItems(rawItems);
    if (parsed.length > 0) resolved.statusContexts[context] = parsed;
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

export function commandLabel(command: CommandId, labels?: Partial<Record<CommandId, string>>): string {
  return labels?.[command] || DEFAULT_COMMAND_LABELS[command] || command;
}

export function formatKeyHint(spec: string): string {
  const key = normalizeKeySpec(spec);
  if (!key) return spec;
  const parts = key.split("+");
  const base = parts[parts.length - 1] || "";
  const mods = new Set(parts.slice(0, -1));
  const prefix = `${mods.has("ctrl") ? "^" : ""}${mods.has("alt") ? "!" : ""}${mods.has("meta") ? "M-" : ""}`;
  return `${prefix}${base}`;
}
