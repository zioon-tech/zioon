import { describe, expect, it } from "vitest";
import { repairToolCallMessageOrder } from "../src/chat/message-order";

describe("tool call message order repair", () => {
  it("moves injected context after required tool messages", () => {
    const messages = [
      { role: "user", content: "List files" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "list_files", arguments: "{}" }
          }
        ]
      },
      { role: "system", content: "【评论上下文】\n评论总结：keep this in mind" },
      { role: "tool", tool_call_id: "call-1", content: "a.ts\nb.ts" },
      { role: "assistant", content: "Found two files." }
    ];

    expect(repairToolCallMessageOrder(messages)).toEqual([
      messages[0],
      messages[1],
      messages[3],
      messages[2],
      messages[4]
    ]);
  });

  it("leaves already valid tool call groups unchanged", () => {
    const messages = [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "read_file", arguments: "{}" }
          }
        ]
      },
      { role: "tool", tool_call_id: "call-1", content: "ok" },
      { role: "user", content: "continue" }
    ];

    expect(repairToolCallMessageOrder(messages)).toBe(messages);
  });
});
