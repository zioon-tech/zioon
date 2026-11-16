import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeToolPolicyPatch,
  createRuntimeToolSync,
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
  it("uses a same-scope stale snapshot immediately while refreshing in the background", async () => {
    const scope = { baseUrl: "runtime", profileId: "profile", accountScope: "alice" };
    let finish;
    const refresh = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const sync = createRuntimeToolSync({
      readScope: () => scope, readStatus: () => ({ ...scope, status: "synced", syncedAt: 1 }),
      refresh, now: () => 20_000
    });
    expect(await sync({ preferCached: true })).toEqual({ applied: true, cached: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await sync({ preferCached: true })).toEqual({ applied: true, cached: true });
    finish({ applied: true });
    await sync();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["baseUrl", "profileId", "accountScope"])("waits for a fresh snapshot after %s changes", async field => {
    let scope = { baseUrl: "runtime", profileId: "profile", accountScope: "alice" };
    const previous = { ...scope, status: "synced", syncedAt: 1 };
    let finish;
    const isCurrent = [];
    const refresh = vi.fn((_scope, guard) => {
      isCurrent.push(guard);
      return refresh.mock.calls.length === 1 ? new Promise(resolve => { finish = resolve; }) : { applied: true };
    });
    const sync = createRuntimeToolSync({ readScope: () => scope, readStatus: () => previous, refresh, now: () => 20_000 });
    const first = sync();
    await Promise.resolve();
    scope = { ...scope, [field]: "changed" };
    let settled = false;
    const next = sync({ preferCached: true }).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(isCurrent[0]()).toBe(false);
    finish({ applied: false });
    await first;
    await next;
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls[1][0][field]).toBe("changed");
  });

  it("does not apply an old account catalog after the account has changed", async () => {
    const state = createState({ "runtime.mode": "runtime" });
    const before = [...state.values];
    await expect(syncEnabledToolsFromRuntimeProfile({
      state, storage: localStorage, isCurrentScope: () => false,
      fetchImpl: async url => jsonResponse(200, String(url).endsWith("/v1/capabilities/tools")
        ? { tools: [{ name: "privateTool" }] } : { profile: { id: "private", policy: {} } })
    })).resolves.toMatchObject({ applied: false, reason: "scope-changed" });
    expect([...state.values]).toEqual(before);
  });

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
    expect(state.values.get("runtime.injectableToolNames")).toEqual([
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
    expect(state.values.get("runtime.injectableToolNames")).toEqual([
      "webFetch",
      "todoWrite",
      "read",
      "Bash"
    ]);
  });

  it("applies only Runtime-injectable tool enablement when catalog includes unavailable tools", async () => {
    const state = createState({
      "chat.tools": [
        { function: { name: "webFetch" } },
        { function: { name: "read" } },
        { function: { name: "Bash" } }
      ],
      "chat.enabledTools": ["webFetch", "read", "Bash"],
      "runtime.mode": "runtime"
    });
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/v1/capabilities/tools")) {
        return jsonResponse(200, {
          tools: [
            { name: "webFetch", modelInjectable: true },
            { name: "read", modelInjectable: false, unavailableReason: "device_unavailable" },
            { name: "Bash", modelInjectable: false, unavailableReason: "device_unavailable" }
          ]
        });
      }
      return jsonResponse(200, {
        profile: {
          id: "interactive.default",
          policy: { allowedTools: ["webFetch", "read", "Bash"] }
        }
      });
    });

    await expect(syncEnabledToolsFromRuntimeProfile({
      state,
      storage: localStorage,
      fetchImpl
    })).resolves.toMatchObject({
      applied: true,
      runtimeEnabledTools: ["webFetch"],
      runtimeInjectableTools: ["webFetch"],
      enabledTools: ["webFetch"]
    });

    expect(state.values.get("runtime.supportedToolNames")).toEqual([
      "webFetch",
      "read",
      "Bash"
    ]);
    expect(state.values.get("runtime.injectableToolNames")).toEqual([
      "webFetch"
    ]);
    expect(state.values.get("chat.enabledTools")).toEqual(["webFetch"]);
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
