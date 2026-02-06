import { expect, test } from "bun:test";
import { splitDiffByFile } from "../diff";

test("splitDiffByFile splits unified diff into file chunks", () => {
  const text = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/src/b.ts b/src/b.ts",
    "index 333..444 100644",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");

  const chunks = splitDiffByFile(text);
  expect(chunks.length).toBe(2);
  expect(chunks[0]?.path).toBe("src/a.ts");
  expect(chunks[1]?.path).toBe("src/b.ts");
  expect(chunks[0]?.diff.includes("@@ -1 +1 @@")).toBe(true);
});
