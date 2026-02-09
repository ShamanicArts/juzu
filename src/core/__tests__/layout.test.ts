import { describe, expect, test } from "bun:test";
import { calculateLayout } from "../layout";
import type { CommitNode, LayoutMode } from "../types";

function makeNode(overrides: Partial<CommitNode>): CommitNode {
  return {
    changeId: "",
    commitId: "",
    parents: [],
    author: "dev@example.com",
    time: "2026-02-06 00:00:00",
    bookmarks: [],
    gitBranches: [],
    descriptionTitle: "",
    descriptionFull: "",
    isEmpty: false,
    isConflict: false,
    isHidden: false,
    isRoot: false,
    isWorkingCopy: false,
    ...overrides,
  };
}

function fixtureNodes(): CommitNode[] {
  return [
    makeNode({ changeId: "c4", commitId: "c4c4c4", parents: ["c3"], isWorkingCopy: true }),
    makeNode({ changeId: "c3", commitId: "c3c3c3", parents: ["c2"] }),
    makeNode({ changeId: "c2", commitId: "c2c2c2", parents: ["c1", "b1"], isConflict: true }),
    makeNode({ changeId: "b1", commitId: "b1b1b1", parents: ["c1"], bookmarks: ["feature/x"] }),
    makeNode({ changeId: "c1", commitId: "c1c1c1", parents: [], bookmarks: ["main"], isRoot: true, isEmpty: true }),
  ];
}

describe("layout modes", () => {
  test("chronological keeps first-parent chain on one lane", () => {
    const out = calculateLayout("chronological", fixtureNodes());
    const byId = new Map(out.nodes.map((n) => [n.changeId, n]));
    expect(byId.get("c4")?.lane).toBe(0);
    expect(byId.get("c3")?.lane).toBe(0);
    expect(byId.get("c2")?.lane).toBe(0);
    expect(byId.get("b1")?.lane).toBe(1);
    expect(byId.get("c1")?.lane).toBe(0);
  });

  test("topological depth lane assignment is stable", () => {
    const out = calculateLayout("topological", fixtureNodes());
    const byId = new Map(out.nodes.map((n) => [n.changeId, n]));
    expect(byId.get("c1")?.lane).toBe(0);
    expect(byId.get("b1")?.lane).toBe(1);
    expect(byId.get("c2")?.lane).toBe(2);
    expect(byId.get("c3")?.lane).toBe(3);
    expect(byId.get("c4")?.lane).toBe(4);
  });

  test("mainline keeps selected spine on lane zero", () => {
    const out = calculateLayout("mainline", fixtureNodes());
    const byId = new Map(out.nodes.map((n) => [n.changeId, n]));
    expect(byId.get("c4")?.lane).toBe(0);
    expect(byId.get("c3")?.lane).toBe(0);
    expect(byId.get("c2")?.lane).toBe(0);
    expect(byId.get("c1")?.lane).toBe(0);
    expect((byId.get("b1")?.lane ?? 0) > 0).toBe(true);
  });

  test("pinning overrides assigned lanes in a single pass", () => {
    const pinned = new Map<string, number>([["b1", 5]]);
    const out = calculateLayout("chronological", fixtureNodes(), {}, pinned);
    const byId = new Map(out.nodes.map((n) => [n.changeId, n]));
    expect(byId.get("b1")?.lane).toBe(5);
    expect(byId.get("b1")?.isPinned).toBe(true);
    expect(byId.get("c4")?.lane).toBe(0);
  });

  test("all modes produce deterministic lane assignment", () => {
    const modes: LayoutMode[] = ["chronological", "mainline", "bookmark-centric", "wc-focused", "topological"];
    for (const mode of modes) {
      const first = calculateLayout(mode, fixtureNodes()).nodes.map((n) => `${n.changeId}:${n.lane ?? -1}`).join(",");
      const second = calculateLayout(mode, fixtureNodes()).nodes.map((n) => `${n.changeId}:${n.lane ?? -1}`).join(",");
      expect(first).toBe(second);
    }
  });

  test("empty graph edge case", () => {
    const out = calculateLayout("chronological", []);
    expect(out.nodes).toHaveLength(0);
    expect(out.maxLane).toBe(0);
  });

  test("many-parent merge does not crash and assigns lanes", () => {
    const nodes = [
      makeNode({ changeId: "m", commitId: "mmmm", parents: ["p1", "p2", "p3"], isWorkingCopy: true }),
      makeNode({ changeId: "p1", commitId: "1111", parents: ["root"] }),
      makeNode({ changeId: "p2", commitId: "2222", parents: ["root"] }),
      makeNode({ changeId: "p3", commitId: "3333", parents: ["root"] }),
      makeNode({ changeId: "root", commitId: "rrrr", parents: [], isRoot: true }),
    ];
    const out = calculateLayout("chronological", nodes);
    expect(out.nodes.every((n) => typeof n.lane === "number")).toBe(true);
  });
});
