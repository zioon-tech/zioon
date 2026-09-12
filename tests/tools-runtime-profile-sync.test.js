import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeToolPolicyPatch,
  mergeRuntimeCapabilityToolsIntoWorkbenchTools,
  persistEnabledToolsToRuntimeProfile,
  syncEnabledToolsFromRuntimeProfile
} from "../extensions/dev.tools/main.js";

function jsonResponse(status, value) {
  return new globalThis.Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function createState(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn((key) => values.get(key)),
    set: vi.fn((key, value) => {
      values.set(key, value);
      return value;
    }),
    values
  };
}

describe("tools Runtime interaction profile sync", () => {
  it("applies only Runtime-supported tool enablement in Runtime mode", async () => {
    const state = createState({
      "chat.tools": [
        { function: { name: "read" } },
        { function: { name: "Bash" } },
        { function: { name: "modelsManage" } },
        { function: { name: "browserOnly" } }
      ],
      "chat.enabledTools": ["read", "modelsManage", "browserOnly"],
      "runtime.mode": "runtime"
    });
    const fetchImpl = vi.fn(async (url) => {
      const value = String(url);
      if (value.endsWith("/v1/capabilities/tools")) {
        return jsonResponse(200, {
          tools: [
            { name: "read", hostKinds: ["local-tools"] },
            { name: "Bash", hostKinds: ["local-tools"] },
            { name: "modelsManage", hostKinds: ["runtime-plugin"], pluginId: "dev.langchain-chat" },
            {
              name: "plugin.echo",
              description: "Plugin echo",
              inputSchema: { type: "object" },
              hostKinds: ["runtime-plugin"]
            }
          ]
        });
      }
      if (value.endsWith("/v1/interaction-profiles/interactive.default")) {
        return jsonResponse(200, {
          profile: {
            id: "interactive.default",
            policy: { allowedTools: ["Bash", "modelsManage", "plugin.echo"] }
          }
        });
      }
      throw new Error(`Unexpected request: ${value}`);
    });

    await expect(syncEnabledToolsFromRuntimeProfile({
      state,
      storage: localStorage,
      fetchImpl
    })).resolves.toMatchObject({
      applied: true,
      runtimeEnabledTools: ["Bash", "modelsManage", "plugin.echo"],
      enabledTools: ["Bash", "modelsManage", "plugin.echo"]
    });

    expect(state.values.get("runtime.supportedToolNames")).toEqual([
      "read",
      "Bash",
      "modelsManage",
      "plugin.echo"
    ]);
    expect(state.values.get("runtime.enabledToolNames")).toEqual(["Bash", "modelsManage", "plugin.echo"]);
    expect(state.values.get("chat.enabledTools")).toEqual([
      "Bash",
      "modelsManage",
      "plugin.echo"
    ]);
    expect(state.values.get("chat.tools")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        "x-zionRuntimeOnly": true,
        function: expect.objectContaining({ name: "plugin.echo" })
      })
    ]));
  });

  it("does not overwrite a newer local selection with a stale Runtime read", async () => {
    const state = createState({
      "chat.tools": [
        { function: { name: "webFetch" } },
        { function: { name: "todoWrite" } },
        { function: { name: "read" } },
        { function: { name: "Bash" } }
      ],
      "chat.enabledTools": ["webFetch", "todoWrite", "read", "Bash"],
      "runtime.mode": "runtime"
    });
    const applyEnabledTools = vi.fn();
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/v1/capabilities/tools")) {
        return jsonResponse(200, {
          tools: ["webFetch", "todoWrite", "read", "Bash"]
            .map((name) => ({ name, hostKinds: ["runtime"] }))
        });
      }
      return jsonResponse(200, {
        profile: {
          id: "interactive.default",
          policy: { allowedTools: ["webFetch", "todoWrite"] }
        }
      });
    });

    await expect(syncEnabledToolsFromRuntimeProfile({
      state,
      storage: localStorage,
      fetchImpl,
      shouldApplyEnabledTools: () => false,
      applyEnabledTools
    })).resolves.toMatchObject({
      applied: false,
      reason: "local-selection-changed"
    });

    expect(applyEnabledTools).not.toHaveBeenCalled();
    expect(state.values.get("chat.enabledTools")).toEqual([
      "webFetch",
      "todoWrite",
      "read",
      "Bash"
    ]);
    expect(state.values.get("runtime.supportedToolNames")).toEqual([
      "webFetch",
      "todoWrite",
      "read",
      "Bash"
    ]);
  });

  it("persists only Runtime-supported tool choices back to the profile", async () => {
    const state = createState({
      "runtime.mode": "runtime",
      "runtime.supportedToolNames": ["read", "Bash", "sendMail", "modelsManage"],
      "runtime.interactionProfileId": "interactive.default"
    });
    const fetchImpl = vi.fn(async (url, init = {}) => {
      expect(String(url)).toBe(
        "http://127.0.0.1:8766/v1/interaction-profiles/interactive.default"
      );
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(init.body)).toEqual({
        policy: {
          preset: "trusted-automation",
          allowedTools: ["read", "Bash", "modelsManage"],
          allowedRecipients: [],
          maxMailPerRun: 0
        },
        metadata: {
          toolSelectionUserManaged: true
        }
      });
      return jsonResponse(200, {
        profile: {
          id: "interactive.default",
          policy: {
            preset: "trusted-automation",
            allowedTools: ["read", "Bash", "modelsManage"]
          }
        }
      });
    });

    await expect(persistEnabledToolsToRuntimeProfile({
      enabledTools: ["read", "Bash", "modelsManage"],
      state,
      storage: localStorage,
      fetchImpl
    })).resolves.toMatchObject({
      persisted: true
    });

    expect(state.values.get("runtime.enabledToolNames")).toEqual(["read", "Bash", "modelsManage"]);
  });

  it("derives the minimum policy preset from enabled Runtime tools", () => {
    expect(createRuntimeToolPolicyPatch(["read"])).toMatchObject({
      preset: "read-only",
      allowedTools: ["read"]
    });
    expect(createRuntimeToolPolicyPatch(["read", "write"])).toMatchObject({
      preset: "workspace-write",
      allowedTools: ["read", "write"]
    });
    expect(createRuntimeToolPolicyPatch(["read", "memoryManage"])).toMatchObject({
      preset: "workspace-write",
      allowedTools: ["read", "memoryManage"]
    });
    expect(createRuntimeToolPolicyPatch(["read", "agentsManage"])).toMatchObject({
      preset: "workspace-write",
      allowedTools: ["read", "agentsManage"]
    });
    expect(createRuntimeToolPolicyPatch(["read", "identityManage"])).toMatchObject({
      preset: "workspace-write",
      allowedTools: ["read", "identityManage"]
    });
    expect(createRuntimeToolPolicyPatch(["read", "projectAutomationManage"])).toMatchObject({
      preset: "workspace-write",
      allowedTools: ["read", "projectAutomationManage"]
    });
    expect(createRuntimeToolPolicyPatch(["sessionList", "sessionCreate"])).toMatchObject({
      preset: "workspace-write",
      allowedTools: ["sessionList", "sessionCreate"]
    });
    expect(createRuntimeToolPolicyPatch(["read", "Bash", "sendMail"])).toMatchObject({
      preset: "trusted-automation",
      allowedTools: ["read", "Bash", "sendMail"],
      allowedRecipients: ["*"],
      maxMailPerRun: 10
    });
    expect(createRuntimeToolPolicyPatch(["read", "schedulerManage"])).toMatchObject({
      preset: "trusted-automation",
      allowedTools: ["read", "schedulerManage"]
    });
    expect(createRuntimeToolPolicyPatch(["read", "modelsManage"])).toMatchObject({
      preset: "trusted-automation",
      allowedTools: ["read", "modelsManage"]
    });
    expect(createRuntimeToolPolicyPatch(["read", "toolsManage"])).toMatchObject({
      preset: "trusted-automation",
      allowedTools: ["read", "toolsManage"]
    });
    expect(createRuntimeToolPolicyPatch(["read", "pluginsManage"])).toMatchObject({
      preset: "trusted-automation",
      allowedTools: ["read", "pluginsManage"]
    });
    expect(createRuntimeToolPolicyPatch(["read", "mailManage"])).toMatchObject({
      preset: "trusted-automation",
      allowedTools: ["read", "mailManage"]
    });
  });

  it("merges Runtime-only capability definitions into Workbench tools", () => {
    const state = createState({
      "chat.tools": [{ function: { name: "read" } }]
    });

    const tools = mergeRuntimeCapabilityToolsIntoWorkbenchTools({
      state,
      capabilityTools: [{
        name: "read",
        description: "Existing read",
        inputSchema: { type: "object" },
        hostKinds: ["local-tools"]
      }, {
        name: "plugin.echo",
        description: "Plugin echo",
        inputSchema: { type: "object" },
        hostKinds: ["runtime-plugin"],
        owner: { kind: "plugin", id: "dev.echo" },
        availability: {
          headless: true,
          requiresWorkbench: false,
          requiresDevice: false,
          requiresNetwork: false
        },
        policy: { minimumPreset: "read-only" }
      }]
    });

    expect(tools.map((tool) => tool.function.name)).toEqual([
      "read",
      "plugin.echo"
    ]);
    expect(tools[1]).toMatchObject({
      "x-zionRuntimeOnly": true,
      "x-zionToolOwner": { kind: "plugin", id: "dev.echo" },
      "x-zionToolAvailability": {
        headless: true,
        requiresWorkbench: false,
        requiresDevice: false,
        requiresNetwork: false
      },
      "x-zionToolPolicy": { minimumPreset: "read-only" },
      function: {
        name: "plugin.echo",
        description: "Plugin echo",
        parameters: { type: "object" }
      }
    });
  });
});
