import { For, Show, createMemo } from "solid-js";
import { RGBA } from "@opentui/core";
import { state } from "../../core/state";
import { tuiState } from "../../core/state-tui";
import { UI_TOKENS } from "../../core/ui-tokens";
import { mixHex } from "../../core/color-utils";
import { commandLabel, formatKeyHint, type StatusContextId, type TuiKeymapConfig } from "../../core/tui-keymap";

type Tone = "action" | "ops" | "view" | "marks" | "neutral";
type Item = { key: string; label: string; tone: Tone };

const MODE_TONE: Record<string, Tone> = {
  action: "action",
  ops: "ops",
  view: "view",
  marks: "marks",
};

function toneHex(tone: Tone): string {
  switch (tone) {
    case "action":
      return (UI_TOKENS.semantic as any).modeAction || UI_TOKENS.semantic.warn;
    case "ops":
      return (UI_TOKENS.semantic as any).modeOps || UI_TOKENS.semantic.info;
    case "view":
      return (UI_TOKENS.semantic as any).modeView || UI_TOKENS.semantic.modeLog;
    case "marks":
      return (UI_TOKENS.semantic as any).modeMarks || UI_TOKENS.semantic.success;
    default:
      return UI_TOKENS.slate.textMuted;
  }
}

function itemBg(tone: Tone, _themeVersion?: number): RGBA {
  return RGBA.fromHex(mixHex(UI_TOKENS.slate.bg2, toneHex(tone), 0.42));
}

function itemFg(tone: Tone, _themeVersion?: number): RGBA {
  return RGBA.fromHex(mixHex(UI_TOKENS.slate.text, toneHex(tone), 0.46));
}

function statusContextActive(context: StatusContextId): boolean {
  switch (context) {
    case "oplog":
      return state.viewMode === "oplog";
    case "obslog":
      return state.viewMode === "obslog";
    case "diff":
      return state.viewMode === "diff";
    case "merge":
      return tuiState.mergeMode;
    case "rebase":
      return Boolean(state.rebaseSourceId);
    case "describe":
      return state.describeMode;
    case "revset":
      return tuiState.revsetMode;
    case "themePicker":
      return tuiState.themePickerMode;
    default:
      return false;
  }
}

