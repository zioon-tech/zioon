import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import {
  accountError, accountRole, intersectAccountPolicy, requireAccountScope, roleScopes
} from "./account-policy.mjs";

const { Pool } = pg;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const migration001 = join(moduleDirectory, "postgres/migrations/001_account_control_plane.sql");
const migration002 = join(moduleDirectory, "postgres/migrations/002_space_scoped_audit.sql");
const DAY = 86_400_000;
const MAX_TASK_GRANT_TTL_MS = 10 * 365 * DAY;
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const id = (kind) => `${kind}:${randomUUID()}`;
const secret = () => randomBytes(32).toString("base64url");
const integer = (value) => Number(value);

function text(value, label, max = 256) {
  if (typeof value !== "string" || !value.length || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw accountError(400, "invalid_identity", `${label} is invalid`);
  }
  return value;
}

function userFromRow(row) {
  return row && {
    id: row.id,
    name: row.name,
    email: row.email,
    status: row.status,
    createdAt: integer(row.created_at)
  };
}

function spaceFromRow(row) {
  return row && {
    id: row.id,
    name: row.name,
    kind: row.kind,
    createdBy: row.created_by,
    createdAt: integer(row.created_at)
  };
}

function membershipFromRow(row) {
  return row && {
    userId: row.user_id,
    spaceId: row.space_id,
    role: row.role,
    status: row.status,
    revision: integer(row.revision)
  };
}

function jsonObject(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    return {};
  }
}

function jsonArray(value) {
  const parsed = jsonObject(value);
  return Array.isArray(parsed) ? parsed : [];
}

export class PostgresAccountStore {
  backend = "postgres";

  constructor({
    connectionString,
    pool = null,
    maxConnections = 10,
    idleTimeoutMs = 30_000,
    connectionTimeoutMs = 10_000,
    ssl = undefined,
    now = () => Date.now()
  } = {}) {
    if (!pool && !String(connectionString || "").trim()) {
      throw new Error("PostgreSQL Account Store requires a connection string");
    }
    this.pool = pool || new Pool({
      connectionString,
      max: maxConnections,
      idleTimeoutMillis: idleTimeoutMs,
      connectionTimeoutMillis: connectionTimeoutMs,
      ...(ssl === undefined ? {} : { ssl }),
      application_name: "zion-runtime-accounts"
    });
    this.ownsPool = !pool;
    this.now = now;
  }

