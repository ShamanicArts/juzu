import { For } from "solid-js";
import { RGBA } from "@opentui/core";

const BG = RGBA.fromHex("#1a1b26");
const BORDER = RGBA.fromHex("#00f0ff");
const CYAN = RGBA.fromHex("#00f0ff");
const YELLOW = RGBA.fromHex("#ffaa00");
const GREEN = RGBA.fromHex("#00ff9d");
const FG = RGBA.fromHex("#c0caf5");
const DIM = RGBA.fromHex("#565f89");
const BLACK_TRANSPARENT = RGBA.fromValues(0, 0, 0, 0.7);

interface HelpModalProps {
  width: number;
  height: number;
}

export function HelpModal(props: HelpModalProps) {
  const helpSections = [
    { type: "header", text: "Navigation" },
    { type: "key", key: "j/k or ↑/↓", desc: "Navigate commits" },
    { type: "key", key: "PgUp/PgDn", desc: "Scroll sidebar" },
    { type: "spacer" },
    { type: "header", text: "Layout Modes" },
    { type: "key", key: "1", desc: "Chronological" },
    { type: "key", key: "2", desc: "Mainline" },
    { type: "key", key: "3", desc: "Bookmark-centric" },
    { type: "key", key: "4", desc: "WC-focused" },
    { type: "key", key: "5", desc: "Topological" },
    { type: "spacer" },
    { type: "header", text: "View Options" },
    { type: "key", key: "x", desc: "Toggle description expand" },
    { type: "key", key: "f", desc: "Toggle files list" },
    { type: "key", key: "r", desc: "Refresh data" },
    { type: "key", key: "?", desc: "Toggle this help" },
    { type: "spacer" },
    { type: "header", text: "Commit Operations" },
    { type: "key", key: "n", desc: "New commit from selected" },
    { type: "key", key: "e", desc: "Edit (checkout) selected" },
    { type: "key", key: "d", desc: "Describe (edit message)" },
    { type: "key", key: "b", desc: "Rebase mode (select source)" },
    { type: "key", key: "i", desc: "Insert commit after selected" },
    { type: "key", key: "u", desc: "Undo last operation" },
    { type: "spacer" },
    { type: "header", text: "Shift Operations" },
    { type: "key", key: "Shift+A", desc: "Abandon selected" },
    { type: "key", key: "Shift+S", desc: "Squash into parent" },
    { type: "key", key: "Shift+D", desc: "Duplicate selected" },
    { type: "spacer" },
    { type: "header", text: "Rebase Mode" },
    { type: "key", key: "Enter/b", desc: "Complete rebase (select dest)" },
    { type: "key", key: "Esc", desc: "Cancel rebase mode" },
    { type: "spacer" },
    { type: "header", text: "General" },
    { type: "key", key: "q / Ctrl+C", desc: "Quit" },
  ];

  return (
    <box
      flexGrow={1}
      backgroundColor={BLACK_TRANSPARENT}
      flexDirection="column"
    >
      <box flexGrow={1} />
      
      <box flexDirection="row">
        <box flexGrow={1} />
        
        <box
          width={Math.min(60, props.width - 4)}
          height={Math.min(28, props.height - 4)}
          backgroundColor={BG}
          borderStyle="single"
          borderColor={BORDER}
          flexDirection="column"
        >
          <box height={1} flexDirection="row">
            <box flexGrow={1} />
            <text fg={CYAN}>jj-viz TUI Help</text>
            <box flexGrow={1} />
          </box>

          <text fg={DIM}>──────────────────────────────────────────</text>

          <For each={helpSections}>
            {(item) => {
              if (item.type === "spacer") {
                return <box height={1} />;
              }
              if (item.type === "header") {
                return (
                  <box height={1}>
                    <text fg={CYAN}>{item.text}</text>
                  </box>
                );
              }
              return (
                <box height={1} flexDirection="row">
                  <text fg={YELLOW}>{(item.key as string).padEnd(12)}</text>
                  <text fg={FG}>{item.desc}</text>
                </box>
              );
            }}
          </For>

          <box flexGrow={1} />
          
          <box height={1} flexDirection="row">
            <box flexGrow={1} />
            <text fg={DIM}>Press ? or Esc to close</text>
            <box flexGrow={1} />
          </box>
        </box>
        
        <box flexGrow={1} />
      </box>
      
      <box flexGrow={1} />
    </box>
  );
}
