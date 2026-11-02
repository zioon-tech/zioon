import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PostgresAccountStore } from "../../runtime/src/accounts/postgres-account-store.mjs";
import { PlatformAdminService } from "../../runtime/src/platform-admin/service.mjs";
import { createPlatformAdminHandler } from "../../runtime/src/platform-admin/http-handler.mjs";

test("PostgreSQL platform authority is separate from Space ownership, uses CAS, safeguards and durable public audit", {
  skip: !process.env.ZION_TEST_POSTGRES_URL
}, async () => {
  const schema = "portals_test_" + randomBytes(8).toString("hex");
  const control = new pg.Pool({ connectionString: process.env.ZION_TEST_POSTGRES_URL, max: 1 });
  await control.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.ZION_TEST_POSTGRES_URL,
    options: `-c search_path=${schema}`, max: 4 });
  const accounts = await new PostgresAccountStore({ pool }).initialize();
  await pool.query(`CREATE TABLE runtime_runs(id TEXT,space_id TEXT,status TEXT,payload_json JSONB,updated_at BIGINT)`);
  const db = { pool, accounts, close: async () => {
    await pool.end(); await control.query(`DROP SCHEMA ${schema} CASCADE`); await control.end();
  } };
  const service = await new PlatformAdminService({ pool: db.pool, health: async () => ({ status: "ok" }) }).initialize();
  const user = await db.accounts.resolveIdentity({ issuer: "https://test.invalid", subject: "ordinary-owner", name: "Ordinary" });
  const owner = await db.accounts.resolveIdentity({ issuer: "https://test.invalid", subject: "platform-owner", name: "Platform" });
  const principal = id => ({ kind: "account", source: "cookie", user: { id } });
  const platform = principal(owner.id), ordinary = principal(user.id);
  const server = createServer(async (req, res) => {
    const handler = createPlatformAdminHandler({ service, access: { requireLogin: async request => {
      if (request.headers.origin !== "https://admin.test" && request.method !== "GET") {
        throw Object.assign(new Error(), { statusCode: 403, code: "invalid_origin" });
      }
      return request.headers.cookie === "owner" ? platform : request.headers.cookie === "ordinary" ? ordinary : null;
    } } });
    if (!await handler(req, res, new URL(req.url, "http://test"))) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (path, cookie = "owner", method = "GET", body) => fetch(base + path, {
    method, headers: { cookie, origin: "https://admin.test", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await db.pool.query(`INSERT INTO platform_admin_roles(user_id,role,revision,updated_at)
      VALUES($1,'owner',nextval('platform_admin_role_revision'),$2)`, [owner.id, Date.now()]);
    assert.equal((await api("/v1/platform-admin/overview", "none")).status, 401);
    assert.equal((await api("/v1/platform-admin/overview", "ordinary")).status, 403);
    assert.equal((await db.accounts.personalSpace(user.id)).createdBy, user.id);
    assert.equal((await api("/v1/platform-admin/overview")).status, 200);
    const revision = (await service.roles())[0].revision;
    await assert.rejects(service.changeRole(platform, owner.id, { role: null, revision }), { code: "last_platform_owner" });
    await service.changeRole(platform, user.id, { role: "viewer", revision: 0 });
    const viewerRevision = (await service.roles()).find(r => r.user_id === user.id).revision;
    await assert.rejects(service.changeRole(ordinary, owner.id, { role: "operator", revision }), { code: "platform_admin_required" });
    await assert.rejects(service.changeIncident(ordinary, null, { title: "test", message: "test", revision: 0, status: "investigating", impact: "minor", components: ["runtime"] }), { code: "platform_admin_required" });
    const race = await Promise.allSettled([
      service.changeRole(platform, user.id, { role: "operator", revision: viewerRevision }),
      service.changeRole(platform, user.id, { role: "owner", revision: viewerRevision })
    ]);
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(race.find(r => r.status === "rejected").reason.code, "revision_conflict");
    const role = (await service.roles()).find(r => r.user_id === user.id);
    await service.changeRole(platform, user.id, { role: null, revision: role.revision });
    await service.changeRole(platform, user.id, { role: "operator", revision: 0 });
    assert.ok((await service.roles()).find(r => r.user_id === user.id).revision > role.revision);
    await assert.rejects(service.changeRole(platform, user.id, { role: "owner", revision: role.revision }), { code: "revision_conflict" });
    const input = { title: "测试服务事件", message: "公开影响说明", revision: 0, status: "investigating", impact: "minor", components: ["runtime"] };
    const created = await service.changeIncident(ordinary, null, input);
    await service.changeIncident(ordinary, created.id, { ...input, status: "resolved", message: "已恢复", revision: created.revision });
    const publicResponse = await api("/v1/status/incidents", "none");
    assert.equal(publicResponse.status, 200);
    const publicData = await publicResponse.json();
    assert.equal(publicData.incidents[0].updates.length, 2);
    assert.equal(publicData.incidents[0].status, "resolved");
    assert.equal(JSON.stringify(publicData).includes(owner.id), false);
    const wrongOrigin = await fetch(base + "/v1/platform-admin/incidents", { method: "POST",
      headers: { cookie: "owner", origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify(input) });
    assert.equal(wrongOrigin.status, 403);
    const history = await service.history();
    assert.equal(history.length, 6);
    assert.equal(history.filter(row => row.action === "platform.incident_updated").length, 2);
    assert.equal((await service.runs()).length, 0);
    assert.equal((await service.accounts()).length > 1, true);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await db.close();
  }
});
