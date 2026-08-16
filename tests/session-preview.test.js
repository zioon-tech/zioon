import { describe, expect, it } from "vitest";
import { extractLastUserMessagePreview } from "../extensions/shared/session-preview.js";

describe("session preview", () => {
  it("uses the latest explicit user block", () => {
    expect(extractLastUserMessagePreview([
      "user first question",
      "assistant first answer",
      "user latest question",
      "with a second line",
      "assistant latest answer"
    ].join("\n"))).toBe("latest question with a second line");
  });

  it("skips a trailing empty user block", () => {
    expect(extractLastUserMessagePreview([
      "user meaningful question",
      "assistant completed answer",
      "user   ",
      "",
      "  "
    ].join("\n"))).toBe("meaningful question");
  });

  it("uses implicit opening content as a user message", () => {
    expect(extractLastUserMessagePreview([
      "#project/zion",
      "",
      "Please review the sidebar.",
      "assistant Done."
    ].join("\n"))).toBe("#project/zion Please review the sidebar.");
  });

  it("compacts whitespace and truncates long previews", () => {
    expect(extractLastUserMessagePreview(
      "user   one\n\n  two   three",
      12
    )).toBe("one two thr…");
  });

  it("returns an empty string when no user content exists", () => {
    expect(extractLastUserMessagePreview("assistant answer only")).toBe("");
  });
});
