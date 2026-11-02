import { describe, expect, it, vi } from "vitest";
import { accountRequestScope } from "../src/accounts/account-access-control.mjs";
import { createRuntimeServer } from "../src/server.mjs";

describe("ADC plugin account routing", () => {
  it("permits account plugin commands while retaining administrative methods", () => {
    expect(accountRequestScope("POST", "/v1/plugins/dev.agent-device-cloud/commands")).toBe("runtime.read");
    expect(accountRequestScope("POST", "/v1/plugins/dev.other/commands")).toBe("runtime.read");
    expect(accountRequestScope("PUT", "/v1/plugins/dev.agent-device-cloud/commands")).toBe("runtime.manage");
  });

  it("passes the authenticated principal and Origin, and requires execution scope for mutations", async () => {
    const principal = { kind: "account", user: { id: "user-adc" }, space: { id: "space-adc" } };
    const commands = vi.fn(async (_id, _args, call) => ({
      userId: call.principal.user.id, origin: call.origin
    }));
    const accessControl = {
      applyCors: () => true,
      authorizeRuntimeRequest: async () => principal,
      requireScope: vi.fn(async (_principal, scope) => {
        if (scope === "run.execute") throw Object.assign(new Error("Permission denied"), { statusCode: 403 });
      })
    };
    const sessions = {
      createSession() {}, forkSession() {}, getSession: async () => ({ id: "session-adc" }),
      getSessionMessages() {}, getSessionTranscript() {}, appendSessionMessages() {}, listSessions() {}
    };
    const server = createRuntimeServer({
      executor: { execute() {} }, runs: { get() {}, getEvents() {} }, sessions,
      accessControl, pluginCommands: commands
    });
    try {
      const { url } = await server.start();
      const call = (action) => fetch(`${url}/v1/plugins/dev.agent-device-cloud/commands`, {
        method: "POST", headers: { origin: "https://zion.example", "content-type": "application/json" },
        body: JSON.stringify({ action, sessionId: "session-adc", principal: { user: { id: "forged" } } })
      });
      const status = await call("status");
      expect(status.status).toBe(200);
      expect((await status.json()).result).toEqual({ userId: "user-adc", origin: "https://zion.example" });
      expect((await call("connect")).status).toBe(403);
      expect(commands).toHaveBeenCalledTimes(1);
      expect(accessControl.requireScope).toHaveBeenCalledWith(principal, "run.execute");
    } finally { await server.close(); }
  });
});
