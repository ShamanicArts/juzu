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
    { key: "/", action: "REVSET" },
    { key: "h", action: "HELP" },
  ],
  leader: [
    { key: "a", action: "ABANDON" },
    { key: "s", action: "SQUASH" },
    { key: "d", action: "DUPE" },
    { key: "u", action: "REDO" },
    { key: "m", action: "MERGE" },
    { key: "f", action: "FETCH" },
    { key: "p", action: "PUSH" },
    { key: "b", action: "BM SET" },
    { key: "x", action: "BM DEL" },
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
  revset: [
    { key: "Enter", action: "APPLY" },
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

export function StatusBar(props: { width: number; height: number }) {
  const currentMode = createMemo(() => {
    if (tuiState.revsetMode) return "revset";
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
      case "revset": return "REVSET";
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
      case "revset": return COLORS.describe;
      case "leader": return COLORS.leader;
      case "rebase": return COLORS.rebase;
      case "merge": return COLORS.merge;
      default: return COLORS.segmentBg;
    }
  });

  const keybinds = createMemo(() => {
    return KEYBINDS[currentMode()] || KEYBINDS.normal;
  });

  const showStatusMessage = createMemo(() => {
    if (!state.statusMessage) return false;
    if (state.statusMessage.startsWith("Error")) return true;
    return !tuiState.leaderMode;
  });

  const wrappedKeybindRows = createMemo(() => {
    const rows: Keybind[][] = [];
    const maxRows = Math.max(1, props.height - (showStatusMessage() ? 1 : 0));
    const firstRowWidth = Math.max(20, props.width - 16);
    const otherRowWidth = Math.max(20, props.width - 2);

    const segmentWidth = (kb: Keybind) => kb.key.length + 1 + kb.action.length + 2;

    let current: Keybind[] = [];
    let used = 0;
    let rowIdx = 0;

    for (const kb of keybinds()) {
      const limit = rowIdx === 0 ? firstRowWidth : otherRowWidth;
      const w = segmentWidth(kb);
      if (used + w > limit && current.length > 0) {
        rows.push(current);
        if (rows.length >= maxRows) return rows;
        current = [kb];
        used = w;
        rowIdx++;
      } else {
        current.push(kb);
        used += w;
      }
    }
    if (current.length > 0 && rows.length < maxRows) rows.push(current);
    return rows;
  });

  const isSpecialMode = createMemo(() => {
    return ["describe", "revset", "leader", "rebase", "merge"].includes(currentMode());
  });

  return (
    <box height={props.height} backgroundColor={COLORS.barBg} flexDirection="column">
      <For each={wrappedKeybindRows()}>
        {(row, idx) => (
          <box height={1} flexDirection="row">
            <Show when={idx() === 0}>
              <box backgroundColor={modeColor()} paddingLeft={1} paddingRight={1}>
                <text fg={isSpecialMode() ? COLORS.dark : COLORS.muted}>
                  <strong>{modeLabel()}</strong>
                </text>
              </box>
            </Show>
            <box paddingLeft={idx() === 0 ? 2 : 1} flexDirection="row">
              <For each={row}>
                {(kb) => (
                  <box flexDirection="row">
                    <text fg={COLORS.key}>{kb.key}</text>
                    <text fg={COLORS.action}> {kb.action}  </text>
                  </box>
                )}
              </For>
            </box>
          </box>
        )}
      </For>

      <Show when={showStatusMessage()}>
        <box height={1} paddingLeft={1}>
          <text fg={state.statusMessage?.startsWith("Error") ? COLORS.error : COLORS.muted}>
            {state.statusMessage}
          </text>
        </box>
      </Show>
    </box>
  );
}
