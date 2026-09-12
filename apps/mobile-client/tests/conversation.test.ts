import { describe, expect, it } from "vitest";
import {
  buildConversationItems,
  meaningfulSessionTitle,
  summarizeToolCall,
  toolResultOk,
  transcriptOutsideActiveRun,
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
      id: "final",
      content: "Final answer",
      reasoningContent: "Plan search\n\nChoose official source\n\nSynthesize",
    });
    expect(items[1].message.toolCalls?.map((call) => call.id))
      .toEqual(["call-1", "call-2"]);
    expect(Object.keys(items[1].toolResults)).toEqual(["call-1", "call-2"]);
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

  it("lets the live projection own assistant and tool messages for its Run", () => {
    const messages = [
      message({ role: "user", runId: "run-live", sequence: 1 }),
      message({ role: "assistant", runId: "run-live", sequence: 2 }),
      message({ role: "tool", runId: "run-live", sequence: 3 }),
      message({ role: "assistant", runId: "run-old", sequence: 4 }),
    ];

    expect(transcriptOutsideActiveRun(messages, "run-live").map((item) => item.sequence))
      .toEqual([1, 4]);
  });

  it("treats generated Session placeholders as missing titles", () => {
    expect(meaningfulSessionTitle("新会话")).toBe("");
    expect(meaningfulSessionTitle("Release review")).toBe("Release review");
  });
});
