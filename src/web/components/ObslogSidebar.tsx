import { Show, createMemo, For } from "solid-js";
import type { ObslogEntry } from "../../core/jj-api";

export function ObslogSidebar(props: {
  entries: ObslogEntry[];
  changeId: string | null;
  selectedIndex: number;
  onRefresh: () => void;
}) {
  const selected = createMemo(() => {
    const idx = Math.max(0, Math.min(props.selectedIndex, Math.max(0, props.entries.length - 1)));
    return props.entries[idx] || null;
  });

  // Extract args from operation tags
  const getArgsFromTags = (tags: string[]): string | null => {
    const argsTag = tags.find((t) => t.toLowerCase().startsWith("args:"));
    return argsTag || null;
  };

  const formatTime = (timeStr: string) => {
    try {
      const date = new Date(timeStr);
      if (Number.isNaN(date.getTime())) return timeStr;
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
          <span class="mono">Obslog</span>
        </div>
        <div class="jjv-panelActions">
          <button class="jjv-btn jjv-btn--ghost" disabled={!props.changeId} onClick={props.onRefresh}>Refresh</button>
        </div>
      </div>

      <div class="jjv-card">
        <div class="jjv-cardTitle">Context</div>
        <div class="jjv-kv">
          <div class="jjv-kvRow">
            <div class="jjv-k">Change</div>
            <div class="jjv-v mono">{props.changeId || "(none)"}</div>
          </div>
          <div class="jjv-kvRow">
            <div class="jjv-k">Versions</div>
            <div class="jjv-v">{props.entries.length}</div>
          </div>
        </div>
        <div class="jjv-muted" style={{ "margin-top": "10px" }}>
          Keyboard: j/k (navigate), PageUp/PageDown (jump), r (refresh), g/Esc (back)
        </div>
      </div>

      <Show when={selected()} fallback={<div class="jjv-muted">Select a version</div>}>
        {(sel) => {
          const argsLine = getArgsFromTags(sel().operationTags);
          return (
            <>
              <div class="jjv-card">
                <div class="jjv-cardTitle">Selected Version</div>
                <div class="jjv-row jjv-row--wrap" style={{ "margin-bottom": "10px" }}>
                  <Show when={sel().isWorkingCopy}>
                    <span class="jjv-badge jjv-badge--wc">@ Working Copy</span>
                  </Show>
                  <Show when={sel().isHidden}>
                    <span class="jjv-badge jjv-badge--empty">hidden</span>
                  </Show>
                  <Show when={sel().isConflict}>
                    <span class="jjv-badge jjv-badge--conflict">conflict</span>
                  </Show>
                  <Show when={sel().isEmpty}>
                    <span class="jjv-badge jjv-badge--empty">empty</span>
                  </Show>
                </div>
                <div class="jjv-row jjv-row--wrap" style={{ "justify-content": "space-between" }}>
                  <div class="mono" style={{ "font-weight": "700", color: "var(--cyan)" }}>{sel().changeId}</div>
                  <div class="mono jjv-muted">{sel().commitId}</div>
                </div>
                <div class="jjv-kv" style={{ "margin-top": "10px" }}>
                  <div class="jjv-kvRow">
                    <div class="jjv-k">Author</div>
                    <div class="jjv-v">{sel().author}</div>
                  </div>
                  <div class="jjv-kvRow">
                    <div class="jjv-k">Time</div>
                    <div class="jjv-v">{formatTime(sel().time)}</div>
                  </div>
                </div>
              </div>

              <div class="jjv-card">
                <div class="jjv-cardTitle">Operation</div>
                <div class="jjv-kv">
                  <div class="jjv-kvRow">
                    <div class="jjv-k">Op ID</div>
                    <div class="jjv-v mono" style={{ color: "var(--cyan)" }}>{sel().operationId}</div>
                  </div>
                  <div class="jjv-kvRow">
                    <div class="jjv-k">User</div>
                    <div class="jjv-v">{sel().operationUser}</div>
                  </div>
                  <div class="jjv-kvRow">
                    <div class="jjv-k">Duration</div>
                    <div class="jjv-v mono">{sel().operationDuration}</div>
                  </div>
                </div>
                <pre class="jjv-diff mono" style={{ "margin-top": "10px" }}>
                  {sel().operationDescriptionFull || sel().operationDescription || "(no operation description)"}
                </pre>
                <Show when={argsLine}>
                  <div class="jjv-cardTitle" style={{ "margin-top": "10px" }}>Command</div>
                  <pre class="jjv-diff mono" style={{ "border-left": "3px solid var(--orange)" }}>{argsLine}</pre>
                </Show>
                <Show when={sel().operationTags.length > 0}>
                  <div class="jjv-cardTitle" style={{ "margin-top": "10px" }}>Operation Tags</div>
                  <div class="jjv-files">
                    <For each={sel().operationTags}>
                      {(tag) => (
                        <div class="jjv-fileRow" style={{ "grid-template-columns": "1fr" }}>
                          <span class="jjv-filePath mono" style={{ color: tag.toLowerCase().startsWith("args:") ? "var(--orange)" : "inherit" }}>
                            {tag}
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              <div class="jjv-card">
                <div class="jjv-cardTitle">Description</div>
                <pre class="jjv-diff mono">{sel().descriptionFull || sel().descriptionTitle || "(no description)"}</pre>
              </div>
            </>
          );
        }}
      </Show>
    </div>
  );
}
