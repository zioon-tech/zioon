import { describe, expect, it } from "vitest";
import {
  normalizeToolExecution,
  resolveToolExecutionTimeoutMs
} from "../src/tool-execution.mjs";

describe("Tool execution policy", () => {
  it.each([
    ["read", "safe", "cooperative"],
    ["write", "invocation", "cooperative"],
    ["process", "reconcile", "best-effort"],
    ["external", "reconcile", "best-effort"]
  ])("provides conservative %s defaults", (
    effect,
    idempotency,
    cancellation
  ) => {
    expect(normalizeToolExecution({ effect })).toMatchObject({
      effect,
      idempotency,
      cancellation
    });
  });

  it("infers effects from existing risk declarations", () => {
    expect(normalizeToolExecution(null, { risk: "read-only" }).effect)
      .toBe("read");
    expect(normalizeToolExecution(null, { risk: "external-effect" }).effect)
      .toBe("external");
  });

  it("bounds a tool-specific timeout argument", () => {
    const policy = normalizeToolExecution({
      effect: "process",
      timeoutMs: 120_000,
      maxTimeoutMs: 600_000,
      timeoutArgument: "timeout"
    });

    expect(resolveToolExecutionTimeoutMs(policy, { timeout: 450_000 }))
      .toBe(450_000);
    expect(resolveToolExecutionTimeoutMs(policy, { timeout: 900_000 }))
      .toBe(600_000);
    expect(resolveToolExecutionTimeoutMs(policy, {})).toBe(120_000);
  });

  it("rejects invalid contracts during registration", () => {
    expect(() => normalizeToolExecution({
      effect: "write",
      idempotency: "sometimes"
    })).toThrow("idempotency mode is invalid");
    expect(() => normalizeToolExecution({
      effect: "read",
      timeoutMs: 500,
      maxTimeoutMs: 100
    })).toThrow("must be at least timeoutMs");
  });
});
