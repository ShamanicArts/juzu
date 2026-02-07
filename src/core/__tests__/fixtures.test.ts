import { describe, expect, test } from "bun:test";
import { readFixture } from "../../test-utils/fixtures";

function splitBlocks(text: string, tag: string): string[] {
  // Fixtures historically used either ASCII SOH (\x01) or a unicode section marker.
  // Prefer ASCII to keep fixtures portable.
  const ascii = `\x01<${tag}>\x01`;
  const unicode = `§<${tag}>§`;
  const parts = (text.includes(ascii) ? text.split(ascii) : text.split(unicode))
    .map((x) => x.trim())
    .filter(Boolean);
  return parts;
}

function countFields(block: string): number {
  // Field separators are SOH (\x01) in current fixtures.
  if (block.includes("\x01")) return block.split("\x01").length;
  return block.split("§").length;
}

describe("jj parser fixtures", () => {
  test("log fixture includes parseable blocks", async () => {
    const text = await readFixture("jj-log.sample.txt");
    const blocks = splitBlocks(text, "JJ-SEP");
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(countFields(block)).toBeGreaterThanOrEqual(12);
    }
  });

  test("oplog fixture includes parseable blocks", async () => {
    const text = await readFixture("jj-oplog.sample.txt");
    const blocks = splitBlocks(text, "JJ-OP-SEP");
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(countFields(block)).toBeGreaterThanOrEqual(9);
    }
  });

  test("obslog fixture includes parseable blocks", async () => {
    const text = await readFixture("jj-obslog.sample.txt");
    const blocks = splitBlocks(text, "JJ-OBS-SEP");
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(countFields(block)).toBeGreaterThanOrEqual(15);
    }
  });
});
