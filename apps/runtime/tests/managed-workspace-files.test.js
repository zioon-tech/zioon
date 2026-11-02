import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxTerminalService } from "../src/sandbox/sandbox-terminal-service.mjs";

const resources = [];
afterEach(async () => {
  for (const service of resources.splice(0)) await service.close();
});

function fixture(content = "sandbox-only\n") {
  const actor = { kind: "account", user: { id: "account:one" }, space: { id: "space:one" } };
  const grant = { userId: "account:one", spaceId: "space:one", grantId: "grant:files" };
  const invoke = vi.fn(async (input) => ({
    ok: true,
    content: JSON.stringify({
      path: input.toolCall.arguments.path,
      content,
      content_hash: "hash:one",
      entries: []
    })
  }));
  const service = new SandboxTerminalService({
    sandbox: {
      invoke,
      bindingForAccount: (id) => id === "account:one" ? { accountId: id, workspaceId: "workspace:one" } : null,
      onInstanceInvalidated: () => ({ dispose() {} })
    },
    provider: {}, store: {},
    authorizeActor: async () => actor,
    withLifecycleGrant: vi.fn(async (_context, operation) =>
      operation({ principal: grant, policy: { allowedTools: ["read", "write", "tree", "glob", "grep"], fileRoots: ["/"] } }))
  });
  resources.push(service);
  return { service, actor, invoke, grant };
}

describe("Managed workspace file HTTP routing", () => {
  it("routes an omitted Node to the authenticated account and durable file broker", async () => {
    const { service, actor, invoke, grant } = fixture();
    const result = await service.handleRequest({
      path: "/files/read?path=%2Fworkspace%2Fprobe.txt", method: "GET", runContext: { principal: actor }
    });
    expect(result).toMatchObject({ status: 200, body: { content: "sandbox-only\n" } });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0][0]).toMatchObject({
      principal: grant, toolCall: { name: "read", arguments: { path: "/workspace/probe.txt", _plugin_data: true } }
    });
  });

  it("preserves explicit Device routing without issuing a managed operation", async () => {
    const { service, actor, invoke } = fixture();
    expect(await service.handleRequest({
      path: "/files/read?path=%2Fproject%2Ffile&node_id=node%3Apersonal", method: "GET",
      runContext: { principal: actor, target: { nodeId: "node:personal" } }
    })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects an unprovisioned account before issuing any file operation", async () => {
    const { service, invoke } = fixture();
    await expect(service.handleRequest({
      path: "/files/read?path=%2Fetc%2Fhostname", method: "GET",
      runContext: { principal: { userId: "account:unbound" } }
    })).rejects.toMatchObject({ statusCode: 403, code: "sandbox_account_unbound" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses the write capability with optimistic concurrency through the same broker", async () => {
    const { service, actor, invoke } = fixture();
    await service.handleRequest({
      path: "/files/write", method: "POST",
      body: Buffer.from(JSON.stringify({ path: "/workspace/probe.txt", content: "updated", expected_hash: "previous" })),
      runContext: { principal: actor }
    });
    expect(invoke.mock.calls[0][0].toolCall).toMatchObject({
      name: "write", arguments: { content: "updated", expected_hash: "previous", _plugin_data: true }
    });
  });

  it("lists actual directory entries and keeps JSONL pagination semantics", async () => {
    const { service, actor, invoke } = fixture("one\ntwo\nthree\n");
    const entries = await service.handleRequest({
      path: "/files/entries?path=%2Fworkspace", method: "GET", runContext: { principal: actor }
    });
    expect(entries.body.entries).toEqual([]);
    expect(invoke.mock.calls[0][0].toolCall.arguments._plugin_entries).toBe(true);
    const page = await service.handleRequest({
      path: "/files/read-jsonl?path=%2Fworkspace%2Frows.jsonl&offset=2&limit=1", method: "GET",
      runContext: { principal: actor }
    });
    expect(page.body).toMatchObject({ content: "two", start_line: 2, end_line: 2, has_previous: true, has_more: true });
  });

  it("never sends unsupported default file operations to another Node", async () => {
    const { service, actor, invoke } = fixture();
    await expect(service.handleRequest({
      path: "/files/delete", method: "POST", body: Buffer.from('{"path":"/workspace/file"}'),
      runContext: { principal: actor }
    })).rejects.toMatchObject({ statusCode: 405 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a resource identifier outside the current managed workspace", async () => {
    const { service, actor, invoke } = fixture();
    await expect(service.handleRequest({
      path: "/files/read?path=%2Fworkspace%2Ffile&resource_id=workspace%3Aother",
      method: "GET", runContext: { principal: actor }
    })).rejects.toMatchObject({ statusCode: 403, code: "file_target_conflict" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