  async initialize() {
    const [sql001, sql002] = await Promise.all([
      readFile(migration001, "utf8"),
      readFile(migration002, "utf8")
    ]);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(983724610)");
      await client.query(sql001);
      await client.query(
        `INSERT INTO account_schema_migrations (version, applied_at)
         VALUES (1, $1) ON CONFLICT (version) DO NOTHING`,
        [this.now()]
      );
      const applied002 = await client.query(
        "SELECT 1 FROM account_schema_migrations WHERE version = 2"
      );
      if (!applied002.rowCount) {
        await client.query(sql002);
        await client.query(
          `INSERT INTO account_schema_migrations (version, applied_at)
           VALUES (2, $1)`,
          [this.now()]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this;
  }

  async transaction(action) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async audit(actorId, action, targetId, details = {}, { spaceId, client = this.pool } = {}) {
    const detailsJson = JSON.stringify(details && typeof details === "object" ? details : {});
    if (Buffer.byteLength(detailsJson, "utf8") > 16 * 1024) {
      throw accountError(400, "invalid_audit_details", "Audit details exceed the storage limit");
    }
    text(spaceId, "Space ID", 128);
    await client.query(
      `INSERT INTO account_audit
       (space_id, actor_id, action, target_id, created_at, details_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [spaceId, actorId, action, targetId, this.now(), detailsJson]
    );
  }

  async findIdentity(issuer, subject, client = this.pool) {
    const result = await client.query(
      `SELECT u.* FROM account_users u
       JOIN account_identities i ON u.id = i.user_id
       WHERE i.issuer = $1 AND i.subject = $2`,
      [issuer, subject]
    );
    return userFromRow(result.rows[0]);
  }

  async identityForUser(userId, issuer) {
    const result = await this.pool.query(
      "SELECT issuer, subject FROM account_identities WHERE user_id=$1 AND issuer=$2",
      [userId, issuer]
    );
    return result.rows[0] || null;
  }

  async linkIdentity(userId, spaceId, { issuer, subject }) {
    text(issuer, "Issuer", 2048);
    text(subject, "Subject");
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["account-link", userId, issuer])]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([issuer, subject])]);
      const existing = await this.findIdentity(issuer, subject, client);
      if (existing && existing.id !== userId) throw accountError(409, "identity_already_linked");
      const current = await client.query("SELECT subject FROM account_identities WHERE user_id=$1 AND issuer=$2", [userId, issuer]);
      if (current.rows.some((row) => row.subject !== subject)) throw accountError(409, "account_already_linked");
      if (existing) return { linked: true, changed: false };
      await client.query("INSERT INTO account_identities (issuer,subject,user_id) VALUES ($1,$2,$3)", [issuer, subject, userId]);
      await this.audit(userId, "account.identity_linked", userId, { issuer, subject }, { spaceId, client });
      return { linked: true, changed: true };
    });
  }

  async personalSpace(userId, client = this.pool) {
    const result = await client.query(
      `SELECT s.* FROM account_spaces s
       JOIN account_memberships m ON m.space_id = s.id
       WHERE s.kind = 'personal' AND s.created_by = $1
         AND m.user_id = $1 AND m.status = 'active'
       LIMIT 1`,
      [userId]
    );
    return spaceFromRow(result.rows[0]);
  }

  async ensurePersonalSpace(user, client) {
    const existing = await this.personalSpace(user.id, client);
    if (existing) return existing;
    const spaceId = id("space");
    const createdAt = this.now();
    const name = user.name && user.name !== "Zion 用户"
      ? `${String(user.name).slice(0, 120)} 的 Zion`
      : "我的 Zion";
    await client.query(
      `INSERT INTO account_spaces (id, name, kind, created_by, created_at)
       VALUES ($1, $2, 'personal', $3, $4)
       ON CONFLICT DO NOTHING`,
      [spaceId, name, user.id, createdAt]
    );
    const space = spaceFromRow((await client.query(
      `SELECT * FROM account_spaces
       WHERE kind = 'personal' AND created_by = $1`,
      [user.id]
    )).rows[0]);
    await client.query(
      `INSERT INTO account_memberships
       (space_id, user_id, role, status, revision, created_at, updated_at)
       VALUES ($1, $2, 'owner', 'active', 1, $3, $3)
       ON CONFLICT (space_id, user_id) DO UPDATE SET
         role = 'owner', status = 'active',
         revision = account_memberships.revision + 1, updated_at = EXCLUDED.updated_at`,
      [space.id, user.id, createdAt]
    );
    await this.audit(user.id, "space.personal_created", space.id, {}, {
      spaceId: space.id,
      client
    });
    return space;
  }

  async resolveIdentity({ issuer, subject, name = "", email = "", emailVerified = false }) {
    text(issuer, "Issuer", 2048);
    text(subject, "Subject");
    return this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [JSON.stringify([issuer, subject])]
      );
      let user = await this.findIdentity(issuer, subject, client);
      if (user) {
        if (user.status !== "active") throw accountError(403, "account_disabled");
        if (name || (email && emailVerified === true)) {
          const result = await client.query(
            `UPDATE account_users SET name = $1, email = $2 WHERE id = $3 RETURNING *`,
            [
              name ? String(name).slice(0, 160) : user.name,
              email && emailVerified === true ? String(email).slice(0, 254) : user.email,
              user.id
            ]
          );
          user = userFromRow(result.rows[0]);
        }
        await this.ensurePersonalSpace(user, client);
        return user;
      }
      const userId = id("user");
      const result = await client.query(
        `INSERT INTO account_users (id, name, email, created_at)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [
          userId,
          String(name || "Zion 用户").slice(0, 160),
          emailVerified === true ? String(email).slice(0, 254) : "",
          this.now()
        ]
      );
      user = userFromRow(result.rows[0]);
      await client.query(
        "INSERT INTO account_identities (issuer, subject, user_id) VALUES ($1, $2, $3)",
        [issuer, subject, user.id]
      );
      const space = await this.ensurePersonalSpace(user, client);
      await this.audit(user.id, "account.created", user.id, {}, {
        spaceId: space.id,
        client
      });
      return user;
    });
  }

