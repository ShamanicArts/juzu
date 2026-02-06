import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function runCmd(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `command failed: ${args.join(" ")}`);
}

export type TempJJRepo = {
  path: string;
  cleanup: () => Promise<void>;
  run: (args: string[]) => Promise<void>;
};

export async function createTempJJRepo(): Promise<TempJJRepo> {
  const path = await mkdtemp(join(tmpdir(), "jj-viz-test-"));
  await runCmd(["jj", "git", "init"], path);

  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
    run: async (args: string[]) => {
      await runCmd(args, path);
    },
  };
}
