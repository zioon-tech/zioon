import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CancellationController } from "../../../packages/runtime/src/index";
import { NodeBroker } from "../src/node-broker.mjs";
import { createNodeHttpHandler } from "../src/node-http-handler.mjs";

const resources = [];

async function startGateway(token = "device-secret") {
  const broker = new NodeBroker();
  const handler = createNodeHttpHandler({
    broker,
    token,
    maxWaitMs: 50
  });
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
  const address = server.address();
  const resource = {
    broker,
    server,
    url: `http://127.0.0.1:${address.port}`
  };
  resources.push(resource);
  return resource;
}

function headers(token = "device-secret") {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  };
}

function registration() {
  return {
    protocolVersion: 1,
    nodeId: "node:test",
    instanceId: "instance:test",
    capabilities: [{
      name: "read",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }],
    resources: [{
      resourceId: "workspace:test",
      kind: "workspace",
      projectId: "project:test"
    }]
  };
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.broker.close();
    await new Promise((resolve) => resource.server.close(resolve));
  }
});

describe("Device node HTTP handler", () => {
  it("requires the configured bearer token", async () => {
    const gateway = await startGateway();

    const response = await fetch(
      `${gateway.url}/v1/device-nodes/register`,
      {
        method: "POST",
        headers: headers("wrong-token"),
        body: JSON.stringify(registration())
      }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid device node credential"
    });
    expect(gateway.broker.snapshot().nodes).toEqual([]);
  });

  it("delivers and completes an invocation through authenticated HTTP", async () => {
    const gateway = await startGateway();
    const registerResponse = await fetch(
      `${gateway.url}/v1/device-nodes/register`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(registration())
      }
    );
    expect(registerResponse.status).toBe(200);

    const completion = gateway.broker.invoke({
      invocationId: "invocation:test",
      runId: "run:test",
      attemptId: "attempt:test",
      projectId: "project:test",
      policy: {
        allowedTools: ["read"]
      },
      toolCall: {
        id: "call:test",
        name: "read",
        arguments: { path: "/project/README.md" }
      }
    }, new CancellationController().signal);

    const nextResponse = await fetch(
      `${gateway.url}/v1/device-nodes/node%3Atest/invocations/next`
      + "?instanceId=instance%3Atest&waitMs=20",
      {
        headers: headers()
      }
    );
    expect(nextResponse.status).toBe(200);
    const { command } = await nextResponse.json();
    expect(command).toMatchObject({
      type: "tool.invoke",
      invocationId: "invocation:test"
    });

    const resultResponse = await fetch(
      `${gateway.url}/v1/device-nodes/node%3Atest/invocations/`
      + "invocation%3Atest/result",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          instanceId: "instance:test",
          result: {
            ok: true,
            content: "from device"
          }
        })
      }
    );
    expect(resultResponse.status).toBe(200);
    await expect(resultResponse.json()).resolves.toMatchObject({
      accepted: true,
      duplicate: false
    });
    await expect(completion).resolves.toEqual({
      ok: true,
      content: "from device"
    });
  });

  it("exposes authenticated Node and project-binding status", async () => {
    const gateway = await startGateway();
    await fetch(`${gateway.url}/v1/device-nodes/register`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(registration())
    });

    const response = await fetch(`${gateway.url}/v1/device-nodes`, {
      headers: headers()
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      nodes: [{
        nodeId: "node:test",
        status: "online"
      }],
      projectBindings: [{
        projectId: "project:test",
        nodeId: "node:test",
        resourceId: "workspace:test"
      }],
      pendingInvocations: 0,
      receiptCount: 0
    });
  });

  it("returns no content when an authenticated poll has no work", async () => {
    const gateway = await startGateway();
    await fetch(`${gateway.url}/v1/device-nodes/register`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(registration())
    });

    const response = await fetch(
      `${gateway.url}/v1/device-nodes/node%3Atest/invocations/next`
      + "?instanceId=instance%3Atest&waitMs=5",
      {
        headers: headers()
      }
    );

    expect(response.status).toBe(204);
  });
});
