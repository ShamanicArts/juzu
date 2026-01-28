// Allow Bun globals in this TypeScript file
declare const Bun: any;

// Make this a module to allow top-level await
export {};

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

// Script directory for serving static assets (allows running from anywhere)
const SCRIPT_DIR = import.meta.dir;

// Removed isWorkingCopy from template - we will calculate it in Node
const JJ_TEMPLATE = `change_id.short() ++ "§" ++ commit_id.short() ++ "§" ++ parents.map(|p| p.change_id().short()).join(",") ++ "§" ++ author.email() ++ "§" ++ author.timestamp() ++ "§" ++ bookmarks.join(",") ++ "§" ++ description.first_line() ++ "§" ++ description ++ "§" ++ empty ++ "§" ++ conflict ++ "§" ++ hidden ++ "§" ++ root ++ "§<JJ-SEP>§"`;

// Git branch cache
let gitBranchCache = new Map<string, string[]>(); // commitId -> branches[]
let lastGitBranchFetch = 0;

async function getWorkingCopyId(): Promise<string> {
  const proc = Bun.spawn(["jj", "log", "--no-graph", "-r", "@", "-T", "change_id.short()"], {
    cwd: PROC_CWD,
    stderr: "pipe"
  });
  return await new Response(proc.stdout).text();
}

