import { describe, expect, it } from "vitest";
import {
  conversationInputCommand,
  conversationRequestFingerprint,
  createConversationInputSnapshot,
  snapshotContextMessages
} from "../src/conversation-input.mjs";

describe("conversation input versions", () => {
  const command = { clientRequestId: "submission-1" };
  const request = {
    messages: [{ role: "assistant", content: "edited answer" }],
    model: { providerId: "local", modelId: "test" },
    policy: { allowedTools: ["read"] }
  };

  it("accepts complete explicit context ending with an assistant", () => {
    const snapshot = createConversationInputSnapshot({
      id: "input-1", sessionId: "s1", command, request, createdAt: 1
    });
    expect(snapshot.contextMessages).toEqual(request.messages);
    expect(snapshotContextMessages(snapshot)).toEqual([{
      schemaVersion: 1, id: "input:input-1:1", sessionId: "s1",
      inputSnapshotId: "input-1", sequence: 1, createdAt: 1,
      provenance: "submitted-context", role: "assistant", content: "edited answer"
    }]);
  });

  it("copies the accepted context instead of retaining caller references", () => {
    const mutable = structuredClone(request);
    const snapshot = createConversationInputSnapshot({
      id: "input-1", sessionId: "s1", command, request: mutable
    });
    mutable.messages[0].content = "later edit";
    mutable.policy.allowedTools.push("write");
    expect(snapshot.messages).toEqual(request.messages);
    expect(snapshot.policy.allowedTools).toEqual(["read"]);
  });

  it("separates submitted conversation history from per-run contributor context", () => {
    const contextMessages = [{ role: "user", content: "question" }];
    const messages = [{ role: "system", content: "dynamic context" }, ...contextMessages];
    const snapshot = createConversationInputSnapshot({
      id: "input-1", sessionId: "s1", command,
      request: { ...request, messages, sessionHistory: contextMessages }
    });
    expect(snapshot.messages).toEqual(messages);
    expect(snapshotContextMessages(snapshot)).toHaveLength(1);
    expect(snapshotContextMessages(snapshot)[0].content).toBe("question");
  });

  it("ignores transport timings and key ordering when comparing retries", () => {
    const a = { ...request, metadata: { skills: { enabled: ["a"] }, chatSubmission: { at: 1 }, documentProjection: { anchor: 12 } } };
    const b = { ...request, metadata: { documentProjection: { anchor: 20 }, chatSubmission: { at: 2 }, skills: { enabled: ["a"] } } };
    expect(conversationRequestFingerprint(a)).toBe(conversationRequestFingerprint(b));
    expect(conversationRequestFingerprint({ ...a, messages: [{ role: "user", content: "different" }] }))
      .not.toBe(conversationRequestFingerprint(a));
  });

  it.each([
    { schemaVersion: 2, mode: "snapshot", clientRequestId: "s" },
    { schemaVersion: 1, mode: "append", clientRequestId: "s" },
    { schemaVersion: 1, mode: "snapshot", clientRequestId: "" }
  ])("rejects unsupported or unidentifiable submissions", conversationInput => {
    expect(() => conversationInputCommand({ sessionId: "s1", conversationInput })).toThrow();
  });

  it("keeps the existing Run interface available without a conversation snapshot", () => {
    expect(conversationInputCommand({ messages: request.messages })).toBeNull();
    expect(conversationInputCommand({
      sessionId: "s1", conversationInput: { schemaVersion: 1, mode: "snapshot", ...command }
    })).toEqual(command);
  });
});
