import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require(["node", "sqlite"].join(":"));

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

function encode(value) {
  return JSON.stringify(value);
}

function decodeArray(value) {
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
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
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
  return {
    credentialId: parts[1],
    secret: parts[2]
  };
}

function deviceFromRow(row) {
  if (!row) return null;
  return {
    deviceId: String(row.device_id),
    kind: String(row.kind),
    label: String(row.label || ""),
    platform: String(row.platform || ""),
    scopes: decodeArray(row.scopes_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastSeenAt: Number(row.last_seen_at || 0),
    revokedAt: Number(row.revoked_at || 0) || null
  };
}

export class SqliteAccessStore {
  constructor(path, {
    now = () => Date.now(),
    pairingTtlMs = 5 * 60_000,
    credentialTtlMs = 30 * 24 * 60 * 60_000,
    pairingAttempts = 5,
    touchIntervalMs = 60_000
  } = {}) {
    this.path = path;
    this.now = now;
    this.pairingTtlMs = pairingTtlMs;
    this.credentialTtlMs = credentialTtlMs;
    this.pairingAttempts = pairingAttempts;
    this.touchIntervalMs = touchIntervalMs;
    this.lastTouches = new Map();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 30000;

      CREATE TABLE IF NOT EXISTS runtime_access_pairings (
        pairing_id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        user_code_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        delivery TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts_remaining INTEGER NOT NULL,
        consumed_at INTEGER,
        consumed_by_device_id TEXT
      );

      CREATE TABLE IF NOT EXISTS runtime_access_devices (
        device_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        platform TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS runtime_access_credentials (
        credential_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER,
        FOREIGN KEY (device_id) REFERENCES runtime_access_devices(device_id)
      );

      CREATE INDEX IF NOT EXISTS runtime_access_pairings_expires
        ON runtime_access_pairings(expires_at);
      CREATE INDEX IF NOT EXISTS runtime_access_credentials_device
        ON runtime_access_credentials(device_id);
      CREATE INDEX IF NOT EXISTS runtime_access_credentials_expires
        ON runtime_access_credentials(expires_at);
    `);
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Some filesystems do not support POSIX permissions.
      }
    }
  }

  createPairing({
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
    if (!Number.isSafeInteger(lifetime) || lifetime < 30_000 || lifetime > 3_600_000) {
      throw statusError(400, "Pairing lifetime must be between 30 seconds and 1 hour");
    }
    const now = this.now();
    const pairingId = `pairing:${randomUUID()}`;
    const secret = randomBytes(32).toString("base64url");
    let userCode = createUserCode();
    while (this.db.prepare(`
      SELECT 1 FROM runtime_access_pairings WHERE user_code_hash = ?
    `).get(digest(normalizeUserCode(userCode)))) {
      userCode = createUserCode();
    }
    this.db.prepare(`
      INSERT INTO runtime_access_pairings (
        pairing_id, secret_hash, user_code_hash, kind, delivery,
        scopes_json, label, created_at, expires_at, attempts_remaining
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pairingId,
      digest(secret),
      digest(normalizeUserCode(userCode)),
      normalizedKind,
      normalizedDelivery,
      encode(normalizedScopes),
      String(label || "").trim(),
      now,
      now + lifetime,
      this.pairingAttempts
    );
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

  exchangePairing({
    pairingId,
    secret,
    userCode,
    deviceId,
    label = "",
    platform = ""
  } = {}) {
    const normalizedPairingId = String(pairingId || "").trim();
    const normalizedCode = normalizeUserCode(userCode);
    if ((!normalizedPairingId || !secret) && !normalizedCode) {
      throw statusError(400, "Pairing secret or user code is required");
    }
    const now = this.now();
    let transactionOpen = false;
    this.db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    try {
      const row = normalizedPairingId && secret
        ? this.db.prepare(`
            SELECT * FROM runtime_access_pairings WHERE pairing_id = ?
          `).get(normalizedPairingId)
        : this.db.prepare(`
            SELECT * FROM runtime_access_pairings WHERE user_code_hash = ?
          `).get(digest(normalizedCode));
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
      const matches = normalizedPairingId && secret
        ? digestMatches(secret, row.secret_hash)
        : digestMatches(normalizedCode, row.user_code_hash);
      if (!matches) {
        this.db.prepare(`
          UPDATE runtime_access_pairings
          SET attempts_remaining = MAX(0, attempts_remaining - 1)
          WHERE pairing_id = ?
        `).run(row.pairing_id);
        this.db.exec("COMMIT");
        transactionOpen = false;
        throw statusError(401, "Pairing invitation is invalid");
      }

      const kind = normalizeKind(row.kind);
      const resolvedDeviceId = deviceId
        ? requireId(deviceId, "Device id")
        : `device:${randomUUID()}`;
      const existing = this.db.prepare(`
        SELECT device_id, revoked_at
        FROM runtime_access_devices
        WHERE device_id = ?
      `).get(resolvedDeviceId);
      if (existing && !existing.revoked_at) {
        throw statusError(409, `Device is already paired: ${resolvedDeviceId}`);
      }
      const scopes = decodeArray(row.scopes_json);
      this.db.prepare(`
        INSERT INTO runtime_access_devices (
          device_id, kind, label, platform, scopes_json,
          created_at, updated_at, last_seen_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(device_id) DO UPDATE SET
          kind = excluded.kind,
          label = excluded.label,
          platform = excluded.platform,
          scopes_json = excluded.scopes_json,
          updated_at = excluded.updated_at,
          last_seen_at = excluded.last_seen_at,
          revoked_at = NULL
      `).run(
        resolvedDeviceId,
        kind,
        String(label || row.label || "").trim(),
        String(platform || "").trim(),
        encode(scopes),
        now,
        now,
        now
      );
      this.db.prepare(`
        UPDATE runtime_access_credentials
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE device_id = ?
      `).run(now, resolvedDeviceId);

      const credentialId = `credential:${randomUUID()}`;
      const credentialSecret = randomBytes(32).toString("base64url");
      const expiresAt = now + this.credentialTtlMs;
      this.db.prepare(`
        INSERT INTO runtime_access_credentials (
          credential_id, device_id, secret_hash, created_at, expires_at,
          last_used_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(
        credentialId,
        resolvedDeviceId,
        digest(credentialSecret),
        now,
        expiresAt,
        now
      );
      this.db.prepare(`
        UPDATE runtime_access_pairings
        SET consumed_at = ?, consumed_by_device_id = ?
        WHERE pairing_id = ?
      `).run(now, resolvedDeviceId, row.pairing_id);
      this.db.exec("COMMIT");
      transactionOpen = false;

      return {
        credential: createCredentialToken(credentialId, credentialSecret),
        credentialId,
        expiresAt,
        delivery: String(row.delivery),
        device: {
          deviceId: resolvedDeviceId,
          kind,
          label: String(label || row.label || "").trim(),
          platform: String(platform || "").trim(),
          scopes,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          revokedAt: null
        }
      };
    } catch (error) {
      if (transactionOpen) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  authenticate(credential) {
    const parsed = parseCredentialToken(credential);
    if (!parsed) return null;
    const row = this.db.prepare(`
      SELECT
        c.credential_id,
        c.secret_hash,
        c.expires_at,
        c.revoked_at AS credential_revoked_at,
        d.*
      FROM runtime_access_credentials c
      JOIN runtime_access_devices d ON d.device_id = c.device_id
      WHERE c.credential_id = ?
    `).get(parsed.credentialId);
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
      this.db.prepare(`
        UPDATE runtime_access_credentials SET last_used_at = ?
        WHERE credential_id = ?
      `).run(now, parsed.credentialId);
      this.db.prepare(`
        UPDATE runtime_access_devices SET last_seen_at = ?, updated_at = ?
        WHERE device_id = ?
      `).run(now, now, row.device_id);
      this.lastTouches.set(parsed.credentialId, now);
    }
    return {
      credentialId: String(row.credential_id),
      expiresAt: Number(row.expires_at),
      device: deviceFromRow(row)
    };
  }

  isCredentialActive(credentialId, deviceId) {
    const row = this.db.prepare(`
      SELECT c.expires_at, c.revoked_at AS credential_revoked_at, d.revoked_at
      FROM runtime_access_credentials c
      JOIN runtime_access_devices d ON d.device_id = c.device_id
      WHERE c.credential_id = ? AND c.device_id = ?
    `).get(String(credentialId || ""), String(deviceId || ""));
    return !!row
      && !row.credential_revoked_at
      && !row.revoked_at
      && Number(row.expires_at) > this.now();
  }

  listDevices() {
    return this.db.prepare(`
      SELECT *
      FROM runtime_access_devices
      ORDER BY created_at ASC, device_id ASC
    `).all().map(deviceFromRow);
  }

  revokeDevice(deviceId) {
    const id = requireId(deviceId, "Device id");
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare(`
        UPDATE runtime_access_devices
        SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
        WHERE device_id = ?
      `).run(now, now, id);
      this.db.prepare(`
        UPDATE runtime_access_credentials
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE device_id = ?
      `).run(now, id);
      this.db.exec("COMMIT");
      return Number(update.changes) > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  revokeCredential(credentialId) {
    const id = requireId(credentialId, "Credential id");
    const update = this.db.prepare(`
      UPDATE runtime_access_credentials
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE credential_id = ?
    `).run(this.now(), id);
    this.lastTouches.delete(id);
    return Number(update.changes) > 0;
  }

  close() {
    this.db.close();
  }
}