async function getJJLog() {
  console.log("Fetching JJ log...");

  // Check if we should refresh git branch cache (every 5 seconds)
  const now = Date.now();
  if (now - lastGitBranchFetch > 5000) {
    gitBranchCache = await getGitBranches();
    lastGitBranchFetch = now;
  }

  // Parallel fetch: Log + Working Copy ID + Git Branches
  const [logText, wcId] = await Promise.all([
      (async () => {
          const proc = Bun.spawn(["jj", "log", "--no-graph", "-r", "::", "--limit", "500", "-T", JJ_TEMPLATE], {
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
    if (parts.length < 12) { // Adjusted length check
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

    // Reverse index for booleans (Standard again)
    const root = parts[parts.length-1];
    const hidden = parts[parts.length-2];
    const conflict = parts[parts.length-3];
    const empty = parts[parts.length-4];

    const descFull = parts.slice(7, parts.length-4).join("§");

    // Get git branches for this commit
    const shortCommitId = commitId.trim();
    const gitBranches = gitBranchCache.get(shortCommitId) || [];

    return {
      changeId: changeId.trim(),
      commitId: commitId.trim(),
      parents: parents ? parents.split(",") : [],
      author: author.trim(),
      time: time.trim(),
      bookmarks: bookmarks ? bookmarks.split(",").filter(b => b.trim()) : [],
      gitBranches: gitBranches,
      descriptionTitle: descTitle.trim(),
      descriptionFull: descFull.trim(),
      isEmpty: empty.trim() === "true",
      isConflict: conflict.trim() === "true",
      isHidden: hidden.trim() === "true",
      isRoot: root.trim() === "true",
      isWorkingCopy: changeId.trim() === cleanWcId // Server-side calculation
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
  // Fetch git branch info for all commits
  // Use for-each-ref to get branch -> commit mappings
  const proc = Bun.spawn(["git", "for-each-ref", "--format=%(objectname:short) %(refname:short)", "refs/heads"], {
    cwd: PROC_CWD,
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();

  const commitBranches = new Map<string, string[]>();

  output.trim().split("\n").forEach(line => {
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

async function getFiles(changeId: string): Promise<string> {
  const proc = Bun.spawn(["jj", "diff", "--summary", "-r", changeId], {
    cwd: PROC_CWD,
    stderr: "pipe",
  });
  return await new Response(proc.stdout).text();
}

const server = Bun.serve({
  port: args.port,
  async fetch(req: Request) {
    const url = new URL(req.url);
    
    // API Endpoint
      if (url.pathname === "/api/log") {
        try {
          const data = await getJJLog();
          return new Response(JSON.stringify(data), {
              headers: { 
                  "Content-Type": "application/json",
                  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
                  "Pragma": "no-cache",
                  "Expires": "0",
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
        // Parse into JSON list { type: 'A'|'M'|'D', path: string }
        const parsed = files.trim().split("\n").filter(Boolean).map(line => {
          const [type, ...pathParts] = line.split(" ");
          return { type, path: pathParts.join(" ") };
        });
        return Response.json(parsed);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response("Error fetching files: " + msg, { status: 500 });
      }
    }

    // Mutations
    if (req.method === "POST") {
        const body = await req.json();
        
        if (url.pathname === "/api/describe") {
            const { changeId, description } = body;
            console.log("Describing", changeId, description);
            const proc = Bun.spawn(["jj", "describe", "-r", changeId, "-m", description], { cwd: PROC_CWD });
            await proc.exited;
            return Response.json({ success: true });
        }

        if (url.pathname === "/api/rebase") {
            const { sourceId, destinationId } = body;
            console.log("Rebasing", sourceId, "onto", destinationId);
            const proc = Bun.spawn(["jj", "rebase", "-s", sourceId, "-d", destinationId], { cwd: PROC_CWD });
            const exitCode = await proc.exited;
            if (exitCode !== 0) {
                 const stderr = await new Response(proc.stderr).text();
                 return Response.json({ error: stderr }, { status: 400 });
            }
            return Response.json({ success: true });
        }
        
        if (url.pathname === "/api/new") {
             const { parentIds } = body;
             const args = ["jj", "new"];
             if (parentIds && Array.isArray(parentIds)) {
                 args.push(...parentIds);
             } else if (body.parentId) {
                 args.push(body.parentId);
             }
             
             const proc = Bun.spawn(args, { cwd: PROC_CWD });
             await proc.exited;
             return Response.json({ success: true });
        }

        if (url.pathname === "/api/edit") {
            const { changeId } = body;
            console.log("Editing revision (checkout)", changeId);
            // jj edit <changeId>
            const proc = Bun.spawn(["jj", "edit", changeId], { cwd: PROC_CWD });
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                 const stderr = await new Response(proc.stderr).text();
                 return Response.json({ error: stderr }, { status: 400 });
            }
            return Response.json({ success: true });
        }

        if (url.pathname === "/api/abandon") {
            const { changeId } = body;
            console.log("Abandoning revision", changeId);
            // jj abandon <changeId>
            const proc = Bun.spawn(["jj", "abandon", changeId], { cwd: PROC_CWD });
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                 const stderr = await new Response(proc.stderr).text();
                 return Response.json({ error: stderr }, { status: 400 });
            }
            return Response.json({ success: true });
        }

        if (url.pathname === "/api/squash") {
            const { changeId, into, intoId, paths } = body;
            const target = into || intoId;
            console.log("Squashing", changeId, "into", target || "parent", paths ? `(${paths.length} files)` : "");

            // jj squash: use --from for source when using --into
            const args = ["jj", "squash", "--from", changeId];
            if (target) {
                args.push("--into", target);
            }
            // If specific paths are provided, only squash those files
            if (paths && Array.isArray(paths) && paths.length > 0) {
                args.push(...paths);
            }

            const proc = Bun.spawn(args, { cwd: PROC_CWD });
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
                 const stderr = await new Response(proc.stderr).text();
                 console.log("Squash failed:", stderr);
                 return Response.json({ error: stderr }, { status: 400 });
            }
            return Response.json({ success: true });
        }
    }

    // Static Asset Serving (relative to script location)
    if (url.pathname === "/") {
      return new Response(Bun.file(`${SCRIPT_DIR}/public/index.html`));
    }
    if (url.pathname === "/style.css") {
      return new Response(Bun.file(`${SCRIPT_DIR}/public/style.css`));
    }
    
    // On-the-fly TypeScript bundling
    if (url.pathname === "/client.js") {
      const build = await Bun.build({
        entrypoints: [`${SCRIPT_DIR}/public/client.ts`],
        minify: false,
      });
      return new Response(build.outputs[0]);
    }

    return new Response("Not Found", { status: 404 });
  },
});

const url = `http://localhost:${server.port}`;
console.log(`🚀 jj-viz running at ${url}`);

// Auto-open browser unless disabled
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
