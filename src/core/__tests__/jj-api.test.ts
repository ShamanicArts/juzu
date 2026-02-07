import { describe, expect, test } from "bun:test";
import {
  enrichNodesWithGitBranches,
  parseJJLogText,
  parseObslogText,
  parseOpLogText,
} from "../jj-api";
import { readFixture } from "../../test-utils/fixtures";

describe("jj-api parsers", () => {
  test("parseJJLogText parses valid entries and skips malformed blocks", async () => {
    const sample = await readFixture("jj-log.sample.txt");
    const mixed = `${sample}\nbad\x01block\x01only`;
    const parsed = parseJJLogText(mixed, "cccc3333");
    expect(parsed).toHaveLength(3);
    expect(parsed[1]?.isWorkingCopy).toBe(true);
  });

  test("parseOpLogText parses tags and skips malformed blocks", async () => {
    const sample = await readFixture("jj-oplog.sample.txt");
    const mixed = `${sample}\nmissing\x01fields`;
    const parsed = parseOpLogText(mixed);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.tags.length).toBeGreaterThan(0);
    expect(parsed[1]?.isCurrent).toBe(true);
  });

  test("parseObslogText parses operation metadata and skips malformed blocks", async () => {
    const sample = await readFixture("jj-obslog.sample.txt");
    const mixed = `${sample}\ninvalid\x01obslog`;
    const parsed = parseObslogText(mixed, "aaaa1111");
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.operationId.length).toBeGreaterThan(0);
    expect(parsed[0]?.isWorkingCopy).toBe(true);
  });
});

describe("git branch enrichment", () => {
  test("matches exact and short commit ids", () => {
    const nodes = [
      {
        changeId: "a",
        commitId: "abcde12",
        parents: [],
        author: "x",
        time: "t",
        bookmarks: [],
        gitBranches: [],
        descriptionTitle: "",
        descriptionFull: "",
        isEmpty: false,
        isConflict: false,
        isHidden: false,
        isRoot: true,
        isWorkingCopy: false,
      },
      {
        changeId: "b",
        commitId: "f00ba4123456",
        parents: [],
        author: "x",
        time: "t",
        bookmarks: [],
        gitBranches: [],
        descriptionTitle: "",
        descriptionFull: "",
        isEmpty: false,
        isConflict: false,
        isHidden: false,
        isRoot: false,
        isWorkingCopy: false,
      },
    ];
    const branches = new Map<string, string[]>([
      ["abcde12", ["main"]],
      ["f00ba41", ["feature/x"]],
    ]);

    const enriched = enrichNodesWithGitBranches(nodes, branches);
    expect(enriched[0]?.gitBranches).toEqual(["main"]);
    expect(enriched[1]?.gitBranches).toEqual(["feature/x"]);
  });
});
