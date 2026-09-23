import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CancellationController,
  createAgentExecutor,
  MemoryRunStore
} from "../../../packages/runtime/src/index";
import { RuntimeAccessControl } from "../../runtime/src/access-control.mjs";
import { NodeBroker } from "../../runtime/src/node-broker.mjs";
import { createNodeHttpHandler } from "../../runtime/src/node-http-handler.mjs";
import { PostgresAccessStore } from "../../runtime/src/postgres-access-store.mjs";
import {
  createPostgresTestDatabase
} from "../../runtime/tests/helpers/postgres-test-database.mjs";
import {
  DeviceConnector,
  exchangeDevicePairing
} from "../src/device-connector.mjs";
import {
  DEVICE_SERVICE_TOOL_NAME
} from "../src/device-service-host.mjs";

const resources = [];
let database;

beforeAll(async () => {
  database = await createPostgresTestDatabase("device_connector");
});

afterAll(async () => {
  await database.close();
});

function registration(instanceId = "instance:connector") {
  return {
    protocolVersion: 1,
    nodeId: "node:connector",
    instanceId,
    label: "Connector Test",
    platform: "test",
    capabilities: [{
      name: "read",
      version: "1",
      risk: "read",
      description: "Read a file",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" }
        }
      },
      hostKind: "local-tools"
    }],
    resources: [{
      resourceId: "workspace:connector",
      kind: "workspace",
      projectId: "project:connector"
    }]
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function createHarness({
  token = "device-secret",
  connectorToken = token,
  toolHost,
  serviceHost,
  registration: registrationInput = registration()
} = {}) {
  const broker = new NodeBroker();
  const handler = createNodeHttpHandler({
    broker,
    token,
    maxWaitMs: 30
  });
  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "127.0.0.1"}`
    );
    await handler(request, response, url);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const connector = new DeviceConnector({
    runtimeUrl: `http://127.0.0.1:${address.port}`,
    token: connectorToken,
    registration: registrationInput,
    toolHost: toolHost || {
      async invoke() {
        return { ok: true, content: "device result" };
      }
    },
    serviceHost,
    pollWaitMs: 20,
    retryDelayMs: 5
  });
  resources.push({ broker, connector, server });
  return { broker, connector };
}

function invocation() {
  return {
    invocationId: "invocation:connector",
    runId: "run:connector",
    attemptId: "attempt:connector",
    projectId: "project:connector",
    policy: {
      allowedTools: ["read"]
    },
    toolCall: {
      id: "call:connector",
      name: "read",
      arguments: {
        path: "/workspace/README.md"
      }
    }
  };
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.connector.stop();
    resource.broker.close();
    await new Promise((resolve) => resource.server.close(resolve));
    await resource.accessStore?.close();
  }
});

