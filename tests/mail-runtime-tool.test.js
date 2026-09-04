import { describe, expect, it, vi } from "vitest";
import { activateRuntimePlugin } from "../extensions/dev.mail/runtime.js";
import {
  buildMailProfilePatch,
  mailManageToolDefinition
} from "../extensions/dev.mail/mail-runtime-shared.js";

function activateWithService(service) {
  const tools = [];
  const stateBucket = new Map();
  activateRuntimePlugin({
    apiVersion: 2,
    plugin: { id: "dev.mail", version: "test" },
    config: { mailService: service },
    log: vi.fn(),
    tools: {
      registerTool(tool) {
        tools.push(tool);
        return { dispose() {} };
      }
    },
    context: { registerProvider: vi.fn() },
    state: {
      namespace: vi.fn(() => ({
        get: (key) => stateBucket.get(String(key)),
        set: (key, value) => {
          if (value == null) stateBucket.delete(String(key));
          else stateBucket.set(String(key), value);
          return value;
        },
        delete: (key) => stateBucket.delete(String(key)),
        entries: () => Array.from(stateBucket.entries())
      }))
    }
  });
  return tools[0];
}

function profile(overrides = {}) {
  return {
    id: "interactive.default",
    modelProfileId: "workbench.user.dynamic.kimi-k2.5",
    policy: {
      preset: "read-only",
      allowedTools: ["read"],
      allowedRecipients: [],
      maxMailPerRun: 0,
      ...overrides.policy
    },
    metadata: {
      ...(overrides.metadata || {})
    }
  };
}

describe("Runtime mailManage tool", () => {
  it("exposes a trusted mailManage schema", () => {
    expect(mailManageToolDefinition()).toMatchObject({
      name: "mailManage",
      inputSchema: {
        properties: {
          action: {
            enum: [
              "list",
              "add_recipient",
              "remove_recipient",
              "set_default_recipient",
              "set_notify_always",
              "set_notify_once_for_session"
            ]
          }
        }
      }
    });
    expect(buildMailProfilePatch(profile(), {
      recipients: ["TEAM@example.com"],
      defaultRecipient: "TEAM@example.com"
    })).toMatchObject({
      policy: {
        preset: "trusted-automation",
        allowedTools: ["read", "sendMail"],
        allowedRecipients: ["team@example.com"],
        maxMailPerRun: 10
      },
      metadata: {
        mail: {
          defaultRecipient: "team@example.com",
          notifyAlways: false
        }
      }
    });
  });

  it("manages Runtime mail policy on the InteractionProfile", async () => {
    let current = profile();
    const service = {
      getProfile: vi.fn(() => current),
      patchProfile: vi.fn((profileId, patch) => {
        current = {
          ...current,
          policy: {
            ...current.policy,
            ...patch.policy
          },
          metadata: {
            ...current.metadata,
            ...patch.metadata
          }
        };
        return current;
      })
    };
    const tool = activateWithService(service);

    expect(tool.name).toBe("mailManage");
    expect(tool.policy).toEqual({ minimumPreset: "trusted-automation" });

    const initial = JSON.parse((await tool.invoke({ action: "list" })).content);
    expect(initial).toMatchObject({
      recipients: [],
      send_mail_enabled: false,
      max_mail_per_run: 0
    });

    const added = JSON.parse((await tool.invoke({
      action: "add_recipient",
      email: "Team@Example.com"
    })).content);
    expect(added).toMatchObject({
      recipients: ["team@example.com"],
      default_recipient: "team@example.com",
      send_mail_enabled: true,
      max_mail_per_run: 10
    });
    expect(service.patchProfile).toHaveBeenLastCalledWith("interactive.default", {
      policy: expect.objectContaining({
        preset: "trusted-automation",
        allowedTools: ["read", "sendMail"],
        allowedRecipients: ["team@example.com"],
        maxMailPerRun: 10
      }),
      metadata: {
        mail: {
          defaultRecipient: "team@example.com",
          notifyAlways: false
        }
      }
    });

    const notify = JSON.parse((await tool.invoke({
      action: "set_notify_always",
      enabled: true
    })).content);
    expect(notify).toMatchObject({
      notify_always: true
    });

    const once = JSON.parse((await tool.invoke({
      action: "set_notify_once_for_session",
      session_id: "session_123"
    })).content);
    expect(once).toMatchObject({
      session_id: "session_123",
      notify_once: true
    });
    const listed = JSON.parse((await tool.invoke({ action: "list" })).content);
    expect(listed.notify_once_sessions).toEqual(["session_123"]);

    const removed = JSON.parse((await tool.invoke({
      action: "remove_recipient",
      email: "team@example.com"
    })).content);
    expect(removed).toMatchObject({
      recipients: [],
      default_recipient: "",
      send_mail_enabled: false,
      max_mail_per_run: 0
    });
    expect(current.policy).toMatchObject({
      preset: "read-only",
      allowedTools: ["read"],
      allowedRecipients: [],
      maxMailPerRun: 0
    });
  });

  it("rejects invalid recipient email addresses", async () => {
    const tool = activateWithService({
      getProfile: () => profile(),
      patchProfile: vi.fn()
    });

    await expect(tool.invoke({
      action: "add_recipient",
      email: "not-an-email"
    })).resolves.toMatchObject({
      ok: false,
      error: "Invalid email"
    });
  });
});
