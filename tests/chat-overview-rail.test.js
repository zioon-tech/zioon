import { describe, expect, it } from "vitest";
import { findAssistantBlockRange } from "../extensions/dev.langchain-chat/overview-rail.js";

describe("chat overview rail", () => {
  it("finds the active assistant block from the preferred head line", () => {
    const text = [
      "user 你好",
      "assistant 第一行",
      "第二行",
      "",
      "user 下一条"
    ].join("\n");

    expect(findAssistantBlockRange(text, 1)).toEqual({
      headLine: 1,
      endLine: 3,
      lineCount: 5
    });
  });

  it("falls back to the latest assistant block when the preferred line is stale", () => {
    const text = [
      "user A",
      "assistant 老回答",
      "",
      "user B",
      "assistant 新回答",
      "补充一行"
    ].join("\n");

    expect(findAssistantBlockRange(text, 99)).toEqual({
      headLine: 4,
      endLine: 5,
      lineCount: 6
    });
  });

  it("returns null when the document has no assistant block", () => {
    expect(findAssistantBlockRange("user only", 0)).toBeNull();
  });
});
