// Allow Bun globals in this TypeScript file
declare const Bun: any;

// Make this a module to allow top-level await
export {};

import solidDomPlugin from "./src/web/bun-plugin-solid-dom";

// CLI Arguments
const args = {
    port: parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || process.env.PORT || '3000'),
    noOpen: process.argv.includes('--no-open') || process.argv.includes('-n'),
    help: process.argv.includes('--help') || process.argv.includes('-h')
};

// Show help
if (args.help) {
    console.log(`
jj-viz - High-performance Canvas visualization for Jujutsu VCS

Usage: bun run server.ts [options]

Options:
  --port=<num>   Port to run server on (default: 3000)
  -n, --no-open  Don't auto-open browser
  -h, --help     Show this help message

Examples:
  bun run server.ts              # Start on port 3000, auto-open browser
  bun run server.ts --port=8080  # Start on port 8080
  bun run server.ts -n           # Start without opening browser
`);
    process.exit(0);
}

// Find JJ repository root by walking up directory tree
async function findJJRoot(startDir: string): Promise<string | null> {
    let current = startDir;
    while (true) {
        const jjDir = `${current}/.jj`;
        try {
            await Bun.file(jjDir).stat();
            return current;
        } catch {
            const parent = current.substring(0, current.lastIndexOf('/'));
            if (!parent || parent === current) return null;
            current = parent;
        }
    }
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

const JJ_TEMPLATE = `change_id.short() ++ "§" ++ commit_id.short() ++ "§" ++ parents.map(|p| p.change_id().short()).join(",") ++ "§" ++ author.email() ++ "§" ++ author.timestamp() ++ "§" ++ bookmarks.join(",") ++ "§" ++ description.first_line() ++ "§" ++ description ++ "§" ++ empty ++ "§" ++ conflict ++ "§" ++ hidden ++ "§" ++ root ++ "§<JJ-SEP>§"`;

// Git branch cache
let gitBranchCache = new Map<string, string[]>();
let lastGitBranchFetch = 0;

async function getWorkingCopyId(): Promise<string> {
  const proc = Bun.spawn(["jj", "log", "--no-graph", "-r", "@", "-T", "change_id.short()"], {
    cwd: PROC_CWD,
    stderr: "pipe"
  });
  return await new Response(proc.stdout).text();
}

async function getJJLog(limit = 500) {
  console.log("Fetching JJ log...");

  const now = Date.now();
  if (now - lastGitBranchFetch > 5000) {
    gitBranchCache = await getGitBranches();
    lastGitBranchFetch = now;
  }

  const [logText, wcId] = await Promise.all([
    (async () => {
      const proc = Bun.spawn(["jj", "log", "--no-graph", "-r", "::", "--limit", String(limit), "-T", JJ_TEMPLATE], {
        cwd: PROC_CWD,
        stderr: "pipe",
      });
      return await new Response(proc.stdout).text();
    })(),
    getWorkingCopyId()
  ]);

  const cleanWcId = wcId.trim();

  return logText.split("§<JJ-SEP>§").map(block => block.trim()).filter(Boolean).map(block => {
    const parts = block.split("§");
    if (parts.length < 12) {
      console.log("Skipping malformed block:", block.substring(0, 50));
      return null;
    }

    const changeId = parts[0];
    const commitId = parts[1];
    const parents = parts[2];
    const author = parts[3];
    const time = parts[4];
    const bookmarks = parts[5];
    const descTitle = parts[6];

    const root = parts[parts.length-1];
    const hidden = parts[parts.length-2];
    const conflict = parts[parts.length-3];
    const empty = parts[parts.length-4];

    const descFull = parts.slice(7, parts.length-4).join("§");

    const shortCommitId = commitId.trim();
    const gitBranches = gitBranchCache.get(shortCommitId) || [];

    return {
      changeId: changeId.trim(),
      commitId: commitId.trim(),
      parents: parents ? parents.split(",").filter((p: string) => p.trim()) : [],
      author: author.trim(),
      time: time.trim(),
      bookmarks: bookmarks ? bookmarks.split(",").filter((b: string) => b.trim()) : [],
      gitBranches: gitBranches,
      descriptionTitle: descTitle.trim(),
      descriptionFull: descFull.trim(),
      isEmpty: empty.trim() === "true",
      isConflict: conflict.trim() === "true",
      isHidden: hidden.trim() === "true",
      isRoot: root.trim() === "true",
      isWorkingCopy: changeId.trim() === cleanWcId
    };
  }).filter(Boolean);
}

async function getDiff(changeId: string): Promise<string> {
  const proc = Bun.spawn(["jj", "diff", "--git", "-r", changeId], {
    cwd: PROC_CWD,
    stderr: "pipe",
  });
  return await new Response(proc.stdout).text();
}

async function getGitBranches(): Promise<Map<string, string[]>> {
  const proc = Bun.spawn(["git", "for-each-ref", "--format=%(objectname:short) %(refname:short)", "refs/heads"], {
    cwd: PROC_CWD,
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();

  const commitBranches = new Map<string, string[]>();

  output.trim().split("\n").forEach((line: string) => {
    const [commitId, branchName] = line.split(" ");
    if (commitId && branchName) {
      if (!commitBranches.has(commitId)) {
        commitBranches.set(commitId, [] as string[]);
      }
      commitBranches.get(commitId)!.push(branchName);
    }
  });

  return commitBranches;
}

async function getFiles(changeId: string): Promise<Array<{ type: string; path: string }>> {
  const proc = Bun.spawn(["jj", "diff", "--summary", "-r", changeId], {
    cwd: PROC_CWD,
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  
  return output.trim().split("\n").filter(Boolean).map((line: string) => {
    const [type, ...pathParts] = line.split(" ");
    return { type, path: pathParts.join(" ") };
  });
}

const server = Bun.serve({
  port: args.port,
  async fetch(req: Request) {
    const url = new URL(req.url);
    
    // API Endpoints
    if (url.pathname === "/api/log") {
      try {
        const limitRaw = url.searchParams.get("limit");
        const limit = Math.max(1, Math.min(2000, Number(limitRaw || "500") || 500));
        const data = await getJJLog(limit);
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

    if (url.pathname.startsWith("/api/diff/")) {
      const id = url.pathname.split("/").pop();
      if (!id) return new Response("Missing id", { status: 400 });
      try {
        const diff = await getDiff(id);
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
        const files = await getFiles(id);
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
          const args: string[] = ["jj", "new"];
          if (Array.isArray(parentIds) && parentIds.length > 0) {
            args.push(...parentIds);
            console.log("Creating new commit from parents", parentIds);
          } else if (parentId) {
            args.push(parentId);
            console.log("Creating new commit from", parentId);
          }
          const proc = Bun.spawn(args, { cwd: PROC_CWD });
          await proc.exited;
          return Response.json({ success: true });
        }
        
        case "/api/edit": {
          const { changeId } = body;
          console.log("Editing revision (checkout)", changeId);
          const proc = Bun.spawn(["jj", "edit", changeId], { cwd: PROC_CWD });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            return Response.json({ error: stderr }, { status: 400 });
          }
          return Response.json({ success: true });
        }
        
        case "/api/describe": {
          const { changeId, description } = body;
          console.log("Describing", changeId, description);
          const proc = Bun.spawn(["jj", "describe", "-r", changeId, "-m", description], { cwd: PROC_CWD });
          await proc.exited;
          return Response.json({ success: true });
        }
        
        case "/api/abandon": {
          const { changeId } = body;
          console.log("Abandoning revision", changeId);
          const proc = Bun.spawn(["jj", "abandon", changeId], { cwd: PROC_CWD });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            return Response.json({ error: stderr }, { status: 400 });
          }
          return Response.json({ success: true });
        }
        
        case "/api/squash": {
          const { changeId, into, intoId, paths } = body;
          const target = into || intoId;
          console.log("Squashing", changeId, "into", target || "parent", Array.isArray(paths) ? `(${paths.length} files)` : "");
          const args: string[] = ["jj", "squash", "--use-destination-message"]; 
          if (target) {
            args.push("--from", changeId, "--into", target);
          } else {
            // Match legacy behavior: squash the revision into its parent.
            args.push("-r", changeId);
          }
          if (Array.isArray(paths) && paths.length > 0) args.push(...paths);
          const proc = Bun.spawn(args, { cwd: PROC_CWD });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            return Response.json({ error: stderr }, { status: 400 });
          }
          return Response.json({ success: true });
        }

        case "/api/move": {
          const { sourceId, destinationId } = body;
          console.log("Moving (rebase)", sourceId, "onto", destinationId);
          const proc = Bun.spawn(["jj", "rebase", "-s", sourceId, "-d", destinationId], {
            cwd: PROC_CWD,
            stderr: "pipe",
          });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            return Response.json({ error: stderr }, { status: 400 });
          }
          return Response.json({ success: true });
        }

        case "/api/insert": {
          const { afterId, parentId, childId } = body;
          if (afterId) {
            console.log("Inserting new commit after", afterId);
            const proc = Bun.spawn(["jj", "new", afterId], { cwd: PROC_CWD, stderr: "pipe" });
            const exitCode = await proc.exited;
            if (exitCode !== 0) {
              const stderr = await new Response(proc.stderr).text();
              return Response.json({ error: stderr }, { status: 400 });
            }
            return Response.json({ success: true });
          }
          if (parentId && childId) {
            console.log("Inserting new commit between", parentId, "and", childId);
            const proc1 = Bun.spawn(["jj", "new", parentId], { cwd: PROC_CWD, stderr: "pipe" });
            const exit1 = await proc1.exited;
            if (exit1 !== 0) {
              const stderr = await new Response(proc1.stderr).text();
              return Response.json({ error: stderr }, { status: 400 });
            }
            const proc2 = Bun.spawn(["jj", "rebase", "-s", childId, "-d", "@"], { cwd: PROC_CWD, stderr: "pipe" });
            const exit2 = await proc2.exited;
            if (exit2 !== 0) {
              const stderr = await new Response(proc2.stderr).text();
              return Response.json({ error: stderr }, { status: 400 });
            }
            return Response.json({ success: true });
          }
          return Response.json({ error: "Missing afterId or (parentId, childId)" }, { status: 400 });
        }

        case "/api/split": {
          const { changeId, paths, message } = body;
          if (!changeId) return Response.json({ error: "Missing changeId" }, { status: 400 });
          if (!Array.isArray(paths) || paths.length === 0) {
            return Response.json({ error: "Missing paths" }, { status: 400 });
          }
          const msg = typeof message === "string" && message.trim() ? message.trim() : "split";
          console.log("Splitting", changeId, `(${paths.length} files)`);
          const proc = Bun.spawn(["jj", "split", "-r", changeId, "-m", msg, ...paths], { cwd: PROC_CWD, stderr: "pipe" });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            return Response.json({ error: stderr }, { status: 400 });
          }
          return Response.json({ success: true });
        }
        
        case "/api/duplicate": {
          const { changeId } = body;
          console.log("Duplicating", changeId);
          const proc = Bun.spawn(["jj", "duplicate", changeId], { cwd: PROC_CWD });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            return Response.json({ error: stderr }, { status: 400 });
          }
          return Response.json({ success: true });
        }
        
        case "/api/rebase": {
          const { sourceId, destinationId } = body;
          console.log("Rebasing", sourceId, "onto", destinationId);
          const proc = Bun.spawn(["jj", "rebase", "-s", sourceId, "-d", destinationId], {
            cwd: PROC_CWD,
            stderr: "pipe"
          });
          const exitCode = await proc.exited;
          if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text();
            return Response.json({ error: stderr }, { status: 400 });
          }
          return Response.json({ success: true });
        }
        
        case "/api/undo": {
          console.log("Undoing");
          const proc = Bun.spawn(["jj", "undo"], { cwd: PROC_CWD });
          await proc.exited;
          return Response.json({ success: true });
        }
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
          entrypoints: [`${SCRIPT_DIR}/src/web/App.tsx`],
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

if (!args.noOpen) {
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
    console.log(`🌐 Browser auto-open disabled. Visit ${url}`);
}
