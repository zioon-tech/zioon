// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginDataFileHost } from "../packages/local-tools-client/src/plugin-data-files.mjs";
import { createPluginFileService } from "../apps/runtime/src/plugin-file-service.mjs";
import { createDeviceServiceClient } from "../apps/runtime/src/device-service-client.mjs";
import { createPluginDataLocations } from "../apps/runtime/src/plugin-data-locations.mjs";
import { RuntimeIdentityContextProvider, activateRuntimePlugin } from "../extensions/dev.identity/runtime.js";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zion-identity-data-"));
  roots.push(root);
  const location = { nodeId: "", root: join(root, "dev.identity") };
  const values = new Map();
  const state = { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
  const fileService = createPluginFileService({
    toolHost: { invoke: vi.fn(() => { throw new Error("No terminal should be used"); }) },
    dataLocation: location,
    fileClient: createDeviceServiceClient({
      service: "local-tools", baseUrl: "http://fixture",
      dataFiles: createPluginDataFileHost({ root })
    })
  });
  return { root, location, state, fileService, values };
}

describe("Identity plugin data integration", () => {
  it("initializes without terminals and refreshes externally edited files between Runs", async () => {
    const { location, state, fileService } = await setup();
    const provider = new RuntimeIdentityContextProvider({
      state, fileService, memoryRoot: location.root, dataLocation: location
    });
    const messages = [{ role: "user", content: "hello" }];
    const first = await provider.contribute(messages, { runId: "one" });
    expect(first[0].content).toContain(location.root);
    expect(first[0].content).not.toContain("~/.zion-next/memory");
    await writeFile(join(location.root, "user.md"), "Updated outside Zion using Bash");
    expect((await provider.contribute(messages, { runId: "one" }))[0].content).not.toContain("Updated outside");
    const second = await provider.contribute(first, { runId: "two" });
    expect(second[0].content).toContain("Updated outside Zion using Bash");
    expect(second.filter((item) => item.content.includes("<identity_context>"))).toHaveLength(1);
  });

  it("directs agent-fs memory access through native MCP and its cached Skill", async () => {
    const { location, state, fileService } = await setup();
    const provider = new RuntimeIdentityContextProvider({
      state,
      fileService,
      memoryRoot: location.root,
      dataLocation: { ...location, backend: "agent-fs", apiUrl: "https://memory.example.test" }
    });
    const [context] = await provider.contribute(
      [{ role: "user", content: "inspect memory" }],
      { runId: "agentfs-context" }
    );
    expect(context.content).toContain("authoritative agent-fs memory service");
    expect(context.content).toContain("mcp__agentfs__grep");
    expect(context.content).toContain('name: "agentfs-memory", include_body: true');
    expect(context.content).toContain("do not use a sandbox loopback address or a plugin-data mirror");
    expect(context.content).not.toContain("biographyQuery");
    expect(context.content).not.toContain("query-biography.py");
  });

  it("uses CLI instructions and exposes no MCP tools when MCP is disabled", async () => {
    const { location, state, fileService } = await setup();
    const tools = new Map();
    const providers = [];
    const disposable = activateRuntimePlugin({
      plugin: { id: "dev.identity", version: "test" },
      locations: { data: {
        ...location, backend: "agent-fs", apiUrl: "https://memory.example.test", accessMode: "cli"
      } },
      config: { fileService, mcpService: null, memoryAccessMode: "cli" },
      state: { namespace: () => state },
      context: { registerProvider(provider) {
        providers.push(provider);
        return { dispose() {} };
      } },
      tools: { registerTool(tool) {
        tools.set(tool.name, tool);
        return { dispose() {} };
      } }
    });
    try {
      const [context] = await providers[0].contribute(
        [{ role: "user", content: "inspect memory using CLI" }],
        { runId: "agentfs-cli-context" }
      );
      expect(context.content).toContain("MCP tools are disabled");
      expect(context.content).toContain("use Bash with the authenticated agent-fs CLI");
      expect(context.content).toContain("agent-fs download");
      expect(context.content).not.toContain("mcp__agentfs__");
      expect([...tools.keys()].some((name) => name.startsWith("mcp__"))).toBe(false);
    } finally { await disposable.dispose(); }
  });

  it("freezes Runtime identity context per chat session across Runs", async () => {
    const { location, state, fileService, values } = await setup();
    await mkdir(location.root, { recursive: true });
    await writeFile(join(location.root, "user.md"), "# User\nSession original");
    const provider = new RuntimeIdentityContextProvider({
      state, fileService, memoryRoot: location.root, dataLocation: location
    });
    const messages = [{ role: "user", content: "hello" }];
    const runContext = (runId, sessionId) => ({
      runId,
      attemptId: `${runId}-attempt`,
      request: {
        sessionId,
        policy: { preset: "read-only", fileRoots: [] }
      }
    });

    const first = await provider.contribute(messages, runContext("run-1", "chat-session"));
    expect(first[0].content).toContain("Session original");

    await writeFile(join(location.root, "user.md"), "# User\nSession updated");
    const sameSession = await provider.contribute(messages, runContext("run-2", "chat-session"));
    expect(sameSession[0].content).toContain("Session original");
    expect(sameSession[0].content).not.toContain("Session updated");

    const nextSession = await provider.contribute(messages, runContext("run-3", "next-session"));
    expect(nextSession[0].content).toContain("Session updated");
    expect(values.get("sessionSnapshots.v1")["chat-session"].snapshot.content)
      .toContain("Session original");
  });

  it("isolates Identity files and snapshot caches by Space and account", async () => {
    const root = await mkdtemp(join(tmpdir(), "zion-identity-scoped-"));
    roots.push(root);
    const values = new Map();
    const state = {
      get: (key) => values.get(key),
      set: (key, value) => values.set(key, value)
    };
    const locations = createPluginDataLocations({
      root,
      scope: "account"
    });
    const fileService = createPluginFileService({
      toolHost: { invoke: vi.fn(() => { throw new Error("No terminal should be used"); }) },
      dataLocation: (runContext, options) =>
        locations.forPlugin("dev.identity", runContext, options),
      fileClient: createDeviceServiceClient({
        service: "local-tools",
        baseUrl: "http://fixture",
        dataFiles: createPluginDataFileHost({ root })
      })
    });
    const providers = [];
    const tools = new Map();
    const disposable = activateRuntimePlugin({
      plugin: { id: "dev.identity", version: "test" },
      locations: {
        scopeMode: "account",
        forRequest: (runContext, options) =>
          locations.forPlugin("dev.identity", runContext, options).data
      },
      config: { fileService },
      state: { namespace: () => state },
      context: {
        registerProvider(provider) {
          providers.push(provider);
          return { dispose() {} };
        }
      },
      tools: {
        registerTool(tool) {
          tools.set(tool.name, tool);
          return { dispose() {} };
        }
      }
    });
    const provider = providers[0];
    const principal = (userId) => ({
      version: 1,
      kind: "user",
      userId,
      spaceId: "space:one"
    });
    const fileContext = (userId) => ({
      principal: principal(userId),
      policy: { preset: "workspace-write", fileRoots: [] }
    });
    await fileService.writeTextFiles({
      files: {
        user: {
          relativePath: "user.md",
          content: "# User\nAlice private profile"
        }
      },
      runContext: fileContext("user:alice")
    });
    await fileService.writeTextFiles({
      files: {
        user: {
          relativePath: "user.md",
          content: "# User\nBob private profile"
        }
      },
      runContext: fileContext("user:bob")
    });
    const runContext = (userId) => ({
      runId: `run:${userId}`,
      request: {
        principal: principal(userId),
        policy: { preset: "read-only", fileRoots: [] }
      }
    });

    const alice = await provider.contribute(
      [{ role: "user", content: "hello" }],
      runContext("user:alice")
    );
    const bob = await provider.contribute(
      [{ role: "user", content: "hello" }],
      runContext("user:bob")
    );
    expect(alice[0].content).toContain("Alice private profile");
    expect(alice[0].content).not.toContain("Bob private profile");
    expect(bob[0].content).toContain("Bob private profile");
    expect(bob[0].content).not.toContain("Alice private profile");
    expect(values.has("snapshot")).toBe(false);
    expect(values.has("sessionSnapshots.v1")).toBe(false);
    const identityContext = JSON.parse((await tools.get("identityContext").invoke(
      { include_content: true },
      fileContext("user:alice")
    )).content);
    expect(identityContext.content).toContain("Alice private profile");
    expect(await tools.get("projectAutomationManage").invoke(
      { action: "get" },
      fileContext("user:alice")
    )).toMatchObject({
      ok: false,
      error: expect.stringContaining("account-scoped")
    });
    await expect(provider.contribute(
      [{ role: "user", content: "hello" }],
      { runId: "missing-principal", request: { policy: { preset: "read-only" } } }
    )).rejects.toThrow("Account-scoped plugin data requires spaceId");
    await disposable.dispose();
  });

  it("appends concurrent completed runs without replacing either event", async () => {
    const { location, state, fileService } = await setup();
    const tools = new Map();
    const disposable = activateRuntimePlugin({
      plugin: { id: "dev.identity", version: "test" },
      locations: { data: location },
      config: { fileService },
      state: { namespace: () => state },
      context: { registerProvider: () => ({ dispose() {} }) },
      tools: { registerTool(tool) { tools.set(tool.name, tool); return { dispose() {} }; } }
    });
    try {
      const manage = tools.get("identityManage");
      const results = await Promise.all(["first", "second"].map((run) =>
        manage.invoke({
          action: "append_biography_events", source_session_id: "chat",
          source_run_id: run, source_at: "2026-09-13T00:00:00Z",
          events: [{ kind: "outcome", summary: run }]
        }, { policy: { preset: "workspace-write" } })
      ));
      expect(results.every((result) => result.ok)).toBe(true);
      const loaded = await fileService.readTextFiles({
        files: { events: "biography/events.jsonl" }
      });
      const records = loaded.files.events.trim().split("\n").map(JSON.parse);
      expect(records.map((event) => event.runId).sort()).toEqual(["first", "second"]);
      expect(tools.has("biographyQuery")).toBe(false);
      expect(await manage.invoke({ action: "update_snapshot", content: "old browser" }, {
        policy: { preset: "workspace-write" }
      })).toMatchObject({ ok: false });
    } finally { await disposable.dispose(); }
  });

  it("refuses overriding a bound root or a different execution Node", async () => {
    const { fileService } = await setup();
    await expect(fileService.readTextFiles({ fileRoot: "/old-memory", files: { user: "user.md" } }))
      .rejects.toThrow("conflicts with the plugin data location");
    await expect(fileService.readTextFiles({
      files: { user: "user.md" }, runContext: { target: { nodeId: "other-node" } }
    })).rejects.toThrow("conflicts with the requested target");
  });

  it("does not inject full identity into a Run authorized only for a project file", async () => {
    const { location, state, fileService } = await setup();
    const provider = new RuntimeIdentityContextProvider({
      state, fileService, memoryRoot: location.root, dataLocation: location
    });
    const messages = [
      { role: "system", content: "<identity_context>stale private data</identity_context>" },
      { role: "user", content: "work on project" }
    ];
    const result = await provider.contribute(messages, {
      runId: "restricted", request: { policy: { fileRoots: [join(location.root, "projects/example/project.md")] } }
    });
    expect(result).toEqual([{ role: "user", content: "work on project" }]);
  });
});
