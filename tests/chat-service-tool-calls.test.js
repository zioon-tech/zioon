import { describe, expect, it } from "vitest";
import {
  flushCompletedOpenAIToolCalls,
  ingestOpenAIToolCallDeltas
} from "../extensions/dev.langchain-chat/chat-service.js";

describe("OpenAI streamed tool call buffering", () => {
  it("buffers tool calls until the stream finish marker", () => {
    const buffer = [];
    const calls = [];

    expect(ingestOpenAIToolCallDeltas(buffer, [
      { index: 0, id: "call-1", function: { name: "list_files", arguments: "{\"session_id\":\"abc\"" } }
    ], { onToolCall: (tc) => calls.push(tc) })).toBe(0);
    expect(calls).toEqual([]);

    expect(ingestOpenAIToolCallDeltas(buffer, [
      { index: 0, function: { arguments: "}" } }
    ], { onToolCall: (tc) => calls.push(tc) })).toBe(0);
    expect(calls).toEqual([]);

    expect(flushCompletedOpenAIToolCalls(buffer, { onToolCall: (tc) => calls.push(tc) })).toBe(1);

    expect(calls).toEqual([
      { id: "call-1", name: "list_files", args: { session_id: "abc" } }
    ]);
  });

  it("flushes completed buffers at finish_reason tool_calls or DONE", () => {
    const buffer = [
      {
        id: "call-1",
        name: "list_files",
        arguments: "{\"description\":\"List project files\",\"session_id\":\"1d91d0a457fa\"}"
      }
    ];
    const events = [];
    const calls = [];

    const emitted = flushCompletedOpenAIToolCalls(buffer, {
      beforeControlEvent: (event) => events.push(event),
      onToolCall: (tc) => calls.push(tc)
    });

    expect(emitted).toBe(1);
    expect(events).toEqual(["toolCall"]);
    expect(calls).toEqual([
      {
        id: "call-1",
        name: "list_files",
        args: { description: "List project files", session_id: "1d91d0a457fa" }
      }
    ]);
    expect(flushCompletedOpenAIToolCalls(buffer, { onToolCall: (tc) => calls.push(tc) })).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("routes missing required arguments to invalid-tool feedback", () => {
    const buffer = [
      {
        id: "call-1",
        name: "Bash",
        arguments: "{}"
      }
    ];
    const calls = [];
    const invalid = [];
    const tools = [
      {
        type: "function",
        function: {
          name: "Bash",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"]
          }
        }
      }
    ];

    expect(flushCompletedOpenAIToolCalls(buffer, {
      tools,
      onToolCall: (tc) => calls.push(tc),
      onInvalidToolCall: (tc) => invalid.push(tc)
    })).toBe(1);

    expect(calls).toEqual([]);
    expect(invalid).toEqual([
      { id: "call-1", name: "Bash", args: {}, error: "missing required argument \"command\"" }
    ]);
  });
});
