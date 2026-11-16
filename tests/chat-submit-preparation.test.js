import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { captureDocumentInput } from "../src/chat/document-input";
import { appendConversationDraft } from "../src/chat/conversation-draft.js";

describe("interactive chat preparation", () => {
  it("freezes the selected input before async preparation while allowing later typing", async () => {
    const source = fs.readFileSync("extensions/dev.langchain-chat/main.js", "utf8");
    const begin = source.indexOf("  const doRun = async");
    const end = source.indexOf("  // 注册命令", begin);
    let text = "user secret context\nuser selected\nuser later";
    const from = text.indexOf("user selected");
    const to = text.indexOf("\nuser later");
    const editor = {
      getValue: () => text, getCursor: () => ({ line: 1, ch: 0 }),
      getView: () => ({ state: { selection: { main: { from, to } } } })
    };
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let input;
    let actor = { userId: "alice", spaceId: "space-a" };
    let capturedAccount;
    const invoke = Object.getPrototypeOf(async function() {}).constructor;
    const run = new invoke("accountCan", "getEd", "getSessionId", "getRunState",
      "interactivePreparations", "crypto", "beginConversationViewportFollow", "window",
      "runtime", "pendingRecoveryRuns", "recoverInteractiveRuntimeRun", "performRun", "captureDocumentInput", "captureInteractiveRuntimeAccount",
      source.slice(begin, end) + "return doRun({ useSelection: true });");
    const pending = run(
      () => true, () => editor, () => "s", () => ({}), new Map(),
      { randomUUID: () => "snapshot" }, () => {},
      { zion: { events: { emit: vi.fn() }, state: { get() {} } } },
      { beginRun() {}, setController() {}, clearController() {}, isRunActive: () => false },
      new Map(), vi.fn(), async (_opts, preparation) => {
        await gate;
        input = preparation.inputSnapshot;
        capturedAccount = preparation.expectedAccount;
      }, captureDocumentInput, () => ({ ...actor })
    );
    text = "user changed while sending";
    actor = { userId: "bob", spaceId: "space-a" };
    release();
    await pending;
    expect(input.messages).toEqual([{ role: "user", content: "selected" }]);
    expect(input.documentText).toContain("user later");
    expect(editor.getValue()).toBe("user changed while sending");
    expect(capturedAccount).toEqual({ userId: "alice", spaceId: "space-a" });
  });

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

  it("shows local feedback immediately and clears it when preparation is cancelled", async () => {
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
    const run = new invoke("accountCan", "getEd", "getSessionId", "getRunState", "interactivePreparations", "crypto", "beginConversationViewportFollow", "window", "runtime", "pendingRecoveryRuns", "recoverInteractiveRuntimeRun", "performRun", "captureDocumentInput", "appendConversationDraft", "captureInteractiveRuntimeAccount",
      source.slice(begin, end) + "return doRun();");
    const pending = run(
      () => true, () => ({ getView: () => null }), () => "s", () => ({}), new Map(),
      { randomUUID: () => "local" }, () => {}, { zion: { events: { emit }, state: { get() {} } } },
      runtime, new Map(), vi.fn(),
      async (_opts, preparation) => { await gate; return { aborted: preparation.signal.aborted }; },
      () => ({ documentText: "user question", insertionOffset: 13 }), appendConversationDraft, () => null
    );
    expect(state.get("runId")).toBe("preparing-local");
    expect(emit).toHaveBeenCalledWith("chat/preparing", expect.objectContaining({
      submissionId: "preparing-local", answerAnchorPos: 13
    }));
    expect(emit.mock.calls.find(([topic]) => topic === "chat/preparing")[1]).not.toHaveProperty("status");
    state.get("controller").abort();
    release();
    await expect(pending).resolves.toEqual({ aborted: true });
    expect(emit.mock.calls.filter(([topic]) => topic === "chat/prepared")).toHaveLength(1);
  });
});
