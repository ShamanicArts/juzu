import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

export function fixturePath(name: string): string {
  return join(fixturesDir, name);
}

export async function readFixture(name: string): Promise<string> {
  return Bun.file(fixturePath(name)).text();
}
