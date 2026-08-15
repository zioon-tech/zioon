import { describe, expect, it } from "vitest";
import { createToolCardId, resolveToolCardId } from "../src/chat/tool-card-id";

describe("tool card ids", () => {
  it("scopes provider ids by run", () => {
    expect(createToolCardId("run-1", "call-1")).toBe("tool:run-1:call-1");
    expect(createToolCardId("run-2", "call-1")).toBe("tool:run-2:call-1");
  });

  it("keeps legacy ids when no run is available", () => {
    expect(createToolCardId(null, "call-1")).toBe("call-1");
  });

  it("uses the explicit card id for call and result events", () => {
    const cardId = "tool:run-1:call-1";
    expect(resolveToolCardId({
      runId: "run-1",
      cardId,
      toolCall: { id: "call-1", cardId }
    })).toBe(cardId);
    expect(resolveToolCardId({
      runId: "run-1",
      cardId,
      toolCallId: "call-1"
    })).toBe(cardId);
  });

  it("encodes ids before embedding them in document markers", () => {
    expect(createToolCardId("run with spaces", "call/1")).toBe("tool:run%20with%20spaces:call%2F1");
  });
});