  async getUser(userId, client = this.pool) {
    const result = await client.query("SELECT * FROM account_users WHERE id = $1", [userId]);
    return userFromRow(result.rows[0]);
  }

  async space(spaceId, client = this.pool) {
    const result = await client.query("SELECT * FROM account_spaces WHERE id = $1", [spaceId]);
    return spaceFromRow(result.rows[0]);
  }

  async membership(userId, spaceId, client = this.pool) {
    const result = await client.query(
      `SELECT m.* FROM account_memberships m
       JOIN account_users u ON u.id = m.user_id
       WHERE m.space_id = $1 AND m.user_id = $2 AND u.status = 'active'`,
      [spaceId, userId]
    );
    return membershipFromRow(result.rows[0]);
  }

  async require(userId, scope, spaceId, client = this.pool) {
    return requireAccountScope(await this.membership(userId, spaceId, client), scope);
  }

  async listSpaces(userId) {
    const result = await this.pool.query(
      `SELECT s.*, m.role, m.status, m.revision
       FROM account_memberships m
       JOIN account_spaces s ON s.id = m.space_id
       JOIN account_users u ON u.id = m.user_id
       WHERE m.user_id = $1 AND m.status = 'active' AND u.status = 'active'
       ORDER BY (s.kind = 'personal') DESC, s.created_at, s.id`,
      [userId]
    );
    return result.rows.map((row) => ({
      ...spaceFromRow(row),
      membership: membershipFromRow(row)
    }));
  }

  async createTeamSpace(userId, { name }) {
    const spaceName = text(String(name || "").trim(), "Space name", 160);
    return this.transaction(async (client) => {
      const user = await this.getUser(userId, client);
      if (!user || user.status !== "active") throw accountError(401, "authentication_required");
      const spaceId = id("space");
      const createdAt = this.now();
      const result = await client.query(
        `INSERT INTO account_spaces (id, name, kind, created_by, created_at)
         VALUES ($1, $2, 'team', $3, $4) RETURNING *`,
        [spaceId, spaceName, userId, createdAt]
      );
      await client.query(
        `INSERT INTO account_memberships
         (space_id, user_id, role, status, revision, created_at, updated_at)
         VALUES ($1, $2, 'owner', 'active', 1, $3, $3)`,
        [spaceId, userId, createdAt]
      );
      await this.audit(userId, "space.team_created", spaceId, {}, { spaceId, client });
      return {
        ...spaceFromRow(result.rows[0]),
        membership: await this.membership(userId, spaceId, client)
      };
    });
  }

