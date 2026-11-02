import { describe, expect, it } from "vitest";
import { inferToolResultError } from "../extensions/dev.langchain-chat/tool-result-diagnostics.js";

describe("tool result diagnostics", () => {
  it("extracts SSH banner failures from Bash JSON results", () => {
    const result = JSON.stringify({
      command: "ssh host.example.com",
      ok: false,
      exit_code: 255,
      stdout: "",
      stderr: "Error reading SSH protocol banner"
    });

    expect(inferToolResultError("Bash", result, false)).toBe("Error reading SSH protocol banner");
  });

  it("extracts timeout and non-zero exit failures without requiring thrown errors", () => {
    expect(inferToolResultError("Bash", JSON.stringify({
      ok: false,
      exit_code: 124,
      stderr: "Command timed out after 120000ms"
    }))).toBe("Command timed out after 120000ms");

    expect(inferToolResultError("Bash", JSON.stringify({
      exit_code: 2,
      stderr: "No such file or directory"
    }))).toBe("No such file or directory (exit 2)");
  });

  it("does not mark explicit successful structured results as failed because of output text", () => {
    expect(inferToolResultError("Bash", JSON.stringify({
      ok: true,
      exit_code: 0,
      stdout: "Documentation mentions Error reading SSH protocol banner as an example."
    }), true)).toBe("");
  });
});
