import { applyRuntimeConfig, getRuntimeConfig } from "../core/runtime-config";

function applyWebCssVars() {
  const t = getRuntimeConfig().uiTokens;
  const root = document.documentElement;
  root.style.setProperty("--bg", t.slate.bg0);
  root.style.setProperty("--panel", t.slate.panel);
  root.style.setProperty("--panel2", t.slate.panelElevated);
  root.style.setProperty("--surface", t.slate.bg1);
  root.style.setProperty("--surface-2", t.slate.bg2);
  root.style.setProperty("--text", t.slate.text);
  root.style.setProperty("--muted", t.slate.textMuted);
  root.style.setProperty("--border", t.slate.borderSoft);
  root.style.setProperty("--border2", t.slate.borderStrong);
  root.style.setProperty("--success", t.semantic.success);
  root.style.setProperty("--warn", t.semantic.warn);
  root.style.setProperty("--error", t.semantic.error);
  root.style.setProperty("--info", t.semantic.info);
  root.style.setProperty("--file-add", t.semantic.fileAdd);
  root.style.setProperty("--file-mod", t.semantic.fileMod);
  root.style.setProperty("--file-del", t.semantic.fileDel);
}

async function boot() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (response.ok) {
      const cfg = await response.json();
      applyRuntimeConfig(cfg);
      applyWebCssVars();
    }
  } catch {
    // Fall back to built-in defaults.
  }

  await import("./App");
}

void boot();
