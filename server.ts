// Allow Bun globals in this TypeScript file
declare const Bun: any;

// Make this a module to allow top-level await
export {};

import solidDomPlugin from "./src/web/bun-plugin-solid-dom";
import { watch, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAndApplyRuntimeConfig } from "./src/core/config-loader";
import { getRuntimeConfig } from "./src/core/runtime-config";
import {
  fetchJJLogWithGitBranches,
  fetchOpLog,
  fetchObslog,
  findJJRoot,
  jjAbandon,
  jjBookmarkDelete,
  jjBookmarkRename,
  jjBookmarkSet,
  jjBookmarkTrack,
  jjBookmarkUntrack,
  jjCreateNew,
  jjDescribe,
  jjDuplicate,
  jjEdit,
  jjGitFetch,
  jjGitPush,
  jjGetDiff,
  jjGetFiles,
  jjInsertAfter,
  jjMove,
  jjRebase,
  jjRedo,
  jjRestoreOperation,
  jjRestore,
  jjSplit,
  jjSquashPaths,
  jjUndo,
} from "./src/core/jj-api";

// CLI Arguments
const args = {
    port: parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || process.env.PORT || '3000'),
    open: process.argv.includes('--open') || process.argv.includes('-o'),
    help: process.argv.includes('--help') || process.argv.includes('-h'),
    theme: process.argv.find(a => a.startsWith('--theme='))?.split('=')[1] || process.env.JJVIZ_THEME || null,
};

// Show help
if (args.help) {
    console.log(`
jj-viz - High-performance Canvas visualization for Jujutsu VCS

Usage: bun run server.ts [options]

Options:
  --port=<num>   Port to run server on (default: 3000)
  -o, --open     Auto-open browser
  --theme=<name> Theme name (themes/<name>.toml)
  --config=<path> Explicit config TOML file
  -h, --help     Show this help message

Examples:
  bun run server.ts              # Start on port 3000 (no auto-open)
  bun run server.ts --port=8080  # Start on port 8080
  bun run server.ts -o           # Start with opening browser
`);
    process.exit(0);
}

// Resolve working directory
const startDir = process.cwd();
const PROC_CWD = await findJJRoot(startDir);

if (!PROC_CWD) {
    console.error(`❌ No .jj directory found in "${startDir}" or any parent directory.`);
    console.error("   Are you in a JJ repository? Run 'jj init' to create one.");
    process.exit(1);
}

console.log(`📁 JJ Repository: ${PROC_CWD}`);

// Script directory for serving static assets
const SCRIPT_DIR = import.meta.dir;

const resolvedConfig = await resolveAndApplyRuntimeConfig({
  argv: process.argv.slice(2),
  repoRoot: PROC_CWD,
  appDir: SCRIPT_DIR,
});
console.log(`🎨 Theme: ${resolvedConfig.theme.name}`);

type SseEventPayload = {
  type: string;
  ts: number;
  seq: number;
};

const encoder = new TextEncoder();
const sseClients = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
let nextSseClientId = 1;
let eventSeq = 0;

function encodeSseEvent(event: string, payload: SseEventPayload): Uint8Array {
  const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  return encoder.encode(body);
}

function broadcastSse(event: string, payload: Omit<SseEventPayload, "seq">) {
  const message: SseEventPayload = { ...payload, seq: ++eventSeq };
  const chunk = encodeSseEvent(event, message);
  for (const [clientId, controller] of sseClients.entries()) {
    try {
      controller.enqueue(chunk);
    } catch {
      sseClients.delete(clientId);
    }
  }
}

function createSseResponse(req: Request): Response {
  const clientId = nextSseClientId++;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseClients.set(clientId, controller);
      controller.enqueue(encoder.encode(": connected\n\n"));
      controller.enqueue(encodeSseEvent("ready", { type: "ready", ts: Date.now(), seq: ++eventSeq }));

      const onAbort = () => {
        sseClients.delete(clientId);
        try {
          controller.close();
        } catch {
          // stream already closed
        }
      };
      req.signal.addEventListener("abort", onAbort, { once: true });
    },
    cancel() {
      sseClients.delete(clientId);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Connection: "keep-alive",
    },
  });
}

