import { describe, expect, test } from "bun:test";
import { readFixture } from "../../test-utils/fixtures";

describe("jj parser fixtures", () => {
  test("log fixture includes parseable blocks", async () => {
    const text = await readFixture("jj-log.sample.txt");
    const blocks = text.split("§<JJ-SEP>§").map((x) => x.trim()).filter(Boolean);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.split("§").length).toBeGreaterThanOrEqual(12);
    }
  });

  test("oplog fixture includes parseable blocks", async () => {
    const text = await readFixture("jj-oplog.sample.txt");
    const blocks = text.split("§<JJ-OP-SEP>§").map((x) => x.trim()).filter(Boolean);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.split("§").length).toBeGreaterThanOrEqual(9);
    }
  });

  test("obslog fixture includes parseable blocks", async () => {
    const text = await readFixture("jj-obslog.sample.txt");
    const blocks = text.split("§<JJ-OBS-SEP>§").map((x) => x.trim()).filter(Boolean);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.split("§").length).toBeGreaterThanOrEqual(15);
    }
  });
});
