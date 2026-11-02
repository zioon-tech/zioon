import { describe, expect, it, vi } from "vitest";
import { ManagedNodeToolRouter, managedNodeIdentity } from "../src/sandbox/managed-node-router.mjs";

function fixture() {
  const binding = { accountId: "account:one", workspaceId: "workspace:one" };
  const sandboxTools = ["Bash", "read", "write", "edit", "glob", "grep", "tree"].map((name) => ({ name }));
  const deviceTools = [...sandboxTools, { name: "sendMail" }, { name: "mcpListTools" }, { name: "mcpCall" }];
  const sandbox = {
    supportedToolNames: sandboxTools.map((tool) => tool.name),
    bindingForAccount: () => binding, invoke: vi.fn(),
    getToolDefinitions: () => sandboxTools, listTools: vi.fn(async () => sandboxTools)
  };
  const device = {
    supportedToolNames: deviceTools.map((tool) => tool.name),
    getToolDefinitions: () => deviceTools, listTools: vi.fn(async () => deviceTools), invoke: vi.fn()
  };
  const request = { principal: { userId: "account:one", spaceId: "space:one" } };
  return { router: new ManagedNodeToolRouter({ sandbox, device }), sandbox, device,
    sandboxTools, deviceTools, request, nodeId: managedNodeIdentity("space:one", binding).nodeId };
}

describe("Managed Node tool catalog", () => {
  it("injects only workspace tools for an omitted or managed target even with connected Devices", async () => {
    const h = fixture();
    expect(await h.router.listTools(h.request)).toEqual(h.sandboxTools);
    expect(await h.router.listTools({ ...h.request, target: { nodeId: h.nodeId } })).toEqual(h.sandboxTools);
    expect(h.device.listTools).not.toHaveBeenCalled();
    // The management catalog retains real optional Device capabilities.
    expect(h.router.supportedToolNames).toContain("sendMail");
  });

  it("exposes Device-only capabilities when the request explicitly selects that Device", async () => {
    const h = fixture();
    const request = { ...h.request, target: { nodeId: "node:personal" } };
    expect(await h.router.listTools(request)).toEqual(h.deviceTools);
    expect(h.device.listTools).toHaveBeenCalledWith(request);
    expect(h.sandbox.listTools).not.toHaveBeenCalled();
  });
});