  async createSession(userId, { ttlMs = 7 * DAY, activeSpaceId = "" } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * DAY) {
      throw accountError(400, "invalid_session_lifetime");
    }
    return this.transaction(async (client) => {
      const user = await this.getUser(userId, client);
      if (!user || user.status !== "active") throw accountError(403, "account_disabled");
      const personal = await this.ensurePersonalSpace(user, client);
      const spaceId = activeSpaceId || personal.id;
      await this.require(userId, "runtime.read", spaceId, client);
      const sessionId = id("login");
      const token = `zion_account_v1.${secret()}`;
      const expiresAt = this.now() + ttlMs;
      await client.query(
        `INSERT INTO account_sessions
         (id, token_hash, user_id, active_space_id, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sessionId, hash(token), userId, spaceId, this.now(), expiresAt]
      );
      await this.audit(userId, "session.created", sessionId, {}, { spaceId, client });
      return { sessionId, token, expiresAt };
    });
  }

  async authenticate(token) {
    if (!String(token || "").startsWith("zion_account_v1.")) return null;
    return this.transaction(async (client) => {
      const result = await client.query(
        `SELECT s.*, u.name, u.email, u.status, u.created_at AS user_created_at
         FROM account_sessions s
         JOIN account_users u ON s.user_id = u.id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND u.status = 'active'
         FOR UPDATE OF s`,
        [hash(token)]
      );
      const row = result.rows[0];
      if (!row || integer(row.expires_at) <= this.now()) return null;
      const user = {
        id: row.user_id,
        name: row.name,
        email: row.email,
        status: row.status,
        createdAt: integer(row.user_created_at)
      };
      let membership = await this.membership(user.id, row.active_space_id, client);
      let space = membership?.status === "active"
        ? await this.space(row.active_space_id, client)
        : null;
      if (!space) {
        space = await this.ensurePersonalSpace(user, client);
        membership = await this.membership(user.id, space.id, client);
        await client.query(
          "UPDATE account_sessions SET active_space_id = $1 WHERE id = $2",
          [space.id, row.id]
        );
      }
      return {
        user,
        sessionId: row.id,
        expiresAt: integer(row.expires_at),
        space,
        membership
      };
    });
  }

  async activeSession(sessionId, userId) {
    const result = await this.pool.query(
      `SELECT 1 FROM account_sessions s
       JOIN account_users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL
         AND s.expires_at > $3 AND u.status = 'active'`,
      [sessionId, userId, this.now()]
    );
    return result.rowCount > 0;
  }

  async selectSpace(userId, sessionId, spaceId) {
    return this.transaction(async (client) => {
      const membership = await this.require(userId, "runtime.read", spaceId, client);
      const result = await client.query(
        `UPDATE account_sessions SET active_space_id = $1
         WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL AND expires_at > $4
         RETURNING id`,
        [spaceId, sessionId, userId, this.now()]
      );
      if (!result.rowCount) throw accountError(401, "authentication_required");
      await this.audit(userId, "session.space_selected", sessionId, {}, { spaceId, client });
      return { space: await this.space(spaceId, client), membership };
    });
  }

  async revokeSession(userId, sessionId) {
    const result = await this.pool.query(
      `UPDATE account_sessions SET revoked_at = $1
       WHERE id = $2 AND user_id = $3
       RETURNING active_space_id`,
      [this.now(), sessionId, userId]
    );
    if (result.rows[0]) {
      await this.audit(userId, "session.revoked", sessionId, {}, {
        spaceId: result.rows[0].active_space_id
      });
    }
  }

  async listSessions(userId) {
    const result = await this.pool.query(
      `SELECT id, active_space_id, created_at, expires_at
       FROM account_sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2
       ORDER BY created_at DESC`,
      [userId, this.now()]
    );
    return result.rows.map((row) => ({
      id: row.id,
      activeSpaceId: row.active_space_id,
      createdAt: integer(row.created_at),
      expiresAt: integer(row.expires_at)
    }));
  }

  async listMembers(actorId, spaceId) {
    await this.require(actorId, "members.manage", spaceId);
    const result = await this.pool.query(
      `SELECT u.id, u.name, u.email, m.role, m.status, m.revision
       FROM account_memberships m
       JOIN account_users u ON m.user_id = u.id
       WHERE m.space_id = $1 ORDER BY u.created_at, u.id`,
      [spaceId]
    );
    return result.rows.map((row) => ({ ...row, revision: integer(row.revision) }));
  }

  async setMember(actorId, userId, { role, status = "active" }, spaceId) {
    accountRole(role);
    if (!["active", "removed"].includes(status)) throw accountError(400, "invalid_member_status");
    return this.transaction(async (client) => {
      const actor = await this.require(actorId, "members.manage", spaceId, client);
      const target = await this.membership(userId, spaceId, client);
      if (!target) throw accountError(404, "member_not_found");
      if ((role === "owner" || target.role === "owner") && actor.role !== "owner") {
        throw accountError(403, "owner_required");
      }
      if (target.role === "owner" && (role !== "owner" || status !== "active")) {
        const count = await client.query(
          `SELECT COUNT(*)::int AS n FROM account_memberships
           WHERE space_id = $1 AND role = 'owner' AND status = 'active'`,
          [spaceId]
        );
        if (count.rows[0].n <= 1) throw accountError(409, "last_owner");
      }
      await client.query(
        `UPDATE account_memberships SET role = $1, status = $2,
           revision = revision + 1, updated_at = $3
         WHERE space_id = $4 AND user_id = $5`,
        [role, status, this.now(), spaceId, userId]
      );
      if (status === "removed") {
        await client.query(
          `UPDATE account_run_grants SET revoked_at = $1
           WHERE space_id = $2 AND user_id = $3 AND revoked_at IS NULL`,
          [this.now(), spaceId, userId]
        );
      }
      await this.audit(
        actorId,
        status === "removed" ? "member.removed" : "member.role_changed",
        userId,
        {},
        { spaceId, client }
      );
      return this.membership(userId, spaceId, client);
    });
  }

  async invite(actorId, { role = "member", ttlMs = DAY } = {}, spaceId) {
    accountRole(role);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 7 * DAY) {
      throw accountError(400, "invalid_invitation_lifetime");
    }
    return this.transaction(async (client) => {
      const actor = await this.require(actorId, "members.manage", spaceId, client);
      const space = await this.space(spaceId, client);
      if (space?.kind !== "team") {
        throw accountError(
          409,
          "personal_space_private",
          "Create or select a team Space before inviting members"
        );
      }
      if (role === "owner" && actor.role !== "owner") throw accountError(403, "owner_required");
      const invitationId = id("invitation");
      const token = secret();
      const expiresAt = this.now() + ttlMs;
      await client.query(
        `INSERT INTO account_invitations
         (id, token_hash, space_id, role, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [invitationId, hash(token), spaceId, role, actorId, expiresAt]
      );
      await this.audit(actorId, "invitation.created", invitationId, {}, { spaceId, client });
      return { id: invitationId, token, role, expiresAt, spaceId };
    });
  }

