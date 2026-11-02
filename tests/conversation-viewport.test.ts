import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginConversationViewportFollow,
  initializeConversationViewport,
  isConversationViewportFollowing,
  restoreConversationViewportStability,
  scheduleConversationViewportFollow,
  setConversationViewportFollowing
} from "../src/chat/conversation-viewport.js";

function createFrameHarness() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    callbacks.delete(id);
  });
  return {
    flush() {
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback(performance.now());
    }
  };
}

function createStateStore(initial: Array<[string, unknown]> = []) {
  const values = new Map<string, unknown>(initial);
  return {
    values,
    get(key: string) {
      return values.get(key);
    },
    set(key: string, value: unknown) {
      values.set(key, value);
    }
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("conversation viewport follow coordinator", () => {
  it("coalesces preparing, assistant insertion, and first token into one frame", () => {
    const frames = createFrameHarness();
    const state = createStateStore();
    const view = {};
    const reveals: string[] = [];

    beginConversationViewportFollow(view, {
      sessionId: "session-1",
      state,
      cycleId: "submission-1"
    });
    scheduleConversationViewportFollow(view, {
      sessionId: "session-1",
      state,
      cycleId: "submission-1",
      initial: true,
      reveal: () => {
        reveals.push("preparing");
        return true;
      }
    });
    scheduleConversationViewportFollow(view, {
      sessionId: "session-1",
      state,
      cycleId: "submission-1",
      initial: true,
      reveal: () => {
        reveals.push("assistant");
        return true;
      }
    });
    scheduleConversationViewportFollow(view, {
      sessionId: "session-1",
      state,
      cycleId: "submission-1",
      initial: true,
      reveal: () => {
        reveals.push("first-token");
        return true;
      }
    });

    frames.flush();
    expect(reveals).toEqual(["first-token"]);
    expect(scheduleConversationViewportFollow(view, {
      sessionId: "session-1",
      state,
      cycleId: "submission-1",
      initial: true,
      reveal: () => {
        reveals.push("stale-initial");
        return true;
      }
    })).toBe(false);
    frames.flush();
    expect(reveals).toEqual(["first-token"]);
  });

  it("does not let Run acceptance reattach a viewport after user detach", () => {
    const frames = createFrameHarness();
    const state = createStateStore();
    const view = {};
    const reveal = vi.fn(() => true);

    beginConversationViewportFollow(view, {
      sessionId: "session-1",
      state,
      cycleId: "submission-1"
    });
    scheduleConversationViewportFollow(view, {
      sessionId: "session-1",
      state,
      cycleId: "submission-1",
      initial: true,
      reveal
    });
    frames.flush();
    expect(reveal).toHaveBeenCalledTimes(1);

    setConversationViewportFollowing(view, false, {
      sessionId: "session-1",
      state
    });
    expect(scheduleConversationViewportFollow(view, {
      sessionId: "session-1",
      state,
      cycleId: "submission-1",
      initial: true,
      reveal
    })).toBe(false);
    frames.flush();
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("restores the submit baseline when layout anchoring moves a visible target", () => {
    const frames = createFrameHarness();
    const state = createStateStore();
    const view = {
      scrollDOM: {
        scrollTop: 120,
        scrollHeight: 1_000,
        clientHeight: 300
      }
    };

    beginConversationViewportFollow(view, {
      sessionId: "session-1",
      state,
      cycleId: "submission-1"
    });
    view.scrollDOM.scrollTop = 82;
    scheduleConversationViewportFollow(view, {
      sessionId: "session-1",
      state,
      cycleId: "submission-1",
      initial: true,
      reveal: () => true
    });

    frames.flush();
    expect(view.scrollDOM.scrollTop).toBe(120);

    view.scrollDOM.scrollTop = 74;
    expect(restoreConversationViewportStability(view, {
      sessionId: "session-1",
      state
    })).toBe(true);
    expect(view.scrollDOM.scrollTop).toBe(120);
  });

  it("restores the visual top anchor when document edits change block height", () => {
    const frames = createFrameHarness();
    const state = createStateStore();
    const view = {
      scrollDOM: {
        scrollTop: 125,
        scrollHeight: 1_000,
        clientHeight: 300,
        scrollLeft: 0
      },
      lineBlockAtHeight: vi.fn(() => ({
        from: 50,
        top: 120
      })),
      lineBlockAt: vi.fn(() => ({
        from: 60,
        top: 170
      }))
    };
    const update = {
      changes: {
        mapPos: vi.fn((pos: number) => pos + 10)
      }
    };

    beginConversationViewportFollow(view, {
      sessionId: "session-1",
      state,
      cycleId: "submission-1"
    });
    expect(restoreConversationViewportStability(view, {
      sessionId: "session-1",
      state,
      update
    })).toBe(false);

    scheduleConversationViewportFollow(view, {
      sessionId: "session-1",
      state,
      cycleId: "submission-1",
      initial: true,
      reveal: () => true
    });
    frames.flush();

    view.scrollDOM.scrollTop = 90;
    expect(restoreConversationViewportStability(view, {
      sessionId: "session-1",
      state
    })).toBe(true);
    expect(view.lineBlockAt).toHaveBeenCalledWith(60);
    expect(view.scrollDOM.scrollTop).toBe(175);
  });

  it("keeps split views independent after one view detaches", () => {
    const frames = createFrameHarness();
    const state = createStateStore([
      ["chat.followLatest.session-1", true]
    ]);
    const first = {};
    const second = {};
    const firstReveal = vi.fn(() => true);
    const secondReveal = vi.fn(() => true);

    initializeConversationViewport(first, {
      sessionId: "session-1",
      state
    });
    initializeConversationViewport(second, {
      sessionId: "session-1",
      state
    });
    setConversationViewportFollowing(first, false, {
      sessionId: "session-1",
      state
    });

    expect(state.values.get("chat.followLatest.session-1")).toBe(true);
    expect(isConversationViewportFollowing(first, {
      sessionId: "session-1",
      state
    })).toBe(false);
    expect(isConversationViewportFollowing(second, {
      sessionId: "session-1",
      state
    })).toBe(true);

    scheduleConversationViewportFollow(first, {
      sessionId: "session-1",
      state,
      reveal: firstReveal
    });
    scheduleConversationViewportFollow(second, {
      sessionId: "session-1",
      state,
      reveal: secondReveal
    });
    frames.flush();

    expect(firstReveal).not.toHaveBeenCalled();
    expect(secondReveal).toHaveBeenCalledTimes(1);
  });
});
