import { beforeEach, describe, expect, test } from "bun:test";
import { actions, navigation, state } from "../state";
import type { CommitNode } from "../types";

function node(overrides: Partial<CommitNode>): CommitNode {
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

const nodes: CommitNode[] = [
  node({ changeId: "c3", commitId: "333", parents: ["c2"], isWorkingCopy: true }),
  node({ changeId: "c2", commitId: "222", parents: ["c1", "b1"] }),
  node({ changeId: "b1", commitId: "b11", parents: ["c1"], bookmarks: ["feature/x"] }),
  node({ changeId: "c1", commitId: "111", parents: [], isRoot: true, bookmarks: ["main"] }),
];

describe("state store behavior", () => {
  beforeEach(() => {
    actions.reset();
  });

  test("nodes and layout mode update source state", () => {
    actions.setNodes(nodes);
    expect(state.nodes.length).toBe(4);
    expect(state.selectedId).toBe("c3");

    actions.setLayoutMode("chronological");
    expect(state.layoutMode).toBe("chronological");

    actions.setLayoutMode("topological");
    expect(state.layoutMode).toBe("topological");
  });

  test("pinned node state is tracked", () => {
    actions.pinNode("b1", 5);
    expect(state.pinnedNodes.get("b1")).toBe(5);
    actions.unpinNode("b1");
    expect(state.pinnedNodes.has("b1")).toBe(false);
  });

  test("selection navigation works in oplog and obslog views", () => {
    actions.setOpLogEntries([
      {
        id: "op1",
        shortId: "op1",
        time: "t1",
        duration: "1s",
        tags: [],
        descriptionTitle: "one",
        descriptionFull: "one",
        isCurrent: true,
        user: "dev",
      },
      {
        id: "op2",
        shortId: "op2",
        time: "t2",
        duration: "1s",
        tags: [],
        descriptionTitle: "two",
        descriptionFull: "two",
        isCurrent: false,
        user: "dev",
      },
    ]);
    actions.setViewMode("oplog");
    expect(state.opLogSelectedId).toBe("op1");
    navigation.moveDown();
    expect(state.opLogSelectedId).toBe("op2");
    navigation.moveUp();
    expect(state.opLogSelectedId).toBe("op1");

    actions.setObslogEntries([
      {
        changeId: "c1",
        commitId: "111",
        operationId: "op1",
        operationDescription: "desc",
        operationDescriptionFull: "desc",
        operationUser: "dev",
        operationDuration: "1s",
        operationTags: [],
        time: "t",
        author: "dev",
        bookmarks: [],
        descriptionTitle: "d",
        descriptionFull: "d",
        isWorkingCopy: false,
        isEmpty: false,
        isConflict: false,
        isHidden: false,
      },
      {
        changeId: "c1",
        commitId: "222",
        operationId: "op2",
        operationDescription: "desc",
        operationDescriptionFull: "desc",
        operationUser: "dev",
        operationDuration: "1s",
        operationTags: [],
        time: "t",
        author: "dev",
        bookmarks: [],
        descriptionTitle: "d",
        descriptionFull: "d",
        isWorkingCopy: false,
        isEmpty: false,
        isConflict: false,
        isHidden: false,
      },
    ]);
    actions.setViewMode("obslog");
    navigation.moveDown();
    expect(state.obslogSelectedIndex).toBe(1);
    navigation.moveUp();
    expect(state.obslogSelectedIndex).toBe(0);
  });

  test("op mode requires single selection and resets on selection change", () => {
    actions.setNodes(nodes);
    actions.setOpMode("split");
    expect(state.opMode).toBe("split");

    actions.toggleSelection("c2");
    expect(state.selectedIds.size).toBe(2);
    expect(state.opMode).toBe("none");

    actions.setOpMode("move");
    expect(state.opMode).toBe("none");

    actions.selectNode("c2");
    actions.setOpMode("move");
    expect(state.opMode).toBe("move");
  });
});