const heartbeatInterval = setInterval(() => {
  broadcastSse("heartbeat", { type: "heartbeat", ts: Date.now() });
}, 25_000);

const watchControllers: AbortController[] = [];
let repoEventDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRepoUpdatedEvent() {
  if (repoEventDebounceTimer) clearTimeout(repoEventDebounceTimer);
  repoEventDebounceTimer = setTimeout(() => {
    broadcastSse("repo-updated", { type: "repo-updated", ts: Date.now() });
  }, 500);
}

function startRepoWatch(path: string, recursive: boolean) {
  const controller = new AbortController();
  watchControllers.push(controller);

  void (async () => {
    try {
      for await (const _event of watch(path, { recursive, signal: controller.signal })) {
        scheduleRepoUpdatedEvent();
      }
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.name === "AbortError") return;
      if (err.code === "ENOENT") return;
      if (recursive) {
        startRepoWatch(path, false);
        return;
      }
      console.error(`Watch error for ${path}:`, e);
    }
  })();
}

const jjDir = `${PROC_CWD}/.jj`;
startRepoWatch(jjDir, true);
startRepoWatch(`${jjDir}/working_copy`, false);
startRepoWatch(`${jjDir}/repo`, false);
startRepoWatch(`${jjDir}/repo/store`, false);
startRepoWatch(`${jjDir}/repo/store/operations`, false);

