import { describe, expect, it, vi } from "vitest";
import {
  getSessionRunIndicatorStatus,
  markSessionRunViewed
} from "../extensions/dev.session-manager/features/run-state.js";

describe("session run indicators", () => {
  it("maps active and unread terminal states to distinct indicators", () => {
    expect(getSessionRunIndicatorStatus({ streaming: true })).toBe("streaming");
    expect(getSessionRunIndicatorStatus({ awaiting: true })).toBe("ready");
    expect(getSessionRunIndicatorStatus({ awaiting: true, error: true })).toBe("error");
    expect(getSessionRunIndicatorStatus({ awaiting: true, aborted: true })).toBe("aborted");
  });

  it("hides terminal indicators after the session is viewed", () => {
    expect(getSessionRunIndicatorStatus({ awaiting: false, error: true })).toBe("");
    expect(getSessionRunIndicatorStatus({ awaiting: false, aborted: true })).toBe("");
  });

  it("does not publish a state update when there is nothing to mark as viewed", () => {
    const update = vi.fn();
    const zion = {
      state: {
        get: () => ({ streaming: true, awaiting: false }),
        update
      }
    };

    expect(markSessionRunViewed(zion, "session-1")).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("marks an unread run as viewed without discarding its terminal result", () => {
    const values = new Map([
      ["chat.runs.session-1", { runId: "run-1", awaiting: true, error: true }]
    ]);
    const set = vi.fn((key, value) => values.set(key, value));
    const zion = {
      state: {
        get: (key) => values.get(key),
        set,
        update: (key, updater) => set(key, updater(values.get(key)))
      }
    };

    expect(markSessionRunViewed(zion, "session-1")).toBe(true);
    expect(values.get("chat.runs.session-1")).toEqual({
      runId: "run-1",
      awaiting: false,
      error: true
    });
    expect(getSessionRunIndicatorStatus(values.get("chat.runs.session-1"))).toBe("");
  });
});
