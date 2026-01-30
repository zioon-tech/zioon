import { describe, it, expect } from "vitest";
import {
  DEFAULT_REASONING_CONTENT_PLACEHOLDER,
  normalizeToolCallsReasoningContentMode,
  isLikelyReasoningModelId,
  shouldForceReasoningContentWithToolCalls,
  patchMessagesForReasoningContentToolCalls
} from "../extensions/dev.langchain-chat/reasoning-policy";

describe("tool-calls reasoning policy", () => {
  it("normalizes mode", () => {
    expect(normalizeToolCallsReasoningContentMode(undefined)).toBe("auto");
    expect(normalizeToolCallsReasoningContentMode("AUTO")).toBe("auto");
    expect(normalizeToolCallsReasoningContentMode(true)).toBe("always");
    expect(normalizeToolCallsReasoningContentMode("on")).toBe("always");
    expect(normalizeToolCallsReasoningContentMode(false)).toBe("never");
    expect(normalizeToolCallsReasoningContentMode("off")).toBe("never");
  });

  it("infers likely reasoning models", () => {
    expect(isLikelyReasoningModelId("deepseek-reasoner")).toBe(true);
    expect(isLikelyReasoningModelId("kimi-k2.5")).toBe(true);
    expect(isLikelyReasoningModelId("deepseek-chat")).toBe(false);
  });

  it("forces reasoning_content for tool_calls when configured or inferred", () => {
    expect(shouldForceReasoningContentWithToolCalls({ mode: "always", modelId: "deepseek-chat" })).toBe(true);
    expect(shouldForceReasoningContentWithToolCalls({ mode: "never", modelId: "deepseek-reasoner" })).toBe(false);
    expect(shouldForceReasoningContentWithToolCalls({ mode: "auto", modelId: "deepseek-reasoner" })).toBe(true);
    expect(shouldForceReasoningContentWithToolCalls({ mode: "auto", modelId: "deepseek-chat" })).toBe(false);
  });

  it("patches assistant.tool_calls messages only", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", tool_calls: [{ id: "1" }], content: "" },
      { role: "tool", tool_call_id: "1", content: "ok" },
      { role: "assistant", content: "done" }
    ];

    const noForce = patchMessagesForReasoningContentToolCalls(msgs, { force: false });
    expect(noForce).toBe(msgs);

    const forced = patchMessagesForReasoningContentToolCalls(msgs, { force: true });
    expect(forced).not.toBe(msgs);
    expect(forced[1].reasoning_content).toBe(DEFAULT_REASONING_CONTENT_PLACEHOLDER);
    expect(forced[0].reasoning_content).toBeUndefined();
    expect(forced[2].reasoning_content).toBeUndefined();
  });
});
