export const DEFAULT_UI_TOKENS = {
  slate: {
    bg0: "#111318",
    bg1: "#161b22",
    bg2: "#1d2530",
    panel: "#1a2029",
    panelElevated: "#222b37",
    borderSoft: "#2a3442",
    borderStrong: "#3a4759",
    text: "#d8dee8",
    textMuted: "#8a95a7",
  },
  semantic: {
    success: "#74b88c",
    warn: "#c9a86a",
    error: "#ce6f7c",
    info: "#7f9fbf",
    fileAdd: "#22c55e",
    fileMod: "#f59e0b",
    fileDel: "#ef4444",
    modeLog: "#6f89ad",
  },
  graph: {
    node: "#444",
    nodeSelected: "#ffffff",
    nodeConflict: "#ff0055",
    text: "#888",
    textDesc: "#bbb",
    textMuted: "#6a7685",
    nodeBorder: "#666",
    lanes: [
      "#00f0ff",
      "#ff0055",
      "#00ff9d",
      "#ffaa00",
      "#aa00ff",
      "#00aaff",
      "#ffff00",
      "#ff00aa",
    ],
    canvasTint: "rgba(17, 19, 24, 0.22)",
    commitId: "#5a6a7a",
    bookmark: "#c9a86a",
    bookmarkSelected: "#e8c884",
    fileAdd: "#74b88c",
    fileMod: "#c9a86a",
    fileDel: "#ce6f7c",
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
  },
  radius: {
    sm: 6,
    md: 10,
    lg: 12,
  },
  separator: {
    subtle: "rgba(138, 149, 167, 0.24)",
    strong: "rgba(138, 149, 167, 0.42)",
  },
} as const;

export type UiTokens = typeof DEFAULT_UI_TOKENS;

let activeTokens: UiTokens = JSON.parse(JSON.stringify(DEFAULT_UI_TOKENS));

export let UI_TOKENS: UiTokens = activeTokens;

function mergeObject(base: any, patch: any): any {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch ?? base;
  const out: any = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const prev = (out as any)[k];
    if (Array.isArray(v)) {
      (out as any)[k] = [...v];
    } else if (v && typeof v === "object" && prev && typeof prev === "object" && !Array.isArray(prev)) {
      (out as any)[k] = mergeObject(prev, v);
    } else {
      (out as any)[k] = v;
    }
  }
  return out;
}

export function setUiTokens(next: Partial<UiTokens>) {
  activeTokens = mergeObject(DEFAULT_UI_TOKENS, next);
  UI_TOKENS = activeTokens;
}

export function resetUiTokens() {
  activeTokens = JSON.parse(JSON.stringify(DEFAULT_UI_TOKENS));
  UI_TOKENS = activeTokens;
}
