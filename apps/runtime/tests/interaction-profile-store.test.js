import { describe, expect, it } from "vitest";
import {
  createDefaultInteractionProfile,
  createDefaultScheduledInteractionProfile,
  normalizeInteractionProfile,
  resolveInteractionRequest
} from "../src/interaction-profile-store.mjs";

describe("InteractionProfile Context Providers", () => {
  it("normalizes legacy provider aliases to stable Runtime provider ids", () => {
    const profile = normalizeInteractionProfile({
      id: "legacy",
      modelProfileId: "model",
      contextProviders: {
        enabled: ["skills", "memory", "project", "compression"],
        disabled: ["terminal-inventory"]
      }
    });

    expect(profile.contextProviders).toEqual({
      enabled: [
        "dev.skills.available",
        "dev.memory.context",
        "dev.identity.context",
        "dev.context-compression"
      ],
      disabled: ["dev.terminal-manager.inventory"]
    });
  });

  it("seeds explicit provider ids for interactive and scheduled defaults", () => {
    const interactive = createDefaultInteractionProfile({
      modelProfileId: "model",
      availableToolNames: [
        "read", "write", "Bash", "memoryList", "modelsManage",
        "observabilityQuery", "observabilityRawRead"
      ]
    });
    expect(interactive.policy).toMatchObject({
      preset: "read-only",
      allowedTools: [
        "read", "memoryList", "observabilityQuery", "observabilityRawRead"
      ]
    });
    expect(interactive.contextProviders).toEqual({
      enabled: [
        "dev.skills.available",
        "dev.terminal-manager.inventory",
        "dev.memory.context",
        "dev.identity.context",
        "dev.context-compression"
      ],
      disabled: []
    });
    expect(createDefaultScheduledInteractionProfile({
      modelProfileId: "model"
    }).contextProviders).toEqual({
      enabled: [
        "dev.skills.available",
        "dev.terminal-manager.inventory",
        "dev.memory.context",
        "dev.identity.context",
        "dev.context-compression"
      ],
      disabled: []
    });
  });

  it("restores terminal context for Scheduler runs using a legacy scheduled default", () => {
    const profile = normalizeInteractionProfile({
      id: "scheduled.default",
      modelProfileId: "model",
      policy: {
        preset: "trusted-automation",
        allowedTools: ["Bash"]
      },
      contextProviders: {
        enabled: ["dev.memory.context"],
        disabled: ["dev.terminal-manager.inventory"]
      },
      metadata: {
        includeTerminalContext: false
      }
    });

    const resolved = resolveInteractionRequest({
      body: {
        interactionProfileId: "scheduled.default",
        metadata: { source: "scheduler-worker" }
      },
      interactionProfiles: {
        get: () => profile
      }
    });

    expect(resolved.metadata).toMatchObject({
      includeTerminalContext: true,
      contextProviders: {
        enabled: [
          "dev.memory.context",
          "dev.terminal-manager.inventory"
        ],
        disabled: []
      }
    });
  });
});
