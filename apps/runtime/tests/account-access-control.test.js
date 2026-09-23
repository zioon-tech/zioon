import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AccountAccessControl, accountRequestScope } from "../src/accounts/account-access-control.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import {
  createPostgresTestDatabase,
  provisionTestTeam
} from "./helpers/postgres-test-database.mjs";

const cleanup = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function harness() {
  const database = await createPostgresTestDatabase("account_access");
  cleanup.push(() => database.close());
  const { accounts } = database;
  const devices = new PostgresAccessStore(database.pool, { spaceId: "space:one" });
  const owner = await provisionTestTeam(database, {
    spaceId: "space:one",
    issuer: "https://id.test"
  });
  const outsider = await accounts.resolveIdentity({
    issuer: "https://id.test",
    subject: "outsider"
  });
  const member = await accounts.resolveIdentity({
    issuer: "https://id.test",
    subject: "member"
  });
  await accounts.acceptInvitation(
    member.id,
    (await accounts.invite(owner.id, {}, "space:one")).token
  );
  const tokens = Object.fromEntries(await Promise.all(
    [owner, member, outsider].map(async (user) => [
      user.id,
      (await accounts.createSession(user.id, {
        activeSpaceId: user.id === outsider.id ? "" : "space:one"
      })).token
    ])
  ));
  const access = new AccountAccessControl({
    accounts, store: devices, publicBaseUrl: "https://workbench.test",
    oidc: { secureCookies: true }, servedSpaceId: "space:one"
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "https://workbench.test");
    if (await access.handleHttp(request, response, url)) return;
    try {
      const principal = await access.authorizeRuntimeRequest(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ userId: principal.user.id }));
    } catch (error) {
      response.writeHead(error.statusCode || 500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = (user, cookie = false) => cookie
    ? { cookie: `__Host-zion_account=${tokens[user.id]}`, origin: "https://workbench.test" }
    : { authorization: `Bearer ${tokens[user.id]}` };
  const call = (path, user, method = "GET", body, extra = {}) => fetch(url + path, {
    method, headers: { ...headers(user), "content-type": "application/json", ...extra },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { accounts, devices, access, owner, member, outsider, tokens, headers, call, url };
}

describe("AccountAccessControl", () => {
  it("uses explicit write routes and limits control-plane and relay access", () => {
    expect(accountRequestScope("POST", "/v1/runs")).toBe("run.execute");
    expect(accountRequestScope("POST", "/v1/sessions/s/messages")).toBe("run.execute");
    expect(accountRequestScope("POST", "/v1/assets")).toBe("runtime.write");
    expect(accountRequestScope("PATCH", "/v1/sessions/s")).toBe("runtime.write");
    expect(accountRequestScope("POST", "/v1/unknown-future-endpoint")).toBe("runtime.manage");
    expect(accountRequestScope("GET", "/v1/workbench-state/kv/runtime.secret")).toBe("runtime.manage");
    expect(accountRequestScope("GET", "/v1/device-services/local-tools/files")).toBe("runtime.manage");
  });

  it("canonicalizes loopback account login before setting a host-only cookie", async () => {
    const h = await harness();
    h.access.publicBaseUrl = "http://127.0.0.1:18866";
    h.access.oidc.secureCookies = false;
    const response = await fetch(`${h.url}/v1/account/login?returnTo=/account`, {
      redirect: "manual"
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location"))
      .toBe("http://127.0.0.1:18866/v1/account/login?returnTo=/account");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("denies legacy owner and client credentials while retaining bound resource connections", async () => {
    const h = await harness();
    for (const kind of ["owner", "client"]) {
      const invite = await h.devices.createPairing({ kind, delivery: "bearer" });
      const legacy = await h.devices.exchangePairing({ userCode: invite.userCode });
      expect(await h.access.authenticateHeaders({
        authorization: `Bearer ${legacy.credential}`
      })).toBeNull();
      const another = await h.devices.createPairing({ kind, delivery: "bearer" });
      const response = await fetch(h.url + "/v1/access/pair", {
        method: "POST", body: JSON.stringify({ userCode: another.userCode })
      });
      expect(response.status).toBe(403);
    }
    const inviteResponse = await h.call("/v1/access/pairings", h.owner, "POST", { kind: "resource" });
    expect(inviteResponse.status).toBe(201);
    const invite = await inviteResponse.json();
    const response = await fetch(h.url + "/v1/access/pair", {
      method: "POST", body: JSON.stringify({ userCode: invite.userCode, device: { deviceId: "node:one" } })
    });
    expect(response.status).toBe(200);
    const resource = await response.json();
    const request = { headers: { authorization: `Bearer ${resource.credential}` } };
    expect((await h.access.authorizeNode({ request, nodeId: "node:one" })).device.kind)
      .toBe("resource");
    await expect(h.access.authorizeNode({ request, nodeId: "node:two" })).rejects.toThrow("not bound");
    expect(await h.access.hasScope(
      await h.access.authenticateRequest(request),
      "runtime.read"
    )).toBe(false);
  });

  it("allows an outsider to see their identity and accept one invitation only", async () => {
    const h = await harness();
    expect((await h.call("/v1/account/me", h.outsider)).status).toBe(200);
    for (const path of ["/v1/sessions", "/v1/workbench-state/kv/key", "/v1/runs/guessed/events", "/v1/models"]) {
      expect([403, 409]).toContain((await h.call(path, h.outsider)).status);
    }
    const invite = await (await h.call("/v1/account/invitations", h.owner, "POST", { role: "viewer" })).json();
    expect((await h.call("/v1/account/invitations/accept", h.outsider, "POST", { token: invite.token })).status).toBe(200);
    expect((await h.call(
      "/v1/account/spaces/select",
      h.outsider,
      "POST",
      { spaceId: "space:one" }
    )).status).toBe(200);
    expect((await h.call("/v1/sessions", h.outsider)).status).toBe(200);
    expect((await h.call("/v1/runs", h.outsider, "POST", {})).status).toBe(403);
    expect((await h.call("/v1/account/invitations/accept", h.member, "POST", { token: invite.token })).status).toBe(403);
  });

  it("blocks privilege escalation through HTTP services and browser CSRF", async () => {
    const h = await harness();
    for (const [method, path] of [
      ["PUT", "/v1/interaction-profiles/default"], ["PUT", "/v1/model-profiles/default"],
      ["POST", "/v1/skills/sync"], ["POST", "/v1/model-gateway/proxy"],
      ["GET", "/v1/device-services/plugin-service/secret"], ["GET", "/v1/account/members"]
    ]) expect((await h.call(path, h.member, method)).status).toBe(403);
    const response = await fetch(h.url + "/v1/account/logout", {
      method: "POST", headers: { ...h.headers(h.owner, true), origin: "http://localhost:4000" }
    });
    expect(response.status).toBe(403);
    expect(await h.accounts.authenticate(h.tokens[h.owner.id])).not.toBeNull();
  });

  it("revokes only the current session and immediately rejects stale principals", async () => {
    const h = await harness();
    const principal = await h.access.authenticateHeaders(h.headers(h.member));
    const otherSession = await h.accounts.createSession(h.member.id, {
      activeSpaceId: "space:one"
    });
    expect((await h.call("/v1/access/logout", h.member, "POST")).status).toBe(200);
    await expect(h.access.reauthorize(principal, "runtime.read"))
      .rejects.toThrow("runtime.read");
    expect((await h.accounts.authenticate(otherSession.token)).user.id).toBe(h.member.id);
    expect((await h.call("/v1/sessions", h.member)).status).toBe(401);
  });

  it("sets viewer collaboration to read-only and rechecks membership removal", async () => {
    const h = await harness();
    await h.accounts.setMember(
      h.owner.id,
      h.member.id,
      { role: "viewer" },
      "space:one"
    );
    const authorization = await h.access.authenticateCollaboration({ headers: h.headers(h.member) });
    expect(authorization.readOnly).toBe(true);
    await h.accounts.setMember(
      h.owner.id,
      h.member.id,
      { role: "viewer", status: "removed" },
      "space:one"
    );
    await expect(h.access.reauthorize(authorization.principal, "runtime.read"))
      .rejects.toThrow("runtime.read");
  });

  it("overwrites model-supplied execution principals and bounds the task grant", async () => {
    const h = await harness();
    const principal = await h.access.authenticateHeaders(h.headers(h.member));
    const ceiling = { preset: "trusted-automation", allowedTools: ["read", "Bash"], maxToolCalls: 10 };
    const request = await h.access.authorizeRunRequest(principal, {
      principal: { userId: h.owner.id, spaceId: "space:two", grantId: "forged" },
      policy: { ...ceiling, allowedTools: ["read", "modelsManage"], maxToolCalls: 100 }
    }, ceiling);
    expect(request.principal).toMatchObject({ userId: h.member.id, spaceId: "space:one" });
    expect(request.policy).toMatchObject({ allowedTools: ["read"], maxToolCalls: 10 });
    await expect(h.access.authorizeRunRequest(
      principal,
      { spaceId: "space:two" },
      ceiling
    )).rejects.toThrow("space_mismatch");
    expect((await h.accounts.validateGrant(request.principal)).policy.allowedTools)
      .toEqual(["read"]);
  });

  it("never routes an authenticated Session into another Runtime Space", async () => {
    const h = await harness();
    const principal = await h.access.authenticateHeaders(h.headers(h.member));
    const otherSpace = { ...principal, space: { id: "space:other", name: "Other" } };
    expect(await h.access.hasScope(otherSpace, "runtime.read")).toBe(false);
    await expect(h.access.reauthorize(otherSpace, "runtime.read"))
      .rejects.toThrow("Select the Space served by this Runtime");
  });
});
