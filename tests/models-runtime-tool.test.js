import { describe, expect, it, vi } from "vitest";
import { activateRuntimePlugin } from "../extensions/dev.langchain-chat/runtime.js";
import {
  modelsManageToolDefinition,
  runtimeProfileIdForDynamicModel
} from "../extensions/dev.langchain-chat/models-runtime-shared.js";

function profile(overrides = {}) {
  return {
    id: "workbench.user.dynamic.kimi-k2.5",
    providerId: "user.dynamic",
    sourceModelId: "kimi-k2.5",
    providerType: "openai",
    endpoint: "https://models.example/chat",
    model: "kimi-k2.5",
    label: "Kimi K2.5",
    credentialRequired: true,
    credentialConfigured: true,
    capabilities: {},
    metadata: {},
    ...overrides
  };
}

function activateWithService(service) {
  const tools = [];
  activateRuntimePlugin({
    apiVersion: 2,
    plugin: { id: "dev.langchain-chat", version: "test" },
    config: { modelService: service },
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

describe("Runtime modelsManage tool", () => {
  it("exposes the shared modelsManage schema", () => {
    expect(modelsManageToolDefinition()).toMatchObject({
      name: "modelsManage",
      inputSchema: {
        properties: {
          action: {
            enum: expect.arrayContaining(["list", "add", "set_active", "delete"])
          },
          key: { type: "string" }
        }
      }
    });
  });

  it("lists profiles and switches the active Runtime interaction profile", async () => {
    const profiles = [profile()];
    const service = {
      listProfiles: vi.fn(() => profiles),
      getActiveModel: vi.fn(() => ({
        interactionProfileId: "interactive.default",
        modelProfileId: "workbench.user.dynamic.kimi-k2.5"
      })),
      setActiveProfile: vi.fn((profileId, options) => ({
        id: options.interactionProfileId,
        modelProfileId: profileId
      }))
    };
    const tool = activateWithService(service);

    expect(tool.name).toBe("modelsManage");
    expect(tool.policy).toEqual({ minimumPreset: "trusted-automation" });

    const listed = JSON.parse((await tool.invoke({ action: "list" })).content);
    expect(listed).toMatchObject({
      models: [expect.objectContaining({
        providerId: "user.dynamic",
        id: "kimi-k2.5",
        profileId: "workbench.user.dynamic.kimi-k2.5",
        credentialConfigured: true,
        availability: { status: "available" }
      })],
      active: {
        interactionProfileId: "interactive.default",
        modelProfileId: "workbench.user.dynamic.kimi-k2.5"
      }
    });

    const active = JSON.parse((await tool.invoke({
      action: "set_active",
      provider_id: "user.dynamic",
      model_id: "kimi-k2.5"
    })).content);
    expect(active).toMatchObject({
      set_active: "workbench.user.dynamic.kimi-k2.5",
      active: {
        id: "interactive.default",
        modelProfileId: "workbench.user.dynamic.kimi-k2.5"
      }
    });
    expect(service.setActiveProfile).toHaveBeenCalledWith(
      "workbench.user.dynamic.kimi-k2.5",
      { interactionProfileId: "interactive.default" }
    );
  });

  it("imports, updates, exports, and deletes user.dynamic Runtime profiles", async () => {
    const profiles = [];
    const service = {
      listProfiles: vi.fn(() => profiles),
      getActiveModel: vi.fn(() => null),
      upsertProfile: vi.fn(async ({ profile: nextProfile, credential }) => {
        const stored = {
          ...nextProfile,
          credentialConfigured: !!credential
        };
        const index = profiles.findIndex((item) => item.id === stored.id);
        if (index >= 0) profiles[index] = stored;
        else profiles.push(stored);
        return { profile: stored };
      }),
      deleteProfile: vi.fn(async (profileId) => {
        const index = profiles.findIndex((item) => item.id === profileId);
        if (index < 0) return null;
        const [removed] = profiles.splice(index, 1);
        return { profile: removed };
      })
    };
    const tool = activateWithService(service);

    const imported = JSON.parse((await tool.invoke({
      action: "import",
      data: {
        "kimi-k2.5": {
          label: "Kimi K2.5",
          url: "https://models.example/chat",
          model: "kimi-k2.5",
          key: "secret"
        }
      }
    })).content);
    expect(imported).toMatchObject({
      imported: 1,
      runtime: 1,
      profiles: [expect.objectContaining({
        id: runtimeProfileIdForDynamicModel("kimi-k2.5"),
        credentialConfigured: true
      })]
    });
    expect(JSON.stringify(imported)).not.toContain("secret");

    const updated = JSON.parse((await tool.invoke({
      action: "update",
      model_id: "kimi-k2.5",
      description: "Primary default model",
      max_tokens: 4096
    })).content);
    expect(updated.saved.profile).toMatchObject({
      id: runtimeProfileIdForDynamicModel("kimi-k2.5"),
      metadata: expect.objectContaining({
        description: "Primary default model",
        defaultOutputTokens: 4096
      })
    });

    const exported = JSON.parse((await tool.invoke({ action: "export" })).content);
    expect(exported).toMatchObject({
      "kimi-k2.5": expect.objectContaining({
        description: "Primary default model",
        _runtimeBacked: true
      })
    });

    const deleted = JSON.parse((await tool.invoke({
      action: "delete",
      model_id: "kimi-k2.5"
    })).content);
    expect(deleted).toMatchObject({
      deleted: "user.dynamic:kimi-k2.5",
      profile: {
        id: runtimeProfileIdForDynamicModel("kimi-k2.5")
      }
    });
  });
});
