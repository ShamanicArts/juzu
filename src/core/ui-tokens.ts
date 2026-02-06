export const UI_TOKENS = {
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

export type UiTokens = typeof UI_TOKENS;
