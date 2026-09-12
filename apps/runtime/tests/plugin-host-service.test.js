import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  createPluginHostService
} from "../src/plugin-host-service.mjs";

function jsonResponse(value, status = 200) {
  return new globalThis.Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function deviceResponse(value, status = 200) {
  return {
    ok: true,
    content: JSON.stringify({
      status,
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from(JSON.stringify(value), "utf8").toString("base64")
    })
  };
}

describe("Plugin Host service", () => {
  it("uses the local Plugin Host directly outside Node mode", async () => {
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/plugins/") {
        return jsonResponse({
          success: true,
          data: [{ id: "dev.one" }],
          total: 1
        });
      }
      if (url.pathname === "/plugins/dev/list") {
        return jsonResponse({
          success: true,
          data: { sessions: [{ devId: "dev-1" }] }
        });
      }
      if (url.pathname === "/plugins/dev/start") {
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({
          path: "/workspace/plugin"
        });
        return jsonResponse({
          success: true,
          data: { devId: "dev-2" }
        });
      }
      throw new Error(`Unexpected Plugin Host request: ${url}`);
    });
    const service = createPluginHostService({
      baseUrl: "http://127.0.0.1:8767",
      fetchImpl
    });

    await expect(service.list({ limit: 10 })).resolves.toEqual({
      plugins: [{ id: "dev.one" }],
      total: 1,
      limit: 10,
      offset: 0,
      devSessions: [{ devId: "dev-1" }]
    });
    await expect(service.startDev({
      path: "/workspace/plugin"
    })).resolves.toEqual({ devId: "dev-2" });
  });

  it("routes remote Plugin Host requests through the Device Broker", async () => {
    const invoke = vi.fn(async (invocation) => {
      const args = invocation.toolCall.arguments;
      expect(args.service).toBe("plugin-service");
      expect(args.method).toBe("GET");
      expect(args.path).toBe("/plugins/search?query=identity&limit=5");
      return deviceResponse({
        success: true,
        data: [{ id: "dev.identity" }],
        count: 1
      });
    });
    const service = createPluginHostService({
      nodeBroker: { invoke }
    });
    const signal = {
      throwIfCancelled() {},
      onCancel() {
        return { dispose() {} };
      }
    };

    await expect(service.search({
      query: "identity",
      limit: 5,
      runContext: {
        runId: "run-1",
        attemptId: "attempt-1",
        sessionId: "session-1",
        projectId: "project-1",
        signal
      }
    })).resolves.toEqual({
      query: "identity",
      plugins: [{ id: "dev.identity" }],
      count: 1
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        attemptId: "attempt-1",
        sessionId: "session-1",
        projectId: "project-1",
        policy: {
          preset: "trusted-automation",
          allowedTools: ["zion.internal.deviceService"]
        },
        toolCall: expect.objectContaining({
          name: "zion.internal.deviceService"
        })
      }),
      signal
    );
  });
});
