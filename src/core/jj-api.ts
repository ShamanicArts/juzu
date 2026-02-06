import type { CommitNode, FilesCacheEntry } from "./types";

export const JJ_TEMPLATE =
  `change_id.short() ++ "§" ++ commit_id.short() ++ "§" ++ parents.map(|p| p.change_id().short()).join(",") ++ "§" ++ author.email() ++ "§" ++ author.timestamp() ++ "§" ++ bookmarks.join(",") ++ "§" ++ description.first_line() ++ "§" ++ description ++ "§" ++ empty ++ "§" ++ conflict ++ "§" ++ hidden ++ "§" ++ root ++ "§<JJ-SEP>§"`;

export function parseJJLogText(logText: string, wcId: string): CommitNode[] {
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

  return parseJJLogText(logText, wcId);
}

export async function fetchGitBranches(cwd: string): Promise<Map<string, string[]>> {
  const out = await runCmdText([
    "git",
    "for-each-ref",
    "--format=%(objectname:short) %(refname:short)",
    "refs/heads",
  ], cwd, 10000);

  const commitBranches = new Map<string, string[]>();
  out
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const [commitId, branchName] = line.split(" ");
      if (!commitId || !branchName) return;
      if (!commitBranches.has(commitId)) commitBranches.set(commitId, []);
      commitBranches.get(commitId)!.push(branchName);
    });

  return commitBranches;
}

export async function fetchJJLogWithGitBranches(cwd: string, limit: number): Promise<CommitNode[]> {
  const [nodes, gitBranches] = await Promise.all([
    fetchJJLog(cwd, limit),
    fetchGitBranches(cwd),
  ]);

  return enrichNodesWithGitBranches(nodes, gitBranches);
}

export function enrichNodesWithGitBranches(nodes: CommitNode[], gitBranches: Map<string, string[]>): CommitNode[] {
  
  return nodes.map((node) => {
    const branches =
      gitBranches.get(node.commitId) ||
      gitBranches.get(node.commitId.slice(0, 7)) ||
      [];
    return {
      ...node,
      gitBranches: branches,
    };
  });
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

export async function jjCreateNew(
  cwd: string,
  opts: { parentId?: string; parentIds?: string[] } = {}
): Promise<void> {
  const cmd = ["jj", "new"];
  if (Array.isArray(opts.parentIds) && opts.parentIds.length > 0) {
    cmd.push(...opts.parentIds);
  } else if (opts.parentId) {
    cmd.push(opts.parentId);
  }
  await runCmdText(cmd, cwd);
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
  const args: string[] = ["jj", "squash", "--use-destination-message"];
  if (opts.intoId) {
    args.push("--from", changeId, "--into", opts.intoId);
  } else {
    args.push("-r", changeId);
  }
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

export async function jjRedo(cwd: string): Promise<void> {
  await runCmdText(["jj", "redo"], cwd);
}

export async function jjGetDiff(changeId: string, cwd: string): Promise<string> {
  return runCmdText(["jj", "diff", "--git", "-r", changeId], cwd);
}

export async function jjGetFiles(changeId: string, cwd: string): Promise<Array<{ type: string; path: string }>> {
  const out = await runCmdText(["jj", "diff", "--summary", "-r", changeId], cwd);
  return out
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [type, ...rest] = line.split(" ");
      return { type, path: rest.join(" ") };
    });
}

// Restore operation (jump to specific operation)
export async function jjRestoreOperation(operationId: string, cwd: string): Promise<void> {
  await runCmdText(["jj", "op", "restore", operationId], cwd);
}

// Op log types
export interface OpLogEntry {
  id: string;
  shortId: string;
  time: string;
  duration: string;
  tags: string[];
  descriptionTitle: string;
  descriptionFull: string;
  isCurrent: boolean;
  user: string;
}

export const OP_LOG_TEMPLATE =
  `id.short() ++ "§" ++ id.short(8) ++ "§" ++ time ++ "§" ++ time.duration() ++ "§" ++ tags ++ "§" ++ description.first_line() ++ "§" ++ description ++ "§" ++ current_operation ++ "§" ++ user ++ "\n§<JJ-OP-SEP>§\n"`;

