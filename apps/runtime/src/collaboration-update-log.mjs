import { createHash } from "node:crypto";
import * as Y from "yjs";

export const COLLABORATION_LOG_MAX_ROWS = 128;
export const COLLABORATION_LOG_MAX_BYTES = 1024 * 1024;

export const collaborationStateSelect = `SELECT d.*, log.updates
  FROM runtime_collaboration_documents d
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'version',version::text,'hash',update_hash,
      'state',encode(update_blob,'base64')) ORDER BY version) AS updates
    FROM runtime_collaboration_updates
    WHERE space_id=d.space_id AND session_id=d.session_id
  ) log ON TRUE
  WHERE d.space_id=$1 AND d.session_id=$2`;

export function collaborationUpdateHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function collaborationStorageHash(row) {
  return collaborationUpdateHash(JSON.stringify([
    Number(row.base_version ?? row.version), row.base_hash ?? row.state_hash,
    (row.updates || []).map(update => [Number(update.version), update.hash])
  ]));
}

function invalidState(message) {
  return Object.assign(new Error(message), { code: "collaboration_state_invalid", statusCode: 500 });
}

function check(condition, message) {
  if (!condition) throw invalidState(message);
}

function safeInteger(value, name, minimum = 0) {
  const result = Number(value);
  check(Number.isSafeInteger(result) && result >= minimum, `Invalid collaboration ${name}`);
  return result;
}

function validHash(bytes, expected, name) {
  check(typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected),
    `Invalid collaboration ${name} hash`);
  check(collaborationUpdateHash(bytes) === expected, `Collaboration ${name} hash mismatch`);
}

/** Verify persisted bytes even when an accepted document is cached. */
export function verifyCollaborationRow(row) {
  if (!row) return null;
  const base = Buffer.from(row.state_blob || []);
  check(base.length > 0, "Collaboration base is missing");
  const version = safeInteger(row.version, "version", 1);
  const legacy = row.base_version == null;
  const baseVersion = legacy ? version : safeInteger(row.base_version, "base version", 1);
  const count = safeInteger(row.update_count ?? 0, "update count");
  const storedBytes = safeInteger(row.update_bytes ?? 0, "update bytes");
  const source = row.updates == null ? [] : row.updates;
  check(Array.isArray(source), "Invalid collaboration update vector");
  check(count === source.length && version - baseVersion === count,
    "Collaboration update vector is incomplete");
  check(count < COLLABORATION_LOG_MAX_ROWS && storedBytes <= COLLABORATION_LOG_MAX_BYTES,
    "Collaboration update vector exceeds its bounds");
  validHash(base, legacy ? row.state_hash : row.base_hash, "base");
  check(typeof row.state_hash === "string" && /^[a-f0-9]{64}$/.test(row.state_hash),
    "Invalid collaboration state hash");
  let bytes = 0;
  const updates = source.map((item, index) => {
    check(item && typeof item === "object", "Invalid collaboration update entry");
    check(safeInteger(item.version, "update version", 1) === baseVersion + index + 1,
      "Collaboration update order changed");
    check(typeof item.state === "string" && /^[A-Za-z0-9+/=\r\n]+$/.test(item.state),
      "Invalid collaboration update encoding");
    const update = Buffer.from(item.state, "base64");
    check(update.length > 0, "Collaboration update is empty");
    validHash(update, item.hash, "update");
    bytes += update.length;
    return update;
  });
  check(bytes === storedBytes, "Collaboration update byte count changed");
  return { base, updates, version, baseVersion, legacy, stateHash: row.state_hash };
}

function rebuildDocument(verified) {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, verified.base);
    for (const update of verified.updates) Y.applyUpdate(document, update);
    if (!verified.legacy) validHash(Y.encodeStateAsUpdate(document), verified.stateHash, "state");
    return document;
  } catch (cause) {
    document.destroy();
    if (cause?.code === "collaboration_state_invalid") throw cause;
    throw invalidState("Collaboration stored update cannot be decoded");
  }
}

export function readCollaborationState(row) {
  const verified = verifyCollaborationRow(row);
  if (!verified) return null;
  if (verified.legacy) return new Uint8Array(verified.base);
  const document = rebuildDocument(verified);
  try { return Y.encodeStateAsUpdate(document); }
  finally { document.destroy(); }
}

/** Yjs does not throw for unresolved dependencies; do not acknowledge them. */
export function assertCollaborationUpdateIntegrated(document, update) {
  const decoded = Y.decodeUpdate(update);
  const vector = Y.decodeStateVector(Y.encodeStateVector(document));
  const requireClock = (client, clock) => {
    if ((vector.get(client) || 0) < clock) throw Object.assign(
      new Error("Collaboration update is waiting for a missing dependency"),
      { code: "collaboration_dependency_missing", statusCode: 409 });
  };
  for (const item of decoded.structs) requireClock(item.id.client, item.id.clock + item.length);
  for (const [client, ranges] of decoded.ds.clients) {
    for (const range of ranges) requireClock(client, range.clock + range.len);
  }
}

/** Encoded-byte accounting is a bound, not an estimate of Y object heap use. */
export class CollaborationDocumentCache {
  constructor({ maxBytes = 8 * 1024 * 1024, maxDocuments = 16 } = {}) {
    this.maxBytes = Math.max(0, Math.floor(Number(maxBytes) || 0));
    this.maxDocuments = Math.max(0, Math.floor(Number(maxDocuments) || 0));
    this.entries = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  take(key, version, stateHash, storageHash) {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.bytes -= entry.bytes;
      if (entry.version === version && entry.stateHash === stateHash
        && (storageHash == null || entry.storageHash === storageHash)) {
        this.hits++;
        return entry.document;
      }
      entry.document.destroy();
    }
    this.misses++;
    return null;
  }

  put(key, document, { version, stateHash, storageHash, bytes }) {
    const previous = this.entries.get(key);
    if (previous && previous.version > version) { document.destroy(); return; }
    if (previous) {
      this.entries.delete(key);
      this.bytes -= previous.bytes;
      previous.document.destroy();
    }
    if (!this.maxDocuments || bytes > this.maxBytes) { document.destroy(); return; }
    this.entries.set(key, { document, version, stateHash, storageHash, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxDocuments || this.bytes > this.maxBytes) {
      const [oldKey, oldEntry] = this.entries.entries().next().value;
      this.entries.delete(oldKey);
      this.bytes -= oldEntry.bytes;
      oldEntry.document.destroy();
    }
  }

  clear() {
    for (const entry of this.entries.values()) entry.document.destroy();
    this.entries.clear();
    this.bytes = 0;
  }

  snapshot() {
    return { documents: this.entries.size, encodedBytes: this.bytes,
      maxDocuments: this.maxDocuments, maxEncodedBytes: this.maxBytes,
      hits: this.hits, misses: this.misses };
  }
}

export const collaborationDocumentCache = new CollaborationDocumentCache();
const poolIds = new WeakMap();
let poolSequence = 0;
export function collaborationCacheKey(pool, spaceId, sessionId) {
  if (!poolIds.has(pool)) poolIds.set(pool, ++poolSequence);
  return JSON.stringify([poolIds.get(pool), spaceId, sessionId]);
}

/** Call while owning the authorized Space/Workbench mutation lock. */
export function acquireCollaborationDocument(row, { cache = collaborationDocumentCache, key } = {}) {
  const verified = verifyCollaborationRow(row);
  if (!verified) return new Y.Doc();
  return cache.take(key, verified.version, verified.stateHash, collaborationStorageHash(row)) || rebuildDocument(verified);
}
