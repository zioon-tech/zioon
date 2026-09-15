import { describe, expect, it } from "vitest";
import {
  buildConversationItems,
  meaningfulSessionTitle,
  summarizeToolCall,
  toolResultOk,
  projectionIsPersisted,
} from "../src/conversation";
import type { AssistantToolCall, SessionMessage } from "../src/types";

function toolCall(name = "Bash"): AssistantToolCall {
  return {
    id: "call-1",
    type: "function",
    function: {
      name,
      arguments: JSON.stringify({ command: "pwd" }),
    },
  };
}

function message(patch: Partial<SessionMessage>): SessionMessage {
  return {
    id: patch.id || `message-${patch.sequence || 1}`,
    sequence: patch.sequence || 1,
    role: patch.role || "assistant",
    content: patch.content || "",
    ...patch,
  };
}

describe("Mobile conversation projection", () => {
  it("attaches tool results to assistant calls instead of rendering raw tool messages", () => {
    const call = toolCall();
    const items = buildConversationItems([
      message({ role: "user", content: "Where am I?", sequence: 1 }),
      message({ role: "assistant", toolCalls: [call], sequence: 2 }),
      message({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify({ ok: true, stdout: "/workspace/project\n" }),
        sequence: 3,
      }),
      message({ role: "assistant", content: "You are in the project.", sequence: 4 }),
    ]);

    expect(items.map((item) => item.message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    expect(items[1].toolResults[call.id]).toMatchObject({ role: "tool" });
    expect(summarizeToolCall(call, items[1].toolResults[call.id]))
      .toBe("/workspace/project");
  });

  it("groups completed assistant and tool rounds from the same Run", () => {
    const search = toolCall("webSearch");
    const fetchCall = {
      ...toolCall("webFetch"),
      id: "call-2",
    };
    const items = buildConversationItems([
      message({ role: "user", content: "Find news", runId: "run-1", sequence: 1 }),
      message({
        role: "assistant",
        reasoningContent: "Plan search",
        toolCalls: [search],
        runId: "run-1",
        sequence: 2,
      }),
      message({
        role: "tool",
        toolCallId: search.id,
        content: JSON.stringify({ ok: true, results: [] }),
        runId: "run-1",
        sequence: 3,
      }),
      message({
        role: "assistant",
        content: "Checking sources.",
        reasoningContent: "Choose official source",
        toolCalls: [fetchCall],
        runId: "run-1",
        sequence: 4,
      }),
      message({
        role: "tool",
        toolCallId: fetchCall.id,
        content: "Fetched source",
        runId: "run-1",
        sequence: 5,
      }),
      message({
        id: "final",
        role: "assistant",
        content: "Final answer",
        reasoningContent: "Synthesize",
        runId: "run-1",
        sequence: 6,
      }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[1].message).toMatchObject({
      content: "Checking sources.\n\nFinal answer",
      reasoningContent: "Plan search\n\nChoose official source\n\nSynthesize",
    });
    expect(items[1].message.toolCalls?.map((call) => call.id))
      .toEqual(["call-1", "call-2"]);
    expect(Object.keys(items[1].toolResults)).toEqual(["call-1", "call-2"]);
    expect(items[1].blocks.map((block) => block.kind)).toEqual([
      "reasoning", "tool", "reasoning", "text", "tool", "reasoning", "text",
    ]);
  });

  it("keeps intermediate assistant text from tool turns after the Run completes", () => {
    const read = toolCall("read");
    const bash = { ...toolCall("Bash"), id: "call-2" };
    const items = buildConversationItems([
      message({ role: "user", content: "Inspect this repo", runId: "run-1", sequence: 1 }),
      message({
        role: "assistant",
        content: "我先看一下项目结构。",
        toolCalls: [read],
        runId: "run-1",
        sequence: 2,
      }),
      message({
        role: "tool",
        toolCallId: read.id,
        content: JSON.stringify({ ok: true, path: "package.json" }),
        runId: "run-1",
        sequence: 3,
      }),
      message({
        role: "assistant",
        content: "项目是 Vite + React，接着跑移动端测试。",
        toolCalls: [bash],
        runId: "run-1",
        sequence: 4,
      }),
      message({
        role: "tool",
        toolCallId: bash.id,
        content: JSON.stringify({ ok: true, stdout: "19 passed" }),
        runId: "run-1",
        sequence: 5,
      }),
      message({
        id: "final",
        role: "assistant",
        content: "结论：移动端对话投影需要统一。",
        runId: "run-1",
        sequence: 6,
      }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[1].message.content).toBe([
      "我先看一下项目结构。",
      "项目是 Vite + React，接着跑移动端测试。",
      "结论：移动端对话投影需要统一。",
    ].join("\n\n"));
    expect(items[1].message.toolCalls?.map((call) => call.id))
      .toEqual(["call-1", "call-2"]);
    expect(items[1].blocks.map((block) => block.kind))
      .toEqual(["text", "tool", "text", "tool", "text"]);
  });

  it("derives tool failure state from canonical result payloads", () => {
    expect(toolResultOk(message({
      role: "tool",
      toolCallId: "call-1",
      content: JSON.stringify({ ok: false, error: "permission denied" }),
    }))).toBe(false);
    expect(toolResultOk(message({
      role: "tool",
      toolCallId: "call-1",
      content: "Error: command timed out",
    }))).toBe(false);
  });

  it("keeps live blocks while the canonical transcript is incomplete", () => {
    const messages = [
      message({ role: "user", runId: "run-live", sequence: 1 }),
      message({ role: "assistant", runId: "run-live", sequence: 2, content: "First" }),
    ];
    const projection = {
      runId: "run-live", status: "completed" as const, error: "",
      blocks: [
        { id: "run-live:turn:1:text", turn: 1, kind: "text" as const, content: "First" },
        { id: "run-live:turn:2:text", turn: 2, kind: "text" as const, content: "Final" },
      ],
    };
    const live = buildConversationItems(messages, [projection]);
    expect(live[1].message.content).toBe("First\n\nFinal");
    expect(projectionIsPersisted(messages, projection)).toBe(false);
    const complete = [...messages, message({ role: "assistant", runId: "run-live", sequence: 3, content: "Final" })];
    expect(projectionIsPersisted(complete, projection)).toBe(true);
    const history = buildConversationItems(complete);
    expect(history[1].key).toBe(live[1].key);
    expect(history[1].blocks.map((block) => block.id)).toEqual(live[1].blocks.map((block) => block.id));
  });

  it("preserves repeated and overlapping text in distinct assistant turns", () => {
    const items = buildConversationItems(["Checking.", "Checking.", "Checking. Again.", "Again."].map((content, index) =>
      message({ sequence: index + 1, content, runId: "run-1" })
    ));
    expect(items[0].blocks.map((block) => block.kind === "text" && block.content))
      .toEqual(["Checking.", "Checking.", "Checking. Again.", "Again."]);
  });

  it("deduplicates message identities, not repeated text, and keeps tool results scoped by Run", () => {
    const call = toolCall();
    const first = message({ sequence: 1, runId: "one", toolCalls: [call] });
    const second = message({ sequence: 3, runId: "two", toolCalls: [call] });
    const items = buildConversationItems([
      first, { ...first },
      message({ sequence: 2, runId: "one", role: "tool", toolCallId: call.id, content: '{"ok":false,"error":"denied"}' }),
      second,
      message({ sequence: 4, runId: "two", role: "tool", toolCallId: call.id, content: '{"ok":true}' }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].blocks[0]).toMatchObject({ kind: "tool", status: "failed" });
    expect(items[1].blocks[0]).toMatchObject({ kind: "tool", status: "completed" });
  });

  it("does not invent a successful result for an interrupted tool", () => {
    expect(buildConversationItems([message({ toolCalls: [toolCall()], runId: "r" })])[0].blocks[0])
      .toMatchObject({ kind: "tool", status: "interrupted" });
    expect(buildConversationItems([message({ role: "system" })])).toEqual([]);
  });

  it("does not downgrade a completed live tool when history has only its request", () => {
    const call = toolCall();
    const result = message({ role: "tool", runId: "r", toolCallId: call.id, content: '{"ok":true}' });
    const projection = {
      runId: "r", status: "completed" as const, error: "",
      blocks: [{ id: "r:turn:1:tool:call-1", turn: 1, kind: "tool" as const, call, result, status: "completed" as const }],
    };
    const partial = [message({ runId: "r", toolCalls: [call], sequence: 1 })];
    expect(buildConversationItems(partial, [projection])[0].blocks[0]).toMatchObject({ status: "completed", result });
    expect(projectionIsPersisted(partial, projection)).toBe(false);
  });

  it("keeps a previous pending reply ahead of the next user turn", () => {
    const messages = [
      message({ role: "user", content: "Question 1", runId: "r1", sequence: 1 }),
      message({ role: "user", content: "Question 2", runId: "r2", sequence: 2 }),
    ];
    const items = buildConversationItems(messages, [
      { runId: "r1", status: "completed", error: "", blocks: [{ id: "r1:turn:1:text", turn: 1, kind: "text", content: "Answer 1" }] },
      { runId: "r2", status: "running", error: "", blocks: [{ id: "r2:turn:1:text", turn: 1, kind: "text", content: "Answer 2" }] },
    ]);
    expect(items.map((item) => item.message.content)).toEqual(["Question 1", "Answer 1", "Question 2", "Answer 2"]);
  });

  it("treats generated Session placeholders as missing titles", () => {
    expect(meaningfulSessionTitle("新会话")).toBe("");
    expect(meaningfulSessionTitle("session_8cfd7337569f4d64", "session_8cfd7337569f4d64")).toBe("");
    expect(meaningfulSessionTitle("Session 12", "session_8cfd7337569f4d64", { titleAuto: true })).toBe("");
    expect(meaningfulSessionTitle("Session 12", "session_8cfd7337569f4d64", { titleAuto: false })).toBe("Session 12");
    expect(meaningfulSessionTitle("session-mobile")).toBe("session-mobile");
    expect(meaningfulSessionTitle("Release review")).toBe("Release review");
  });
});
