import { describe, expect, it } from "vitest";
import { createDeviceServiceClient } from "../src/device-service-client.mjs";

describe("device service failure propagation", () => {
  it.each(["stale_terminal_reference", "execution_outcome_unknown"])("preserves broker %s errors", async (failureCode) => {
    const client = createDeviceServiceClient({
      service: "local-tools",
      nodeBroker: { invoke: async () => ({ ok: false, error: "interrupted", failureCode, retryable: false }) }
    });
    await expect(client.request("/sessions")).rejects.toMatchObject({
      failureCode, retryable: false, statusCode: failureCode === "stale_terminal_reference" ? 409 : 502
    });
  });

  it("preserves session busy errors through a Device HTTP envelope", async () => {
    const client = createDeviceServiceClient({
      service: "local-tools",
      nodeBroker: { invoke: async () => ({
        ok: true,
        content: JSON.stringify({
          status: 409,
          bodyBase64: Buffer.from(JSON.stringify({
            ok: false, error: "session busy", failureCode: "terminal_session_busy", retryable: true
          })).toString("base64")
        })
      }) }
    });
    await expect(client.request("/sessions/one/exec", { method: "POST", body: { command: "echo ok" } })).rejects.toMatchObject({
      statusCode: 409, failureCode: "terminal_session_busy", retryable: true
    });
  });
});
