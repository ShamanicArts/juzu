import { expect, test } from "bun:test";
import { createTempJJRepo } from "../../src/test-utils/temp-repo";

test("can create and cleanup temp jj repo", async () => {
  const repo = await createTempJJRepo();
  expect(repo.path.length).toBeGreaterThan(0);
  await repo.cleanup();
});
