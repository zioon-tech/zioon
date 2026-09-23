import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";

const ACCESS_TOKEN_PREFIX = "zion_v1";
const PAIRING_KINDS = new Set(["owner", "client", "resource"]);
const PAIRING_DELIVERIES = new Set(["cookie", "bearer"]);
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export const DEFAULT_ACCESS_SCOPES = Object.freeze({
  owner: Object.freeze([
    "runtime.read",
    "runtime.write",
    "collaboration.write",
    "pairing.manage",
    "device.manage"
  ]),
  client: Object.freeze([
    "runtime.read",
    "runtime.write",
    "collaboration.write"
  ]),
  resource: Object.freeze(["node.connect"])
});

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function digestMatches(value, expectedHex) {
  const actual = Buffer.from(digest(value), "hex");
  const expected = Buffer.from(String(expectedHex || ""), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function jsonArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function requireId(value, label) {
  const id = String(value || "").trim();
  if (!ID_PATTERN.test(id)) throw statusError(400, `${label} is invalid`);
  return id;
}

function normalizeKind(value) {
  const kind = String(value || "").trim();
  if (!PAIRING_KINDS.has(kind)) {
    throw statusError(400, `Unsupported pairing kind: ${kind || "missing"}`);
  }
  return kind;
}

function normalizeDelivery(value, kind) {
  const fallback = kind === "resource" ? "bearer" : "cookie";
  const delivery = String(value || fallback).trim();
  if (!PAIRING_DELIVERIES.has(delivery)) {
    throw statusError(400, `Unsupported credential delivery: ${delivery}`);
  }
  if (kind === "resource" && delivery !== "bearer") {
    throw statusError(400, "Resource credentials must use bearer delivery");
  }
  return delivery;
}

function normalizeScopes(value, kind) {
  const allowed = new Set(DEFAULT_ACCESS_SCOPES[kind]);
  if (!Array.isArray(value) || !value.length) return [...allowed];
  const requested = [...new Set(value.map(String).filter(Boolean))];
  if (requested.some((scope) => !allowed.has(scope))) {
    throw statusError(400, `Pairing requests unsupported ${kind} scopes`);
  }
  return requested;
}

function normalizeUserCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function createUserCode() {
  const bytes = randomBytes(12);
  const raw = Array.from(
    bytes,
    (byte) => USER_CODE_ALPHABET[byte & 31]
  ).join("");
  return raw.match(/.{1,4}/g).join("-");
}

function createCredentialToken(credentialId, secret) {
  return `${ACCESS_TOKEN_PREFIX}.${credentialId}.${secret}`;
}

function parseCredentialToken(value) {
  const parts = String(value || "").split(".");
  if (
    parts.length !== 3
    || parts[0] !== ACCESS_TOKEN_PREFIX
    || !ID_PATTERN.test(parts[1])
    || !parts[2]
  ) {
    return null;
  }
  return { credentialId: parts[1], secret: parts[2] };
}

function deviceFromRow(row) {
  if (!row) return null;
  return {
    deviceId: String(row.device_id),
    kind: String(row.kind),
    label: String(row.label || ""),
    platform: String(row.platform || ""),
    scopes: jsonArray(row.scopes_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastSeenAt: Number(row.last_seen_at || 0),
    revokedAt: Number(row.revoked_at || 0) || null
  };
}

export class PostgresAccessStore {
  backend = "postgres";

  constructor(pool, {
    spaceId,
    now = () => Date.now(),
    pairingTtlMs = 5 * 60_000,
    credentialTtlMs = 30 * 24 * 60 * 60_000,
    pairingAttempts = 5,
    touchIntervalMs = 60_000
  } = {}) {
    if (!pool?.query || !pool?.connect) {
      throw new Error("PostgreSQL Access store requires a Pool");
    }
    if (!spaceId) throw new Error("PostgreSQL Access store requires a Space ID");
    this.pool = pool;
    this.spaceId = String(spaceId);
    this.now = now;
    this.pairingTtlMs = pairingTtlMs;
    this.credentialTtlMs = credentialTtlMs;
    this.pairingAttempts = pairingAttempts;
    this.touchIntervalMs = touchIntervalMs;
    this.lastTouches = new Map();
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

  async createPairing({
    kind,
    delivery,
    scopes,
    label = "",
    ttlMs = this.pairingTtlMs
  } = {}) {
    const normalizedKind = normalizeKind(kind);
    const normalizedDelivery = normalizeDelivery(delivery, normalizedKind);
    const normalizedScopes = normalizeScopes(scopes, normalizedKind);
    const lifetime = Number(ttlMs);
    if (
      !Number.isSafeInteger(lifetime)
      || lifetime < 30_000
      || lifetime > 3_600_000
    ) {
      throw statusError(
        400,
        "Pairing lifetime must be between 30 seconds and 1 hour"
      );
    }
    const now = this.now();
    const pairingId = `pairing:${randomUUID()}`;
    const secret = randomBytes(32).toString("base64url");
    let userCode = "";
    let inserted = false;
    for (let attempt = 0; attempt < 10 && !inserted; attempt += 1) {
      userCode = createUserCode();
      const result = await this.pool.query(
        `INSERT INTO runtime_access_pairings
         (pairing_id, space_id, secret_hash, user_code_hash, kind, delivery,
          scopes_json, label, created_at, expires_at, attempts_remaining)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
         ON CONFLICT (user_code_hash) DO NOTHING
         RETURNING pairing_id`,
        [
          pairingId,
          this.spaceId,
          digest(secret),
          digest(normalizeUserCode(userCode)),
          normalizedKind,
          normalizedDelivery,
          JSON.stringify(normalizedScopes),
          String(label || "").trim(),
          now,
          now + lifetime,
          this.pairingAttempts
        ]
      );
      inserted = result.rowCount === 1;
    }
    if (!inserted) throw new Error("Could not allocate a unique pairing code");
    return {
      pairingId,
      secret,
      userCode,
      kind: normalizedKind,
      delivery: normalizedDelivery,
      scopes: normalizedScopes,
      expiresAt: now + lifetime
    };
  }

  async pairingRow({ pairingId, secret, userCode }, client, {
    forUpdate = false
  } = {}) {
    const normalizedPairingId = String(pairingId || "").trim();
    const normalizedCode = normalizeUserCode(userCode);
    if ((!normalizedPairingId || !secret) && !normalizedCode) {
      throw statusError(400, "Pairing secret or user code is required");
    }
    const result = normalizedPairingId && secret
      ? await client.query(
          `SELECT * FROM runtime_access_pairings
           WHERE space_id = $1 AND pairing_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
          [this.spaceId, normalizedPairingId]
        )
      : await client.query(
          `SELECT * FROM runtime_access_pairings
           WHERE space_id = $1 AND user_code_hash = $2${forUpdate ? " FOR UPDATE" : ""}`,
          [this.spaceId, digest(normalizedCode)]
        );
    return {
      row: result.rows[0] || null,
      normalizedPairingId,
      normalizedCode
    };
  }

  validatePairing(row, { normalizedPairingId, normalizedCode, secret }, now) {
    if (!row) throw statusError(401, "Pairing invitation is invalid");
    if (row.consumed_at) {
      throw statusError(409, "Pairing invitation has already been used");
    }
    if (Number(row.expires_at) <= now) {
      throw statusError(410, "Pairing invitation has expired");
    }
    const matches = normalizedPairingId && secret
      ? digestMatches(secret, row.secret_hash)
      : digestMatches(normalizedCode, row.user_code_hash);
    return matches;
  }

  async inspectPairing(input = {}) {
    const lookup = await this.pairingRow(input, this.pool);
    if (!this.validatePairing(lookup.row, { ...lookup, secret: input.secret }, this.now())) {
      throw statusError(401, "Pairing invitation is invalid");
    }
    return {
      pairingId: String(lookup.row.pairing_id),
      kind: String(lookup.row.kind),
      delivery: String(lookup.row.delivery)
    };
  }

  async exchangePairing({
    pairingId,
    secret,
    userCode,
    deviceId,
    label = "",
    platform = "",
    authorizePairing
  } = {}) {
    const outcome = await this.transaction(async (client) => {
      const now = this.now();
      const lookup = await this.pairingRow(
        { pairingId, secret, userCode },
        client,
        { forUpdate: true }
      );
      const row = lookup.row;
      if (!row) throw statusError(401, "Pairing invitation is invalid");
      if (row.consumed_at) {
        throw statusError(409, "Pairing invitation has already been used");
      }
      if (Number(row.expires_at) <= now) {
        throw statusError(410, "Pairing invitation has expired");
      }
      if (Number(row.attempts_remaining) <= 0) {
        throw statusError(429, "Pairing invitation is locked");
      }
      const matches = this.validatePairing(
        row,
        { ...lookup, secret },
        now
      );
      if (!matches) {
        await client.query(
          `UPDATE runtime_access_pairings
           SET attempts_remaining = GREATEST(0, attempts_remaining - 1)
           WHERE space_id = $1 AND pairing_id = $2`,
          [this.spaceId, row.pairing_id]
        );
        return {
          pairingError: statusError(401, "Pairing invitation is invalid")
        };
      }

      await authorizePairing?.(row);
      const kind = normalizeKind(row.kind);
      const resolvedDeviceId = deviceId
        ? requireId(deviceId, "Device id")
        : `device:${randomUUID()}`;
      const existing = await client.query(
        `SELECT device_id, revoked_at FROM runtime_access_devices
         WHERE space_id = $1 AND device_id = $2 FOR UPDATE`,
        [this.spaceId, resolvedDeviceId]
      );
      if (existing.rows[0] && !existing.rows[0].revoked_at) {
        throw statusError(409, `Device is already paired: ${resolvedDeviceId}`);
      }
      const scopes = jsonArray(row.scopes_json);
      const deviceLabel = String(label || row.label || "").trim();
      const devicePlatform = String(platform || "").trim();
      await client.query(
        `INSERT INTO runtime_access_devices
         (space_id, device_id, kind, label, platform, scopes_json,
          created_at, updated_at, last_seen_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7, $7, NULL)
         ON CONFLICT (space_id, device_id) DO UPDATE SET
           kind = EXCLUDED.kind,
           label = EXCLUDED.label,
           platform = EXCLUDED.platform,
           scopes_json = EXCLUDED.scopes_json,
           updated_at = EXCLUDED.updated_at,
           last_seen_at = EXCLUDED.last_seen_at,
           revoked_at = NULL`,
        [
          this.spaceId,
          resolvedDeviceId,
          kind,
          deviceLabel,
          devicePlatform,
          JSON.stringify(scopes),
          now
        ]
      );
      await client.query(
        `UPDATE runtime_access_credentials
         SET revoked_at = COALESCE(revoked_at, $1)
         WHERE space_id = $2 AND device_id = $3`,
        [now, this.spaceId, resolvedDeviceId]
      );

      const credentialId = `credential:${randomUUID()}`;
      const credentialSecret = randomBytes(32).toString("base64url");
      const expiresAt = now + this.credentialTtlMs;
      await client.query(
        `INSERT INTO runtime_access_credentials
         (credential_id, space_id, device_id, secret_hash, created_at,
          expires_at, last_used_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $5, NULL)`,
        [
          credentialId,
          this.spaceId,
          resolvedDeviceId,
          digest(credentialSecret),
          now,
          expiresAt
        ]
      );
      await client.query(
        `UPDATE runtime_access_pairings
         SET consumed_at = $1, consumed_by_device_id = $2
         WHERE space_id = $3 AND pairing_id = $4`,
        [now, resolvedDeviceId, this.spaceId, row.pairing_id]
      );
      return {
        credential: createCredentialToken(credentialId, credentialSecret),
        credentialId,
        expiresAt,
        delivery: String(row.delivery),
        device: {
          deviceId: resolvedDeviceId,
          kind,
          label: deviceLabel,
          platform: devicePlatform,
          scopes,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          revokedAt: null
        }
      };
    });
    if (outcome?.pairingError) throw outcome.pairingError;
    return outcome;
  }

  async authenticate(credential) {
    const parsed = parseCredentialToken(credential);
    if (!parsed) return null;
    const result = await this.pool.query(
      `SELECT c.credential_id, c.secret_hash, c.expires_at,
        c.revoked_at AS credential_revoked_at, d.*
       FROM runtime_access_credentials c
       JOIN runtime_access_devices d
         ON d.space_id = c.space_id AND d.device_id = c.device_id
       WHERE c.space_id = $1 AND c.credential_id = $2`,
      [this.spaceId, parsed.credentialId]
    );
    const row = result.rows[0];
    const now = this.now();
    if (
      !row
      || row.credential_revoked_at
      || row.revoked_at
      || Number(row.expires_at) <= now
      || !digestMatches(parsed.secret, row.secret_hash)
    ) {
      return null;
    }
    const previousTouch = this.lastTouches.get(parsed.credentialId) || 0;
    if (now - previousTouch >= this.touchIntervalMs) {
      await this.transaction(async (client) => {
        await client.query(
          `UPDATE runtime_access_credentials SET last_used_at = $1
           WHERE space_id = $2 AND credential_id = $3`,
          [now, this.spaceId, parsed.credentialId]
        );
        await client.query(
          `UPDATE runtime_access_devices
           SET last_seen_at = $1, updated_at = $1
           WHERE space_id = $2 AND device_id = $3`,
          [now, this.spaceId, row.device_id]
        );
      });
      this.lastTouches.set(parsed.credentialId, now);
    }
    return {
      credentialId: String(row.credential_id),
      expiresAt: Number(row.expires_at),
      device: deviceFromRow(row)
    };
  }

  async isCredentialActive(credentialId, deviceId) {
    const result = await this.pool.query(
      `SELECT c.expires_at, c.revoked_at AS credential_revoked_at, d.revoked_at
       FROM runtime_access_credentials c
       JOIN runtime_access_devices d
         ON d.space_id = c.space_id AND d.device_id = c.device_id
       WHERE c.space_id = $1 AND c.credential_id = $2 AND c.device_id = $3`,
      [
        this.spaceId,
        String(credentialId || ""),
        String(deviceId || "")
      ]
    );
    const row = result.rows[0];
    return !!row
      && !row.credential_revoked_at
      && !row.revoked_at
      && Number(row.expires_at) > this.now();
  }

  async listDevices() {
    const result = await this.pool.query(
      `SELECT * FROM runtime_access_devices
       WHERE space_id = $1
       ORDER BY created_at ASC, device_id ASC`,
      [this.spaceId]
    );
    return result.rows.map(deviceFromRow);
  }

  async revokeDevice(deviceId) {
    const id = requireId(deviceId, "Device id");
    const now = this.now();
    return this.transaction(async (client) => {
      const update = await client.query(
        `UPDATE runtime_access_devices
         SET revoked_at = COALESCE(revoked_at, $1), updated_at = $1
         WHERE space_id = $2 AND device_id = $3`,
        [now, this.spaceId, id]
      );
      await client.query(
        `UPDATE runtime_access_credentials
         SET revoked_at = COALESCE(revoked_at, $1)
         WHERE space_id = $2 AND device_id = $3`,
        [now, this.spaceId, id]
      );
      return update.rowCount > 0;
    });
  }

  async revokeCredential(credentialId) {
    const id = requireId(credentialId, "Credential id");
    const update = await this.pool.query(
      `UPDATE runtime_access_credentials
       SET revoked_at = COALESCE(revoked_at, $1)
       WHERE space_id = $2 AND credential_id = $3`,
      [this.now(), this.spaceId, id]
    );
    this.lastTouches.delete(id);
    return update.rowCount > 0;
  }

  async close() {
    this.lastTouches.clear();
  }
}
