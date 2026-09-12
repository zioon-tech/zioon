import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeviceServiceHttpHandler
} from "../src/device-service-http-handler.mjs";

const servers = [];

async function start(handler) {
  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "127.0.0.1"}`
    );
    if (!await handler(request, response, url)) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
});

describe("Device service HTTP handler", () => {
  it("relays same-origin service requests through the Node Broker", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      content: JSON.stringify({
        status: 200,
        headers: { "content-type": "text/javascript" },
        bodyBase64: Buffer.from("export const ok = true;").toString("base64")
      })
    }));
    const authorize = vi.fn();
    const url = await start(createDeviceServiceHttpHandler({
      broker: { invoke },
      authorize
    }));

    const response = await fetch(
      `${url}/v1/device-services/plugin-service/plugins/dev/dev-1/main.js`
        + "?zionDevTs=1",
      { headers: { accept: "text/javascript" } }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript");
    await expect(response.text()).resolves.toBe("export const ok = true;");
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith(
      expect.anything(),
      {
        service: "plugin-service",
        path: "/plugins/dev/dev-1/main.js"
      }
    );
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.objectContaining({
          allowedTools: ["zion.internal.deviceService"]
        }),
        toolCall: expect.objectContaining({
          name: "zion.internal.deviceService",
          arguments: expect.objectContaining({
            service: "plugin-service",
            method: "GET",
            path: "/plugins/dev/dev-1/main.js?zionDevTs=1"
          })
        })
      }),
      expect.any(Object)
    );
  });

  it("downloads plugin packages from the Node that has them when the request has no target", async () => {
    const targets = [
      {
        node: { registration: { nodeId: "node:cloud" } },
        resource: { resourceId: "workspace:cloud" }
      },
      {
        node: { registration: { nodeId: "node:mac" } },
        resource: { resourceId: "workspace:mac" }
      }
    ];
    const invoke = vi.fn(async (invocation) => {
      if (invocation.target?.nodeId === "node:cloud") {
        return {
          ok: true,
          content: JSON.stringify({
            status: 404,
            headers: { "content-type": "application/json" },
            bodyBase64: Buffer.from(JSON.stringify({ detail: "not found" }))
              .toString("base64")
          })
        };
      }
      return {
        ok: true,
        content: JSON.stringify({
          status: 200,
          headers: { "content-type": "application/octet-stream" },
          bodyBase64: Buffer.from("plugin-zip").toString("base64")
        })
      };
    });
    const url = await start(createDeviceServiceHttpHandler({
      broker: {
        invoke,
        availableTargets: vi.fn(() => targets)
      }
    }));

    const response = await fetch(
      `${url}/v1/device-services/plugin-service/plugins/dev.identity/download`
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("plugin-zip");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: { nodeId: "node:cloud", resourceId: "workspace:cloud" }
      }),
      expect.any(Object)
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: { nodeId: "node:mac", resourceId: "workspace:mac" }
      }),
      expect.any(Object)
    );
  });

  it("aggregates plugin lists across Nodes when the request has no target", async () => {
    const targets = [
      {
        node: { registration: { nodeId: "node:cloud" } },
        resource: { resourceId: "workspace:cloud" }
      },
      {
        node: { registration: { nodeId: "node:mac" } },
        resource: { resourceId: "workspace:mac" }
      }
    ];
    const invoke = vi.fn(async (invocation) => {
      const data = invocation.target?.nodeId === "node:mac"
        ? [{ id: "dev.identity", metadata: { version: "0.1.7" } }]
        : [];
      return {
        ok: true,
        content: JSON.stringify({
          status: 200,
          headers: { "content-type": "application/json" },
          bodyBase64: Buffer.from(JSON.stringify({
            success: true,
            data,
            total: data.length
          })).toString("base64")
        })
      };
    });
    const url = await start(createDeviceServiceHttpHandler({
      broker: {
        invoke,
        availableTargets: vi.fn(() => targets)
      }
    }));

    const response = await fetch(
      `${url}/v1/device-services/plugin-service/plugins`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [{
        id: "dev.identity",
        metadata: { version: "0.1.7" },
        node_id: "node:mac"
      }],
      total: 1
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("aggregates plugin dev sessions across Nodes when the request has no target", async () => {
    const targets = [
      {
        node: { registration: { nodeId: "node:cloud" } },
        resource: { resourceId: "workspace:cloud" }
      },
      {
        node: { registration: { nodeId: "node:mac" } },
        resource: { resourceId: "workspace:mac" }
      }
    ];
    const invoke = vi.fn(async (invocation) => {
      const sessions = invocation.target?.nodeId === "node:mac"
        ? [{ devId: "dev-1", pluginId: "dev.identity" }]
        : [];
      return {
        ok: true,
        content: JSON.stringify({
          status: 200,
          headers: { "content-type": "application/json" },
          bodyBase64: Buffer.from(JSON.stringify({
            success: true,
            data: { sessions }
          })).toString("base64")
        })
      };
    });
    const url = await start(createDeviceServiceHttpHandler({
      broker: {
        invoke,
        availableTargets: vi.fn(() => targets)
      }
    }));

    const response = await fetch(
      `${url}/v1/device-services/plugin-service/plugins/dev/list`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        sessions: [{
          devId: "dev-1",
          pluginId: "dev.identity",
          node_id: "node:mac"
        }]
      }
    });
  });

  it("routes Owner Device access requests to the selected Resource project", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      content: JSON.stringify({
        status: 200,
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(JSON.stringify({
          policy: { scope: "registered-projects" }
        })).toString("base64")
      })
    }));
    const authorize = vi.fn();
    const url = await start(createDeviceServiceHttpHandler({
      broker: { invoke },
      authorize
    }));

    const response = await fetch(
      `${url}/v1/device-services/device-access/policy?project_id=project%3Aone`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      policy: { scope: "registered-projects" }
    });
    expect(authorize).toHaveBeenCalledWith(
      expect.anything(),
      { service: "device-access", path: "/policy" }
    );
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project:one",
        toolCall: expect.objectContaining({
          arguments: expect.objectContaining({
            service: "device-access",
            path: "/policy?project_id=project%3Aone"
          })
        })
      }),
      expect.any(Object)
    );
  });

  it("returns an authorization error without contacting a Device", async () => {
    const invoke = vi.fn();
    const error = new Error("Owner permission required");
    error.statusCode = 403;
    const url = await start(createDeviceServiceHttpHandler({
      broker: { invoke },
      authorize() {
        throw error;
      }
    }));

    const response = await fetch(
      `${url}/v1/device-services/local-tools/sessions`
    );

    expect(response.status).toBe(403);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("serves local terminal inventory when no Node Broker is configured", async () => {
    const terminalService = {
      listInventory: vi.fn(async () => ({
        sessions: [{ id: "local-session", type: "local", cwd: "/workspace" }],
        machines: [{ id: "machine:local", name: "This Mac", kind: "local" }],
        nodes: []
      }))
    };
    const url = await start(createDeviceServiceHttpHandler({
      terminalService,
      serviceBaseUrls: {
        "local-tools": "http://127.0.0.1:8765"
      }
    }));

    const sessions = await fetch(
      `${url}/v1/device-services/local-tools/sessions`
    );
    const machines = await fetch(
      `${url}/v1/device-services/local-tools/machines`
    );

    expect(sessions.status).toBe(200);
    await expect(sessions.json()).resolves.toEqual({
      sessions: [{ id: "local-session", type: "local", cwd: "/workspace" }],
      nodes: []
    });
    expect(machines.status).toBe(200);
    await expect(machines.json()).resolves.toEqual({
      machines: [{ id: "machine:local", name: "This Mac", kind: "local" }],
      nodes: []
    });
    expect(terminalService.listInventory).toHaveBeenCalledTimes(2);
  });

  it("relays local Runtime service routes without a Node Broker", async () => {
    const fetchImpl = vi.fn(async (url, options) => new Response(
      JSON.stringify({
        session: {
          id: "local-session",
          command: JSON.parse(options.body.toString()).command
        }
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    ));
    const url = await start(createDeviceServiceHttpHandler({
      serviceBaseUrls: {
        "local-tools": "http://127.0.0.1:8765"
      },
      fetchImpl
    }));

    const response = await fetch(
      `${url}/v1/device-services/local-tools/sessions/local-session/exec`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "pwd" })
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: { id: "local-session", command: "pwd" }
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8765/sessions/local-session/exec"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json"
        }),
        signal: expect.any(AbortSignal),
        body: expect.any(Buffer)
      })
    );
  });
});
