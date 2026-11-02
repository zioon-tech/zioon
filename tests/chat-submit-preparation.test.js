import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

describe("interactive chat preparation", () => {
  it("assembles the seed history while contributors run and preserves their separate messages", async () => {
    const source = fs.readFileSync("extensions/dev.langchain-chat/main.js", "utf8");
    const begin = source.indexOf("      const [preparedMessages, sessionHistory]", source.indexOf("const runInteractiveThroughRuntime"));
    const end = source.indexOf("      preparation?.signal.throwIfAborted();", begin);
    expect(begin).toBeGreaterThan(0);
    const calls = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const messages = [{ role: "user", content: "hello" }];
    const contributorMessages = [{ role: "system", content: "context" }, ...messages];
    const assemble = Object.getPrototypeOf(async function() {}).constructor;
    const run = new assemble("prepareInteractiveRuntimeMessages", "reconstructHistory", "messages", "contributorContext", "selectedModelConfig", "window",
      source.slice(begin, end) + "return { preparedMessages, sessionHistory };");
    const result = run(
      async opts => {
        calls.push("contributors");
        await gate;
        return opts.transformMessages(contributorMessages);
      },
      async items => { calls.push(items === messages ? "seed" : "prepared"); return [...items]; },
      messages, {}, {}, { zion: {} }
    );
    await Promise.resolve();
    expect(calls).toEqual(["contributors", "seed"]);
    release();
    await expect(result).resolves.toEqual({ preparedMessages: contributorMessages, sessionHistory: messages });
    expect(calls).toEqual(["contributors", "seed", "prepared"]);
  });

  it("keeps preparation cancellable without rendering a synthetic assistant placeholder", async () => {
    const source = fs.readFileSync("extensions/dev.langchain-chat/main.js", "utf8");
    const begin = source.indexOf("  const doRun = async");
    const end = source.indexOf("  // 注册命令", begin);
    const state = new Map();
    const runtime = {
      beginRun: (_sid, id) => state.set("runId", id),
      setController: (_sid, controller) => state.set("controller", controller),
      clearController: vi.fn(), isRunActive: () => true, markAwaiting: vi.fn()
    };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const emit = vi.fn();
    const invoke = Object.getPrototypeOf(async function() {}).constructor;
    const run = new invoke("accountCan", "getEd", "getSessionId", "getRunState", "interactivePreparations", "crypto", "beginConversationViewportFollow", "window", "runtime", "pendingRecoveryRuns", "recoverInteractiveRuntimeRun", "performRun",
      source.slice(begin, end) + "return doRun();");
    const pending = run(
      () => true, () => ({ getView: () => null }), () => "s", () => ({}), new Map(),
      { randomUUID: () => "local" }, () => {}, { zion: { events: { emit }, state: { get() {} } } },
      runtime, new Map(), vi.fn(),
      async (_opts, preparation) => { await gate; return { aborted: preparation.signal.aborted }; }
    );
    expect(state.get("runId")).toBe("preparing-local");
    state.get("controller").abort();
    release();
    await expect(pending).resolves.toEqual({ aborted: true });
    expect(emit).not.toHaveBeenCalled();
  });
});
