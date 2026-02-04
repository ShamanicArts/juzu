import { Show, createMemo, For } from "solid-js";
import type { OpLogEntry } from "../../core/jj-api";

export function OpLogSidebar(props: {
  entries: OpLogEntry[];
  selectedId: string | null;
  onUndo: () => void;
  onRedo: () => void;
  onRestore: () => void;
  onRefresh: () => void;
}) {
  const selected = createMemo(() => props.entries.find((e) => e.id === props.selectedId) || null);

  // Extract args from tags
  const getArgsFromTags = (tags: string[]): string | null => {
    const argsTag = tags.find((t) => t.toLowerCase().startsWith("args:"));
    return argsTag || null;
  };

  const formatTime = (timeStr: string) => {
    try {
      const start = timeStr.split(" - ")[0] || timeStr;
      const date = new Date(start);
      if (Number.isNaN(date.getTime())) return start;
      return date.toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return timeStr;
    }
  };

  return (
    <div class="jjv-inspector">
      <div class="jjv-panelHeader">
        <div class="jjv-panelTitle">
          <span class="mono">Op Log</span>
        </div>
        <div class="jjv-panelActions">
          <button class="jjv-btn jjv-btn--ghost" onClick={props.onRefresh}>Refresh</button>
        </div>
      </div>

      <div class="jjv-card">
        <div class="jjv-cardTitle">Actions</div>
        <div class="jjv-row jjv-row--wrap">
          <button class="jjv-btn jjv-btn--ghost" onClick={props.onUndo}>Undo</button>
          <button class="jjv-btn jjv-btn--ghost" onClick={props.onRedo}>Redo</button>
          <button class="jjv-btn jjv-btn--primary" disabled={!props.selectedId} onClick={props.onRestore}>
            Restore
          </button>
        </div>
        <div class="jjv-muted" style={{ "margin-top": "10px" }}>
          Keyboard: j/k (navigate), Enter (restore), u (undo), R (redo), r (refresh), g/Esc (back)
        </div>
      </div>

      <Show when={selected()} fallback={<div class="jjv-muted">Select an operation</div>}>
        {(sel) => {
          const argsLine = getArgsFromTags(sel().tags);
          return (
            <>
              <div class="jjv-card">
                <div class="jjv-cardTitle">Selected Operation</div>
                <div class="jjv-row" style={{ "margin-bottom": "10px" }}>
                  <span class={`jjv-badge ${sel().isCurrent ? "jjv-badge--wc" : ""}`}>
                    {sel().isCurrent ? "● Current" : "○ Past"}
                  </span>
                </div>
                <div class="jjv-kv">
                  <div class="jjv-kvRow">
                    <div class="jjv-k">ID</div>
                    <div class="jjv-v mono">{sel().id}</div>
                  </div>
                  <div class="jjv-kvRow">
                    <div class="jjv-k">User</div>
                    <div class="jjv-v">{sel().user}</div>
                  </div>
                  <div class="jjv-kvRow">
                    <div class="jjv-k">Time</div>
                    <div class="jjv-v">{formatTime(sel().time)}</div>
                  </div>
                  <div class="jjv-kvRow">
                    <div class="jjv-k">Duration</div>
                    <div class="jjv-v mono">{sel().duration}</div>
                  </div>
                </div>
              </div>

              <div class="jjv-card">
                <div class="jjv-cardTitle">Description</div>
                <pre class="jjv-diff mono">{sel().descriptionFull || sel().descriptionTitle || "(no description)"}</pre>
              </div>

              <Show when={argsLine}>
                <div class="jjv-card">
                  <div class="jjv-cardTitle">Command</div>
                  <pre class="jjv-diff mono" style={{ "border-left": "3px solid var(--orange)" }}>{argsLine}</pre>
                </div>
              </Show>

              <Show when={sel().tags.length > 0}>
                <div class="jjv-card">
                  <div class="jjv-cardTitle">Tags ({sel().tags.length})</div>
                  <div class="jjv-files">
                    <For each={sel().tags}>
                      {(tag) => (
                        <div class="jjv-fileRow" style={{ "grid-template-columns": "1fr" }}>
                          <span class="jjv-filePath mono" style={{ color: tag.toLowerCase().startsWith("args:") ? "var(--orange)" : "inherit" }}>
                            {tag}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </>
          );
        }}
      </Show>
    </div>
  );
}
