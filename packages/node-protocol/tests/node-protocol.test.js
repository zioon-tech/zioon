import { describe, expect, it } from "vitest";
import {
  normalizeNodeRegistration,
  normalizeToolResult,
  validateDeviceCommand
} from "../src/index.mjs";

function registration(overrides = {}) {
  return {
    protocolVersion: 1,
    nodeId: "node:test",
    instanceId: "instance:test",
    capabilities: [{
      name: "read",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }],
    resources: [{
      resourceId: "workspace:test",
      kind: "workspace",
      projectId: "project:test",
      localRoot: "/private/not-for-runtime"
    }],
    ...overrides
  };
}

describe("@zion/node-protocol", () => {
  it("normalizes a registration without leaking local-only fields", () => {
    const result = normalizeNodeRegistration(registration());

    expect(result).toMatchObject({
      protocolVersion: 1,
      nodeId: "node:test",
      instanceId: "instance:test",
      capabilities: [{
        name: "read",
        version: "1",
        risk: "read",
        execution: {
          effect: "read",
          idempotency: "safe",
          cancellation: "cooperative"
        }
      }],
      resources: [{
        resourceId: "workspace:test",
        kind: "workspace",
        projectId: "project:test"
      }]
    });
    expect(result.resources[0]).not.toHaveProperty("localRoot");
  });

  it("normalizes declared policies and keeps legacy Bash timeout behavior", () => {
    const declared = normalizeNodeRegistration(registration({
      capabilities: [{
        name: "publish",
        risk: "external-effect",
        execution: {
          effect: "external",
          timeoutMs: 10_000,
          maxTimeoutMs: 20_000
        }
      }]
    })).capabilities[0];
    expect(declared).toMatchObject({
      executionDeclared: true,
      execution: {
        effect: "external",
        timeoutMs: 10_000,
        maxTimeoutMs: 20_000,
        idempotency: "reconcile"
      }
    });

    const legacyBash = normalizeNodeRegistration(registration({
      capabilities: [{ name: "Bash", risk: "execute" }]
    })).capabilities[0];
    expect(legacyBash).toMatchObject({
      executionDeclared: false,
      execution: {
        effect: "process",
        timeoutArgument: "timeout",
        maxTimeoutMs: 600_000
      }
    });
  });

  it("rejects incompatible versions and duplicate capabilities", () => {
    expect(() => normalizeNodeRegistration(registration({
      protocolVersion: 2
    }))).toThrow("Unsupported Device protocol version");

    expect(() => normalizeNodeRegistration(registration({
      capabilities: [
        { name: "read", risk: "read" },
        { name: "read", risk: "read" }
      ]
    }))).toThrow("Node capability read is duplicated");
  });

  it("validates invocation identity and normalizes results", () => {
    expect(validateDeviceCommand({
      schemaVersion: 1,
      type: "tool.invoke",
      invocationId: "invocation:test",
      resourceId: "workspace:test",
      leaseExpiresAt: 2_000,
      invocation: {
        invocationId: "invocation:test",
        toolCall: {
          id: "call:test",
          name: "read",
          arguments: {}
        }
      }
    })).toMatchObject({
      type: "tool.invoke",
      invocationId: "invocation:test",
      resourceId: "workspace:test",
      leaseExpiresAt: 2_000
    });

    expect(() => validateDeviceCommand({
      schemaVersion: 1,
      type: "tool.invoke",
      invocationId: "invocation:one",
      leaseExpiresAt: 2_000,
      invocation: {
        invocationId: "invocation:two"
      }
    })).toThrow("does not match");

    expect(() => validateDeviceCommand({
      schemaVersion: 1,
      type: "tool.invoke",
      invocationId: "invocation:test",
      leaseExpiresAt: 0,
      invocation: {
        invocationId: "invocation:test"
      }
    })).toThrow("lease expiration");

    expect(normalizeToolResult({
      ok: true,
      content: 42,
      failureCode: "execution_outcome_unknown",
      retryable: false,
      artifactIds: ["artifact:one", ""]
    })).toEqual({
      ok: true,
      content: "42",
      failureCode: "execution_outcome_unknown",
      retryable: false,
      artifactIds: ["artifact:one"]
    });
  });
});
