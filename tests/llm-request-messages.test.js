import { describe, expect, it } from "vitest";
import {
  extractRequestMessages
} from "../extensions/dev.llm-payloads/request-messages.js";

describe("LLM request message extraction", () => {
  it("preserves OpenAI and Claude system messages", () => {
    expect(extractRequestMessages({
      system: "Claude system",
      messages: [{ role: "user", content: "hello" }]
    })).toEqual([
      { role: "system", content: "Claude system" },
      { role: "user", content: "hello" }
    ]);

    expect(extractRequestMessages({
      messages: [
        { role: "system", content: "OpenAI system" },
        { role: "user", content: "hello" }
      ]
    })).toHaveLength(2);
  });

  it("normalizes Gemini contents for the message panel", () => {
    expect(extractRequestMessages({
      systemInstruction: {
        parts: [{ text: "Gemini system" }]
      },
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "response" }] }
      ]
    })).toEqual([
      {
        role: "system",
        content: [{ text: "Gemini system" }]
      },
      {
        role: "user",
        parts: [{ text: "hello" }],
        content: [{ text: "hello" }]
      },
      {
        role: "assistant",
        parts: [{ text: "response" }],
        content: [{ text: "response" }]
      }
    ]);
  });
});
