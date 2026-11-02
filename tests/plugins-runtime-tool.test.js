import { describe, expect, it, vi } from "vitest";
import {
  activateRuntimePlugin
} from "../extensions/dev.plugins/runtime.js";

function activateWithService(service) {
  const tools = [];
  const contribution = activateRuntimePlugin({
    plugin: { id: "dev.plugins", version: "test" },
    config: { pluginHostService: service },
    log: vi.fn(),
    tools: {
      registerTool(tool) {
        tools.push(tool);
        return {
          dispose() {
            tools.splice(tools.indexOf(tool), 1);
          }
        };
      }
    }
  });
  return { contribution, tool: tools[0], tools };
}

describe("pluginsManage Runtime tool", () => {
  it("registers the headless Plugin Host action surface", () => {
    const { contribution, tool, tools } = activateWithService({});

    expect(tool.name).toBe("pluginsManage");
    expect(tool.policy).toEqual({ minimumPreset: "trusted-automation" });
    expect(tool.inputSchema.properties.action.enum).toEqual([
      "list",
      "search",
      "listDev",
      "startDev",
      "stopDev"
    ]);

    contribution.dispose();
    expect(tools).toEqual([]);
  });

  it("routes catalog and development actions through the Host service", async () => {
    const service = {
      list: vi.fn(async () => ({ plugins: [{ id: "dev.one" }] })),
      search: vi.fn(async () => ({ plugins: [{ id: "dev.two" }] })),
      listDev: vi.fn(async () => ({ sessions: [{ devId: "dev-1" }] })),
      startDev: vi.fn(async () => ({ devId: "dev-2" })),
      stopDev: vi.fn(async () => ({ stopped: ["dev-2"] }))
    };
    const { tool } = activateWithService(service);
    const runContext = { runId: "run-1", projectId: "project-1" };

    await expect(tool.invoke({ action: "list", limit: 10 }, runContext))
      .resolves.toMatchObject({ ok: true });
    await expect(tool.invoke({ action: "search", query: "identity" }, runContext))
      .resolves.toMatchObject({ ok: true });
    await expect(tool.invoke({ action: "listDev" }, runContext))
      .resolves.toMatchObject({ ok: true });
    await expect(tool.invoke({ action: "startDev", path: "/workspace/plugin" }, runContext))
      .resolves.toMatchObject({ ok: true });
    await expect(tool.invoke({ action: "stopDev", devId: "dev-2" }, runContext))
      .resolves.toMatchObject({ ok: true });

    expect(service.list).toHaveBeenCalledWith({
      limit: 10,
      offset: undefined,
      runContext
    });
    expect(service.startDev).toHaveBeenCalledWith({
      path: "/workspace/plugin",
      runContext
    });
    expect(service.stopDev).toHaveBeenCalledWith({
      devId: "dev-2",
      runContext
    });
  });

  it.each(["list", "search", "listDev", "startDev", "stopDev"])(
    "forwards the selected Node and parent constraints for %s",
    async (action) => {
      const service = { [action]: vi.fn(async () => ({ ok: true })) };
      const { tool } = activateWithService(service);
      const runContext = {
        runId: "run-1",
        projectId: "project-1",
        target: { resourceId: "workspace:cloud" },
        policy: { allowedTerminalSessionIds: ["cloud-terminal"] }
      };
      const original = structuredClone(runContext);

      expect(tool.inputSchema.properties.node_id).toMatchObject({ type: "string" });
      await expect(tool.invoke({
        action,
        node_id: "node:cloud",
        query: "plugin",
        path: "/workspace/plugin",
        devId: "dev-1"
      }, runContext)).resolves.toMatchObject({ ok: true });

      expect(service[action]).toHaveBeenCalledWith(expect.objectContaining({
        runContext: {
          ...original,
          target: { nodeId: "node:cloud", resourceId: "workspace:cloud" }
        }
      }));
      expect(runContext).toEqual(original);
    }
  );

  it("rejects a Node that conflicts with the parent target before calling the Host", async () => {
    const service = { stopDev: vi.fn(async () => ({ stopped: ["dev-1"] })) };
    const { tool } = activateWithService(service);

    await expect(tool.invoke({
      action: "stopDev",
      node_id: "node:cloud",
      devId: "dev-1"
    }, {
      target: { nodeId: "node:mac" }
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/conflict/i)
    });
    expect(service.stopDev).not.toHaveBeenCalled();
  });

  it("rejects unavailable headless actions without dispatch", async () => {
    const service = { list: vi.fn() };
    const { tool } = activateWithService(service);

    await expect(tool.invoke({ action: "install", node_id: "node:cloud" }))
      .resolves.toMatchObject({ ok: false, error: "Unknown action: install" });
    expect(service.list).not.toHaveBeenCalled();
  });

  it("reports Host failures without substituting a different Node", async () => {
    const service = { listDev: vi.fn(async () => { throw new Error("Node offline"); }) };
    const { tool } = activateWithService(service);

    await expect(tool.invoke({ action: "listDev" }))
      .resolves.toMatchObject({ ok: false, error: "Node offline" });
    expect(service.listDev).toHaveBeenCalledTimes(1);
  });
});