export function parseOpLogText(logText: string): OpLogEntry[] {
  return logText
    .split("§<JJ-OP-SEP>§")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const parts = block.split("§");
      if (parts.length < 9) return null;

      return {
        id: parts[0].trim(),
        shortId: parts[1].trim(),
        time: parts[2].trim(),
        duration: parts[3].trim(),
        tags: parts[4] ? parts[4].split("\n").map((t) => t.trim()).filter(Boolean) : [],
        descriptionTitle: parts[5].trim(),
        descriptionFull: parts[6].trim(),
        isCurrent: parts[7].trim() === "true",
        user: parts[8].trim(),
      } satisfies OpLogEntry;
    })
    .filter(Boolean) as OpLogEntry[];
}

export async function fetchOpLog(cwd: string, limit: number): Promise<OpLogEntry[]> {
  const logText = await runCmdText(["jj", "op", "log", "--no-graph", "--limit", String(limit), "-T", OP_LOG_TEMPLATE], cwd, 15000);

  return parseOpLogText(logText);
}

// Obslog types
export interface ObslogEntry {
  changeId: string;
  commitId: string;
  operationId: string;
  operationDescription: string;
  operationDescriptionFull: string;
  operationUser: string;
  operationDuration: string;
  operationTags: string[];
  time: string;
  author: string;
  bookmarks: string[];
  descriptionTitle: string;
  descriptionFull: string;
  isWorkingCopy: boolean;
  isEmpty: boolean;
  isConflict: boolean;
  isHidden: boolean;
}

// CommitEvolutionEntry provides `commit()` and `operation()`.
// We include operation info so the UI can explain *why* a version exists.
export const OBSLOG_TEMPLATE =
  `commit.change_id().short() ++ "§" ++ commit.commit_id().short() ++ "§" ++ operation.id().short() ++ "§" ++ operation.description().first_line() ++ "§" ++ operation.description() ++ "§" ++ operation.user() ++ "§" ++ operation.time().duration() ++ "§" ++ operation.tags() ++ "§" ++ commit.author().timestamp() ++ "§" ++ commit.author().email() ++ "§" ++ commit.hidden() ++ "§" ++ commit.description().first_line() ++ "§" ++ commit.description() ++ "§" ++ commit.empty() ++ "§" ++ commit.conflict() ++ "\n§<JJ-OBS-SEP>§\n"`;

export function parseObslogText(logText: string, wcId: string): ObslogEntry[] {
  return logText
    .split("§<JJ-OBS-SEP>§")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const parts = block.split("§");
      if (parts.length < 15) return null;

      const changeIdEntry = parts[0].trim();
      const operationId = parts[2].trim();
      const operationDescription = parts[3].trim();
      const operationDescriptionFull = parts[4].trim();
      const operationUser = parts[5].trim();
      const operationDuration = parts[6].trim();
      const operationTags = parts[7] ? parts[7].split("\n").map((t) => t.trim()).filter(Boolean) : [];
      const isHidden = parts[10].trim() === "true";
      const descriptionFull = parts.slice(12, parts.length - 2).join("§").trim();

      return {
        changeId: changeIdEntry,
        commitId: parts[1].trim(),
        operationId,
        operationDescription,
        operationDescriptionFull,
        operationUser,
        operationDuration,
        operationTags,
        time: parts[8].trim(),
        author: parts[9].trim(),
        bookmarks: [],
        descriptionTitle: parts[11].trim(),
        descriptionFull,
        isWorkingCopy: changeIdEntry === wcId,
        isEmpty: parts[parts.length - 2].trim() === "true",
        isConflict: parts[parts.length - 1].trim() === "true",
        isHidden,
      } satisfies ObslogEntry;
    })
    .filter(Boolean) as ObslogEntry[];
}

export async function fetchObslog(changeId: string, cwd: string, limit: number): Promise<ObslogEntry[]> {
  const [logText, wcId] = await Promise.all([
    runCmdText(["jj", "obslog", "--no-graph", "-r", changeId, "--limit", String(limit), "-T", OBSLOG_TEMPLATE], cwd, 15000),
    getWorkingCopyId(cwd),
  ]);

  return parseObslogText(logText, wcId);
}
