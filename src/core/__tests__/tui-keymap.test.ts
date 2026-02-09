import { describe, expect, test } from "bun:test";
import { findCommandForEvent, findLeaderModeForEvent, matchesKeySpec, resolveTuiKeymapConfig } from "../tui-keymap";

describe("tui keymap resolver", () => {
  test("uses defaults when config missing", () => {
    const config = resolveTuiKeymapConfig(undefined);
    expect(config.leaders.action).toBe("ctrl+x");
    expect(config.modeBindings.action.n).toBe("new");
    expect(config.idleBindings["ctrl+d"]).toBe("diff-toggle");
    expect(config.idleBindings["ctrl+t"]).toBeUndefined();
    expect(config.showLeaderTriggersInStatus).toBe(true);
  });

  test("applies custom leader and idle bindings", () => {
    const config = resolveTuiKeymapConfig({
      leaders: { action: "ctrl+s" },
      idleBindings: { n: "new" },
      modeBindings: { action: { k: "new" } },
      modeOrder: ["view", "action"],
      exitKeys: ["esc"],
    });

    expect(config.leaders.action).toBe("ctrl+s");
    expect(config.idleBindings.n).toBe("new");
    expect(config.modeBindings.action.k).toBe("new");
    expect(config.modeOrder).toEqual(["view", "action"]);
    expect(config.exitKeys).toEqual(["escape"]);
  });

  test("applies custom status contexts and labels", () => {
    const config = resolveTuiKeymapConfig({
      statusContextOrder: ["diff", "oplog"],
      statusContextLabels: { diff: "PATCH" },
      statusContexts: {
        diff: [
          { key: "x", label: "Close", tone: "view" },
          { key: "j/k", label: "Move", tone: "neutral" },
        ],
      },
      commandLabels: {
        "bookmark-set": "Mark+",
      },
    });

    expect(config.statusContextOrder).toEqual(["diff", "oplog"]);
    expect(config.statusContextLabels.diff).toBe("PATCH");
    expect(config.statusContexts.diff[0]?.label).toBe("Close");
    expect(config.commandLabels["bookmark-set"]).toBe("Mark+");
  });
});

describe("tui key matching", () => {
  test("matches ctrl combos and aliases", () => {
    const key = { name: "x", sequence: "\u0018", ctrl: true, shift: false, meta: false } as any;
    expect(matchesKeySpec("ctrl+x", key)).toBe(true);
    expect(matchesKeySpec("control+x", key)).toBe(true);
  });

  test("resolves leader and command for event", () => {
    const config = resolveTuiKeymapConfig(undefined);
    const leaderKey = { name: "x", sequence: "\u0018", ctrl: true, shift: false, meta: false } as any;
    const commandKey = { name: "n", sequence: "n", ctrl: false, shift: false, meta: false } as any;

    expect(findLeaderModeForEvent(config, leaderKey)).toBe("action");
    expect(findCommandForEvent(config.modeBindings.action, commandKey)).toBe("new");
  });
});
