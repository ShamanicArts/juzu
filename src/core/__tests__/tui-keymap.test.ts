import { describe, expect, test } from "bun:test";
import { findCommandForEvent, findLeaderModeForEvent, matchesKeySpec, resolveTuiKeymapConfig } from "../tui-keymap";

describe("tui keymap resolver", () => {
  test("uses defaults when config missing", () => {
    const config = resolveTuiKeymapConfig(undefined);
    expect(config.leaders.revision).toBe("ctrl+x");
    expect(config.modeBindings.revision.n).toBe("new");
    expect(config.idleBindings["ctrl+d"]).toBe("diff-toggle");
  });

  test("applies custom leader and idle bindings", () => {
    const config = resolveTuiKeymapConfig({
      leaders: { revision: "ctrl+s" },
      idleBindings: { n: "new" },
      modeBindings: { revision: { k: "new" } },
      modeOrder: ["graph", "revision"],
      exitKeys: ["esc"],
    });

    expect(config.leaders.revision).toBe("ctrl+s");
    expect(config.idleBindings.n).toBe("new");
    expect(config.modeBindings.revision.k).toBe("new");
    expect(config.modeOrder).toEqual(["graph", "revision"]);
    expect(config.exitKeys).toEqual(["escape"]);
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

    expect(findLeaderModeForEvent(config, leaderKey)).toBe("revision");
    expect(findCommandForEvent(config.modeBindings.revision, commandKey)).toBe("new");
  });
});
