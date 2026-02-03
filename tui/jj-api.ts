import type { CommitNode, FilesCacheEntry } from "./types";

const JJ_TEMPLATE =
  `change_id.short() ++ "§" ++ commit_id.short() ++ "§" ++ parents.map(|p| p.change_id().short()).join(",") ++ "§" ++ author.email() ++ "§" ++ author.timestamp() ++ "§" ++ bookmarks.join(",") ++ "§" ++ description.first_line() ++ "§" ++ description ++ "§" ++ empty ++ "§" ++ conflict ++ "§" ++ hidden ++ "§" ++ root ++ "§<JJ-SEP>§"`;

export async function findJJRoot(startDir: string): Promise<string | null> {
  let current = startDir;
  while (true) {
    try {
      await Bun.file(`${current}/.jj`).stat();
      return current;
    } catch {
      const parent = current.substring(0, current.lastIndexOf("/"));
      if (!parent || parent === current) return null;
      current = parent;
    }
  }
}

export async function runCmdText(args: string[], cwd: string, timeoutMs = 15000): Promise<string> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, timeoutMs);

  try {
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      const msg = (stderrText || "").trim() || `Command failed (${exitCode}): ${args.join(" ")}`;
      throw new Error(msg);
    }

    return stdoutText;
  } finally {
    clearTimeout(timeout);
  }
}

async function getWorkingCopyId(cwd: string): Promise<string> {
  return (await runCmdText(["jj", "log", "--no-graph", "-r", "@", "-T", "change_id.short()"], cwd, 8000)).trim();
}

export async function fetchJJLog(cwd: string, limit: number): Promise<CommitNode[]> {
  const [logText, wcId] = await Promise.all([
    runCmdText(["jj", "log", "--no-graph", "-r", "::", "--limit", String(limit), "-T", JJ_TEMPLATE], cwd, 15000),
    getWorkingCopyId(cwd),
  ]);

  return logText
    .split("§<JJ-SEP>§")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const parts = block.split("§");
      if (parts.length < 12) return null;

      const changeId = parts[0].trim();
      const commitId = parts[1].trim();
      const root = parts[parts.length - 1].trim();
      const hidden = parts[parts.length - 2].trim();
      const conflict = parts[parts.length - 3].trim();
      const empty = parts[parts.length - 4].trim();
      const descriptionFull = parts.slice(7, parts.length - 4).join("§").trim();

      return {
        changeId,
        commitId,
        parents: parts[2] ? parts[2].split(",").map((p) => p.trim()).filter(Boolean) : [],
        author: parts[3].trim(),
        time: parts[4].trim(),
        bookmarks: parts[5] ? parts[5].split(",").map((b) => b.trim()).filter(Boolean) : [],
        gitBranches: [],
        descriptionTitle: parts[6].trim(),
        descriptionFull,
        isEmpty: empty === "true",
        isConflict: conflict === "true",
        isHidden: hidden === "true",
        isRoot: root === "true",
        isWorkingCopy: changeId === wcId,
      } satisfies CommitNode;
    })
    .filter(Boolean) as CommitNode[];
}

export async function fetchFilesForNodes(
  nodes: CommitNode[],
  cwd: string,
  onUpdate: (cache: Map<string, FilesCacheEntry>) => void
): Promise<void> {
  const cache = new Map<string, FilesCacheEntry>();
  const FILES_TTL_MS = 30000;

  await Promise.all(
    nodes.map(async (node) => {
      try {
        const out = await runCmdText(["jj", "diff", "--summary", "-r", node.changeId], cwd, 10000);
        const files = out
          .trim()
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((line) => {
            const [type, ...rest] = line.split(" ");
            return { type, path: rest.join(" ") };
          });
        cache.set(node.changeId, { atMs: Date.now(), files });
      } catch {
        cache.set(node.changeId, { atMs: Date.now(), files: [] });
      }
    })
  );

  onUpdate(cache);
}
