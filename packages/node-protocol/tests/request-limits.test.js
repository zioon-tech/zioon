import { describe, expect, it } from "vitest";
import {
  formatByteSize,
  parseByteSize,
  requestBodyLimitError
} from "../src/index.mjs";

describe("request size limits", () => {
  it("parses human-readable byte sizes", () => {
    expect(parseByteSize("8MiB")).toBe(8 * 1024 * 1024);
    expect(parseByteSize("2 MB")).toBe(2_000_000);
    expect(parseByteSize("512KiB")).toBe(512 * 1024);
    expect(parseByteSize("1048576")).toBe(1024 * 1024);
  });

  it("formats limits for error messages", () => {
    expect(formatByteSize(8 * 1024 * 1024)).toBe("8 MiB");
    expect(formatByteSize(1536)).toBe("1.5 KiB");
  });

  it("rejects invalid and unsafe values", () => {
    expect(() => parseByteSize("large")).toThrow("invalid");
    expect(() => parseByteSize("0")).toThrow("between");
  });

  it("creates structured request body limit errors", () => {
    const error = requestBodyLimitError("Request body", 8 * 1024 * 1024);
    expect(error).toMatchObject({
      statusCode: 413,
      code: "request_body_limit_exceeded",
      limitBytes: 8 * 1024 * 1024,
      limit: "8 MiB"
    });
    expect(error.hints).toContain(
      "For long conversations, create a handoff summary or compression snapshot."
    );
  });
});
