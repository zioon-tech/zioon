import { describe, expect, it } from "vitest";
import { createSessionReadScheduler } from "../extensions/dev.session-manager/storage/read-scheduler.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
describe("session read scheduling", () => {
  it("coalesces in-flight requests, limits concurrency and prioritizes visible panes", async () => {
    const scheduler = createSessionReadScheduler({ concurrency: 1 });
    let complete;
    const started = [];
    const first = scheduler.read("visible", () => {
      started.push("visible");
      return new Promise(resolve => { complete = resolve; });
    });
    const duplicate = scheduler.read("visible", () => { throw new Error("duplicate dispatch"); });
    expect(duplicate).toBe(first);
    const background = scheduler.read("metadata", () => { started.push("metadata"); }, 1);
    const current = scheduler.read("next-pane", () => { started.push("next-pane"); }, 0);
    await tick();
    expect(started).toEqual(["visible"]);
    expect(scheduler.stats()).toMatchObject({ active: 1, queued: 2 });
    complete("original result");
    expect(await duplicate).toBe("original result");
    await Promise.all([first, background, current]);
    expect(started).toEqual(["visible", "next-pane", "metadata"]);
  });

  it("releases the slot after errors and never retains a failed read", async () => {
    const scheduler = createSessionReadScheduler({ concurrency: 1 });
    const failed = scheduler.read("a", () => { throw new Error("offline"); });
    const queued = scheduler.read("b", () => "ready");
    await expect(failed).rejects.toThrow("offline");
    expect(await queued).toBe("ready");
    expect(await scheduler.read("a", () => "retry")).toBe("retry");
  });
});
