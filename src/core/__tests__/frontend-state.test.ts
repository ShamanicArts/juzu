import { beforeEach, describe, expect, test } from "bun:test";
import { tuiActions, tuiState } from "../state-tui";
import { webActions, webState } from "../state-web";

describe("frontend extension stores", () => {
  beforeEach(() => {
    tuiActions.reset();
    webActions.reset();
  });

  test("web state tracks op mode and viewport", () => {
    webActions.setOpMode("move");
    expect(webState.opMode).toBe("move");
    webActions.setOpTarget("abc123");
    expect(webState.opTargetId).toBe("abc123");

    webActions.setViewport({ scale: 1.2 });
    expect(webState.viewport.scale).toBe(1.2);

    webActions.resetOpMode();
    expect(webState.opMode).toBe("none");
    expect(webState.opTargetId).toBe(null);
  });

  test("tui state tracks leader, merge and cursor", () => {
    tuiActions.setLeaderMode(true);
    expect(tuiState.leaderMode).toBe(true);

    tuiActions.setMergeMode(true);
    tuiActions.toggleMergeSelection("x1");
    expect(tuiState.mergeSelectedIds.has("x1")).toBe(true);

    tuiActions.setCursorPos(5);
    expect(tuiState.cursorPos).toBe(5);

    tuiActions.startRevset("::@");
    expect(tuiState.revsetMode).toBe(true);
    expect(tuiActions.submitRevset()).toBe("::@");
    expect(tuiState.revsetMode).toBe(false);

    tuiActions.setMergeMode(false);
    expect(tuiState.mergeSelectedIds.size).toBe(0);
  });
});
