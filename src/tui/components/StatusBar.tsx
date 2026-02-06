import { Show, createMemo, For } from "solid-js";
import { RGBA } from "@opentui/core";
import { state } from "../../core/state";
import { tuiState } from "../../core/state-tui";

// Tokyo Night palette
const COLORS = {
  barBg: RGBA.fromHex("#1a1b26"),
  segmentBg: RGBA.fromHex("#24283b"),
  key: RGBA.fromHex("#bb9af7"),      // Purple - keybind letters
  action: RGBA.fromHex("#c0caf5"),   // Light - action names
  muted: RGBA.fromHex("#565f89"),    // Dim
  rebase: RGBA.fromHex("#ff9e64"),   // Orange
  merge: RGBA.fromHex("#9ece6a"),    // Green
  leader: RGBA.fromHex("#bb9af7"),   // Purple
  describe: RGBA.fromHex("#7dcfff"), // Cyan
  error: RGBA.fromHex("#f7768e"),    // Red
  dark: RGBA.fromHex("#1a1b26"),
};

interface Keybind {
  key: string;
  action: string;
}

const KEYBINDS: Record<string, Keybind[]> = {
  normal: [
    { key: "n", action: "NEW" },
    { key: "e", action: "EDIT" },
    { key: "d", action: "DESC" },
    { key: "b", action: "REBASE" },
    { key: "u", action: "UNDO" },
    { key: "^x", action: "LEADER" },
    { key: "o", action: "OPLOG" },
    { key: "v", action: "OBSLOG" },
    { key: "h", action: "HELP" },
  ],
  leader: [
    { key: "a", action: "ABANDON" },
    { key: "s", action: "SQUASH" },
    { key: "d", action: "DUPE" },
    { key: "u", action: "REDO" },
    { key: "m", action: "MERGE" },
    { key: "Esc", action: "CANCEL" },
  ],
  rebase: [
    { key: "b", action: "CONFIRM" },
    { key: "Enter", action: "CONFIRM" },
    { key: "Esc", action: "CANCEL" },
  ],
  merge: [
    { key: "Space", action: "SELECT" },
    { key: "m", action: "CONFIRM" },
    { key: "Esc", action: "CANCEL" },
  ],
  describe: [
    { key: "Enter", action: "CONFIRM" },
    { key: "Esc", action: "CANCEL" },
  ],
  oplog: [
    { key: "r", action: "RESTORE" },
    { key: "g", action: "LOG" },
    { key: "h", action: "HELP" },
  ],
  obslog: [
    { key: "g", action: "LOG" },
    { key: "h", action: "HELP" },
  ],
};

export function StatusBar() {
  const currentMode = createMemo(() => {
    if (state.describeMode) return "describe";
    if (tuiState.leaderMode) return "leader";
    if (state.rebaseSourceId) return "rebase";
    if (tuiState.mergeMode) return "merge";
    if (state.viewMode === "oplog") return "oplog";
    if (state.viewMode === "obslog") return "obslog";
    return "normal";
  });

  const modeLabel = createMemo(() => {
    const mode = currentMode();
    switch (mode) {
      case "describe": return "DESCRIBE";
      case "leader": return "LEADER";
      case "rebase": return "REBASE";
      case "merge": return "MERGE";
      case "oplog": return "OPLOG";
      case "obslog": return "OBSLOG";
      default: return "LOG";
    }
  });

  const modeColor = createMemo(() => {
    const mode = currentMode();
    switch (mode) {
      case "describe": return COLORS.describe;
      case "leader": return COLORS.leader;
      case "rebase": return COLORS.rebase;
      case "merge": return COLORS.merge;
      default: return COLORS.segmentBg;
    }
  });

  const keybinds = createMemo(() => {
    return KEYBINDS[currentMode()] || KEYBINDS.normal;
  });

  const isSpecialMode = createMemo(() => {
    return ["describe", "leader", "rebase", "merge"].includes(currentMode());
  });

  const showStatusMessage = createMemo(() => {
    if (!state.statusMessage) return false;
    if (state.statusMessage.startsWith("Error")) return true;
    return !tuiState.leaderMode;
  });

  return (
    <box height={1} backgroundColor={COLORS.barBg} flexDirection="row">
      {/* Mode badge */}
      <box
        backgroundColor={modeColor()}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={isSpecialMode() ? COLORS.dark : COLORS.muted}>
          <strong>{modeLabel()}</strong>
        </text>
      </box>

      {/* Keybinds - using inline boxes for each key/action pair */}
      <box paddingLeft={2} flexGrow={1} flexDirection="row">
        <For each={keybinds()}>
          {(kb) => (
            <box flexDirection="row">
              <text fg={COLORS.key}>{kb.key}</text>
              <text fg={COLORS.action}> {kb.action}  </text>
            </box>
          )}
        </For>
      </box>

      {/* Status message on right */}
      <Show when={showStatusMessage()}>
        <box paddingRight={1}>
          <text fg={state.statusMessage?.startsWith("Error") ? COLORS.error : COLORS.muted}>
            {state.statusMessage}
          </text>
        </box>
      </Show>
    </box>
  );
}
