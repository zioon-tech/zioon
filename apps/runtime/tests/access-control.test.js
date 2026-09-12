import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeAccessControl } from "../src/access-control.mjs";
import { SqliteAccessStore } from "../src/sqlite-access-store.mjs";

const resources = [];

async function createHarness() {
  const store = new SqliteAccessStore(":memory:");
  const access = new RuntimeAccessControl({
    store,
    allowedOrigins: ["https://workbench.test"],
    publicBaseUrl: "https://workbench.test"
  });
  const server = createServer(async (request, response) => {
    const url = new URL(
      request.url || "/",
      `http://${request.headers.host || "127.0.0.1"}`
    );
    if (!access.applyCors(request, response)) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (!await access.handleHttp(request, response, url)) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const harness = {
    store,
    access,
    server,
    url: `http://127.0.0.1:${address.port}`
  };
  resources.push(harness);
  return harness;
}

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await new Promise((resolve) => resource.server.close(resolve));
    resource.store.close();
  }
});

describe("RuntimeAccessControl", () => {
  it("requires HTTPS for every non-loopback Browser Origin", () => {
    const store = new SqliteAccessStore(":memory:");
    try {
      expect(() => new RuntimeAccessControl({
        store,
        allowedOrigins: ["http://workbench.test"]
      })).toThrow("must use HTTPS");
    } finally {
      store.close();
    }
  });

  it("pairs an Owner browser without exposing its credential to JavaScript", async () => {
    const harness = await createHarness();
    const pairing = harness.store.createPairing({
      kind: "owner",
      delivery: "cookie"
    });

    const response = await fetch(`${harness.url}/v1/access/pair`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://workbench.test"
      },
      body: JSON.stringify({
        userCode: pairing.userCode,
        device: {
          deviceId: "client:owner",
          label: "Owner browser"
        }
      })
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      paired: true,
      device: {
        deviceId: "client:owner",
        kind: "owner"
      }
    });
    expect(body).not.toHaveProperty("credential");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");

    const session = await fetch(`${harness.url}/v1/access/session`, {
      headers: { cookie: cookieFrom(response) }
    });
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      authenticated: true,
      device: { deviceId: "client:owner" }
    });
  });

  it("lets an Owner create a scoped Resource invitation", async () => {
    const harness = await createHarness();
    const ownerPairing = harness.store.createPairing({
      kind: "owner",
      delivery: "cookie"
    });
    const owner = harness.store.exchangePairing({
      userCode: ownerPairing.userCode,
      deviceId: "client:owner"
    });
    const cookie = `__Host-zion_session=${encodeURIComponent(owner.credential)}`;

    const response = await fetch(`${harness.url}/v1/access/pairings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "https://workbench.test"
      },
      body: JSON.stringify({
        kind: "resource",
        delivery: "bearer",
        label: "Office Mac"
      })
    });

    expect(response.status).toBe(201);
    const invitation = await response.json();
    expect(invitation).toMatchObject({
      kind: "resource",
      delivery: "bearer",
      scopes: ["node.connect"],
      pairingUrl: expect.stringContaining("#pairing_id=")
    });

    const exchange = await fetch(`${harness.url}/v1/access/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingId: invitation.pairingId,
        secret: invitation.secret,
        device: {
          deviceId: "node:office-mac",
          platform: "darwin"
        }
      })
    });
    expect(exchange.status).toBe(200);
    await expect(exchange.json()).resolves.toMatchObject({
      paired: true,
      credential: expect.stringMatching(/^zion_v1\./),
      credentialId: expect.stringMatching(/^credential:/),
      device: {
        deviceId: "node:office-mac",
        kind: "resource"
      }
    });
  });

  it("rejects cross-origin Owner mutations", async () => {
    const harness = await createHarness();
    const ownerPairing = harness.store.createPairing({
      kind: "owner",
      delivery: "cookie"
    });
    const owner = harness.store.exchangePairing({
      userCode: ownerPairing.userCode,
      deviceId: "client:owner"
    });

    const response = await fetch(`${harness.url}/v1/access/pairings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `__Host-zion_session=${encodeURIComponent(owner.credential)}`,
        origin: "https://attacker.test"
      },
      body: JSON.stringify({ kind: "client" })
    });

    expect(response.status).toBe(403);
  });

  it("allows only Client credentials into collaboration rooms", async () => {
    const harness = await createHarness();
    const clientPairing = harness.store.createPairing({
      kind: "client",
      delivery: "bearer"
    });
    const client = harness.store.exchangePairing({
      userCode: clientPairing.userCode,
      deviceId: "client:collaboration"
    });
    const context = harness.access.authenticateCollaboration({
      headers: {},
      token: client.credential
    });
    expect(context).toMatchObject({
      principal: {
        device: { deviceId: "client:collaboration" }
      }
    });
    expect(() => harness.access.reauthorize(
      context.principal,
      "collaboration.write"
    )).not.toThrow();
    harness.store.revokeDevice("client:collaboration");
    expect(() => harness.access.reauthorize(
      context.principal,
      "collaboration.write"
    )).toThrow("no longer active");

    const resourcePairing = harness.store.createPairing({
      kind: "resource",
      delivery: "bearer"
    });
    const resource = harness.store.exchangePairing({
      userCode: resourcePairing.userCode,
      deviceId: "node:collaboration"
    });
    expect(() => harness.access.authenticateCollaboration({
      headers: {},
      token: resource.credential
    })).toThrow("collaboration.write");
  });

  it("lets paired Browser Clients use Device Services without management access", async () => {
    const harness = await createHarness();
    const pairing = harness.store.createPairing({
      kind: "client",
      delivery: "bearer"
    });
    const client = harness.store.exchangePairing({
      userCode: pairing.userCode,
      deviceId: "client:browser"
    });
    const principal = harness.access.authenticateHeaders(
      { authorization: `Bearer ${client.credential}` }
    );

    expect(() => harness.access.authorizeDeviceService({
      method: "GET",
      zionPrincipal: principal
    })).not.toThrow();
    expect(() => harness.access.authorizeDeviceService({
      method: "POST",
      zionPrincipal: principal
    })).not.toThrow();
    expect(() => harness.access.authorizeDeviceService({
      method: "GET",
      zionPrincipal: principal
    }, {
      service: "device-access"
    })).toThrow("device.manage");
    expect(() => harness.access.requireScope(
      principal,
      "device.manage"
    )).toThrow("device.manage");

    const ownerPairing = harness.store.createPairing({
      kind: "owner",
      delivery: "bearer"
    });
    const owner = harness.store.exchangePairing({
      userCode: ownerPairing.userCode,
      deviceId: "client:owner-access"
    });
    const ownerPrincipal = harness.access.authenticateHeaders(
      { authorization: `Bearer ${owner.credential}` }
    );
    expect(() => harness.access.authorizeDeviceService({
      method: "PATCH",
      zionPrincipal: ownerPrincipal
    }, {
      service: "device-access"
    })).not.toThrow();

    harness.store.revokeDevice("client:browser");
    expect(() => harness.access.authorizeDeviceService({
      method: "GET",
      zionPrincipal: principal
    })).toThrow("no longer active");
  });
});
