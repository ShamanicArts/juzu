const $ = (selector) => document.querySelector(selector);

const elements = {
  app: $("#app"),
  canvas: $("#graph-canvas"),
  repoName: $("#repo-name"),
  revsetForm: $("#revset-form"),
  revsetInput: $("#revset-input"),
  layoutMode: $("#layout-mode"),
  historyLimit: $("#history-limit"),
  refreshButton: $("#refresh-button"),
  graphLoading: $("#graph-loading"),
  graphEmpty: $("#graph-empty"),
  clearRevset: $("#clear-revset"),
  zoomOut: $("#zoom-out"),
  zoomIn: $("#zoom-in"),
  focusSelection: $("#focus-selection"),
  connectionStatus: $("#connection-status"),
  liveDot: $("#live-dot"),
  graphCount: $("#graph-count"),
  zoomLevel: $("#zoom-level"),
  inspectorEmpty: $("#inspector-empty"),
  inspectorContent: $("#inspector-content"),
  copyChangeId: $("#copy-change-id"),
  changeId: $("#change-id"),
  stateBadges: $("#state-badges"),
  changeTitle: $("#change-title"),
  changeDescription: $("#change-description"),
  commitId: $("#commit-id"),
  changeAuthor: $("#change-author"),
  changeTime: $("#change-time"),
  bookmarksRow: $("#bookmarks-row"),
  changeBookmarks: $("#change-bookmarks"),
  filesTab: $("#files-tab"),
  diffTab: $("#diff-tab"),
  fileCount: $("#file-count"),
  filesPanel: $("#files-panel"),
  diffPanel: $("#diff-panel"),
  filesLoading: $("#files-loading"),
  diffLoading: $("#diff-loading"),
  fileList: $("#file-list"),
  diffView: $("#diff-view"),
  toast: $("#toast"),
};

const state = {
  layout: null,
  selectedId: null,
  activeTab: "files",
  viewport: { x: 18, y: 18, scale: 1 },
  didInitialFocus: false,
  isDragging: false,
  dragStart: null,
  movedDuringDrag: false,
  selectionRequest: 0,
  selectionController: null,
  renderPending: false,
  refreshTimer: null,
  toastTimer: null,
};

const ctx = elements.canvas.getContext("2d");
const styles = getComputedStyle(document.documentElement);
const colors = {
  background: styles.getPropertyValue("--bg-0").trim(),
  selected: styles.getPropertyValue("--bg-2").trim(),
  text: styles.getPropertyValue("--text").trim(),
  soft: styles.getPropertyValue("--text-soft").trim(),
  muted: styles.getPropertyValue("--text-muted").trim(),
  border: styles.getPropertyValue("--border-soft").trim(),
  info: styles.getPropertyValue("--info").trim(),
  warning: styles.getPropertyValue("--warn").trim(),
  error: styles.getPropertyValue("--error").trim(),
  lanes: Array.from({ length: 8 }, (_, index) =>
    styles.getPropertyValue(`--lane-${index}`).trim(),
  ),
};

function laneColor(lane) {
  return colors.lanes[(lane ?? 0) % colors.lanes.length];
}

function shortId(value, length = 8) {
  return value ? value.slice(0, length) : "—";
}

function displayTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value || "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function apiUrl(path, params = {}) {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== "" && value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function requestJson(path, params = {}, options = {}) {
  const response = await fetch(apiUrl(path, params), {
    headers: { Accept: "application/json" },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(await responseMessage(response));
  return response.json();
}

async function requestText(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    headers: { Accept: "text/plain" },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(await responseMessage(response));
  return response.text();
}

async function responseMessage(response) {
  try {
    const body = await response.json();
    return body.error || body.message || `${response.status} ${response.statusText}`;
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function showToast(message, kind = "info") {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.kind = kind;
  elements.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function scheduleRender() {
  if (state.renderPending) return;
  state.renderPending = true;
  requestAnimationFrame(() => {
    state.renderPending = false;
    drawGraph();
  });
}

function resizeCanvas() {
  const rect = elements.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (elements.canvas.width !== width || elements.canvas.height !== height) {
    elements.canvas.width = width;
    elements.canvas.height = height;
  }
  scheduleRender();
}

function visibleWorldBounds() {
  const rect = elements.canvas.getBoundingClientRect();
  const { x, y, scale } = state.viewport;
  return {
    left: -x / scale,
    right: (rect.width - x) / scale,
    top: -y / scale,
    bottom: (rect.height - y) / scale,
  };
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.roundRect(x, y, width, height, r);
}

function drawGraph() {
  const ratio = window.devicePixelRatio || 1;
  const rect = elements.canvas.getBoundingClientRect();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  if (!state.layout?.nodes.length) return;

  const { x, y, scale } = state.viewport;
  const bounds = visibleWorldBounds();
  const nodes = state.layout.nodes;
  const byId = new Map(nodes.map((node) => [node.changeId, node]));
  const rowLeft = Math.min(12, bounds.left - 12);
  const rowWidth = Math.max(rect.width / scale + 40, state.layout.textColumnX + 720);

  ctx.save();
  ctx.setTransform(ratio * scale, 0, 0, ratio * scale, ratio * x, ratio * y);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const node of nodes) {
    if (node.changeId !== state.selectedId) continue;
    roundedRect(ctx, rowLeft, node.y - 31, rowWidth, 62, 5);
    ctx.fillStyle = colors.selected;
    ctx.fill();
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1 / scale;
    ctx.stroke();
  }

  for (const node of nodes) {
    if (node.y < bounds.top - 160 || node.y > bounds.bottom + 160) continue;
    for (const parentId of node.parents) {
      const parent = byId.get(parentId);
      if (!parent) continue;
      const startX = node.x;
      const startY = node.y;
      const endX = parent.x;
      const endY = parent.y;
      const bend = Math.max(18, Math.abs(endY - startY) * 0.36);
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.bezierCurveTo(startX, startY + bend, endX, endY - bend, endX, endY);
      ctx.strokeStyle = laneColor(node.lane);
      ctx.globalAlpha = node.isHidden ? 0.32 : 0.72;
      ctx.lineWidth = (node.changeId === state.selectedId ? 2.6 : 1.8) / scale;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  const baseFont = `${12 / Math.max(0.78, scale)}px ${styles.getPropertyValue("--mono")}`;
  for (const node of nodes) {
    if (node.y < bounds.top - 60 || node.y > bounds.bottom + 60) continue;
    const selected = node.changeId === state.selectedId;
    const color = laneColor(node.lane);
    ctx.globalAlpha = node.isHidden ? 0.45 : 1;

    if (node.isWorkingCopy) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, 10, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2 / scale;
      ctx.stroke();
    }

    if (node.isConflict) {
      ctx.save();
      ctx.translate(node.x, node.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = colors.background;
      ctx.strokeStyle = colors.error;
      ctx.lineWidth = 2.2 / scale;
      ctx.fillRect(-6, -6, 12, 12);
      ctx.strokeRect(-6, -6, 12, 12);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(node.x, node.y, selected ? 6.4 : 5.2, 0, Math.PI * 2);
      ctx.fillStyle = selected ? color : colors.background;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 / scale;
      ctx.stroke();
    }

    const textX = state.layout.textColumnX;
    ctx.font = baseFont;
    ctx.textBaseline = "middle";
    ctx.fillStyle = selected ? colors.info : colors.soft;
    ctx.fillText(shortId(node.changeId), textX, node.y - 10);

    ctx.font = `${selected ? 600 : 500} 14px Inter, ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = selected ? colors.text : colors.soft;
    const title = node.descriptionTitle?.trim() || "(no description)";
    ctx.fillText(title.slice(0, 92), textX + 78, node.y - 10);

    ctx.font = `11px ${styles.getPropertyValue("--mono")}`;
    ctx.fillStyle = colors.muted;
    const detail = node.isWorkingCopy ? "working copy" : node.author || "unknown author";
    ctx.fillText(detail.slice(0, 72), textX, node.y + 13);

    let bookmarkX = textX + 78;
    for (const bookmark of node.bookmarks.slice(0, 3)) {
      const width = Math.min(150, ctx.measureText(bookmark).width + 14);
      roundedRect(ctx, bookmarkX, node.y + 4, width, 19, 4);
      ctx.fillStyle = colors.border;
      ctx.fill();
      ctx.fillStyle = colors.text;
      ctx.fillText(bookmark.slice(0, 20), bookmarkX + 7, node.y + 14);
      bookmarkX += width + 6;
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function nodeAt(clientX, clientY) {
  if (!state.layout) return null;
  const rect = elements.canvas.getBoundingClientRect();
  const worldY = (clientY - rect.top - state.viewport.y) / state.viewport.scale;
  let best = null;
  let distance = 34;
  for (const node of state.layout.nodes) {
    const candidate = Math.abs(node.y - worldY);
    if (candidate < distance) {
      distance = candidate;
      best = node;
    }
  }
  return best;
}

function setScale(nextScale, anchorX, anchorY) {
  const previous = state.viewport.scale;
  const scale = Math.min(2, Math.max(0.45, nextScale));
  if (scale === previous) return;
  const worldX = (anchorX - state.viewport.x) / previous;
  const worldY = (anchorY - state.viewport.y) / previous;
  state.viewport.scale = scale;
  state.viewport.x = anchorX - worldX * scale;
  state.viewport.y = anchorY - worldY * scale;
  elements.zoomLevel.textContent = `${Math.round(scale * 100)}%`;
  scheduleRender();
}

function zoomBy(factor) {
  const rect = elements.canvas.getBoundingClientRect();
  setScale(state.viewport.scale * factor, rect.width / 2, rect.height / 2);
}

function focusNode(node, center = true) {
  if (!node || !state.layout) return;
  const rect = elements.canvas.getBoundingClientRect();
  const targetX = Math.min(105, rect.width * 0.14);
  const targetY = center ? rect.height * 0.42 : 64;
  state.viewport.x = targetX - node.x * state.viewport.scale;
  state.viewport.y = targetY - node.y * state.viewport.scale;
  scheduleRender();
}

function badge(label, kind) {
  const item = document.createElement("span");
  item.className = "state-badge";
  item.dataset.kind = kind;
  item.textContent = label;
  return item;
}

function renderInspector(node) {
  if (!node) {
    elements.inspectorEmpty.hidden = false;
    elements.inspectorContent.hidden = true;
    return;
  }

  elements.inspectorEmpty.hidden = true;
  elements.inspectorContent.hidden = false;
  elements.changeId.textContent = shortId(node.changeId, 12);
  elements.changeTitle.textContent = node.descriptionTitle?.trim() || "No description";
  const full = node.descriptionFull?.trim() || "";
  elements.changeDescription.textContent =
    full && full !== node.descriptionTitle ? full : "";
  elements.changeDescription.hidden = !elements.changeDescription.textContent;
  elements.commitId.textContent = shortId(node.commitId, 16);
  elements.commitId.title = node.commitId;
  elements.changeAuthor.textContent = node.author || "—";
  elements.changeTime.textContent = displayTime(node.time);
  elements.changeTime.title = node.time || "";

  elements.stateBadges.replaceChildren();
  if (node.isWorkingCopy) elements.stateBadges.append(badge("Working copy", "working-copy"));
  if (node.isConflict) elements.stateBadges.append(badge("Conflict", "conflict"));
  if (node.isEmpty) elements.stateBadges.append(badge("Empty", "empty"));
  if (node.isHidden) elements.stateBadges.append(badge("Hidden", "hidden"));
  if (node.isRoot) elements.stateBadges.append(badge("Root", "root"));

  const bookmarks = [...node.bookmarks, ...node.gitBranches];
  elements.bookmarksRow.hidden = bookmarks.length === 0;
  elements.changeBookmarks.replaceChildren();
  for (const name of bookmarks) {
    const item = document.createElement("span");
    item.className = "bookmark";
    item.textContent = name;
    elements.changeBookmarks.append(item);
  }
}

async function selectNode(node, options = {}) {
  if (!node) return;
  state.selectedId = node.changeId;
  renderInspector(node);
  scheduleRender();
  if (options.focus) focusNode(node);

  state.selectionRequest += 1;
  const request = state.selectionRequest;
  state.selectionController?.abort();
  state.selectionController = new AbortController();
  const signal = state.selectionController.signal;
  elements.fileList.replaceChildren();
  elements.fileCount.textContent = "";
  elements.filesLoading.hidden = false;
  elements.filesLoading.textContent = "Loading files…";
  elements.diffView.replaceChildren();
  elements.diffLoading.hidden = state.activeTab !== "diff";

  try {
    const files = await requestJson(
      `/changes/${encodeURIComponent(node.changeId)}/files`,
      {},
      { signal },
    );
    if (request !== state.selectionRequest) return;
    renderFiles(files);
  } catch (error) {
    if (error.name !== "AbortError" && request === state.selectionRequest) {
      elements.filesLoading.hidden = false;
      elements.filesLoading.textContent = error.message;
    }
  }

  if (state.activeTab === "diff" && request === state.selectionRequest) {
    await loadDiff(node, request, signal);
  }
}

function renderFiles(files) {
  elements.filesLoading.hidden = true;
  elements.fileCount.textContent = files.length ? String(files.length) : "";
  elements.fileList.replaceChildren();
  if (!files.length) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = "No files changed.";
    elements.fileList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "file-row";
    const status = document.createElement("span");
    status.className = "file-status";
    status.dataset.kind = file.type.toLowerCase();
    status.textContent = file.type.slice(0, 1).toUpperCase();
    const path = document.createElement("span");
    path.className = "file-path";
    path.textContent = file.path;
    path.title = file.path;
    row.append(status, path);
    fragment.append(row);
  }
  elements.fileList.append(fragment);
}

async function loadDiff(node, request = state.selectionRequest, signal = undefined) {
  elements.diffLoading.hidden = false;
  elements.diffLoading.textContent = "Loading diff…";
  elements.diffView.replaceChildren();
  try {
    const text = await requestText(
      `/changes/${encodeURIComponent(node.changeId)}/diff`,
      { signal },
    );
    if (request !== state.selectionRequest) return;
    renderDiff(text);
  } catch (error) {
    if (error.name !== "AbortError" && request === state.selectionRequest) {
      elements.diffLoading.hidden = false;
      elements.diffLoading.textContent = error.message;
    }
  }
}

function diffLineKind(line) {
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  if (line.startsWith("\\ No newline")) return "meta";
  return "context";
}

function renderDiff(text) {
  elements.diffLoading.hidden = true;
  elements.diffView.replaceChildren();
  if (!text.trim()) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = "No textual diff.";
    elements.diffView.append(empty);
    return;
  }

  const allLines = text.split("\n");
  const limit = 5000;
  const fragment = document.createDocumentFragment();
  for (const line of allLines.slice(0, limit)) {
    const row = document.createElement("div");
    row.className = "diff-line";
    row.dataset.kind = diffLineKind(line);
    row.textContent = line || " ";
    fragment.append(row);
  }
  if (allLines.length > limit) {
    const truncated = document.createElement("div");
    truncated.className = "diff-truncated";
    truncated.textContent = `Diff truncated after ${limit.toLocaleString()} lines.`;
    fragment.append(truncated);
  }
  elements.diffView.append(fragment);
}

function setActiveTab(tab) {
  state.activeTab = tab;
  const filesActive = tab === "files";
  elements.filesTab.setAttribute("aria-selected", String(filesActive));
  elements.diffTab.setAttribute("aria-selected", String(!filesActive));
  elements.filesPanel.hidden = !filesActive;
  elements.diffPanel.hidden = filesActive;
  if (!filesActive && !elements.diffView.childNodes.length) {
    const node = state.layout?.nodes.find((item) => item.changeId === state.selectedId);
    if (node) loadDiff(node);
  }
}

function currentParams() {
  return {
    limit: elements.historyLimit.value,
    mode: elements.layoutMode.value,
    revset: elements.revsetInput.value.trim(),
  };
}

async function loadRepository(options = {}) {
  const preserveViewport = options.preserveViewport ?? false;
  const previousSelected = state.selectedId;
  elements.app.setAttribute("aria-busy", "true");
  elements.graphLoading.hidden = false;
  elements.graphEmpty.hidden = true;
  elements.refreshButton.disabled = true;

  try {
    const [repo, layout, count] = await Promise.all([
      requestJson("/repo"),
      requestJson("/layout", currentParams()),
      requestJson("/node-count", { revset: elements.revsetInput.value.trim() }),
    ]);
    state.layout = layout;
    elements.repoName.textContent = repo.workspaceName;
    elements.repoName.title = repo.workspaceRoot;
    const shown = layout.nodes.length;
    elements.graphCount.textContent = `${shown.toLocaleString()} of ${count.count.toLocaleString()} changes`;
    elements.graphEmpty.hidden = shown !== 0;

    if (!shown) {
      state.selectedId = null;
      renderInspector(null);
    } else {
      const selected =
        layout.nodes.find((node) => node.changeId === previousSelected) ||
        layout.nodes.find((node) => node.isWorkingCopy) ||
        layout.nodes[0];
      await selectNode(selected);
      if (!preserveViewport || !state.didInitialFocus) {
        focusNode(selected, false);
        state.didInitialFocus = true;
      }
    }
    scheduleRender();
  } catch (error) {
    showToast(error.message, "error");
    elements.graphCount.textContent = "Unable to load history";
  } finally {
    elements.graphLoading.hidden = true;
    elements.refreshButton.disabled = false;
    elements.app.setAttribute("aria-busy", "false");
  }
}

function moveSelection(delta) {
  if (!state.layout?.nodes.length) return;
  const index = state.layout.nodes.findIndex((node) => node.changeId === state.selectedId);
  const nextIndex = Math.min(
    state.layout.nodes.length - 1,
    Math.max(0, (index < 0 ? 0 : index) + delta),
  );
  selectNode(state.layout.nodes[nextIndex], { focus: true });
}

function connectEvents() {
  const source = new EventSource("/api/v1/events");
  source.addEventListener("ready", () => {
    elements.connectionStatus.textContent = "Live";
    elements.liveDot.dataset.state = "live";
  });
  source.addEventListener("repo-updated", () => {
    elements.connectionStatus.textContent = "Updating";
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(async () => {
      await loadRepository({ preserveViewport: true });
      elements.connectionStatus.textContent = "Live";
      elements.liveDot.dataset.state = "live";
    }, 180);
  });
  source.onerror = () => {
    elements.connectionStatus.textContent = "Reconnecting";
    elements.liveDot.dataset.state = "error";
  };
}

elements.canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  elements.canvas.setPointerCapture(event.pointerId);
  state.isDragging = true;
  state.movedDuringDrag = false;
  state.dragStart = {
    clientX: event.clientX,
    clientY: event.clientY,
    viewportX: state.viewport.x,
    viewportY: state.viewport.y,
  };
  elements.canvas.dataset.dragging = "true";
});

elements.canvas.addEventListener("pointermove", (event) => {
  if (!state.isDragging || !state.dragStart) return;
  const dx = event.clientX - state.dragStart.clientX;
  const dy = event.clientY - state.dragStart.clientY;
  if (Math.abs(dx) + Math.abs(dy) > 4) state.movedDuringDrag = true;
  state.viewport.x = state.dragStart.viewportX + dx;
  state.viewport.y = state.dragStart.viewportY + dy;
  scheduleRender();
});

function endPointer(event) {
  if (!state.isDragging) return;
  if (!state.movedDuringDrag) {
    const node = nodeAt(event.clientX, event.clientY);
    if (node) selectNode(node);
  }
  state.isDragging = false;
  state.dragStart = null;
  delete elements.canvas.dataset.dragging;
}

elements.canvas.addEventListener("pointerup", endPointer);
elements.canvas.addEventListener("pointercancel", endPointer);

elements.canvas.addEventListener("dblclick", (event) => {
  const node = nodeAt(event.clientX, event.clientY);
  if (node) selectNode(node, { focus: true });
});

elements.canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = elements.canvas.getBoundingClientRect();
  const factor = Math.exp(-event.deltaY * 0.0015);
  setScale(
    state.viewport.scale * factor,
    event.clientX - rect.left,
    event.clientY - rect.top,
  );
}, { passive: false });

elements.canvas.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if (key === "j" || event.key === "ArrowDown") {
    event.preventDefault();
    moveSelection(1);
  } else if (key === "k" || event.key === "ArrowUp") {
    event.preventDefault();
    moveSelection(-1);
  } else if (event.key === "Home" && state.layout?.nodes.length) {
    event.preventDefault();
    selectNode(state.layout.nodes[0], { focus: true });
  } else if (event.key === "End" && state.layout?.nodes.length) {
    event.preventDefault();
    selectNode(state.layout.nodes.at(-1), { focus: true });
  } else if (key === "f") {
    event.preventDefault();
    const node = state.layout?.nodes.find((item) => item.changeId === state.selectedId);
    focusNode(node);
  } else if (key === "d") {
    event.preventDefault();
    setActiveTab("diff");
  }
});

elements.revsetForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.didInitialFocus = false;
  loadRepository();
});
elements.layoutMode.addEventListener("change", () => loadRepository({ preserveViewport: true }));
elements.historyLimit.addEventListener("change", () => loadRepository({ preserveViewport: true }));
elements.refreshButton.addEventListener("click", () => loadRepository({ preserveViewport: true }));
elements.clearRevset.addEventListener("click", () => {
  elements.revsetInput.value = "";
  state.didInitialFocus = false;
  loadRepository();
});
elements.zoomOut.addEventListener("click", () => zoomBy(0.82));
elements.zoomIn.addEventListener("click", () => zoomBy(1.22));
elements.focusSelection.addEventListener("click", () => {
  const node = state.layout?.nodes.find((item) => item.changeId === state.selectedId);
  focusNode(node);
});
elements.filesTab.addEventListener("click", () => setActiveTab("files"));
elements.diffTab.addEventListener("click", () => setActiveTab("diff"));
elements.copyChangeId.addEventListener("click", async () => {
  const node = state.layout?.nodes.find((item) => item.changeId === state.selectedId);
  if (!node) return;
  try {
    await navigator.clipboard.writeText(node.changeId);
    showToast("Change ID copied");
  } catch {
    showToast("Clipboard access is unavailable", "error");
  }
});

new ResizeObserver(resizeCanvas).observe(elements.canvas);
resizeCanvas();
connectEvents();
loadRepository();
