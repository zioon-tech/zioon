import { describe, expect, it, vi } from "vitest";
import { registerSessionTagExclusionCommands } from "../extensions/dev.session-manager/commands/tag-exclusions.js";
import {
  createSessionTagIndex,
  getIndexedSessionTags,
  updateSessionTagIndex
} from "../extensions/dev.session-manager/model/session-tag-index.js";

function makeHarness() {
  const commands = new Map();
  let index = createSessionTagIndex();
  index = updateSessionTagIndex(index, "s1", "#project #project/zion #alpha", "1");
  index = updateSessionTagIndex(index, "s2", "#project/ui #beta", "2");
  const commitIndex = vi.fn((next) => { index = next; });
  const disposable = registerSessionTagExclusionCommands({
    zion: {
      commands: {
        registerCommand: (id, handler) => {
          commands.set(id, handler);
          return { dispose: () => commands.delete(id) };
        }
      }
    },
    getIndex: () => index,
    commitIndex,
    getCurrentSessionId: () => "s1"
  });
  return { commands, commitIndex, disposable, getIndex: () => index };
}

describe("session tag exclusion commands", () => {
  it("ignores and restores an exact tag in the current session", () => {
    const harness = makeHarness();
    const ignore = harness.commands.get("zion.sessions.excludeTag")({ path: "project" });
    expect(ignore).toEqual(expect.objectContaining({
      ok: true,
      visibleTags: ["project/zion", "alpha"],
      ignoredTags: ["project"]
    }));

    const restore = harness.commands.get("zion.sessions.restoreTag")({
      path: "project",
      subtree: false
    });
    expect(restore).toEqual(expect.objectContaining({
      ok: true,
      ignoredTags: []
    }));
    expect(harness.commitIndex).toHaveBeenCalledTimes(2);
    harness.disposable.dispose();
    expect(harness.commands.size).toBe(0);
  });

  it("reports impact and bulk-ignores a subtree across sessions", () => {
    const harness = makeHarness();
    const impact = harness.commands.get("zion.sessions.getTagExclusionImpact")({ path: "project" });
    expect(impact).toEqual({
      path: "project",
      sessionIds: ["s1", "s2"],
      sessionCount: 2,
      tagCount: 3
    });

    const result = harness.commands.get("zion.sessions.excludeTagSubtreeBulk")({ path: "project" });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      sessionCount: 2,
      tagCount: 3
    }));
    expect(getIndexedSessionTags(harness.getIndex(), "s1")).toEqual(["alpha"]);
    expect(getIndexedSessionTags(harness.getIndex(), "s2")).toEqual(["beta"]);
  });
});