  async acceptInvitation(userId, token) {
    return this.transaction(async (client) => {
      const user = await this.getUser(userId, client);
      if (!user || user.status !== "active") throw accountError(401, "authentication_required");
      const result = await client.query(
        `SELECT * FROM account_invitations WHERE token_hash = $1 FOR UPDATE`,
        [hash(token)]
      );
      const row = result.rows[0];
      if (!row || row.revoked_at || row.consumed_by || integer(row.expires_at) <= this.now()) {
        throw accountError(403, "invalid_invitation");
      }
      const inviter = await this.require(row.created_by, "members.manage", row.space_id, client);
      if (row.role === "owner" && inviter.role !== "owner") {
        throw accountError(403, "invalid_invitation");
      }
      const current = await this.membership(userId, row.space_id, client);
      if (!current || current.status !== "active") {
        const timestamp = this.now();
        await client.query(
          `INSERT INTO account_memberships
           (space_id, user_id, role, status, revision, created_at, updated_at)
           VALUES ($1, $2, $3, 'active', 1, $4, $4)
           ON CONFLICT (space_id, user_id) DO UPDATE SET
             role = EXCLUDED.role, status = 'active',
             revision = account_memberships.revision + 1, updated_at = EXCLUDED.updated_at`,
          [row.space_id, userId, row.role, timestamp]
        );
      }
      await client.query(
        "UPDATE account_invitations SET consumed_by = $1 WHERE id = $2",
        [userId, row.id]
      );
      await this.audit(userId, "invitation.accepted", row.id, {}, {
        spaceId: row.space_id,
        client
      });
      return {
        space: await this.space(row.space_id, client),
        membership: await this.membership(userId, row.space_id, client)
      };
    });
  }

