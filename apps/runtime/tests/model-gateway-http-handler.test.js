import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { createModelGatewayHttpHandler } from "../src/model-gateway-http-handler.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { SqliteRunStore } from "../src/sqlite-run-store.mjs";

const resources = [];

async function startServer(handler) {
  const directory = mkdtempSync(join(tmpdir(), "zion-model-gateway-"));
  const store = new SqliteRunStore(join(directory, "runtime.sqlite3"));
  const executor = createAgentExecutor({
    engine: {
      id: "unused",
      async *streamTurn() {
        yield { type: "message.delta", delta: "unused" };
      }
    },
    tools: {
      async listTools() {
        return [];
      },
      async invoke() {
        throw new Error("No tools configured");
      }
    },
    runs: store
  });
  const server = createRuntimeServer({
    executor,
    runs: store,
    port: 0,
    serviceHttpHandlers: [handler]
  });
  const address = await server.start();
  resources.push({ directory, store, server });
  return address.url;
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.server.close();
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("Runtime model gateway", () => {
  it("streams registered model traffic and applies Runtime credentials", async () => {
    const upstream = vi.fn(async (url, options) => {
      let body = "";
      for await (const chunk of options.body) body += chunk.toString();
      expect(String(url)).toBe("https://models.example/v1/chat/completions");
      expect(options.headers.authorization).toBe("Bearer runtime-secret");
      expect(body).toBe('{"model":"demo"}');
      return new Response("data: ok\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    const handler = createModelGatewayHttpHandler({
      profiles: [{
        id: "demo",
        endpoint: "https://models.example/v1/chat/completions",
        credentialRef: "model.demo"
      }],
      credentials: {
        async acquire() {
          return {
            headers: { authorization: "Bearer runtime-secret" },
            release: vi.fn()
          };
        }
      },
      fetchImpl: upstream
    });
    const url = await startServer(handler);

    const response = await fetch(
      `${url}/v1/model-gateway/proxy?target=${encodeURIComponent(
        "https://models.example/v1/chat/completions"
      )}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer browser-secret"
        },
        body: '{"model":"demo"}'
      }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: ok\n\n");
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("uses the requested profile when multiple profiles share an endpoint", async () => {
    const acquire = vi.fn(async ({ ref }) => ({
      headers: {
        authorization: ref === "model.requested"
          ? "Bearer requested-secret"
          : "Bearer wrong-secret"
      },
      release: vi.fn()
    }));
    const upstream = vi.fn(async (_url, options) => {
      expect(options.headers.authorization).toBe("Bearer requested-secret");
      return new Response("data: ok\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    const handler = createModelGatewayHttpHandler({
      profiles: [{
        id: "first-match",
        endpoint: "https://models.example/v1/chat/completions",
        credentialRef: "model.first"
      }, {
        id: "requested-profile",
        endpoint: "https://models.example/v1/chat/completions",
        credentialRef: "model.requested"
      }],
      credentials: { acquire },
      fetchImpl: upstream
    });
    const url = await startServer(handler);

    const query = new URLSearchParams({
      target: "https://models.example/v1/chat/completions",
      profileId: "requested-profile"
    });
    const response = await fetch(
      `${url}/v1/model-gateway/proxy?${query}`,
      { method: "POST", body: '{"model":"demo"}' }
    );

    expect(response.status).toBe(200);
    expect(acquire).toHaveBeenCalledWith({ ref: "model.requested" });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("rejects a target that does not match the requested profile", async () => {
    const handler = createModelGatewayHttpHandler({
      profiles: [{
        id: "requested-profile",
        endpoint: "https://models.example/v1/chat/completions",
        credentialRef: "model.requested"
      }],
      fetchImpl: vi.fn()
    });
    const url = await startServer(handler);
    const query = new URLSearchParams({
      target: "https://api.deepseek.com/chat/completions",
      profileId: "requested-profile"
    });

    const response = await fetch(
      `${url}/v1/model-gateway/proxy?${query}`,
      { method: "POST", body: "{}" }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Model gateway target does not match the requested profile"
    });
  });

  it("rejects arbitrary proxy targets", async () => {
    const handler = createModelGatewayHttpHandler({
      profiles: [],
      fetchImpl: vi.fn()
    });
    const url = await startServer(handler);

    const response = await fetch(
      `${url}/v1/model-gateway/proxy?target=${encodeURIComponent(
        "http://169.254.169.254/latest/meta-data"
      )}`,
      { method: "POST", body: "{}" }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Model gateway target is not registered"
    });
  });
});
