import { describe, expect, it, vi } from "vitest";
import { activateRuntimePlugin } from "../extensions/dev.tools/runtime.js";
import {
  inferToolPolicyPatch,
  toolsManageToolDefinition
} from "../extensions/dev.tools/tools-runtime-shared.js";

function activateWithService(service) {
  const tools = [];
  activateRuntimePlugin({
    apiVersion: 2,
    plugin: { id: "dev.tools", version: "test" },
    config: { toolService: service },
    log: vi.fn(),
    tools: {
      registerTool(tool) {
        tools.push(tool);
        return { dispose() {} };
      }
    },
    context: { registerProvider: vi.fn() },
    state: { namespace: vi.fn() }
  });
  return tools[0];
}

describe("Runtime toolsManage tool", () => {
  it("exposes the shared toolsManage schema", () => {
    expect(toolsManageToolDefinition()).toMatchObject({
      name: "toolsManage",
      inputSchema: {
        properties: {
          action: {
            enum: ["list", "get", "enable", "disable", "set_enabled", "sync"]
          }
        }
      }
    });
    expect(inferToolPolicyPatch(["read"])).toMatchObject({
      preset: "read-only",
      allowedTools: ["read"]
    });
    expect(inferToolPolicyPatch(["read", "sessionCreate"])).toMatchObject({
      preset: "workspace-write",
      allowedTools: ["read", "sessionCreate"]
    });
    expect(inferToolPolicyPatch(["read", "toolsManage"])).toMatchObject({
      preset: "trusted-automation",
      allowedTools: ["read", "toolsManage"]
    });
  });

  it("lists Runtime capability tools and patches InteractionProfile policy", async () => {
    const profiles = new Map([
      ["interactive.default", {
        id: "interactive.default",
        policy: {
          preset: "read-only",
          allowedTools: ["read"],
          allowedRecipients: [],
          maxMailPerRun: 0
        }
      }]
    ]);
    const service = {
      listTools: vi.fn(() => [{
        name: "read",
        description: "Read files",
        hostKinds: ["local-tools"],
        policy: { minimumPreset: "read-only" }
      }, {
        name: "Bash",
        description: "Run commands",
        hostKinds: ["local-tools"],
        policy: { minimumPreset: "trusted-automation" }
      }, {
        name: "toolsManage",
        description: "Manage tools",
        hostKinds: ["runtime-plugin", "plugin:dev.tools"],
        pluginId: "dev.tools",
        policy: { minimumPreset: "trusted-automation" }
      }]),
      getProfile: vi.fn((profileId) => profiles.get(profileId) || null),
      patchProfile: vi.fn((profileId, patch) => {
        const current = profiles.get(profileId);
        const next = {
          ...current,
          policy: {
            ...(current.policy || {}),
            ...(patch.policy || {})
          }
        };
        profiles.set(profileId, next);
        return next;
      })
    };
    const tool = activateWithService(service);

    expect(tool.name).toBe("toolsManage");
    expect(tool.policy).toEqual({ minimumPreset: "trusted-automation" });

    const listed = JSON.parse((await tool.invoke({ action: "list" })).content);
    expect(listed).toMatchObject({
      interactionProfileId: "interactive.default",
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "read", enabled: true }),
        expect.objectContaining({ name: "Bash", enabled: false }),
        expect.objectContaining({ name: "toolsManage", enabled: false })
      ]),
      enabled: ["read"],
      unknownEnabled: []
    });

    const detail = JSON.parse((await tool.invoke({
      action: "get",
      name: "toolsManage"
    })).content);
    expect(detail.tool).toMatchObject({
      name: "toolsManage",
      pluginId: "dev.tools"
    });

    const enabled = JSON.parse((await tool.invoke({
      action: "enable",
      names: ["Bash", "toolsManage"]
    })).content);
    expect(enabled).toMatchObject({
      interactionProfileId: "interactive.default",
      enabled: ["read", "Bash", "toolsManage"],
      policy: {
        preset: "trusted-automation",
        allowedTools: ["read", "Bash", "toolsManage"]
      }
    });
    expect(service.patchProfile).toHaveBeenLastCalledWith("interactive.default", {
      policy: expect.objectContaining({
        preset: "trusted-automation",
        allowedTools: ["read", "Bash", "toolsManage"]
      }),
      metadata: {
        toolSelectionUserManaged: true
      }
    });

    const disabled = JSON.parse((await tool.invoke({
      action: "disable",
      name: "Bash"
    })).content);
    expect(disabled.policy).toMatchObject({
      preset: "trusted-automation",
      allowedTools: ["read", "toolsManage"]
    });

    const setEnabled = JSON.parse((await tool.invoke({
      action: "set_enabled",
      names: ["read"]
    })).content);
    expect(setEnabled.policy).toMatchObject({
      preset: "read-only",
      allowedTools: ["read"]
    });
  });

  it("rejects unknown Runtime tool names", async () => {
    const tool = activateWithService({
      listTools: () => [{ name: "read", description: "Read files" }],
      getProfile: () => ({
        id: "interactive.default",
        policy: { allowedTools: ["read"] }
      }),
      patchProfile: vi.fn()
    });

    const result = await tool.invoke({
      action: "enable",
      name: "missingTool"
    });
    expect(result).toMatchObject({
      ok: false,
      error: "Unknown Runtime tool(s): missingTool"
    });
  });
});
