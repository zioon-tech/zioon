import { describe, expect, it } from "vitest";
import { reconstructWidgetHistoryMessages } from "../src/chat/widget-history";

describe("chat widget history reconstruction", () => {
  it("keeps thinking and tool cards interleaved with assistant text", () => {
    const docText = [
      "user hi",
      "assistant <!-- zion-assistant:id=run-1 --> A",
      "思考 <!-- zion-thinking:id=thinking-1 -->",
      "B",
      "调用 read <!-- zion-tool:id=tool-1 -->",
      "C"
    ].join("\n");
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "A\nB\nC" }
    ];

    const out = reconstructWidgetHistoryMessages(messages, docText, {
      thinking: [{ id: "thinking-1", text: "reasoning", from: 999 }],
      tools: [{ id: "tool-1", name: "read", args: { path: "a.txt" }, result: "file contents", from: 1 }]
    });

    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "A" },
      { role: "assistant", content: "reasoning" },
      { role: "assistant", content: "B" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "tool-1",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) }
          }
        ]
      },
      { role: "tool", tool_call_id: "tool-1", content: "file contents" },
      { role: "assistant", content: "C" }
    ]);
  });

  it("preserves text and tool order when thinking is stored as reasoning_content", () => {
    const docText = [
      "assistant Before",
      "思考 <!-- zion-thinking:id=thinking-1 -->",
      "Middle",
      "调用 read <!-- zion-tool:id=tool-1 -->",
      "After"
    ].join("\n");
    const messages = [{ role: "assistant", content: "Before\nMiddle\nAfter" }];

    const out = reconstructWidgetHistoryMessages(messages, docText, {
      thinking: [{ id: "thinking-1", text: "reasoning" }],
      tools: [{ id: "tool-1", name: "read", args: {}, result: "ok" }]
    }, { preservedThinking: true });

    expect(out).toEqual([
      { role: "assistant", content: "Before", reasoning_content: "reasoning" },
      { role: "assistant", content: "Middle" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "tool-1",
            type: "function",
            function: { name: "read", arguments: "{}" }
          }
        ]
      },
      { role: "tool", tool_call_id: "tool-1", content: "ok" },
      { role: "assistant", content: "After" }
    ]);
  });

  it("injects widget-only assistant blocks between surrounding user messages", () => {
    const docText = [
      "user 看看 sensor-bench 里面有没有 las-asr 的调用，并测试一下。",
      "assistant ",
      "思考 <!-- zion-thinking:id=thinking-1 -->",
      "调用 write <!-- zion-tool:id=tool-1 -->",
      "思考 <!-- zion-thinking:id=thinking-2 -->",
      "调用 Bash <!-- zion-tool:id=tool-2 -->",
      "user 怎么样？"
    ].join("\n");
    const messages = [
      { role: "system", content: "comment context" },
      { role: "user", content: "看看 sensor-bench 里面有没有 las-asr 的调用，并测试一下。" },
      { role: "user", content: "怎么样？" }
    ];

    const out = reconstructWidgetHistoryMessages(messages, docText, {
      thinking: [
        { id: "thinking-1", text: "first reasoning" },
        { id: "thinking-2", text: "second reasoning" }
      ],
      tools: [
        { id: "tool-1", name: "write", args: { path: "a.md" }, result: "written" },
        { id: "tool-2", name: "Bash", args: { command: "pwd" }, result: "/tmp/project" }
      ]
    });

    expect(out).toEqual([
      { role: "system", content: "comment context" },
      { role: "user", content: "看看 sensor-bench 里面有没有 las-asr 的调用，并测试一下。" },
      { role: "assistant", content: "first reasoning" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "tool-1",
            type: "function",
            function: { name: "write", arguments: JSON.stringify({ path: "a.md" }) }
          }
        ]
      },
      { role: "tool", tool_call_id: "tool-1", content: "written" },
      { role: "assistant", content: "second reasoning" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "tool-2",
            type: "function",
            function: { name: "Bash", arguments: JSON.stringify({ command: "pwd" }) }
          }
        ]
      },
      { role: "tool", tool_call_id: "tool-2", content: "/tmp/project" },
      { role: "user", content: "怎么样？" }
    ]);
  });

  it("restores cards whose stale deletion markers conflict with live document anchors", () => {
    const docText = [
      "user inspect",
      "assistant <!-- zion-assistant:id=run-1 --> ",
      "思考 <!-- zion-thinking:id=thinking-1 -->",
      "调用 read <!-- zion-tool:id=tool-1 -->",
      "assistant done",
      "user continue"
    ].join("\n");
    const messages = [
      { role: "user", content: "inspect" },
      { role: "assistant", content: "done" },
      { role: "user", content: "continue" }
    ];

    const out = reconstructWidgetHistoryMessages(messages, docText, {
      thinking: [{
        id: "thinking-1",
        assistantBlockId: "run-1",
        text: "reasoning"
      }],
      tools: [{
        id: "tool-1",
        assistantBlockId: "run-1",
        name: "read",
        args: { path: "a.txt" },
        result: "contents"
      }],
      deletedThinkingIds: ["thinking-1"],
      deletedToolIds: ["tool-1"]
    }, {
      preservedThinking: true,
      interleavedThinking: true,
      forceReasoning: true
    });

    expect(out).toEqual([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        reasoning_content: "reasoning",
        tool_calls: [{
          id: "tool-1",
          type: "function",
          function: { name: "read", arguments: "{\"path\":\"a.txt\"}" }
        }]
      },
      { role: "tool", tool_call_id: "tool-1", content: "contents" },
      { role: "assistant", content: "done" },
      { role: "user", content: "continue" }
    ]);
  });

  it("keeps preserved reasoning interleaved with each historical tool step", () => {
    const docText = [
      "user inspect",
      "assistant <!-- zion-assistant:id=run-1 --> ",
      "思考 <!-- zion-thinking:id=thinking-1 -->",
      "调用 read <!-- zion-tool:id=tool-1 -->",
      "思考 <!-- zion-thinking:id=thinking-2 -->",
      "调用 grep <!-- zion-tool:id=tool-2 -->",
      "思考 <!-- zion-thinking:id=thinking-3 -->",
      "Final answer",
      "user continue"
    ].join("\n");
    const messages = [
      { role: "user", content: "inspect" },
      { role: "assistant", content: "Final answer" },
      { role: "user", content: "continue" }
    ];

    const out = reconstructWidgetHistoryMessages(messages, docText, {
      thinking: [
        { id: "thinking-1", assistantBlockId: "run-1", text: "reasoning 1" },
        { id: "thinking-2", assistantBlockId: "run-1", text: "reasoning 2" },
        { id: "thinking-3", assistantBlockId: "run-1", text: "reasoning 3" }
      ],
      tools: [
        {
          id: "tool-1",
          assistantBlockId: "run-1",
          name: "read",
          args: {},
          result: "read result"
        },
        {
          id: "tool-2",
          assistantBlockId: "run-1",
          name: "grep",
          args: {},
          result: "grep result"
        }
      ]
    }, {
      preservedThinking: true,
      interleavedThinking: true,
      forceReasoning: true
    });

    expect(out).toEqual([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        tool_calls: [{
          id: "tool-1",
          type: "function",
          function: { name: "read", arguments: "{}" }
        }],
        reasoning_content: "reasoning 1"
      },
      { role: "tool", tool_call_id: "tool-1", content: "read result" },
      {
        role: "assistant",
        tool_calls: [{
          id: "tool-2",
          type: "function",
          function: { name: "grep", arguments: "{}" }
        }],
        reasoning_content: "reasoning 2"
      },
      { role: "tool", tool_call_id: "tool-2", content: "grep result" },
      {
        role: "assistant",
        content: "Final answer",
        reasoning_content: "reasoning 3"
      },
      { role: "user", content: "continue" }
    ]);
  });
});