// Architecture Note: server.ts intentionally stays a thin HTTP adapter.
// The Backend interface is for TUI/Web frontends that need swappable runtime backends.
// The server already is an adapter boundary, so it calls core jj-api helpers directly.
const server = Bun.serve({
  port: args.port,
  async fetch(req: Request) {
    const url = new URL(req.url);
    
    // API Endpoints
    if (url.pathname === "/api/log") {
      try {
        const limitRaw = url.searchParams.get("limit");
        const revsetRaw = url.searchParams.get("revset") || undefined;
        const limit = Math.max(1, Math.min(2000, Number(limitRaw || "500") || 500));
        const data = await fetchJJLogWithGitBranches(PROC_CWD, limit, revsetRaw);
        return new Response(JSON.stringify(data), {
          headers: { 
            "Content-Type": "application/json",
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          }
        });
      } catch (e: unknown) {
        console.error(e);
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: msg }), { status: 500 });
      }
    }

    if (url.pathname === "/api/repo") {
      return new Response(JSON.stringify({ cwd: PROC_CWD }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/api/config") {
      return new Response(JSON.stringify(getRuntimeConfig()), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        },
      });
    }

    if (url.pathname === "/api/events") {
      return createSseResponse(req);
    }

    if (url.pathname.startsWith("/api/diff/")) {
      const id = url.pathname.split("/").pop();
      if (!id) return new Response("Missing id", { status: 400 });
      try {
        const diff = await jjGetDiff(id, PROC_CWD);
        return new Response(diff);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response("Error fetching diff: " + msg, { status: 500 });
      }
    }
    
    if (url.pathname.startsWith("/api/files/")) {
      const id = url.pathname.split("/").pop();
      if (!id) return new Response("Missing id", { status: 400 });
      try {
        const files = await jjGetFiles(id, PROC_CWD);
        return Response.json(files);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response("Error fetching files: " + msg, { status: 500 });
      }
    }

    // Mutations
    if (req.method === "POST") {
      let body: any = {};
      try {
        body = await req.json();
      } catch {
        body = {};
      }
      
      switch (url.pathname) {
        case "/api/new": {
          const { parentId, parentIds } = body;
          try {
            await jjCreateNew(PROC_CWD, { parentId, parentIds });
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }
        
        case "/api/edit": {
          const { changeId } = body;
          try {
            await jjEdit(changeId, PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }
        
        case "/api/describe": {
          const { changeId, description } = body;
          try {
            await jjDescribe(changeId, description, PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }
        
        case "/api/abandon": {
          const { changeId } = body;
          try {
            await jjAbandon(changeId, PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }
        
        case "/api/squash": {
          const { changeId, into, intoId, paths } = body;
          const target = into || intoId;
          try {
            await jjSquashPaths(changeId, {
              intoId: target || null,
              paths: Array.isArray(paths) ? paths : undefined,
            }, PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }

        case "/api/move": {
          const { sourceId, destinationId } = body;
          try {
            await jjMove(sourceId, destinationId, PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }

        case "/api/insert": {
          const { afterId, parentId, childId } = body;
          try {
            if (afterId) {
              await jjCreateNew(PROC_CWD, { parentId: afterId });
              return Response.json({ success: true });
            }
            if (parentId && childId) {
              await jjInsertAfter(parentId, childId, PROC_CWD);
              return Response.json({ success: true });
            }
            return Response.json({ error: "Missing afterId or (parentId, childId)" }, { status: 400 });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }

        case "/api/split": {
          const { changeId, paths, message } = body;
          if (!changeId) return Response.json({ error: "Missing changeId" }, { status: 400 });
          if (!Array.isArray(paths) || paths.length === 0) {
            return Response.json({ error: "Missing paths" }, { status: 400 });
          }
          try {
            await jjSplit(changeId, paths, PROC_CWD, message);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }

        case "/api/restore": {
          const { changeId, paths } = body;
          if (!changeId) return Response.json({ error: "Missing changeId" }, { status: 400 });
          try {
            await jjRestore(changeId, PROC_CWD, Array.isArray(paths) ? paths : undefined);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }

        case "/api/bookmark/set": {
          const { name, revision } = body;
          if (!name || !revision) return Response.json({ error: "Missing name or revision" }, { status: 400 });
          try {
            await jjBookmarkSet(String(name), String(revision), PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }

        case "/api/bookmark/delete": {
          const { name } = body;
          if (!name) return Response.json({ error: "Missing name" }, { status: 400 });
          try {
            await jjBookmarkDelete(String(name), PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }

        case "/api/bookmark/rename": {
          const { oldName, newName } = body;
          if (!oldName || !newName) return Response.json({ error: "Missing oldName or newName" }, { status: 400 });
          try {
            await jjBookmarkRename(String(oldName), String(newName), PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }

        case "/api/bookmark/track": {
          const { remoteBookmark } = body;
          if (!remoteBookmark) return Response.json({ error: "Missing remoteBookmark" }, { status: 400 });
          try {
            await jjBookmarkTrack(String(remoteBookmark), PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }

        case "/api/bookmark/untrack": {
          const { remoteBookmark } = body;
          if (!remoteBookmark) return Response.json({ error: "Missing remoteBookmark" }, { status: 400 });
          try {
            await jjBookmarkUntrack(String(remoteBookmark), PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }

        case "/api/git/fetch": {
          try {
            await jjGitFetch(PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }

        case "/api/git/push": {
          const { bookmark } = body;
          try {
            await jjGitPush(PROC_CWD, typeof bookmark === "string" ? bookmark : undefined);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }
        
        case "/api/duplicate": {
          const { changeId } = body;
          try {
            await jjDuplicate(changeId, PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }
        
        case "/api/rebase": {
          const { sourceId, destinationId } = body;
          try {
            await jjRebase(sourceId, destinationId, PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }
        
        case "/api/undo": {
          try {
            await jjUndo(PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return Response.json({ success: false, error: msg || "Undo failed" }, { status: 500 });
          }
        }

        case "/api/redo": {
          try {
            await jjRedo(PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return Response.json({ success: false, error: msg || "Redo failed" }, { status: 500 });
          }
        }

        case "/api/oplog/restore": {
          const { operationId } = body;
          if (!operationId) return Response.json({ error: "Missing operationId" }, { status: 400 });
          try {
            await jjRestoreOperation(operationId, PROC_CWD);
            return Response.json({ success: true });
          } catch (e) {
            return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
          }
        }
      }
    }

    // GET endpoints for op log and obslog
    if (url.pathname === "/api/oplog") {
      try {
        const limitRaw = url.searchParams.get("limit");
        const limit = Math.max(1, Math.min(500, Number(limitRaw || "100") || 100));
        const entries = await fetchOpLog(PROC_CWD, limit);
        return Response.json(entries);
      } catch (e: unknown) {
        console.error(e);
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ error: msg }, { status: 500 });
      }
    }

    if (url.pathname.startsWith("/api/obslog/")) {
      const changeId = url.pathname.split("/").pop();
      if (!changeId) return new Response("Missing changeId", { status: 400 });
      
      try {
        const limitRaw = url.searchParams.get("limit");
        const limit = Math.max(1, Math.min(100, Number(limitRaw || "50") || 50));
        const entries = await fetchObslog(changeId, PROC_CWD, limit);
        return Response.json(entries);
      } catch (e: unknown) {
        console.error(e);
        const msg = e instanceof Error ? e.message : String(e);
        return Response.json({ error: msg }, { status: 500 });
      }
    }

    // Theme API endpoints
    if (url.pathname === "/api/themes") {
      try {
        const xdg = process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, ".config") : null);
        const themeDirs = [
          join(SCRIPT_DIR, "themes"),
          ...(xdg ? [join(xdg, "jj-viz", "themes")] : []),
          ...(PROC_CWD ? [join(PROC_CWD, ".jj-viz", "themes")] : []),
        ];
        
        const themeNames = new Set<string>();
        for (const dir of themeDirs) {
          try {
            const files = await readdir(dir);
            for (const file of files) {
              if (file.endsWith(".toml")) {
                themeNames.add(file.slice(0, -5));
              }
            }
          } catch {
            // Directory doesn't exist, skip
          }
        }
        
        return Response.json({ themes: Array.from(themeNames).sort() });
      } catch (e: unknown) {
        console.error(e);
        return Response.json({ themes: [] });
      }
    }

    if (url.pathname.startsWith("/api/theme/")) {
      const themeName = url.pathname.split("/").pop();
      if (!themeName) return new Response("Missing theme name", { status: 400 });
      
      try {
        const xdg = process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, ".config") : null);
        const themePaths = [
          ...(PROC_CWD ? [join(PROC_CWD, ".jj-viz", "themes", `${themeName}.toml`)] : []),
          ...(xdg ? [join(xdg, "jj-viz", "themes", `${themeName}.toml`)] : []),
          join(SCRIPT_DIR, "themes", `${themeName}.toml`),
        ];
        
        for (const path of themePaths) {
          try {
            const content = await readFile(path, "utf8");
            const parsed = Bun.TOML.parse(content);
            return Response.json(parsed);
          } catch {
            // File doesn't exist or can't be read, try next
          }
        }
        
        return Response.json({ error: "Theme not found" }, { status: 404 });
      } catch (e: unknown) {
        console.error(e);
        return Response.json({ error: "Error loading theme" }, { status: 500 });
      }
    }

    // Static assets
    if (url.pathname === "/") {
      return new Response(Bun.file(`${SCRIPT_DIR}/public/index.html`));
    }
    
    // Serve web app files
    if (url.pathname === "/web/app.js" || url.pathname.startsWith("/src/")) {
      // In development, we need to bundle the TypeScript
      try {
        const build = await Bun.build({
          entrypoints: [`${SCRIPT_DIR}/src/web/main.ts`],
          target: "browser",
          format: "esm",
          plugins: [solidDomPlugin],
        });
        
        if (!build.success) {
          const errors = build.logs.map(l => l.message).join("\n");
          console.error("Build errors:", errors);
          return new Response(`Build error:\n${errors}`, { status: 500 });
        }
        
        return new Response(build.outputs[0], {
          headers: { "Content-Type": "application/javascript" }
        });
      } catch (e) {
        console.error("Build exception:", e);
        return new Response(`Build error: ${e}`, { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  },
});

const url = `http://localhost:${server.port}`;
console.log(`🚀 jj-viz running at ${url}`);

process.on("exit", () => {
  clearInterval(heartbeatInterval);
  for (const controller of watchControllers) controller.abort();
  if (repoEventDebounceTimer) {
    clearTimeout(repoEventDebounceTimer);
    repoEventDebounceTimer = null;
  }
});

if (args.open) {
    const platform = process.platform;
    const openCommand = platform === 'darwin' ? 'open' :
                       platform === 'win32' ? 'start' : 'xdg-open';
    
    try {
        Bun.spawn([openCommand, url]);
        console.log(`🌐 Opening browser...`);
    } catch (e) {
        console.log(`🌐 Could not auto-open browser. Visit ${url} manually.`);
    }
} else {
    console.log(`🌐 Browser auto-open disabled. Use --open to enable. Visit ${url}`);
}