  async saveLoginTransaction(state, browserSecret, payload, ttlMs = 5 * 60_000) {
    await this.transaction(async (client) => {
      await client.query(
        "DELETE FROM account_login_transactions WHERE expires_at <= $1",
        [this.now()]
      );
      await client.query(
        `INSERT INTO account_login_transactions
         (state_hash, browser_hash, payload_json, expires_at)
         VALUES ($1, $2, $3::jsonb, $4)`,
        [hash(state), hash(browserSecret), JSON.stringify(payload), this.now() + ttlMs]
      );
    });
  }

  async readLoginTransaction(state, browserSecret, { attempt = false } = {}) {
    const result = await this.pool.query(attempt
      ? `UPDATE account_login_transactions SET payload_json=jsonb_set(
          payload_json,'{attempts}',to_jsonb(COALESCE((payload_json->>'attempts')::int,0)+1))
         WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>$3
           AND COALESCE((payload_json->>'attempts')::int,0)<10 RETURNING payload_json`
      : `SELECT payload_json FROM account_login_transactions
         WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>$3`,
    [hash(state), hash(browserSecret), this.now()]);
    if (!result.rowCount) throw accountError(401, "invalid_login_transaction");
    return jsonObject(result.rows[0].payload_json);
  }

  async consumeLoginTransaction(state, browserSecret) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `DELETE FROM account_login_transactions
         WHERE state_hash = $1 AND browser_hash = $2 AND expires_at > $3
         RETURNING payload_json`,
        [hash(state), hash(browserSecret), this.now()]
      );
      if (!result.rowCount) throw accountError(401, "invalid_login_transaction");
      return jsonObject(result.rows[0].payload_json);
    });
  }

  async bindResourcePairing(userId, pairingId, spaceId) {
    await this.require(userId, "pairing.manage", spaceId);
    await this.pool.query(
      `INSERT INTO account_resource_pairings (pairing_id, user_id, space_id)
       VALUES ($1, $2, $3)`,
      [pairingId, userId, spaceId]
    );
    await this.audit(userId, "resource.invited", pairingId, {}, { spaceId });
  }

  async requireResourcePairing(pairingId) {
    const result = await this.pool.query(
      "SELECT user_id, space_id FROM account_resource_pairings WHERE pairing_id = $1",
      [pairingId]
    );
    const row = result.rows[0];
    if (!row) throw accountError(403, "unbound_resource_pairing");
    return this.require(row.user_id, "pairing.manage", row.space_id);
  }

  async issueGrant(userId, policy, {
    spaceId, purpose = "run", sourceId = "", profileId = "", scopes, ttlMs = DAY
  } = {}) {
    const member = await this.require(userId, "run.execute", spaceId);
    if (!["run", "task"].includes(purpose)) throw accountError(400, "invalid_grant_purpose");
    const maximumTtl = purpose === "task"
      ? MAX_TASK_GRANT_TTL_MS
      : 30 * DAY;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > maximumTtl) {
      throw accountError(400, "invalid_grant_lifetime");
    }
    const grantId = id("grant");
    const bounded = intersectAccountPolicy(policy, policy, member.role);
    const currentScopes = roleScopes(member.role);
    const boundedScopes = scopes
      ? currentScopes.filter((scope) => scopes.includes(scope))
      : currentScopes;
    await this.pool.query(
      `INSERT INTO account_run_grants
       (id, user_id, space_id, policy_json, purpose, source_id,
        created_at, expires_at, profile_id, scopes_json)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        grantId, userId, spaceId, JSON.stringify(bounded), purpose,
        String(sourceId), this.now(), this.now() + ttlMs,
        String(profileId), JSON.stringify(boundedScopes)
      ]
    );
    await this.audit(userId, "grant.created", grantId, {}, { spaceId });
    return {
      version: 1,
      userId,
      spaceId,
      grantId,
      kind: purpose === "task" ? "service" : "user"
    };
  }

  async validateGrant(principal, requestedPolicy) {
    if (!principal || principal.version !== 1 || !principal.spaceId) {
      throw accountError(403, "invalid_run_principal");
    }
    const result = await this.pool.query(
      `SELECT * FROM account_run_grants
       WHERE id = $1 AND space_id = $2 AND user_id = $3
         AND revoked_at IS NULL AND expires_at > $4`,
      [principal.grantId, principal.spaceId, principal.userId, this.now()]
    );
    const grant = result.rows[0];
    if (!grant) throw accountError(403, "grant_inactive");
    const member = await this.require(grant.user_id, "run.execute", grant.space_id);
    const policy = jsonObject(grant.policy_json);
    const grantedScopes = jsonArray(grant.scopes_json);
    return {
      principal: {
        version: 1,
        userId: grant.user_id,
        spaceId: grant.space_id,
        grantId: grant.id,
        kind: grant.purpose === "task" ? "service" : "user"
      },
      policy: intersectAccountPolicy(requestedPolicy || policy, policy, member.role),
      profileId: grant.profile_id,
      sourceId: grant.source_id,
      scopes: roleScopes(member.role).filter((scope) => grantedScopes.includes(scope))
    };
  }

  async listGrants(actorId, { spaceId, limit = 50, offset = 0 } = {}) {
    const member = await this.require(actorId, "runtime.read", spaceId);
    const manage = roleScopes(member.role).includes("runtime.manage");
    const result = await this.pool.query(
      `SELECT g.id, g.user_id, u.name AS user_name, g.purpose, g.source_id,
         g.profile_id, g.created_at, g.expires_at, g.revoked_at
       FROM account_run_grants g
       JOIN account_users u ON u.id = g.user_id
       WHERE g.space_id = $1 AND ($2::boolean OR g.user_id = $3)
       ORDER BY g.created_at DESC, g.id DESC LIMIT $4 OFFSET $5`,
      [
        spaceId,
        manage,
        actorId,
        Math.max(1, Math.min(100, Math.floor(Number(limit) || 50))),
        Math.max(0, Math.min(100_000, Math.floor(Number(offset) || 0)))
      ]
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      userName: row.user_name,
      purpose: row.purpose,
      sourceId: row.source_id,
      profileId: row.profile_id,
      createdAt: integer(row.created_at),
      expiresAt: integer(row.expires_at),
      revokedAt: row.revoked_at == null ? null : integer(row.revoked_at)
    }));
  }

  async revokeGrant(actorId, grantId, spaceId = "") {
    return this.transaction(async (client) => {
      const result = await client.query(
        `SELECT user_id, space_id FROM account_run_grants
         WHERE id = $1 ${spaceId ? "AND space_id = $2" : ""} FOR UPDATE`,
        spaceId ? [grantId, spaceId] : [grantId]
      );
      const grant = result.rows[0];
      if (!grant) throw accountError(404, "grant_not_found");
      if (grant.user_id !== actorId) {
        await this.require(actorId, "runtime.manage", grant.space_id, client);
      }
      await client.query(
        "UPDATE account_run_grants SET revoked_at = $1 WHERE id = $2",
        [this.now(), grantId]
      );
      await this.audit(actorId, "grant.revoked", grantId, {}, {
        spaceId: grant.space_id,
        client
      });
    });
  }

  async discardPreviewGrant(principal) {
    if (
      principal?.version !== 1
      || principal?.kind !== "user"
      || !principal?.grantId
      || !principal?.userId
      || !principal?.spaceId
    ) {
      return false;
    }
    const result = await this.pool.query(
      `DELETE FROM account_run_grants
       WHERE id = $1 AND user_id = $2 AND space_id = $3
         AND purpose = 'run' AND source_id = ''`,
      [
        principal.grantId,
        principal.userId,
        principal.spaceId
      ]
    );
    return result.rowCount > 0;
  }

  async setDelegation(sourceId, principal, binding) {
    const grant = await this.validateGrant(principal);
    if (grant.principal.kind !== "service" || grant.sourceId !== sourceId) {
      throw accountError(403, "invalid_task_delegation");
    }
    await this.transaction(async (client) => {
      const previous = await client.query(
        `SELECT grant_id FROM account_delegations
         WHERE space_id = $1 AND source_id = $2 FOR UPDATE`,
        [principal.spaceId, sourceId]
      );
      const previousGrantId = previous.rows[0]?.grant_id;
      if (previousGrantId && previousGrantId !== principal.grantId) {
        await client.query(
          `UPDATE account_run_grants SET revoked_at = $1
           WHERE id = $2 AND revoked_at IS NULL`,
          [this.now(), previousGrantId]
        );
      }
      await client.query(
        `INSERT INTO account_delegations (space_id, source_id, grant_id, binding)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (space_id, source_id) DO UPDATE SET
           grant_id = EXCLUDED.grant_id, binding = EXCLUDED.binding`,
        [principal.spaceId, sourceId, principal.grantId, binding]
      );
    });
  }

  async getDelegation(sourceId, spaceId = "") {
    const result = await this.pool.query(
      `SELECT d.space_id, d.binding, g.id, g.user_id
       FROM account_delegations d
       JOIN account_run_grants g ON g.id = d.grant_id
       WHERE ${spaceId ? "d.space_id = $1 AND d.source_id = $2" : "d.source_id = $1"}
       ORDER BY d.space_id
       LIMIT 2`,
      spaceId ? [spaceId, sourceId] : [sourceId]
    );
    if (result.rows.length > 1) {
      throw accountError(409, "ambiguous_delegation", "Delegation requires an explicit Space");
    }
    const row = result.rows[0];
    return row ? {
      binding: row.binding,
      principal: {
        version: 1,
        kind: "service",
        userId: row.user_id,
        spaceId: spaceId || row.space_id,
        grantId: row.id
      }
    } : null;
  }

  async revokeDelegation(actorId, sourceId, spaceId) {
    await this.transaction(async (client) => {
      const result = await client.query(
        `SELECT d.grant_id, g.user_id FROM account_delegations d
         JOIN account_run_grants g ON g.id = d.grant_id
         WHERE d.space_id = $1 AND d.source_id = $2 FOR UPDATE`,
        [spaceId, sourceId]
      );
      const current = result.rows[0];
      if (!current) return;
      if (current.user_id !== actorId) {
        await this.require(actorId, "runtime.manage", spaceId, client);
      }
      await client.query(
        "UPDATE account_run_grants SET revoked_at = $1 WHERE id = $2",
        [this.now(), current.grant_id]
      );
      await client.query(
        "DELETE FROM account_delegations WHERE space_id = $1 AND source_id = $2",
        [spaceId, sourceId]
      );
      await this.audit(actorId, "grant.revoked", current.grant_id, {}, {
        spaceId,
        client
      });
    });
  }

  async listAudit(actorId, { spaceId, after = 0, limit = 100 } = {}) {
    await this.require(actorId, "members.manage", spaceId);
    const result = await this.pool.query(
      `SELECT sequence, space_id, actor_id, action, target_id, created_at, details_json
       FROM account_audit
       WHERE space_id = $1 AND sequence > $2
       ORDER BY sequence LIMIT $3`,
      [
        spaceId,
        Math.max(0, Number(after) || 0),
        Math.max(1, Math.min(500, Number(limit) || 100))
      ]
    );
    return result.rows.map((row) => ({
      sequence: integer(row.sequence),
      spaceId: row.space_id,
      actorId: row.actor_id,
      action: row.action,
      targetId: row.target_id,
      createdAt: integer(row.created_at),
      details: jsonObject(row.details_json)
    }));
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }
}
