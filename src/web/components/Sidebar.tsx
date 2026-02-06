import { For, Show, createMemo } from "solid-js";
import { actions, selectedNode, state } from "../../core/state";
import { webActions, webState } from "../../core/state-web";

export function Sidebar(props: {
  diffText: string;
  onMergeSelected: () => void;
  onExecuteOp: () => void;
  onDescribeSubmit: () => void;
  onRunMutation: (kind: "new" | "edit" | "describe" | "rebase" | "abandon" | "duplicate" | "undo" | "redo") => void;
}) {
  const node = createMemo(() => selectedNode());
  const isMulti = createMemo(() => state.selectedIds.size > 1);

  const filesState = createMemo(() => {
    const n = node();
    if (!n) {
      return {
        status: "none" as const,
        files: [] as Array<{ type: string; path: string }>,
      };
    }
    const entry = state.filesCache.get(n.changeId);
    if (!entry) {
      return {
        status: "loading" as const,
        files: [] as Array<{ type: string; path: string }>,
      };
    }
    return {
      status: "ready" as const,
      files: entry.files,
    };
  });

  const fileCounts = createMemo(() => {
    const files = filesState().files;
    let a = 0, m = 0, d = 0;
    for (const f of files) {
      if (f.type === "A") a++;
      else if (f.type === "D") d++;
      else m++;
    }
    return { a, m, d, total: files.length };
  });

  const headerId = createMemo(() => {
    const n = node();
    if (!n) return "";
    return `${n.changeId.slice(0, 12)}${n.isWorkingCopy ? "  (@)" : ""}`;
  });

  const badge = (kind: "bookmark" | "branch" | "conflict" | "empty" | "wc") => {
    if (kind === "bookmark") return "jjv-badge jjv-badge--bookmark";
    if (kind === "branch") return "jjv-badge jjv-badge--branch";
    if (kind === "conflict") return "jjv-badge jjv-badge--conflict";
    if (kind === "empty") return "jjv-badge jjv-badge--empty";
    return "jjv-badge jjv-badge--wc";
  };

  const actionPills = createMemo(() => {
    const n = node();
    if (!n) return [] as Array<{ label: string; kind: Parameters<typeof props.onRunMutation>[0] }>;
    const items: Array<{ label: string; kind: Parameters<typeof props.onRunMutation>[0] }> = [
      { label: "Edit", kind: "edit" },
      { label: "New", kind: "new" },
      { label: "Desc", kind: "describe" },
      { label: "Rebase", kind: "rebase" },
      { label: "Undo", kind: "undo" },
      { label: "Redo", kind: "redo" },
    ];
    return items;
  });

  const diffSections = createMemo(() => {
    const text = (props.diffText || "").trim();
    if (!text) return [] as Array<{ title: string; body: string; lines: string[]; added: number; removed: number }>;
    const parts = text.split(/\ndiff --git /g);
    const sections: Array<{ title: string; body: string; lines: string[]; added: number; removed: number }> = [];
    for (let i = 0; i < parts.length; i++) {
      const chunk = parts[i];
      if (!chunk) continue;
      const full = i === 0 ? chunk : `diff --git ${chunk}`;
      const firstLine = full.split("\n")[0] || "diff";
      const match = firstLine.match(/^diff --git a\/(.+) b\/(.+)$/);
      const lines = full.split("\n");
      let added = 0;
      let removed = 0;
      for (const line of lines) {
        if (line.startsWith("+") && !line.startsWith("+++")) added++;
        if (line.startsWith("-") && !line.startsWith("---")) removed++;
      }
      let title = firstLine;
      if (match) {
        const [, leftPath, rightPath] = match;
        title = leftPath === rightPath ? rightPath : `${rightPath} (renamed)`;
      }
      sections.push({ title, body: full, lines, added, removed });
    }
    return sections;
  });

  const lineClass = (line: string) => {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) return "jjv-diffLine jjv-diffLine--file";
    if (line.startsWith("+") && !line.startsWith("+++")) return "jjv-diffLine jjv-diffLine--add";
    if (line.startsWith("-") && !line.startsWith("---")) return "jjv-diffLine jjv-diffLine--del";
    if (line.startsWith("@@")) return "jjv-diffLine jjv-diffLine--hunk";
    if (line.startsWith("diff --git")) return "jjv-diffLine jjv-diffLine--meta";
    if (line.startsWith("index ")) return "jjv-diffLine jjv-diffLine--meta";
    return "jjv-diffLine";
  };

  return (
    <div class="jjv-inspector">
      <div class="jjv-panelHeader">
        <div class="jjv-panelTitle">
          <span class="mono">{headerId() || "Inspector"}</span>
        </div>
        <Show when={node()}>
          <div class="jjv-panelActions">
              <button class="jjv-btn jjv-btn--ghost" onClick={() => webActions.toggleHelp()}>
              {webState.showHelp ? "Close" : "Help"}
              </button>
          </div>
        </Show>
      </div>

      <Show when={webState.showHelp}>
        <div class="jjv-card">
          <div class="jjv-cardTitle">Help</div>
          <div class="jjv-muted">Keyboard</div>
          <div class="mono" style={{ "font-size": "12px", "line-height": "1.5" }}>
            j/k or ArrowUp/ArrowDown  navigate
            <br />
            1-5            layout
            <br />
            r              refresh
            <br />
            f              inline files
            <br />
            n/e/d          new/edit/describe
            <br />
            b              rebase (select src, then dest)
            <br />
            i              insert after selected
            <br />
            u              undo
            <br />
            h              toggle help
            <br />
            Esc            cancel modes
          </div>
          <div class="jjv-muted" style={{ "margin-top": "10px" }}>Mouse</div>
          <div class="mono" style={{ "font-size": "12px", "line-height": "1.5" }}>
            Shift/Ctrl click   multi-select
            <br />
            Alt+drag node      move/pin
            <br />
            Right-click node   pin/unpin
            <br />
            Alt+click line     insert between
          </div>
        </div>
      </Show>

      <Show
        when={!isMulti()}
        fallback={
          <div class="jjv-card">
            <div class="jjv-cardTitle">Multi-select</div>
            <div class="jjv-muted">{state.selectedIds.size} commits selected</div>
            <button class="jjv-btn jjv-btn--primary" onClick={props.onMergeSelected}>
              Merge (octopus)
            </button>
            <div class="jjv-list" style={{ "margin-top": "10px" }}>
              <For each={Array.from(state.selectedIds)}>
                {(id) => <div class="jjv-listItem mono">{id.slice(0, 12)}</div>}
              </For>
            </div>
          </div>
        }
      >
        <Show when={node()} fallback={<div class="jjv-muted">No commit selected</div>}>
          {(n) => (
            <>
              <div class="jjv-card">
                <div class="jjv-row jjv-row--wrap" style={{ "justify-content": "space-between" }}>
                  <div class="mono" style={{ "font-weight": "700" }}>{n().changeId}</div>
                  <div class="mono jjv-muted">{n().commitId.slice(0, 12)}</div>
                </div>

                <div class="jjv-row jjv-row--wrap" style={{ "margin-top": "8px" }}>
                  <Show when={n().isWorkingCopy}>
                    <span class={badge("wc")}>@</span>
                  </Show>
                  <Show when={n().isConflict}>
                    <span class={badge("conflict")}>conflict</span>
                  </Show>
                  <Show when={n().isEmpty}>
                    <span class={badge("empty")}>empty</span>
                  </Show>
                  <For each={n().bookmarks}>{(b) => <span class={badge("bookmark")}>{b}</span>}</For>
                  <For each={n().gitBranches}>{(b) => <span class={badge("branch")}>{b}</span>}</For>
                </div>

                <div class="jjv-row jjv-row--wrap" style={{ "margin-top": "10px" }}>
                  <For each={actionPills()}>
                    {(a) => (
                      <button class="jjv-btn jjv-btn--ghost" onClick={() => props.onRunMutation(a.kind)}>
                        {a.label}
                      </button>
                    )}
                  </For>
                </div>

                <div class="jjv-kv" style={{ "margin-top": "10px" }}>
                  <div class="jjv-kvRow">
                    <div class="jjv-k">Author</div>
                    <div class="jjv-v">{n().author}</div>
                  </div>
                  <div class="jjv-kvRow">
                    <div class="jjv-k">Time</div>
                    <div class="jjv-v">{n().time}</div>
                  </div>
                </div>

                <div class="jjv-desc" style={{ "margin-top": "10px" }}>
                  {n().descriptionFull || "(no description)"}
                </div>

                <div class="jjv-cardTitle" style={{ "margin-top": "10px" }}>
                  Changes
                  <span class="jjv-muted">
                    {fileCounts().total > 0 ? `  (A${fileCounts().a} M${fileCounts().m} D${fileCounts().d})` : ""}
                  </span>
                </div>
                <Show
                  when={filesState().status === "ready"}
                  fallback={<div class="jjv-muted">(loading files...)</div>}
                >
                  <Show
                    when={filesState().files.length > 0}
                    fallback={<div class="jjv-muted">(no changes)</div>}
                  >
                    <div class="jjv-files">
                      <For each={filesState().files.slice(0, 6)}>
                        {(f) => (
                          <div class="jjv-fileRow" style={{ "grid-template-columns": "18px 1fr" }}>
                            <span class={`jjv-fileType jjv-fileType--${f.type} mono`}>{f.type}</span>
                            <span class="jjv-filePath mono">
                              {f.path.split("/").pop() || f.path}
                            </span>
                          </div>
                        )}
                      </For>
                      <Show when={filesState().files.length > 6}>
                        <div class="jjv-muted mono">+{filesState().files.length - 6} more</div>
                      </Show>
                    </div>
                  </Show>
                </Show>
              </div>

              <div class="jjv-card">
                <div class="jjv-cardTitle">Quick Actions</div>
                <Show when={!state.describeMode}>
                  <div class="jjv-row jjv-row--wrap" style={{ "margin-top": "10px" }}>
                    <button class="jjv-btn jjv-btn--primary" onClick={() => props.onRunMutation("describe")}>Edit</button>
                    <button class="jjv-btn" onClick={() => props.onRunMutation("rebase")}>Rebase</button>
                    <button class="jjv-btn" onClick={() => props.onRunMutation("abandon")}>Abandon</button>
                    <button class="jjv-btn" onClick={() => props.onRunMutation("duplicate")}>Dupe</button>
                  </div>
                </Show>

                <Show when={state.describeMode}>
                  <div style={{ "margin-top": "10px" }}>
                    <textarea
                      class="jjv-textarea mono"
                      value={state.describeValue}
                      onInput={(e) => actions.updateDescribeValue(e.currentTarget.value)}
                      rows={6}
                    />
                    <div class="jjv-row" style={{ "margin-top": "8px" }}>
                      <button class="jjv-btn jjv-btn--primary" onClick={props.onDescribeSubmit}>Save</button>
                      <button class="jjv-btn" onClick={() => actions.cancelDescribe()}>Cancel</button>
                    </div>
                  </div>
                </Show>
              </div>

              <div class="jjv-card">
                <div class="jjv-cardTitle">Operations</div>
                <Show when={webState.opMode === "none"}>
                  <div class="jjv-row jjv-row--wrap">
                    <button class="jjv-btn" onClick={() => webActions.setOpMode("split")}>Split</button>
                    <button class="jjv-btn" onClick={() => webActions.setOpMode("squash")}>Squash</button>
                    <button class="jjv-btn" onClick={() => webActions.setOpMode("move")}>Move</button>
                  </div>
                </Show>
                <Show when={webState.opMode !== "none"}>
                  <div class="jjv-muted">
                    {webState.opMode === "split" ? "Select files to split" : webState.opMode === "squash" ? "Select files to squash (or none for all)" : webState.opTargetId ? `Move target: ${webState.opTargetId.slice(0, 8)}` : "Click a target node in graph"}
                  </div>
                  <div class="jjv-row" style={{ "margin-top": "8px" }}>
                    <button class="jjv-btn jjv-btn--primary" onClick={props.onExecuteOp}>Confirm</button>
                    <button class="jjv-btn" onClick={() => webActions.resetOpMode()}>Cancel</button>
                  </div>
                </Show>
              </div>

              <div class="jjv-card">
                <div class="jjv-cardTitle">Files</div>
                <Show when={filesState().files.length > 0} fallback={<div class="jjv-muted">(no changes)</div>}>
                  <div class="jjv-files">
                    <For each={filesState().files}>
                      {(f) => (
                        <label class="jjv-fileRow">
                          <input
                            type="checkbox"
                            disabled={webState.opMode === "none"}
                            checked={webState.opSelectedPaths.has(f.path)}
                            onChange={() => webActions.toggleOpFile(f.path)}
                            style={{ opacity: webState.opMode === "none" ? 0.2 : 1 }}
                          />
                          <span class={`jjv-fileType jjv-fileType--${f.type} mono`}>{f.type}</span>
                          <span class="jjv-filePath mono">{f.path}</span>
                        </label>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              <div class="jjv-card">
                <div class="jjv-cardTitle">Diff by File</div>
                <Show when={diffSections().length > 0} fallback={<pre class="jjv-diff mono">{props.diffText || "(loading...)"}</pre>}>
                  <div class="jjv-files">
                    <For each={diffSections()}>
                      {(section, index) => (
                        <details class="jjv-diffSection" open={index() === 0}>
                          <summary class="jjv-diffSummary mono">
                            <span>{section.title}</span>
                            <span class="jjv-diffSummaryMeta">+{section.added} -{section.removed}</span>
                          </summary>
                          <pre class="jjv-diff mono">
                            <For each={section.lines}>
                              {(line) => <div class={lineClass(line)}>{line || " "}</div>}
                            </For>
                          </pre>
                        </details>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}
