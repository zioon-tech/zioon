import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { RuntimeAccessControl } from "../src/access-control.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

const resources = [];
let database;

beforeAll(async () => {
  database = await createPostgresTestDatabase("runtime_access");
});

afterAll(async () => {
  await database.close();
});

async function pairedCredential(store, kind, deviceId) {
  const pairing = await store.createPairing({
    kind,
    delivery: "bearer"
  });
  return (await store.exchangePairing({
    userCode: pairing.userCode,
    deviceId
  })).credential;
}

async function createHarness() {
  const spaceId = database.nextSpaceId();
  const runs = new PostgresRunStore(database.pool, { spaceId });
  const accessStore = new PostgresAccessStore(database.pool, { spaceId });
  const access = new RuntimeAccessControl({
    store: accessStore,
    allowedOrigins: ["https://workbench.test"]
  });
  const executor = createAgentExecutor({
    engine: {
      id: "access-test",
      async *streamTurn() {
        yield { type: "message.delta", delta: "ok" };
      }
    },
    tools: {
      async listTools() { return []; },
      async invoke() { throw new Error("No tools configured"); }
    },
    runs
  });
  const server = createRuntimeServer({
    executor,
    runs,
    port: 0,
    accessControl: access,
    publicHttpHandlers: [access.handleHttp.bind(access)],
    serviceInfo: { internalDetail: "authenticated-only" }
  });
  const address = await server.start();
  const harness = { runs, accessStore, access, server, url: address.url };
  resources.push(harness);
  return harness;
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.server.close();
    await resource.accessStore.close();
    await resource.runs.close();
  }
});

describe("Runtime Access Control integration", () => {
  it("keeps public health minimal and protects the Runtime API", async () => {
    const harness = await createHarness();

    const health = await fetch(`${harness.url}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      ok: true,
      service: "zion-runtime",
      authRequired: true
    });

    const unauthorized = await fetch(`${harness.url}/v1/models`);
    expect(unauthorized.status).toBe(401);

    const clientCredential = await pairedCredential(
      harness.accessStore,
      "client",
      "client:test"
    );
    const authenticated = await fetch(`${harness.url}/v1/models`, {
      headers: { authorization: `Bearer ${clientCredential}` }
    });
    expect(authenticated.status).toBe(200);

    const resourceCredential = await pairedCredential(
      harness.accessStore,
      "resource",
      "node:test"
    );
    const forbidden = await fetch(`${harness.url}/v1/models`, {
      headers: { authorization: `Bearer ${resourceCredential}` }
    });
    expect(forbidden.status).toBe(403);
  });

  it("uses a paired HttpOnly Workbench session on Runtime routes", async () => {
    const harness = await createHarness();
    const pairing = await harness.accessStore.createPairing({
      kind: "client",
      delivery: "cookie"
    });
    const exchange = await fetch(`${harness.url}/v1/access/pair`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://workbench.test"
      },
      body: JSON.stringify({
        userCode: pairing.userCode,
        device: { deviceId: "client:phone", platform: "mobile" }
      })
    });
    const cookie = String(exchange.headers.get("set-cookie")).split(";")[0];

    const response = await fetch(`${harness.url}/v1/models`, {
      headers: {
        cookie,
        origin: "https://workbench.test"
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("requires Access Control even when non-loopback binding is explicitly enabled", () => {
    const runs = new PostgresRunStore(database.pool, {
      spaceId: database.nextSpaceId()
    });
    resources.push({
      runs,
      accessStore: { close() {} },
      server: { async close() {} }
    });
    const executor = createAgentExecutor({
      engine: {
        id: "access-test",
        async *streamTurn() {
          yield { type: "message.delta", delta: "ok" };
        }
      },
      tools: {
        async listTools() { return []; },
        async invoke() { throw new Error("No tools configured"); }
      },
      runs
    });

    expect(() => createRuntimeServer({
      executor,
      runs,
      host: "0.0.0.0",
      allowRemote: true
    })).toThrow("requires Access Control");
  });
});
