import type { CommitNode, FilesCacheEntry } from "./types";

const JJ_TEMPLATE =
  `change_id.short() ++ "§" ++ commit_id.short() ++ "§" ++ parents.map(|p| p.change_id().short()).join(",") ++ "§" ++ author.email() ++ "§" ++ author.timestamp() ++ "§" ++ bookmarks.join(",") ++ "§" ++ description.first_line() ++ "§" ++ description ++ "§" ++ empty ++ "§" ++ conflict ++ "§" ++ hidden ++ "§" ++ root ++ "§<JJ-SEP>§"`;

/**
 * Find JJ repository root by walking up directory tree
 */
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

/**
 * Run a command and return text output
 */
export async function runCmdText(
  args: string[],
  cwd: string,
  timeoutMs = 15000
): Promise<string> {
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

/**
 * Fetch the JJ log
 */
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

/**
 * Fetch files for nodes
 */
export async function fetchFilesForNodes(
  nodes: CommitNode[],
  cwd: string,
  onUpdate: (cache: Map<string, FilesCacheEntry>) => void
): Promise<void> {
  const cache = new Map<string, FilesCacheEntry>();

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

// JJ Operations
export async function jjNew(parentId: string, cwd: string): Promise<void> {
  await runCmdText(["jj", "new", parentId], cwd);
}

export async function jjEdit(changeId: string, cwd: string): Promise<void> {
  await runCmdText(["jj", "edit", changeId], cwd);
}

export async function jjDescribe(changeId: string, description: string, cwd: string): Promise<void> {
  await runCmdText(["jj", "describe", "-r", changeId, "-m", description], cwd);
}

export async function jjAbandon(changeId: string, cwd: string): Promise<void> {
  await runCmdText(["jj", "abandon", changeId], cwd);
}

export async function jjSquash(changeId: string, into: string | null, cwd: string): Promise<void> {
  const args = ["jj", "squash", "--from", changeId, "--use-destination-message"];
  if (into) {
    args.push("--into", into);
  }
  await runCmdText(args, cwd);
}

export async function jjDuplicate(changeId: string, cwd: string): Promise<void> {
  await runCmdText(["jj", "duplicate", changeId], cwd);
}

export async function jjRebase(sourceId: string, destinationId: string, cwd: string): Promise<void> {
  await runCmdText(["jj", "rebase", "-s", sourceId, "-d", destinationId], cwd);
}

export async function jjInsertAfter(parentId: string, childId: string, cwd: string): Promise<void> {
  await runCmdText(["jj", "new", parentId], cwd);
  await runCmdText(["jj", "rebase", "-s", childId, "-d", "@"], cwd);
}

export async function jjMove(sourceId: string, destinationId: string, cwd: string): Promise<void> {
  await runCmdText(["jj", "rebase", "-s", sourceId, "-d", destinationId], cwd);
}

export async function jjSquashPaths(
  changeId: string,
  opts: { intoId?: string | null; paths?: string[]; message?: string },
  cwd: string
): Promise<void> {
  const args: string[] = ["jj", "squash", "--from", changeId, "--use-destination-message"];
  if (opts.intoId) args.push("--into", opts.intoId);
  if (opts.message && opts.message.trim()) args.push("-m", opts.message.trim());
  if (opts.paths && opts.paths.length > 0) args.push(...opts.paths);
  await runCmdText(args, cwd);
}

export async function jjSplit(changeId: string, paths: string[], cwd: string, message = "split"): Promise<void> {
  const msg = message && message.trim() ? message.trim() : "split";
  await runCmdText(["jj", "split", "-r", changeId, "-m", msg, ...paths], cwd);
}

export async function jjUndo(cwd: string): Promise<void> {
  await runCmdText(["jj", "undo"], cwd);
}

export async function jjGetDiff(changeId: string, cwd: string): Promise<string> {
  return runCmdText(["jj", "diff", "--git", "-r", changeId], cwd);
}
