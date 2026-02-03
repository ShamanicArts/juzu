import { RGBA } from "@opentui/core";

const BG = RGBA.fromHex("#1a1b26");
const BORDER = RGBA.fromHex("#00f0ff");
const CYAN = RGBA.fromHex("#00f0ff");
const YELLOW = RGBA.fromHex("#ffaa00");
const FG = RGBA.fromHex("#c0caf5");
const DIM = RGBA.fromHex("#565f89");

interface HelpModalProps {
  width: number;
  height: number;
}

export function HelpModal(props: HelpModalProps) {
  const modalW = Math.min(60, props.width - 4);
  const modalH = Math.min(28, props.height - 4);

  return (
    <box
      width={props.width}
      height={props.height}
      backgroundColor={BG}
      flexDirection="column"
    >
      <box flexGrow={1} />
      
      <box flexDirection="row">
        <box flexGrow={1} />
        
        <box
          width={modalW}
          height={modalH}
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

          {/* Navigation */}
          <box height={1}><text fg={CYAN}>Navigation</text></box>
          <box height={1} flexDirection="row">
            <text fg={YELLOW}>{"j/k or ↑/↓".padEnd(12)}</text>
            <text fg={FG}>Navigate commits</text>
          </box>
          <box height={1} flexDirection="row">
            <text fg={YELLOW}>{"PgUp/PgDn".padEnd(12)}</text>
            <text fg={FG}>Scroll sidebar</text>
          </box>
          <box height={1} />

          {/* Layout Modes */}
          <box height={1}><text fg={CYAN}>Layout Modes</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"1".padEnd(12)}</text><text fg={FG}>Chronological</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"2".padEnd(12)}</text><text fg={FG}>Mainline</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"3".padEnd(12)}</text><text fg={FG}>Bookmark-centric</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"4".padEnd(12)}</text><text fg={FG}>WC-focused</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"5".padEnd(12)}</text><text fg={FG}>Topological</text></box>
          <box height={1} />

          {/* Operations */}
          <box height={1}><text fg={CYAN}>Operations</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"n".padEnd(12)}</text><text fg={FG}>New commit</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"e".padEnd(12)}</text><text fg={FG}>Edit/checkout</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"d".padEnd(12)}</text><text fg={FG}>Describe</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"b".padEnd(12)}</text><text fg={FG}>Rebase</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"Ctrl+x a".padEnd(12)}</text><text fg={FG}>Abandon</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"Ctrl+x s".padEnd(12)}</text><text fg={FG}>Squash</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"Ctrl+x d".padEnd(12)}</text><text fg={FG}>Duplicate</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"u".padEnd(12)}</text><text fg={FG}>Undo</text></box>
          <box height={1} />

          {/* View */}
          <box height={1}><text fg={CYAN}>View</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"x".padEnd(12)}</text><text fg={FG}>Toggle desc</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"f".padEnd(12)}</text><text fg={FG}>Toggle files</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"r".padEnd(12)}</text><text fg={FG}>Refresh</text></box>
          <box height={1} flexDirection="row"><text fg={YELLOW}>{"h".padEnd(12)}</text><text fg={FG}>Help</text></box>

          <box flexGrow={1} />
          
          <box height={1} flexDirection="row">
            <box flexGrow={1} />
            <text fg={DIM}>Press h or Esc to close</text>
            <box flexGrow={1} />
          </box>
        </box>
        
        <box flexGrow={1} />
      </box>
      
      <box flexGrow={1} />
    </box>
  );
}