describe("DeviceConnector", () => {
  it("registers outward and executes a Runtime invocation locally", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      content: "read through local-tools"
    }));
    const { broker, connector } = await createHarness({
      toolHost: { invoke }
    });
    await connector.start();

    await expect(broker.listTools({
      projectId: "project:connector",
      policy: { allowedTools: ["read"] }
    })).resolves.toEqual([
      expect.objectContaining({ name: "read" })
    ]);
    await expect(broker.invoke(
      invocation(),
      new CancellationController().signal
    )).resolves.toEqual({
      ok: true,
      content: "read through local-tools"
    });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: "invocation:connector",
        projectId: "project:connector"
      }),
      expect.objectContaining({
        cancelled: false
      }),
      {
        resourceId: "workspace:connector"
      }
    );
    await waitFor(
      () => connector.snapshot().activeInvocations === 0,
      "Connector did not settle its invocation"
    );
  });

  it("dispatches internal service requests to the Device service host", async () => {
    const serviceInvoke = vi.fn(async () => ({
      ok: true,
      content: JSON.stringify({ status: 200, bodyBase64: "" })
    }));
    const serviceRegistration = registration();
    serviceRegistration.capabilities.push({
      name: DEVICE_SERVICE_TOOL_NAME,
      version: "1",
      risk: "execute",
      description: "Internal Device service",
      inputSchema: { type: "object" },
      hostKind: "device-service"
    });
    const { broker, connector } = await createHarness({
      serviceHost: { invoke: serviceInvoke },
      registration: serviceRegistration
    });
    await connector.start();

    await expect(broker.invoke({
      ...invocation(),
      policy: { allowedTools: [DEVICE_SERVICE_TOOL_NAME] },
      toolCall: {
        id: "call:service",
        name: DEVICE_SERVICE_TOOL_NAME,
        arguments: {
          service: "local-tools",
          method: "GET",
          path: "/sessions"
        }
      }
    }, new CancellationController().signal)).resolves.toMatchObject({
      ok: true
    });
    expect(serviceInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        service: "local-tools",
        path: "/sessions"
      }),
      expect.any(Object),
      expect.objectContaining({
        invocationId: "invocation:connector"
      })
    );
  });

  it("pairs a Resource and completes an invocation with its bound credential", async () => {
    const broker = new NodeBroker();
    const accessStore = new PostgresAccessStore(database.pool, {
      spaceId: database.nextSpaceId()
    });
    const access = new RuntimeAccessControl({ store: accessStore });
    const handler = createNodeHttpHandler({
      broker,
      authorize: (input) => access.authorizeNode(input),
      maxWaitMs: 30
    });
    const server = createServer(async (request, response) => {
      const url = new URL(
        request.url || "/",
        `http://${request.headers.host || "127.0.0.1"}`
      );
      if (await access.handleHttp(request, response, url)) return;
      await handler(request, response, url);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const runtimeUrl = `http://127.0.0.1:${address.port}`;
    const pairing = await accessStore.createPairing({
      kind: "resource",
      delivery: "bearer"
    });
    const paired = await exchangeDevicePairing({
      runtimeUrl,
      userCode: pairing.userCode,
      device: {
        deviceId: "node:connector",
        label: "Connector Test"
      }
    });
    const connector = new DeviceConnector({
      runtimeUrl,
      token: paired.credential,
      registration: registration(),
      toolHost: {
        async invoke() {
          return { ok: true, content: "paired result" };
        }
      },
      pollWaitMs: 20,
      retryDelayMs: 5
    });
    resources.push({ broker, connector, server, accessStore });
    await connector.start();

    await expect(broker.invoke(
      invocation(),
      new CancellationController().signal
    )).resolves.toEqual({
      ok: true,
      content: "paired result"
    });
  });

  it("stops polling when the Resource credential is revoked", async () => {
    const broker = new NodeBroker();
    const accessStore = new PostgresAccessStore(database.pool, {
      spaceId: database.nextSpaceId()
    });
    const access = new RuntimeAccessControl({ store: accessStore });
    const handler = createNodeHttpHandler({
      broker,
      authorize: (input) => access.authorizeNode(input),
      maxWaitMs: 30
    });
    const server = createServer(async (request, response) => {
      const url = new URL(
        request.url || "/",
        `http://${request.headers.host || "127.0.0.1"}`
      );
      if (await access.handleHttp(request, response, url)) return;
      await handler(request, response, url);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const runtimeUrl = `http://127.0.0.1:${address.port}`;
    const pairing = await accessStore.createPairing({
      kind: "resource",
      delivery: "bearer"
    });
    const paired = await accessStore.exchangePairing({
      userCode: pairing.userCode,
      deviceId: "node:connector"
    });
    const logger = vi.fn();
    const connector = new DeviceConnector({
      runtimeUrl,
      token: paired.credential,
      registration: registration(),
      toolHost: { async invoke() {} },
      pollWaitMs: 20,
      retryDelayMs: 5,
      logger
    });
    resources.push({ broker, connector, server, accessStore });
    await connector.start();

    await accessStore.revokeDevice("node:connector");

    await waitFor(
      () => connector.snapshot().state === "unauthorized",
      "Revoked Connector did not stop"
    );
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      message: expect.stringContaining("pair this Device again")
    }));
  });

  it("completes an Agent tool loop through the remote Node connection", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      content: "README from the device"
    }));
    const { broker, connector } = await createHarness({
      toolHost: { invoke }
    });
    await connector.start();
    const executor = createAgentExecutor({
      engine: {
        id: "node-e2e",
        async *streamTurn(request) {
          if (request.turn === 1) {
            yield {
              type: "tool.call",
              call: {
                id: "call:remote-read",
                name: "read",
                arguments: {
                  path: "/workspace/README.md"
                }
              }
            };
            return;
          }
          const toolMessage = request.messages.find(
            (message) => message.role === "tool"
          );
          yield {
            type: "message.delta",
            delta: `model saw: ${toolMessage?.content || ""}`
          };
        }
      },
      tools: broker,
      runs: new MemoryRunStore()
    });

    const handle = executor.execute({
      prompt: "Read the project README",
      projectId: "project:connector",
      policy: {
        allowedTools: ["read"],
        maxToolCalls: 2
      }
    });
    const events = [];
    for await (const event of handle.events) events.push(event);
    const result = await handle.completion;

    expect(result).toMatchObject({
      status: "completed",
      output: "model saw: README from the device"
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool.requested" }),
      expect.objectContaining({
        type: "tool.completed",
        data: expect.objectContaining({ ok: true })
      }),
      expect.objectContaining({ type: "run.completed" })
    ]));
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("propagates Runtime cancellation to the local Tool Host", async () => {
    let localSignal;
    const { broker, connector } = await createHarness({
      toolHost: {
        async invoke(_invocation, signal) {
          localSignal = signal;
          await new Promise((resolve) => signal.onCancel(resolve));
          signal.throwIfCancelled();
          return { ok: true, content: "unreachable" };
        }
      }
    });
    await connector.start();
    const cancellation = new CancellationController();
    const completion = broker.invoke(invocation(), cancellation.signal);
    const rejected = expect(completion).rejects.toThrow(
      "Tool invocation cancelled: user"
    );
    await waitFor(() => !!localSignal, "Local invocation did not start");

    cancellation.cancel("user");

    await rejected;
    await waitFor(
      () => localSignal.cancelled,
      "Cancellation did not reach the Device Connector"
    );
    expect(localSignal.reason).toBe("user");
  });

  it("rejects an invalid device credential before starting its poll loop", async () => {
    const { broker, connector } = await createHarness({
      connectorToken: "wrong-secret"
    });

    await expect(connector.start()).rejects.toThrow(
      "Invalid device node credential"
    );
    expect(broker.snapshot().nodes).toEqual([]);
  });

  it("does not execute an invocation whose lease already expired", async () => {
    const invoke = vi.fn();
    const connector = new DeviceConnector({
      runtimeUrl: "https://runtime.test",
      token: "device-secret",
      registration: registration(),
      toolHost: { invoke },
      fetchImpl: vi.fn(),
      now: () => 2_000
    });

    connector.acceptCommand({
      schemaVersion: 1,
      type: "tool.invoke",
      invocationId: "invocation:connector",
      resourceId: "workspace:connector",
      leaseExpiresAt: 1_999,
      invocation: invocation()
    });

    await waitFor(
      () => connector.snapshot().activeInvocations === 0,
      "Expired invocation did not settle"
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(connector.snapshot().receiptCount).toBe(1);
  });

  it("refuses to send Device credentials over remote plaintext HTTP", () => {
    expect(() => new DeviceConnector({
      runtimeUrl: "http://runtime.test",
      token: "device-secret",
      registration: registration(),
      toolHost: { invoke: vi.fn() }
    })).toThrow("must use HTTPS");
  });

  it("exchanges a one-time pairing code for a Device credential", async () => {
    const fetchImpl = vi.fn(async () => new globalThis.Response(JSON.stringify({
      paired: true,
      credential: "zion_v1.credential:test.secret",
      credentialId: "credential:test",
      expiresAt: 10_000,
      device: {
        deviceId: "node:connector",
        kind: "resource"
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    await expect(exchangeDevicePairing({
      runtimeUrl: "https://runtime.test",
      userCode: "ABCD-EFGH-JKLM",
      device: {
        deviceId: "node:connector",
        label: "Connector"
      },
      fetchImpl
    })).resolves.toMatchObject({
      credential: "zion_v1.credential:test.secret",
      device: { deviceId: "node:connector" }
    });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://runtime.test/v1/access/pair");
    expect(JSON.parse(options.body)).toMatchObject({
      userCode: "ABCD-EFGH-JKLM",
      device: { deviceId: "node:connector" }
    });
  });

  it("stops a stale Connector and cancels work after a replacement registers", async () => {
    let localSignal;
    const { broker, connector } = await createHarness({
      toolHost: {
        async invoke(_invocation, signal) {
          localSignal = signal;
          await new Promise((resolve) => signal.onCancel(resolve));
          signal.throwIfCancelled();
          return { ok: true, content: "unreachable" };
        }
      }
    });
    await connector.start();
    const completion = broker.invoke(
      invocation(),
      new CancellationController().signal
    );
    await waitFor(() => !!localSignal, "Local invocation did not start");

    broker.registerNode(registration("instance:replacement"));

    await waitFor(
      () => connector.snapshot().state === "stale",
      "Replaced Connector did not become stale"
    );
    expect(localSignal.cancelled).toBe(true);
    expect(localSignal.reason).toBe("connector-replaced");
    await expect(broker.nextCommand(
      "node:connector",
      "instance:replacement"
    )).resolves.toMatchObject({
      type: "tool.invoke",
      invocationId: "invocation:connector"
    });
    broker.completeInvocation(
      "node:connector",
      "instance:replacement",
      "invocation:connector",
      { ok: true, content: "replacement result" }
    );
    await expect(completion).resolves.toMatchObject({
      content: "replacement result"
    });
    expect(broker.snapshot().nodes[0]).toMatchObject({
      instanceId: "instance:replacement",
      status: "online"
    });
  });
});
