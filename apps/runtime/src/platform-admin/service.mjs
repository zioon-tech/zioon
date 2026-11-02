import { randomUUID } from "node:crypto";
import { accountError } from "../accounts/account-policy.mjs";

export const COMPONENTS = ["auth", "runtime", "workbench", "mobile", "marketplace", "adc", "memory"];
const ROLES = ["owner", "operator", "viewer"];
const text = (value, max) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b-\x1f]/.test(value)) {
    throw accountError(400, "invalid_input");
  }
  return value.trim();
};
const incident = row => ({ id: row.id, title: row.title, message: row.message,
  status: row.status, impact: row.impact, components: row.components,
  revision: row.revision, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });

export class PlatformAdminService {
  constructor({ pool, health, now = Date.now }) { Object.assign(this, { pool, health, now }); }
  async initialize() {
    await this.pool.query(`CREATE SEQUENCE IF NOT EXISTS platform_admin_role_revision;
    CREATE TABLE IF NOT EXISTS platform_admin_roles (
      user_id TEXT PRIMARY KEY REFERENCES account_users(id), role TEXT NOT NULL
        CHECK(role IN ('owner','operator','viewer')),
      revision INTEGER NOT NULL DEFAULT 1, updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_admin_audit (
      sequence BIGSERIAL PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
      target_id TEXT NOT NULL, details JSONB NOT NULL, created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_status_incidents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('investigating','identified','monitoring','resolved','maintenance')),
      impact TEXT NOT NULL CHECK(impact IN ('minor','major','maintenance')),
      components JSONB NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS platform_status_incidents_updated ON platform_status_incidents(updated_at DESC);`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS platform_status_updates (
      sequence BIGSERIAL PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES platform_status_incidents(id),
      snapshot JSONB NOT NULL, created_at BIGINT NOT NULL
    )`);
    return this;
  }
  async requireRole(principal, permitted = ROLES, client = this.pool) {
    if (principal?.kind !== "account") throw accountError(401, "authentication_required");
    const row = (await client.query(`SELECT r.role,r.revision FROM platform_admin_roles r
      JOIN account_users u ON u.id=r.user_id WHERE r.user_id=$1 AND u.status='active'`,
    [principal.user.id])).rows[0];
    if (!row || !permitted.includes(row.role)) throw accountError(403, "platform_admin_required");
    return row;
  }
  async write(principal, roles, action) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '10s'");
      // Serialize authority changes and recheck after obtaining the lock.
      await client.query("SELECT pg_advisory_xact_lock(983724619)");
      await this.requireRole(principal, roles, client);
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async audit(client, principal, action, target, details) {
    await client.query(`INSERT INTO platform_admin_audit(actor_id,action,target_id,details,created_at)
      VALUES($1,$2,$3,$4,$5)`, [principal.user.id, action, target, details, this.now()]);
  }
  async overview() {
    const result = await this.pool.query(`SELECT
      (SELECT COUNT(*)::int FROM account_users WHERE status='active') AS accounts,
      (SELECT COUNT(*)::int FROM account_spaces) AS workspaces,
      (SELECT COUNT(*)::int FROM runtime_runs WHERE status='running') AS running,
      (SELECT COUNT(*)::int FROM runtime_runs WHERE status='failed' AND updated_at>$1) AS failed_24h,
      (SELECT COUNT(*)::int FROM account_sessions WHERE revoked_at IS NULL AND expires_at>$2) AS sessions`,
    [this.now() - 86400000, this.now()]);
    return { generatedAt: this.now(), totals: result.rows[0], health: await this.health() };
  }
  async accounts() {
    return (await this.pool.query(`SELECT u.id,u.name,u.email,u.status,u.created_at,
      COUNT(m.space_id)::int AS workspace_count FROM account_users u LEFT JOIN account_memberships m
      ON m.user_id=u.id AND m.status='active' GROUP BY u.id ORDER BY u.created_at DESC LIMIT 200`)).rows;
  }
  async runs() {
    return (await this.pool.query(`SELECT id AS run_id,space_id,status,
      payload_json->>'createdAt' AS created_at,updated_at
      FROM runtime_runs ORDER BY updated_at DESC LIMIT 100`)).rows;
  }
  async workspaces() {
    const exists = (await this.pool.query("SELECT to_regclass('runtime_account_workspaces') AS name")).rows[0].name;
    if (!exists) return [];
    return (await this.pool.query(`SELECT account_id,workspace_id,status,error_code,attempts,updated_at
      FROM runtime_account_workspaces ORDER BY updated_at DESC LIMIT 200`)).rows;
  }
  async roles() {
    return (await this.pool.query(`SELECT r.*,u.name,u.email FROM platform_admin_roles r
      JOIN account_users u ON u.id=r.user_id ORDER BY r.role,u.name`)).rows;
  }
  async changeRole(principal, userId, input) {
    text(userId, 128);
    if (!Number.isSafeInteger(input.revision) || input.revision < 0
      || input.role !== null && !ROLES.includes(input.role)) throw accountError(400, "invalid_input");
    return this.write(principal, ["owner"], async client => {
      const user = (await client.query("SELECT status FROM account_users WHERE id=$1", [userId])).rows[0];
      if (!user || user.status !== "active") throw accountError(400, "active_account_required");
      const before = (await client.query("SELECT * FROM platform_admin_roles WHERE user_id=$1 FOR UPDATE", [userId])).rows[0];
      if ((before?.revision || 0) !== input.revision) throw accountError(409, "revision_conflict");
      if (before?.role === "owner" && input.role !== "owner") {
        const owners = (await client.query(`SELECT COUNT(*)::int AS count FROM platform_admin_roles r
          JOIN account_users u ON u.id=r.user_id WHERE r.role='owner' AND u.status='active'`)).rows[0].count;
        if (owners <= 1) throw accountError(409, "last_platform_owner");
      }
      if (input.role === null) await client.query("DELETE FROM platform_admin_roles WHERE user_id=$1", [userId]);
      else await client.query(`INSERT INTO platform_admin_roles(user_id,role,revision,updated_at)
        VALUES($1,$2,nextval('platform_admin_role_revision'),$3) ON CONFLICT(user_id) DO UPDATE SET role=$2,
        revision=nextval('platform_admin_role_revision'),updated_at=$3`, [userId, input.role, this.now()]);
      await this.audit(client, principal, "platform.role_changed", userId,
        { before: before?.role || null, after: input.role });
      return { changed: true };
    });
  }
  async incidents() {
    return (await this.pool.query(`SELECT i.*,COALESCE(updates.items,'[]'::jsonb) AS updates
      FROM platform_status_incidents i LEFT JOIN LATERAL (
        SELECT jsonb_agg(snapshot ORDER BY sequence DESC) AS items FROM (
          SELECT snapshot,sequence FROM platform_status_updates WHERE incident_id=i.id
          ORDER BY sequence DESC LIMIT 30
        ) recent
      ) updates ON true ORDER BY i.updated_at DESC LIMIT 100`)).rows
      .map(row => ({ ...incident(row), updates: row.updates }));
  }
  async changeIncident(principal, id, input) {
    const title = text(input.title, 160), message = text(input.message, 3000);
    if (!["investigating", "identified", "monitoring", "resolved", "maintenance"].includes(input.status)
      || !["minor", "major", "maintenance"].includes(input.impact)
      || !Array.isArray(input.components) || !input.components.length
      || input.components.some(c => !COMPONENTS.includes(c))
      || !Number.isSafeInteger(input.revision) || input.revision < 0) throw accountError(400, "invalid_input");
    if (id) text(id, 128);
    return this.write(principal, ["owner", "operator"], async client => {
      const before = id && (await client.query("SELECT * FROM platform_status_incidents WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if ((before?.revision || 0) !== input.revision || id && !before) throw accountError(409, "revision_conflict");
      const target = id || `incident:${randomUUID()}`;
      const result = await client.query(`INSERT INTO platform_status_incidents
        (id,title,message,status,impact,components,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)
        ON CONFLICT(id) DO UPDATE SET title=$2,message=$3,status=$4,impact=$5,components=$6,
        revision=platform_status_incidents.revision+1,updated_at=$7 RETURNING *`,
      [target, title, message, input.status, input.impact, JSON.stringify([...new Set(input.components)]), this.now()]);
      await this.audit(client, principal, "platform.incident_updated", target,
        { status: input.status, revision: result.rows[0].revision });
      await client.query(`INSERT INTO platform_status_updates(incident_id,snapshot,created_at) VALUES($1,$2,$3)`,
        [target, incident(result.rows[0]), this.now()]);
      return incident(result.rows[0]);
    });
  }
  async history() {
    return (await this.pool.query(`SELECT sequence,actor_id,action,target_id,details,created_at
      FROM platform_admin_audit ORDER BY sequence DESC LIMIT 100`)).rows;
  }
}