export function StatusBar(props: { width: number; height: number; themeVersion?: number; keymap: TuiKeymapConfig }) {
  const activeStatusContext = createMemo<StatusContextId | null>(() => {
    for (const id of props.keymap.statusContextOrder) {
      if (statusContextActive(id)) return id;
    }
    return null;
  });

  const modeLabel = createMemo(() => {
    const context = activeStatusContext();
    if (context) return props.keymap.statusContextLabels[context] || context.toUpperCase();
    if (tuiState.activeLeaderMode) return props.keymap.labels[tuiState.activeLeaderMode].toUpperCase();
    return "LOG";
  });

  const modeTint = createMemo(() => {
    const context = activeStatusContext();
    if (context === "oplog" || context === "obslog") return toneHex("ops");
    if (context === "diff" || context === "themePicker") return toneHex("view");
    if (context === "merge" || context === "rebase") return toneHex("action");
    if (tuiState.activeLeaderMode) return toneHex(MODE_TONE[tuiState.activeLeaderMode] || "neutral");
    return UI_TOKENS.semantic.modeLog;
  });

  const modeBg = createMemo(() => {
    props.themeVersion;
    return RGBA.fromHex(mixHex(modeTint(), UI_TOKENS.slate.text, 0.18));
  });

  const barBg = createMemo(() => {
    props.themeVersion;
    return RGBA.fromHex(UI_TOKENS.slate.panel);
  });

  const keyColor = createMemo(() => {
    props.themeVersion;
    return RGBA.fromHex(UI_TOKENS.semantic.info);
  });

  const darkText = createMemo(() => {
    props.themeVersion;
    return RGBA.fromHex(UI_TOKENS.slate.bg0);
  });

  const mutedText = createMemo(() => {
    props.themeVersion;
    return RGBA.fromHex(UI_TOKENS.slate.textMuted);
  });

  const errorText = createMemo(() => {
    props.themeVersion;
    return RGBA.fromHex(UI_TOKENS.semantic.error);
  });

  const contextItems = createMemo<Item[] | null>(() => {
    const context = activeStatusContext();
    if (!context) return null;
    const configured = props.keymap.statusContexts[context] || [];
    return configured.map((item) => ({
      key: formatKeyHint(item.key),
      label: item.label,
      tone: item.tone,
    }));
  });

  const items = createMemo<Item[]>(() => {
    const ctx = contextItems();
    if (ctx) return ctx;

    if (tuiState.activeLeaderMode) {
      const tone = MODE_TONE[tuiState.activeLeaderMode] || "neutral";
      const modeItems = Object.entries(props.keymap.modeBindings[tuiState.activeLeaderMode]).map(([key, command]) => ({
        key: formatKeyHint(key),
        label: commandLabel(command, props.keymap.commandLabels),
        tone,
      }));
      modeItems.push({ key: "Esc/q", label: "Exit", tone: "neutral" });
      return modeItems;
    }

    const modeItems: Item[] = props.keymap.modeOrder.map((mode) => ({
      key: props.keymap.showLeaderTriggersInStatus ? formatKeyHint(props.keymap.leaders[mode]) : "",
      label: props.keymap.badges[mode],
      tone: MODE_TONE[mode] || "neutral",
    }));

    if (!props.keymap.showIdleBindingsInStatus) return modeItems;
    const idleItems = Object.entries(props.keymap.idleBindings).map(([key, command]) => ({
      key: formatKeyHint(key),
      label: commandLabel(command, props.keymap.commandLabels),
      tone: "neutral" as const,
    }));
    return [...modeItems, ...idleItems];
  });

  const showStatusMessage = createMemo(() => {
    const msg = (state.statusMessage || "").trim();
    if (!msg) return false;
    if (/^nodes:\d+$/i.test(msg)) return false;
    if (msg === "Loading...") return false;
    if (msg.startsWith("Error")) return true;
    return !tuiState.activeLeaderMode;
  });

  const wrappedRows = createMemo(() => {
    const rows: Item[][] = [];
    const maxRows = Math.max(1, props.height - (showStatusMessage() ? 1 : 0));
    const firstRowWidth = Math.max(20, props.width - 14);
    const otherRowWidth = Math.max(20, props.width - 2);
    const segmentWidth = (item: Item) => item.key.length + item.label.length + 6;

    let current: Item[] = [];
    let used = 0;
    let rowIndex = 0;

    for (const item of items()) {
      const limit = rowIndex === 0 ? firstRowWidth : otherRowWidth;
      const w = segmentWidth(item);
      if (used + w > limit && current.length > 0) {
        rows.push(current);
        if (rows.length >= maxRows) return rows;
        current = [item];
        used = w;
        rowIndex++;
      } else {
        current.push(item);
        used += w;
      }
    }

    if (current.length > 0 && rows.length < maxRows) rows.push(current);
    return rows;
  });

  return (
    <box height={props.height} backgroundColor={barBg()} flexDirection="column">
      <For each={wrappedRows()}>
        {(row, idx) => (
          <box height={1} flexDirection="row" alignItems="center">
            <Show when={idx() === 0}>
              <box backgroundColor={modeBg()} paddingLeft={1} paddingRight={1}>
                <text fg={darkText()}>
                  <strong>{modeLabel()}</strong>
                </text>
              </box>
            </Show>

            <box paddingLeft={idx() === 0 ? 2 : 1} flexDirection="row">
              <For each={row}>
                {(item) => (
                  <>
                    <Show when={item.key.length > 0}>
                      <text fg={keyColor()}>{item.key}</text>
                      <text> </text>
                    </Show>
                    <box backgroundColor={itemBg(item.tone, props.themeVersion)} paddingLeft={1} paddingRight={1}>
                      <text fg={itemFg(item.tone, props.themeVersion)}>{item.label}</text>
                    </box>
                    <text> </text>
                  </>
                )}
              </For>
            </box>
          </box>
        )}
      </For>

      <Show when={showStatusMessage()}>
        <box height={1} paddingLeft={1}>
          <text fg={state.statusMessage?.startsWith("Error") ? errorText() : mutedText()}>
            {state.statusMessage}
          </text>
        </box>
      </Show>
    </box>
  );
}
