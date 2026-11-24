import { createHash, randomUUID } from "node:crypto";
import { deriveSessionTitleFromContent, isPlaceholderSessionTitle } from "./session-title.mjs";
import { mergeMigratedSessionTree, mergeSessionTree, sessionTreeChanges } from "./session-tree-merge.mjs";
import { applySessionMetadataChanges, sessionMetadataChanges } from "../../../packages/runtime-client/src/session-metadata.mjs";
import { extractDocumentLeadPreview } from "../../../extensions/shared/session-preview.js";
import { measureRequestStage } from "./request-performance.mjs";
import {
  hydrateSessionCardMetadata, prepareSessionCardMetadata, readSessionCardBody,
  prepareSessionCardBodies, readSessionCardBodies, sessionCardStorageMode
} from "./session-card-bodies.mjs";
import { sessionCardDetails } from "./session-card-projection.mjs";
import { hydratedSessionCard } from "../../../packages/runtime-client/src/session-card-bodies.mjs";
import * as Y from "yjs";
import {
  acquireCollaborationDocument, assertCollaborationUpdateIntegrated,
  collaborationCacheKey, collaborationDocumentCache, collaborationStateSelect,
  collaborationStorageHash, collaborationUpdateHash, COLLABORATION_LOG_MAX_BYTES, COLLABORATION_LOG_MAX_ROWS,
  readCollaborationState
} from "./collaboration-update-log.mjs";

const MAX_SESSION_REVISIONS = 20;
const MAX_SESSION_REVISION_BYTES = 8 * 1024 * 1024;
const MAX_WORKBENCH_EVENTS = 50_000;
const REVISION_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const REVISION_SNAPSHOT_TEXT_DELTA_BYTES = 64 * 1024;
const REVISION_ANNOTATIONS_KEY = "__zionRevisionAnnotations";

function clone(value, fallback = null) {
  if (value == null) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function jsonValue(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return clone(value, fallback);
}

function nowMs() {
  return Date.now();
}

function defaultTree() {
  return { id: "root", type: "folder", title: "Sessions", children: [] };
}

function contentHash(text, meta) {
  return createHash("sha256")
    .update(String(text || ""))
    .update("\0")
    .update(JSON.stringify(meta || {}))
    .digest("hex");
}

function documentHash(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

function normalizeId(value, label = "session id") {
  const normalized = String(value || "").trim();
  if (!normalized) {
    const error = new Error(`${label} required`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function titleFromText(text, fallback = "Untitled Session") {
  const firstLine = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return String(firstLine || fallback).slice(0, 80);
}

function normalizeConversationTextForDisplay(text) {
  const source = String(text || "").replace(/\r/g, "");
  if (!source.trim()) return source;
  const lines = source.split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex < 0) return source;
  const first = lines[firstContentIndex] || "";
  if (/^\s*(system|user|assistant|tool)\s+/.test(first)) return source;
  const hasLaterRole = lines
    .slice(firstContentIndex + 1)
    .some((line) => /^\s*(system|user|assistant|tool)\s+/.test(line));
  if (!hasLaterRole) return source;
  const next = lines.slice();
  next[firstContentIndex] = first.replace(/^(\s*)/, "$1user ");
  return next.join("\n");
}

function normalizeSessionMeta(sessionId, text, meta = {}, timestamp = nowMs()) {
  const current = isObject(meta) ? meta : {};
  if (["tools", "thinking"].some(kind => current.annotations?.[kind]?.some?.(item => item?.detailRef))) {
    throw Object.assign(new Error("Card detail projections cannot be stored"), { statusCode: 400 });
  }
  const placeholder = isPlaceholderSessionTitle(current.title, sessionId, current);
  const derivedTitle = placeholder ? deriveSessionTitleFromContent(text) : "";
  const title = derivedTitle || String(current.title || "新会话").trim() || "新会话";
  const hasSize = Object.prototype.hasOwnProperty.call(current, "size");
  const hasCreatedAt = Object.prototype.hasOwnProperty.call(current, "createdAt");
  const hasUpdatedAt = Object.prototype.hasOwnProperty.call(current, "updatedAt");
  return {
    ...current,
    ...(Number(current.documentPreviewVersion || 0) >= 1 ? {
      documentPreview: extractDocumentLeadPreview(text),
      documentPreviewVersion: 1
    } : {}),
    ...(placeholder ? { titleAuto: true } : {}),
    id: sessionId,
    title,
    createdAt: Number(hasCreatedAt ? current.createdAt : timestamp) || timestamp,
    updatedAt: Number(hasUpdatedAt ? current.updatedAt : timestamp) || timestamp,
    size: hasSize ? Number(current.size) || 0 : String(text || "").length,
    hash: String(current.hash || documentHash(text))
  };
}

const CATALOG_META_KEYS = [
  "title",
  "createdAt",
  "updatedAt",
  "size",
  "hash",
  "titleAuto",
  "autoRenameChatTriggeredAt",
  "tags",
  "path",
  "displayPath",
  "language",
  "kind"
];
// Select only summaries from PostgreSQL; annotations and previews can be
// much larger than the document and must not cross the startup/search path.
// Decode large toasted metadata once. Repeated -> extraction decompresses the
// annotation-bearing JSONB for each summary field.
const CATALOG_META_JOIN_SQL = `LEFT JOIN LATERAL jsonb_to_record(m.meta_json)
  AS summary(${CATALOG_META_KEYS.map(key => `"${key}" jsonb`).join(", ")}) ON TRUE`;
const CATALOG_META_SQL = "jsonb_strip_nulls(to_jsonb(summary))";

function catalogSessionMeta(sessionId, meta = {}) {
  const current = isObject(meta) ? meta : {};
  const out = { id: sessionId };
  for (const key of CATALOG_META_KEYS) {
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      out[key] = clone(current[key]);
    }
  }
  out.title = String(out.title || current.title || sessionId).trim() || sessionId;
  out.createdAt = Number(out.createdAt || current.createdAt || 0) || 0;
  out.updatedAt = Number(out.updatedAt || current.updatedAt || 0) || 0;
  out.size = Number(out.size || current.size || 0) || 0;
  out.hash = String(out.hash || current.hash || "");
  if (Array.isArray(out.tags)) {
    out.tags = out.tags.map(String).filter(Boolean);
  } else {
    delete out.tags;
  }
  return out;
}

function isFolderNode(node) {
  return !!node && node.type === "folder";
}

function isSessionNode(node) {
  return !!node && node.type === "session";
}

function findNodeAndParent(root, id) {
  let found = null;
  let parent = null;
  const target = String(id || "");
  const visit = (node, candidateParent) => {
    if (!node || found) return;
    if (String(node.id || "") === target) {
      found = node;
      parent = candidateParent;
      return;
    }
    if (isFolderNode(node) && Array.isArray(node.children)) {
      for (const child of node.children) visit(child, node);
    }
  };
  visit(root, null);
  return { node: found, parent };
}

function removeSessionNode(tree, sessionId) {
  const id = String(sessionId || "");
  if (!id || !isFolderNode(tree)) return false;
  const visit = (node) => {
    if (!isFolderNode(node) || !Array.isArray(node.children)) return false;
    const before = node.children.length;
    node.children = node.children.filter((child) =>
      !(isSessionNode(child) && String(child.id || "") === id)
    );
    if (node.children.length !== before) return true;
    return node.children.some((child) => visit(child));
  };
  return visit(tree);
}

function upsertSessionNode(tree, sessionId, {
  parentId = "root",
  title = ""
} = {}) {
  const root = isObject(tree) ? clone(tree, defaultTree()) : defaultTree();
  if (!Array.isArray(root.children)) root.children = [];
  removeSessionNode(root, sessionId);
  const target = String(parentId || "root").trim() || "root";
  const found = findNodeAndParent(root, target);
  const parent = isFolderNode(found.node) ? found.node : root;
  parent.children = Array.isArray(parent.children) ? parent.children : [];
  parent.children.unshift({
    id: sessionId,
    type: "session",
    title: String(title || sessionId)
  });
  return root;
}

function updateSessionNodeTitle(tree, sessionId, title) {
  const root = isObject(tree) ? clone(tree, defaultTree()) : defaultTree();
  const found = findNodeAndParent(root, sessionId);
  if (isSessionNode(found.node)) {
    found.node.title = String(title || sessionId);
    return { tree: root, found: true };
  }
  return { tree: root, found: false };
}

function appendMissingSessionsToTree(tree, sessions) {
  const root = isObject(tree) ? clone(tree, defaultTree()) : defaultTree();
  if (!Array.isArray(root.children)) root.children = [];
  const existing = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "session" && node.id) existing.add(String(node.id));
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child);
  };
  visit(root);
  for (const session of sessions) {
    if (!session.id || existing.has(session.id)) continue;
    root.children.push({
      id: session.id,
      type: "session",
      title: String(session.title || session.id)
    });
    existing.add(session.id);
  }
  return root;
}

function eventFromRow(row) {
  return row && {
    sequence: Number(row.sequence),
    type: String(row.type),
    sessionId: row.session_id || null,
    runId: row.run_id || null,
    revision: row.revision || null,
    sessionRevision: row.session_revision == null
      ? null
      : Number(row.session_revision),
    sourceClientId: row.source_client_id || null,
    data: jsonValue(row.payload_json, {}),
    createdAt: Number(row.created_at)
  };
}

export class PostgresWorkbenchStateStore {
  backend = "postgres";
  collaborationUpdates = true;

  constructor(pool, { spaceId, now = nowMs } = {}) {
    if (!pool?.query || !pool?.connect) {
      throw new Error("PostgreSQL Workbench state store requires a Pool");
    }
    if (!spaceId) throw new Error("PostgreSQL Workbench state store requires a Space ID");
    this.pool = pool;
    this.spaceId = String(spaceId);
    this.now = now;
    this.eventListeners = new Set();
  }

  async initialize() {
    await this.ensureState();
    await this.pruneEvents();
    return this;
  }

  async transaction(action, { client: externalClient, afterCommit } = {}) {
    if (externalClient) {
      if (!Array.isArray(afterCommit)) throw new Error("External Workbench transactions require an after-commit queue");
      const published = [];
      await this.ensureStateExists(this.now(), externalClient);
      await externalClient.query(
        "SELECT revision FROM runtime_workbench_state WHERE space_id = $1 FOR UPDATE", [this.spaceId]);
      const result = await action(externalClient, published, afterCommit);
      afterCommit.push(() => { for (const event of published) this.publish(event); });
      return result;
    }
    const client = await measureRequestStage("db_pool", () => this.pool.connect());
    const published = [];
    const committed = [];
    try {
      await client.query("BEGIN");
      await measureRequestStage("db_setup", () => this.ensureStateExists(this.now(), client));
      await measureRequestStage("db_lock", () => client.query(
        "SELECT revision FROM runtime_workbench_state WHERE space_id = $1 FOR UPDATE",
        [this.spaceId]
      ));
      const result = await measureRequestStage("db_work", () => action(client, published, committed));
      await measureRequestStage("db_commit", () => client.query("COMMIT"));
      for (const callback of committed) callback();
      for (const event of published) this.publish(event);
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      for (const callback of committed) callback.rollback?.();
      throw error;
    } finally {
      client.release();
    }
  }

  async consistentRead(action) {
    await this.ensureStateExists();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
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

  publish(event) {
    queueMicrotask(() => {
      for (const listener of this.eventListeners) {
        try {
          const result = listener(event);
          Promise.resolve(result).catch(() => {});
        } catch {}
      }
    });
  }

  async state(client = this.pool) {
    const result = await client.query(
      `SELECT version, revision, tree_json, index_json, updated_at
       FROM runtime_workbench_state WHERE space_id = $1`,
      [this.spaceId]
    );
    return result.rows[0] || null;
  }

  async ensureStateExists(timestamp = this.now(), client = this.pool) {
    await client.query(
      `INSERT INTO runtime_workbench_state
       (space_id, version, revision, tree_json, index_json, updated_at)
       VALUES ($1, 1, 0, $2::jsonb, '[]'::jsonb, $3)
       ON CONFLICT (space_id) DO NOTHING`,
      [this.spaceId, JSON.stringify(defaultTree()), timestamp]
    );
  }

  async ensureState(timestamp = this.now(), client = this.pool) {
    await this.ensureStateExists(timestamp, client);
    return this.state(client);
  }

  async revision(client = this.pool) {
    const result = await client.query(
      "SELECT revision FROM runtime_workbench_state WHERE space_id = $1", [this.spaceId]
    );
    const row = result.rows[0];
    return row ? `runtime:${Number(row.revision)}` : null;
  }

  async bumpRevision(client, timestamp = this.now(), patch = {}) {
    await this.ensureStateExists(timestamp, client);
    // KV updates need only the sequence number. Preserve untouched JSON columns
    // in PostgreSQL rather than loading and rewriting the entire session catalog.
    const values = [timestamp, this.spaceId];
    const updates = ["revision = revision + 1", "updated_at = $1"];
    for (const [key, column, encode, cast] of [
      ["version", "version", Number, ""],
      ["tree", "tree_json", JSON.stringify, "::jsonb"],
      ["index", "index_json", JSON.stringify, "::jsonb"]
    ]) {
      if (patch[key] == null) continue;
      values.push(encode(patch[key]));
      updates.push(`${column} = $${values.length}${cast}`);
    }
    const result = await client.query(
      `UPDATE runtime_workbench_state
       SET ${updates.join(", ")}
       WHERE space_id = $2
       RETURNING revision`,
      values
    );
    return `runtime:${Number(result.rows[0].revision)}`;
  }

  async currentSession(sessionId, client = this.pool, { cardView = "full" } = {}) {
    const result = await client.query(
      `SELECT d.text, m.meta_json, h.revision, h.updated_at, h.content_hash
       FROM (SELECT $2::text AS id) input
       LEFT JOIN runtime_workbench_documents d
         ON d.space_id = $1 AND d.id = input.id
       LEFT JOIN runtime_workbench_metadata m
         ON m.space_id = $1 AND m.id = input.id
       LEFT JOIN runtime_workbench_session_heads h
         ON h.space_id = $1 AND h.id = input.id`,
      [this.spaceId, sessionId]
    );
    const row = result.rows[0] || {};
    const meta = await hydrateSessionCardMetadata(client, this.spaceId, sessionId, jsonValue(row.meta_json, {}),
      { onlyExpanded: cardView === "render" });
    let computedContentHash = row.content_hash;
    if (!computedContentHash && (row.text != null || row.meta_json != null)) {
      const fullMeta = cardView === "render"
        ? await hydrateSessionCardMetadata(client, this.spaceId, sessionId, jsonValue(row.meta_json, {}))
        : meta;
      // Without a head, reconstruct the original complete JSONB key order.
      // Reference hydration must not change hashes or hash only a card view.
      const hashMeta = (await client.query("SELECT $1::jsonb AS meta",
        [JSON.stringify(fullMeta)])).rows[0].meta;
      computedContentHash = contentHash(row.text, hashMeta);
    }
    return {
      exists: row.text != null || row.meta_json != null,
      text: String(row.text || ""),
      meta,
      revision: Number(row.revision || 0),
      contentHash: computedContentHash,
      updatedAt: Number(row.updated_at || 0)
    };
  }

  async projectRevisionMeta(meta, timestamp, client) {
    const projected = clone(await prepareSessionCardMetadata(
      client, this.spaceId, meta.id, meta, timestamp), {});
    if (!Object.prototype.hasOwnProperty.call(projected, "annotations")) {
      return projected;
    }
    const annotationsJson = JSON.stringify(projected.annotations);
    const ref = createHash("sha256").update(annotationsJson).digest("hex");
    await client.query(
      `INSERT INTO runtime_workbench_revision_annotations
       (space_id, ref, annotations_json, byte_size, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (space_id, ref) DO NOTHING`,
      [
        this.spaceId,
        ref,
        annotationsJson,
        Buffer.byteLength(annotationsJson, "utf8"),
        timestamp
      ]
    );
    projected[REVISION_ANNOTATIONS_KEY] = {
      ref,
      tools: Array.isArray(projected.annotations?.tools)
        ? projected.annotations.tools.length
        : 0,
      thinking: Array.isArray(projected.annotations?.thinking)
        ? projected.annotations.thinking.length
        : 0
    };
    delete projected.annotations;
    return projected;
  }

  async hydrateRevisionMeta(meta, client = this.pool, sessionId = meta?.id) {
    const hydrated = clone(meta, {});
    const reference = hydrated[REVISION_ANNOTATIONS_KEY];
    delete hydrated[REVISION_ANNOTATIONS_KEY];
    const ref = String(reference?.ref || "");
    if (!ref) return hydrateSessionCardMetadata(client, this.spaceId, sessionId, hydrated);
    const result = await client.query(
      `SELECT annotations_json FROM runtime_workbench_revision_annotations
       WHERE space_id = $1 AND ref = $2`,
      [this.spaceId, ref]
    );
    if (result.rows[0]) {
      hydrated.annotations = jsonValue(result.rows[0].annotations_json, {});
    }
    return hydrateSessionCardMetadata(client, this.spaceId, sessionId, hydrated);
  }

  async shouldSnapshotSessionRevision(
    sessionId,
    session,
    reason,
    timestamp,
    { sourceClientId = "" } = {},
    client = this.pool
  ) {
    if (["create", "delete", "restore", "snapshot-merge"].includes(reason)) return true;
    if (reason === "update" && !String(sourceClientId || "")) return true;
    const result = await client.query(
      `SELECT text, content_hash, created_at
       FROM runtime_workbench_session_revisions
       WHERE space_id = $1 AND session_id = $2
       ORDER BY revision DESC LIMIT 1`,
      [this.spaceId, sessionId]
    );
    const previous = result.rows[0];
    if (!previous) return true;
    const hash = contentHash(session.text, session.meta);
    if (previous.content_hash === hash) return false;
    if (timestamp - Number(previous.created_at || 0) >= REVISION_SNAPSHOT_INTERVAL_MS) {
      return true;
    }
    return Math.abs(
      Buffer.byteLength(String(session.text || ""), "utf8")
      - Buffer.byteLength(String(previous.text || ""), "utf8")
    ) >= REVISION_SNAPSHOT_TEXT_DELTA_BYTES;
  }

  async saveSessionRevision(...args) {
    return measureRequestStage("db_history", () => this.writeSessionRevision(...args));
  }

  async writeSessionRevision(
    sessionId,
    session,
    revision,
    reason,
    operationId,
    timestamp,
    { snapshot = true } = {},
    client = this.pool
  ) {
    const hash = contentHash(session.text, session.meta);
    if (snapshot) {
      const revisionMeta = await this.projectRevisionMeta(session.meta, timestamp, client);
      await client.query(
        `INSERT INTO runtime_workbench_session_revisions
         (space_id, session_id, revision, text, meta_json, content_hash,
          reason, operation_id, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
         ON CONFLICT (space_id, session_id, revision) DO NOTHING`,
        [
          this.spaceId,
          sessionId,
          revision,
          session.text,
          JSON.stringify(revisionMeta),
          hash,
          reason,
          operationId || null,
          timestamp
        ]
      );
    }
    await client.query(
      `INSERT INTO runtime_workbench_session_heads
       (space_id, id, revision, content_hash, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (space_id, id) DO UPDATE SET
         revision = EXCLUDED.revision,
         content_hash = EXCLUDED.content_hash,
         updated_at = EXCLUDED.updated_at`,
      [this.spaceId, sessionId, revision, hash, timestamp]
    );
    if (snapshot) await this.pruneSessionRevisions(sessionId, client);
    return hash;
  }

  async checkpointSessionRevision(sessionId, {
    reason = "checkpoint",
    force = false,
    timestamp = this.now()
  } = {}, transactionOptions) {
    const id = normalizeId(sessionId);
    return this.transaction(async (client) => {
      const session = await this.currentSession(id, client);
      if (!session.exists) return { saved: false, reason: "session_not_found" };
      const snapshot = force || await this.shouldSnapshotSessionRevision(
        id,
        session,
        String(reason || "checkpoint"),
        timestamp,
        {},
        client
      );
      if (!snapshot) return { saved: false, reason: "snapshot_not_due" };
      await this.saveSessionRevision(
        id,
        session,
        session.revision,
        String(reason || "checkpoint"),
        null,
        timestamp,
        { snapshot: true },
        client
      );
      return { saved: true, revision: session.revision };
    }, transactionOptions);
  }

  async recordEvent(type, {
    sessionId = "",
    runId = "",
    revision = null,
    sessionRevision = null,
    sourceClientId = "",
    payload = {},
    timestamp = this.now()
  } = {}, client = this.pool, published = null) {
    const resolvedRevision = revision ?? await this.revision(client);
    const result = await client.query(
      `INSERT INTO runtime_workbench_events
       (space_id, type, session_id, run_id, revision, session_revision,
        source_client_id, payload_json, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING sequence, type, session_id, run_id, revision, session_revision,
         source_client_id, payload_json, created_at`,
      [
        this.spaceId,
        normalizeId(type, "event type"),
        String(sessionId || "") || null,
        String(runId || "") || null,
        String(resolvedRevision || "") || null,
        Number.isFinite(Number(sessionRevision)) ? Number(sessionRevision) : null,
        String(sourceClientId || "") || null,
        JSON.stringify(isObject(payload) ? payload : {}),
        Number(timestamp) || this.now()
      ]
    );
    const event = eventFromRow(result.rows[0]);
    if (event) {
      if (published) published.push(event);
      else this.publish(event);
    }
    return event;
  }

  async appendEvent(type, input = {}, transactionOptions) {
    return this.transaction(async (client, published) =>
      this.recordEvent(type, input, client, published), transactionOptions);
  }

  async readEvent(sequence, client = this.pool) {
    const result = await client.query(
      `SELECT sequence, type, session_id, run_id, revision, session_revision,
        source_client_id, payload_json, created_at
       FROM runtime_workbench_events
       WHERE space_id = $1 AND sequence = $2`,
      [this.spaceId, Number(sequence)]
    );
    return eventFromRow(result.rows[0]);
  }

  async listEvents(afterSequence = 0, {
    limit = 500,
    sessionId = ""
  } = {}) {
    const after = Math.max(0, Number(afterSequence) || 0);
    const boundedLimit = Math.max(1, Math.min(2_000, Number(limit) || 500));
    const targetSessionId = String(sessionId || "").trim();
    const result = await this.pool.query(
      `SELECT sequence, type, session_id, run_id, revision, session_revision,
        source_client_id, payload_json, created_at
       FROM runtime_workbench_events
       WHERE space_id = $1 AND sequence > $2
         AND ($3::text = '' OR session_id = $3 OR session_id IS NULL)
       ORDER BY sequence ASC LIMIT $4`,
      [this.spaceId, after, targetSessionId, boundedLimit]
    );
    const bounds = await this.eventBounds();
    return {
      events: result.rows.map(eventFromRow),
      oldestSequence: bounds.oldestSequence,
      latestSequence: bounds.latestSequence,
      resetRequired: after > 0
        && bounds.oldestSequence > 0
        && after < bounds.oldestSequence - 1
    };
  }

  async eventBounds(client = this.pool) {
    const result = await client.query(
      `SELECT MIN(sequence) AS oldest_sequence, MAX(sequence) AS latest_sequence
       FROM runtime_workbench_events WHERE space_id = $1`,
      [this.spaceId]
    );
    return {
      oldestSequence: Number(result.rows[0]?.oldest_sequence || 0),
      latestSequence: Number(result.rows[0]?.latest_sequence || 0)
    };
  }

  subscribeEvents(listener) {
    if (typeof listener !== "function") {
      throw new Error("Workbench event listener must be a function");
    }
    this.eventListeners.add(listener);
    return { dispose: () => this.eventListeners.delete(listener) };
  }

  async pruneEvents(client = this.pool) {
    const result = await client.query(
      `WITH stale AS (
         SELECT sequence FROM runtime_workbench_events
         WHERE space_id = $1
         ORDER BY sequence DESC
         OFFSET $2
       )
       DELETE FROM runtime_workbench_events target
       USING stale
       WHERE target.space_id = $1 AND target.sequence = stale.sequence`,
      [this.spaceId, MAX_WORKBENCH_EVENTS]
    );
    return Number(result.rowCount || 0);
  }

  async readCollaborationDocument(sessionId, client = this.pool) {
    const id = normalizeId(sessionId);
    const result = await client.query(
      collaborationStateSelect,
      [this.spaceId, id]
    );
    const row = result.rows[0];
    return row ? {
      sessionId: id,
      state: readCollaborationState(row),
      stateHash: row.state_hash,
      version: Number(row.version),
      updatedAt: Number(row.updated_at)
    } : null;
  }

  async prepareRunCardBodies(sessionId, { document, projector, ...input }, { client } = {}) {
    if (!client) return this.transaction(db => this.prepareRunCardBodies(sessionId,
      { document, projector, ...input }, { client: db }));
    const originalPlan = projector.planCards({ document, ...input });
    if (!originalPlan.cards.size) return null;
    const snapshot = () => JSON.stringify([
      document.getMap("runProjection").get(input.runId),
      [...originalPlan.originals.keys()].map(id => [id, document.getMap("cards").get(id)])
    ]);
    const captured = snapshot();
    const capturedCards = new Map([...originalPlan.originals].map(([id, card]) =>
      [id, card && typeof card === "object" ? JSON.parse(JSON.stringify(card)) : card]));
    const mode = await sessionCardStorageMode(client);
    const full = new Map(capturedCards), referenced = [];
    for (const [id, card] of capturedCards) {
      if (card?.bodyRef) referenced.push({ kind: card.kind === "tool" ? "tools" : "thinking", card });
    }
    const predecessorBodies = referenced.length === 1
      ? [await readSessionCardBody(client, this.spaceId, sessionId, referenced[0].kind, referenced[0].card)]
      : await readSessionCardBodies(client, this.spaceId, sessionId, referenced);
    for (const [index, { card }] of referenced.entries()) {
      full.set(card.id, hydratedSessionCard(card, predecessorBodies[index]));
    }
    if (snapshot() !== captured) throw Object.assign(new Error("Card projection changed during body hydration"),
      { code: "collaboration_projection_changed", statusCode: 409 });
    const plan = projector.planCards({ document, ...input, readCard: id => full.get(id) });
    const originals = new Map([...plan.originals].map(([id, value]) => [id, JSON.stringify(value)]));
    const originalProjection = JSON.stringify(plan.originalProjection);
    const plannedCards = [...plan.cards.values()];
    const preparedCards = await prepareSessionCardBodies(client, this.spaceId, sessionId,
      plannedCards.map(card => ({ kind: card.kind === "tool" ? "tools" : "thinking", card })), this.now(), mode);
    const prepared = new Map(plannedCards.map((card, index) => [card.id, preparedCards[index].card]));
    return {
      assertCurrent(target) {
        if (JSON.stringify(target.getMap("runProjection").get(input.runId)) !== originalProjection
          || [...originals].some(([id, value]) => JSON.stringify(target.getMap("cards").get(id)) !== value)) {
          throw Object.assign(new Error("Card projection changed during body preparation"),
            { code: "collaboration_projection_changed", statusCode: 409 });
        }
      },
      readCard: id => full.get(id),
      prepareCard(card) {
        if (!prepared.has(card.id)) throw new Error("Card body preparation is missing");
        return prepared.get(card.id);
      }
    };
  }

  async writeCollaborationDocument(sessionId, state, {
    text,
    replaceSnapshot = false,
    expectedVersion,
    sourceClientId = "",
    timestamp = this.now(),
    emitEvent = true
  } = {}, transactionOptions) {
    const id = normalizeId(sessionId);
    const bytes = Buffer.from(state || []);
    if (!bytes.length) throw new Error("collaboration document state required");
    let mergedDocument;
    const cacheKey = collaborationCacheKey(this.pool, this.spaceId, id);
    return this.transaction(async (client, published, committed) => {
      const mode = (await client.query(
        "SELECT mode FROM runtime_collaboration_storage_mode WHERE id='global' FOR SHARE"
      )).rows[0]?.mode;
      if (!mode) throw new Error("Collaboration storage mode is missing");
      const existingResult = await client.query(
        collaborationStateSelect + " FOR UPDATE OF d",
        [this.spaceId, id]
      );
      const existing = existingResult.rows[0];
      const current = await this.currentSession(id, client);
      if (!current.exists) {
        const tombstone = await this.readSession(id, client);
        if (tombstone?.deleted) return {
          ok: true, skipped: true, deleted: true, sessionId: id,
          session_revision: tombstone.session_revision
        };
      }
      if (replaceSnapshot && (
        !Number.isSafeInteger(expectedVersion)
        || expectedVersion !== Number(existing?.version || 0)
        || String(text || "") !== String(current.text || "")
      )) throw Object.assign(new Error("Collaboration snapshot changed during bootstrap"),
        { code: "collaboration_snapshot_changed", statusCode: 409 });
      // Validate and exclusively take the accepted owner even for replacement.
      mergedDocument = acquireCollaborationDocument(existing, { key: cacheKey });
      if (replaceSnapshot) {
        mergedDocument.destroy();
        mergedDocument = new Y.Doc();
      }
      Y.applyUpdate(mergedDocument, bytes);
      assertCollaborationUpdateIntegrated(mergedDocument, bytes);
      const cardMode = await sessionCardStorageMode(client);
      let normalizedBodies = false;
      const cardEntries = [];
      for (const [key, card] of mergedDocument.getMap("cards")) {
        if (!card || typeof card !== "object") continue;
        if (card.bodyRef != null && key !== card.id) throw Object.assign(new Error("Card body identity does not match its key"),
          { statusCode: 403, code: "CARD_BODY_SCOPE_MISMATCH" });
        const kind = card.kind === "tool" ? "tools" : card.kind === "thinking" ? "thinking" : null;
        if (!kind) {
          if (card.bodyRef != null) throw Object.assign(new Error("Invalid referenced card kind"),
            { statusCode: 403, code: "CARD_BODY_SCOPE_MISMATCH" });
          continue;
        }
        // Legacy inline maps need not repeat their key inside each value.
        // Only a complete matching identity can acquire a durable reference.
        if (key !== card.id) continue;
        cardEntries.push({ key, kind, card });
      }
      const preparedCards = await prepareSessionCardBodies(client, this.spaceId, id, cardEntries, timestamp, cardMode);
      for (const [index, { key, card }] of cardEntries.entries()) {
        const prepared = preparedCards[index];
        if (JSON.stringify(prepared.card) !== JSON.stringify(card)) {
          mergedDocument.getMap("cards").set(key, prepared.card);
          normalizedBodies = true;
        }
      }
      const merged = Buffer.from(Y.encodeStateAsUpdate(mergedDocument));
      const stateHash = collaborationUpdateHash(merged);
      const mergedText = mergedDocument.getText("content").toString();
      const nextText = text == null ? null : mergedText;
      await transactionOptions?.validateCollaborationText?.(mergedText);
      const returnToCache = (version, storedRow) => {
        const document = mergedDocument;
        const callback = () => collaborationDocumentCache.put(cacheKey, document,
          { version, stateHash, storageHash: collaborationStorageHash(storedRow), bytes: merged.length });
        callback.rollback = () => document.destroy();
        committed.push(callback);
        mergedDocument = null;
      };
      if (
        existing?.state_hash === stateHash
        && (nextText == null || current.text === nextText)
        && !(mode === "snapshot" && existing.base_version != null)
      ) {
        returnToCache(Number(existing.version), existing);
        return {
          ok: true,
          duplicate: true,
          sessionId: id,
          stateHash,
          version: Number(existing.version),
          state: new Uint8Array(merged)
        };
      }
      const version = Number(existing?.version || 0) + 1;
      const count = Number(existing?.update_count || 0) + 1;
      const updateBytes = Number(existing?.update_bytes || 0) + bytes.length;
      const compact = !existing || replaceSnapshot || mode === "snapshot" || normalizedBodies
        || count >= COLLABORATION_LOG_MAX_ROWS || updateBytes > COLLABORATION_LOG_MAX_BYTES;
      if (compact) {
        await client.query("DELETE FROM runtime_collaboration_updates WHERE space_id=$1 AND session_id=$2",
          [this.spaceId, id]);
        await client.query(
        `INSERT INTO runtime_collaboration_documents
         (space_id, session_id, state_blob, state_hash, version, updated_at,
          base_version, base_hash, update_count, update_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0)
         ON CONFLICT (space_id, session_id) DO UPDATE SET
           state_blob = EXCLUDED.state_blob,
           state_hash = EXCLUDED.state_hash,
           version = EXCLUDED.version,
           updated_at = EXCLUDED.updated_at,
           base_version=EXCLUDED.base_version, base_hash=EXCLUDED.base_hash,
           update_count=0, update_bytes=0`,
        [this.spaceId, id, merged, stateHash, version, timestamp,
          mode === "snapshot" ? null : version, mode === "snapshot" ? null : stateHash]);
      } else {
        await client.query(`UPDATE runtime_collaboration_documents SET
          base_version=COALESCE(base_version,version), base_hash=COALESCE(base_hash,state_hash),
          version=$3, state_hash=$4, updated_at=$5, update_count=$6, update_bytes=$7
          WHERE space_id=$1 AND session_id=$2`,
        [this.spaceId, id, version, stateHash, timestamp, count, updateBytes]);
        await client.query(`INSERT INTO runtime_collaboration_updates
          (space_id,session_id,version,update_blob,update_hash,created_at)
          VALUES($1,$2,$3,$4,$5,$6)`,
        [this.spaceId, id, version, bytes, collaborationUpdateHash(bytes), timestamp]);
      }

      let sessionRevision = current.revision;
      let revision = await this.revision(client);
      // An empty collaboration handshake has no session metadata. Keep its
      // Yjs state without racing the creator's first document/metadata save.
      if (nextText != null && (current.exists ? current.text !== nextText : nextText.length > 0)) {
        if (!current.exists) {
          const sessionResult = await this.updateSessionInTransaction(id, {
            text: nextText,
            reason: "collaboration",
            source_client_id: sourceClientId
          }, client, published);
          sessionRevision = sessionResult.session_revision;
          revision = sessionResult.revision;
        } else {
          const metaCandidate = { ...current.meta };
          delete metaCandidate.size;
          delete metaCandidate.hash;
          delete metaCandidate.updatedAt;
          const nextMeta = normalizeSessionMeta(
            id,
            nextText,
            metaCandidate,
            timestamp
          );
          await this.writeSessionRows(id, nextText, nextMeta, timestamp, client);
          sessionRevision = current.revision + 1;
          await this.saveSessionRevision(
            id,
            { text: nextText, meta: nextMeta },
            sessionRevision,
            "collaboration",
            null,
            timestamp,
            { snapshot: false },
            client
          );
          const tree = await this.stateTree(client);
          await client.query(
            `UPDATE runtime_workbench_state
             SET index_json = $1::jsonb, updated_at = $2
             WHERE space_id = $3`,
            [
              JSON.stringify(await this.updateSessionIndex(tree, id, this.sessionIndexEntry(id, nextMeta, nextText), client)),
              timestamp,
              this.spaceId
            ]
          );
        }
      }
      const event = emitEvent
        ? await this.recordEvent("collaboration.updated", {
            sessionId: id,
            revision,
            sessionRevision,
            sourceClientId,
            payload: { version, stateHash },
            timestamp
          }, client, published)
        : null;
      returnToCache(version, compact ? {
        version, state_hash: stateHash, updates: []
      } : {
        base_version: existing.base_version ?? existing.version,
        base_hash: existing.base_hash ?? existing.state_hash,
        updates: [...(existing.updates || []), { version, hash: collaborationUpdateHash(bytes) }]
      });
      return {
        ok: true,
        sessionId: id,
        stateHash,
        version,
        state: new Uint8Array(merged),
        storage: { compacted: compact, updateRows: compact ? 0 : count,
          updateBytes: compact ? 0 : updateBytes, writtenStateBytes: compact ? merged.length : bytes.length },
        session_revision: sessionRevision,
        event_sequence: event?.sequence ?? 0
      };
    }, transactionOptions).catch(error => {
      mergedDocument?.destroy();
      throw error;
    });
  }

  async deleteCollaborationDocument(sessionId) {
    const result = await this.pool.query(
      `DELETE FROM runtime_collaboration_documents
       WHERE space_id = $1 AND session_id = $2`,
      [this.spaceId, normalizeId(sessionId)]
    );
    return result.rowCount > 0;
  }

  async pruneSessionRevisions(sessionId = "", client = this.pool) {
    const id = String(sessionId || "").trim();
    const result = await client.query(
      `WITH ranked AS (
         SELECT session_id, revision,
           ROW_NUMBER() OVER (
             PARTITION BY session_id ORDER BY revision DESC
           ) AS revision_rank,
           SUM(octet_length(text) + pg_column_size(meta_json)) OVER (
             PARTITION BY session_id ORDER BY revision DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS retained_bytes
         FROM runtime_workbench_session_revisions
         WHERE space_id = $1 AND ($2::text = '' OR session_id = $2)
       ), stale AS (
         SELECT session_id, revision FROM ranked
         WHERE revision_rank > $3
           OR (revision_rank > 1 AND retained_bytes > $4)
       )
       DELETE FROM runtime_workbench_session_revisions target
       USING stale
       WHERE target.space_id = $1
         AND target.session_id = stale.session_id
         AND target.revision = stale.revision
       RETURNING target.meta_json->'${REVISION_ANNOTATIONS_KEY}'->>'ref' AS annotation_ref`,
      [this.spaceId, id, MAX_SESSION_REVISIONS, MAX_SESSION_REVISION_BYTES]
    );
    const refs = [...new Set(result.rows.map(row => row.annotation_ref).filter(Boolean))];
    if (refs.length) await this.pruneRevisionAnnotations(client, refs);
    return Number(result.rowCount || 0);
  }

  async pruneRevisionAnnotations(client = this.pool, refs = null) {
    const result = await client.query(
      `DELETE FROM runtime_workbench_revision_annotations annotations
       WHERE annotations.space_id = $1
         AND ($2::text[] IS NULL OR annotations.ref = ANY($2))
         AND NOT EXISTS (
           SELECT 1 FROM runtime_workbench_session_revisions revisions
           WHERE revisions.space_id = $1
             AND revisions.meta_json->'${REVISION_ANNOTATIONS_KEY}'->>'ref'
               = annotations.ref
         )`,
      [this.spaceId, refs]
    );
    return Number(result.rowCount || 0);
  }

  async runStorageMaintenanceBatch() {
    return {
      complete: true,
      annotations: { complete: true, rewrittenRows: 0 },
      revisions: { complete: true, deletedRows: 0 }
    };
  }

  async recordOperation(
    operationId,
    sessionId,
    sessionRevision,
    result,
    timestamp,
    client = this.pool
  ) {
    if (!operationId) return;
    await client.query(
      `INSERT INTO runtime_workbench_operations
       (space_id, operation_id, session_id, session_revision, result_json, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (space_id, operation_id) DO NOTHING`,
      [
        this.spaceId,
        operationId,
        sessionId,
        sessionRevision,
        JSON.stringify(result),
        timestamp
      ]
    );
  }

  async duplicateOperation(operationId, client = this.pool) {
    if (!operationId) return null;
    const result = await client.query(
      `SELECT result_json FROM runtime_workbench_operations
       WHERE space_id = $1 AND operation_id = $2`,
      [this.spaceId, operationId]
    );
    return result.rows[0]
      ? { ...jsonValue(result.rows[0].result_json, {}), duplicate: true }
      : null;
  }

  sessionIndexEntry(sessionId, meta, text = "") {
    const id = String(sessionId || "");
    const safeMeta = isObject(meta) ? meta : {};
    return {
      id,
      title: String(safeMeta.title || id),
      updatedAt: Number(safeMeta.updatedAt || 0),
      size: Number(safeMeta.size || String(text || "").length || 0),
      hash: String(safeMeta.hash || documentHash(text)),
      createdAt: Number(safeMeta.createdAt || 0)
    };
  }

  async listSessionIndexEntries(client = this.pool) {
    const result = await client.query(
      `SELECT d.id,
         CASE WHEN COALESCE(summary.hash #>> '{}', '') <> ''
           AND summary.size IS NOT NULL THEN '' ELSE d.text END AS text,
         ${CATALOG_META_SQL} AS meta_json
       FROM runtime_workbench_documents d
       LEFT JOIN runtime_workbench_metadata m
         ON m.space_id = d.space_id AND m.id = d.id
       ${CATALOG_META_JOIN_SQL}
       WHERE d.space_id = $1
       ORDER BY d.updated_at DESC, d.id`,
      [this.spaceId]
    );
    return result.rows.map((row) =>
      this.sessionIndexEntry(
        row.id,
        jsonValue(row.meta_json, {}),
        row.text
      )
    );
  }

  async completeTree(tree, client = this.pool) {
    return appendMissingSessionsToTree(
      tree,
      await this.listSessionIndexEntries(client)
    );
  }

  async rebuildIndexFromTree(tree, client = this.pool) {
    const root = isObject(tree) ? tree : defaultTree();
    const ids = [];
    const titles = new Map();
    const visit = (node) => {
      if (!node) return;
      if (isSessionNode(node)) {
        const id = String(node.id || "");
        if (id) {
          ids.push(id);
          titles.set(id, String(node.title || id));
        }
        return;
      }
      if (isFolderNode(node) && Array.isArray(node.children)) {
        for (const child of node.children) visit(child);
      }
    };
    visit(root);
    if (!ids.length) return [];
    const result = await client.query(
      `SELECT d.id,
         CASE WHEN COALESCE(summary.hash #>> '{}', '') <> ''
           AND summary.size IS NOT NULL THEN '' ELSE d.text END AS text,
         ${CATALOG_META_SQL} AS meta_json
       FROM runtime_workbench_documents d
       LEFT JOIN runtime_workbench_metadata m
         ON m.space_id = d.space_id AND m.id = d.id
       ${CATALOG_META_JOIN_SQL}
       WHERE d.space_id = $1 AND d.id = ANY($2::text[])`,
      [this.spaceId, ids]
    );
    const sessions = new Map(result.rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = sessions.get(id);
      if (!row) return [];
      const meta = jsonValue(row.meta_json, {});
      return [this.sessionIndexEntry(id, {
        ...meta,
        title: meta.title || titles.get(id) || id
      }, row.text)];
    });
  }

  async updateSessionIndex(...args) {
    return measureRequestStage("db_index", () => this.updateSessionIndexEntries(...args));
  }

  async updateSessionIndexEntries(tree, sessionId, entry, client) {
    // Single-session writes already hold the shared state lock. Its committed
    // index is authoritative; do not decompress every other session's metadata.
    const state = await this.state(client);
    const entries = new Map(jsonValue(state?.index_json, []).map(item => [String(item.id), item]));
    if (entry) entries.set(sessionId, entry);
    else entries.delete(sessionId);
    const index = [];
    let missing = false;
    const visit = node => {
      if (isSessionNode(node)) {
        const item = entries.get(String(node.id));
        if (item) index.push(item);
        else missing = true;
      }
      for (const child of node?.children || []) visit(child);
    };
    visit(tree);
    // Older imported state can lack summaries; repair it once on that path.
    return missing ? this.rebuildIndexFromTree(tree, client) : index;
  }

  async stateTree(client = this.pool) {
    const state = await this.ensureState(this.now(), client);
    return jsonValue(state.tree_json, defaultTree());
  }

  async writeSessionRows(id, text, meta, timestamp, client) {
    const storedMeta = await prepareSessionCardMetadata(client, this.spaceId, id, meta, timestamp);
    await client.query(
      `INSERT INTO runtime_workbench_documents (space_id, id, text, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (space_id, id) DO UPDATE SET
         text = EXCLUDED.text, updated_at = EXCLUDED.updated_at`,
      [this.spaceId, id, text, timestamp]
    );
    await client.query(
      `INSERT INTO runtime_workbench_metadata (space_id, id, meta_json, updated_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (space_id, id) DO UPDATE SET
         meta_json = EXCLUDED.meta_json, updated_at = EXCLUDED.updated_at`,
      [this.spaceId, id, JSON.stringify(storedMeta), timestamp]
    );
    await client.query(
      `DELETE FROM runtime_workbench_tombstones
       WHERE space_id = $1 AND id = $2`,
      [this.spaceId, id]
    );
  }

  async createSession(input = {}, transactionOptions) {
    return this.transaction(async (client, published) => {
      const duplicate = await this.duplicateOperation(input.operation_id, client);
      if (duplicate) return duplicate;
      const globalRevision = await this.revision(client);
      if (input.expected_revision != null && input.expected_revision !== globalRevision) {
        return { ok: false, conflict: true, revision: globalRevision };
      }
      const requestedId = String(input.id || "").trim();
      const id = requestedId || `session_${randomUUID()}`;
      const current = await this.currentSession(id, client);
      if (current.exists) {
        return {
          ok: false,
          conflict: true,
          reason: "session_exists",
          id,
          revision: globalRevision,
          session_revision: current.revision
        };
      }
      const timestamp = this.now();
      const text = String(input.text ?? input.doc ?? "");
      const baseMeta = isObject(input.meta) ? { ...input.meta } : {};
      if (input.title != null) baseMeta.title = String(input.title || "");
      const meta = normalizeSessionMeta(id, text, baseMeta, timestamp);
      await this.writeSessionRows(id, text, meta, timestamp, client);
      const sessionRevision = current.revision + 1;
      await this.saveSessionRevision(
        id,
        { text, meta },
        sessionRevision,
        String(input.reason || "create"),
        input.operation_id,
        timestamp,
        {},
        client
      );
      const tree = upsertSessionNode(await this.stateTree(client), id, {
        parentId: input.parent_id || input.parentId || "root",
        title: meta.title
      });
      const revision = await this.bumpRevision(client, timestamp, {
        tree,
        index: await this.updateSessionIndex(tree, id, this.sessionIndexEntry(id, meta, text), client)
      });
      const event = await this.recordEvent("session.created", {
        sessionId: id,
        revision,
        sessionRevision,
        sourceClientId: input.source_client_id,
        payload: {
          indexEntry: this.sessionIndexEntry(id, meta, text),
          parentId: String(input.parent_id || input.parentId || "root")
        },
        timestamp
      }, client, published);
      const result = {
        ok: true,
        id,
        revision,
        session_revision: sessionRevision,
        event_sequence: event.sequence
      };
      await this.recordOperation(
        input.operation_id,
        id,
        sessionRevision,
        result,
        timestamp,
        client
      );
      return result;
    }, transactionOptions);
  }

  async readSnapshot(client = this.pool) {
    if (client === this.pool) return this.consistentRead(tx => this.readSnapshot(tx));
    const state = await this.state(client);
    if (!state) return null;
    const [docs, metas, tombstones, kv, bounds] = await Promise.all([
      client.query(
        `SELECT d.id, d.text, COALESCE(h.revision, 0) AS session_revision,
           COALESCE(h.content_hash, '') AS content_hash
         FROM runtime_workbench_documents d
         LEFT JOIN runtime_workbench_session_heads h
           ON h.space_id = d.space_id AND h.id = d.id
         WHERE d.space_id = $1 ORDER BY d.id`,
        [this.spaceId]
      ),
      client.query(
        `SELECT id, meta_json FROM runtime_workbench_metadata
         WHERE space_id = $1 ORDER BY id`,
        [this.spaceId]
      ),
      client.query(
        `SELECT id, revision, deleted_at FROM runtime_workbench_tombstones
         WHERE space_id = $1 ORDER BY deleted_at`,
        [this.spaceId]
      ),
      client.query(
        `SELECT key, value_json FROM runtime_workbench_kv
         WHERE space_id = $1 ORDER BY key`,
        [this.spaceId]
      ),
      this.eventBounds(client)
    ]);
    const snapshot = {
      version: Number(state.version || 1),
      updatedAt: Number(state.updated_at || 0),
      tree: jsonValue(state.tree_json, defaultTree()),
      index: jsonValue(state.index_json, []),
      docs: docs.rows.map((row) => ({
        id: row.id,
        text: normalizeConversationTextForDisplay(row.text),
        session_revision: Number(row.session_revision || 0),
        content_hash: row.content_hash
      })),
      metas: await Promise.all(metas.rows.map(async (row) => ({
        id: row.id,
        meta: await hydrateSessionCardMetadata(client, this.spaceId, row.id, jsonValue(row.meta_json, {}))
      }))),
      tombstones: tombstones.rows.map((row) => ({
        id: row.id,
        revision: Number(row.revision),
        deletedAt: Number(row.deleted_at)
      })),
      kv: Object.fromEntries(kv.rows.map((row) => [
        row.key,
        jsonValue(row.value_json)
      ]))
    };
    return {
      snapshot,
      revision: `runtime:${Number(state.revision)}`,
      event_cursor: bounds.latestSequence,
      updated_at: snapshot.updatedAt
    };
  }

  async searchSessions({ query = "", limit = 50, offset = 0, allowedSessionIds = null } = {}) {
    const take = Math.min(100, Math.max(1, Math.floor(Number(limit) || 50)));
    const skip = Math.max(0, Math.floor(Number(offset) || 0));
    const term = String(query).trim().slice(0, 200);
    const result = await this.pool.query(
      `SELECT d.id, ${CATALOG_META_SQL} AS meta_json,
              substring(d.text FROM greatest(1, strpos(lower(d.text), lower($2)) - 80) FOR 240) AS snippet
       FROM runtime_workbench_documents d
       LEFT JOIN runtime_workbench_metadata m ON m.space_id = d.space_id AND m.id = d.id
       ${CATALOG_META_JOIN_SQL}
       WHERE d.space_id = $1 AND ($5::text[] IS NULL OR d.id=ANY($5)) AND ($2 = '' OR strpos(lower(d.text), lower($2)) > 0
         OR strpos(lower(COALESCE(summary.title #>> '{}', d.id)), lower($2)) > 0)
       ORDER BY d.updated_at DESC, d.id
       LIMIT $3 OFFSET $4`,
      [this.spaceId, term, take + 1, skip, allowedSessionIds]
    );
    return {
      sessions: result.rows.slice(0, take).map((row) => ({
        ...catalogSessionMeta(row.id, jsonValue(row.meta_json, {})),
        snippet: row.snippet || ""
      })),
      hasMore: result.rows.length > take,
      nextOffset: skip + take
    };
  }

  async readCatalog({ metadataLimit = null, view = "" } = {}, client = this.pool) {
    if (client === this.pool) return this.consistentRead(tx => this.readCatalog({ metadataLimit, view }, tx));
    const tree = await this.readTree(client);
    const take = metadataLimit == null ? null : Math.min(100, Math.max(1, Number(metadataLimit) || 100));
    const [sessions, metas, kv] = await Promise.all([
      client.query(
        `SELECT d.id, COALESCE(h.revision, 0) AS session_revision
         FROM runtime_workbench_documents d
         LEFT JOIN runtime_workbench_session_heads h
           ON h.space_id = d.space_id AND h.id = d.id
         WHERE d.space_id = $1 ORDER BY d.id`,
        [this.spaceId]
      ),
      client.query(
        `SELECT m.id, ${CATALOG_META_SQL} AS meta_json
         FROM runtime_workbench_metadata m
         ${CATALOG_META_JOIN_SQL}
         WHERE space_id = $1 ORDER BY id LIMIT $2`,
        [this.spaceId, take]
      ),
      client.query(
        `SELECT key, value_json FROM runtime_workbench_kv
         WHERE space_id = $1 AND key LIKE 'sessions.%' ORDER BY key`,
        [this.spaceId]
      )
    ]);
    return {
      ...(view === "compact"
        ? { revision: tree.revision, event_cursor: tree.event_cursor, updated_at: tree.updated_at }
        : tree),
      catalog: {
        metadataPartial: take != null,
        tree: tree.tree,
        index: tree.index,
        sessions: sessions.rows.map((row) => ({
          id: row.id,
          session_revision: Number(row.session_revision)
        })),
        metas: metas.rows.map((row) => ({
          id: row.id,
          meta: catalogSessionMeta(row.id, jsonValue(row.meta_json, {}))
        })),
        kv: Object.fromEntries(kv.rows.map((row) => [
          row.key,
          jsonValue(row.value_json)
        ]))
      }
    };
  }

  async readStatus() {
    const [state, bounds, counts] = await Promise.all([
      this.state(),
      this.eventBounds(),
      this.pool.query(
        `SELECT
           (SELECT COUNT(*) FROM runtime_workbench_documents WHERE space_id = $1) AS documents,
           (SELECT COUNT(*) FROM runtime_workbench_metadata WHERE space_id = $1) AS metadata`,
        [this.spaceId]
      )
    ]);
    return {
      ok: true,
      service: "zion-runtime",
      revision: state ? `runtime:${Number(state.revision)}` : null,
      event_cursor: bounds.latestSequence,
      updated_at: Number(state?.updated_at || 0),
      documents: Number(counts.rows[0]?.documents || 0),
      metadata: Number(counts.rows[0]?.metadata || 0)
    };
  }

  async readSessionMeta(sessionId, client = this.pool) {
    if (client === this.pool) return this.consistentRead(tx => this.readSessionMeta(sessionId, tx));
    const id = normalizeId(sessionId);
    const result = await client.query(
      `SELECT meta_json FROM runtime_workbench_metadata
       WHERE space_id = $1 AND id = $2`,
      [this.spaceId, id]
    );
    return result.rows[0]
      ? { ...await hydrateSessionCardMetadata(client, this.spaceId, id, jsonValue(result.rows[0].meta_json, {})), id }
      : null;
  }

  async readSessionMetadataRecord(sessionId, options = {}, client = this.pool) {
    if (client === this.pool) return this.consistentRead(tx => this.readSessionMetadataRecord(sessionId, options, tx));
    const id = normalizeId(sessionId);
    // One statement keeps metadata and its head paired without fetching d.text
    // (or detoasting the potentially multi-megabyte document).
    const result = await client.query(
      `SELECT m.meta_json, h.revision, h.updated_at, t.revision AS deleted_revision, t.deleted_at
       FROM (SELECT $2::text AS id) input
       LEFT JOIN runtime_workbench_metadata m ON m.space_id = $1 AND m.id = input.id
       LEFT JOIN runtime_workbench_session_heads h ON h.space_id = $1 AND h.id = input.id
       LEFT JOIN runtime_workbench_tombstones t ON t.space_id = $1 AND t.id = input.id`,
      [this.spaceId, id]
    );
    const row = result.rows[0] || {};
    if (row.meta_json != null) return {
      id, meta: { ...await hydrateSessionCardMetadata(client, this.spaceId, id, jsonValue(row.meta_json, {}),
        { onlyExpanded: options.cardView === "render" }), id },
      session_revision: Number(row.revision || 0),
      updated_at: Number(row.updated_at || 0)
    };
    return row.deleted_revision != null ? {
      id, deleted: true, session_revision: Number(row.deleted_revision),
      deleted_at: Number(row.deleted_at)
    } : null;
  }

  async readTree(client = this.pool) {
    if (client === this.pool) return this.consistentRead(tx => this.readTree(tx));
    const state = await this.state(client);
    const bounds = await this.eventBounds(client);
    return {
      tree: jsonValue(state.tree_json, defaultTree()),
      index: jsonValue(state.index_json, []),
      revision: `runtime:${Number(state.revision)}`,
      event_cursor: bounds.latestSequence,
      updated_at: Number(state.updated_at || 0)
    };
  }

  async writeSnapshot(snapshot, expectedRevision = null, sourceClientId = "", transactionOptions) {
    if (!isObject(snapshot)) throw new Error("snapshot must be an object");
    return this.transaction((client, published) =>
      this.writeSnapshotInTransaction(
        snapshot,
        expectedRevision,
        sourceClientId,
        client,
        published
      ), transactionOptions
    );
  }

  async writeSnapshotInTransaction(
    snapshot,
    expectedRevision,
    sourceClientId,
    client,
    published
  ) {
    const currentRevision = await this.revision(client);
    if (expectedRevision != null && expectedRevision !== currentRevision) {
      return {
        ok: false,
        conflict: true,
        revision: currentRevision,
        snapshot: (await this.readSnapshot(client))?.snapshot || null
      };
    }
    const timestamp = Number(snapshot.updatedAt) || this.now();
    const changedIds = new Set();
    for (const item of Array.isArray(snapshot.docs) ? snapshot.docs : []) {
      const id = normalizeId(item?.id);
      const text = String(item?.text || "");
      const previous = await this.currentSession(id, client);
      if (!previous.exists || previous.text !== text) changedIds.add(id);
      await client.query(
        `INSERT INTO runtime_workbench_documents (space_id, id, text, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (space_id, id) DO UPDATE SET
           text = EXCLUDED.text, updated_at = EXCLUDED.updated_at`,
        [this.spaceId, id, text, timestamp]
      );
    }
    for (const item of Array.isArray(snapshot.metas) ? snapshot.metas : []) {
      const id = normalizeId(item?.id);
      const submittedMeta = isObject(item?.meta) ? { ...item.meta, id } : { id };
      const meta = await prepareSessionCardMetadata(client, this.spaceId, id, submittedMeta, timestamp);
      const previous = await this.currentSession(id, client);
      const fullMeta = await hydrateSessionCardMetadata(client, this.spaceId, id, meta);
      if (!previous.exists || sessionMetadataChanges(previous.meta, fullMeta).length) {
        changedIds.add(id);
      }
      await client.query(
        `INSERT INTO runtime_workbench_metadata (space_id, id, meta_json, updated_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (space_id, id) DO UPDATE SET
           meta_json = EXCLUDED.meta_json, updated_at = EXCLUDED.updated_at`,
        [this.spaceId, id, JSON.stringify(meta), timestamp]
      );
    }
    for (const id of changedIds) {
      const session = await this.currentSession(id, client);
      await this.saveSessionRevision(
        id,
        session,
        session.revision + 1,
        "snapshot-merge",
        null,
        timestamp,
        {},
        client
      );
      await client.query(
        `DELETE FROM runtime_workbench_tombstones
         WHERE space_id = $1 AND id = $2`,
        [this.spaceId, id]
      );
    }
    for (const [key, value] of Object.entries(snapshot.kv || {})) {
      await client.query(
        `INSERT INTO runtime_workbench_kv (space_id, key, value_json, updated_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (space_id, key) DO UPDATE SET
           value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at`,
        [this.spaceId, key, JSON.stringify(value), timestamp]
      );
    }
    for (const item of Array.isArray(snapshot.tombstones) ? snapshot.tombstones : []) {
      const id = String(item?.id || "").trim();
      if (!id || (await this.currentSession(id, client)).exists) continue;
      const revision = Math.max(1, Number(item.revision) || 1);
      const deletedAt = Number(item.deletedAt ?? item.deleted_at) || timestamp;
      await client.query(
        `INSERT INTO runtime_workbench_tombstones
         (space_id, id, revision, deleted_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (space_id, id) DO UPDATE SET
           revision = GREATEST(runtime_workbench_tombstones.revision, EXCLUDED.revision),
           deleted_at = GREATEST(runtime_workbench_tombstones.deleted_at, EXCLUDED.deleted_at)`,
        [this.spaceId, id, revision, deletedAt]
      );
      await client.query(
        `INSERT INTO runtime_workbench_session_heads
         (space_id, id, revision, content_hash, updated_at)
         VALUES ($1, $2, $3, '', $4)
         ON CONFLICT (space_id, id) DO UPDATE SET
           revision = GREATEST(runtime_workbench_session_heads.revision, EXCLUDED.revision),
           updated_at = GREATEST(runtime_workbench_session_heads.updated_at, EXCLUDED.updated_at)`,
        [this.spaceId, id, revision, deletedAt]
      );
    }
    const state = await this.state(client);
    const completeTree = await this.completeTree(
      isObject(snapshot.tree)
        ? snapshot.tree
        : jsonValue(state?.tree_json, defaultTree()),
      client
    );
    const revision = await this.bumpRevision(client, timestamp, {
      version: Number(snapshot.version) || 1,
      tree: completeTree,
      index: await this.rebuildIndexFromTree(completeTree, client)
    });
    let eventSequence = 0;
    for (const id of changedIds) {
      const current = await this.currentSession(id, client);
      const event = await this.recordEvent("session.updated", {
        sessionId: id,
        revision,
        sessionRevision: current.revision,
        sourceClientId,
        payload: {
          reason: "snapshot-merge",
          indexEntry: this.sessionIndexEntry(id, current.meta, current.text)
        },
        timestamp
      }, client, published);
      eventSequence = Math.max(eventSequence, event.sequence);
    }
    const treeEvent = await this.recordEvent("tree.updated", {
      revision,
      sourceClientId,
      payload: { reason: "snapshot-merge" },
      timestamp
    }, client, published);
    return {
      ok: true,
      updated_at: timestamp,
      revision,
      event_sequence: Math.max(eventSequence, treeEvent.sequence)
    };
  }

  async writeTree(tree, _index = [], expectedRevision = null, sourceClientId = "", baseTree = null, operationId = null, transactionOptions) {
    if (!isObject(tree)) throw new Error("tree must be an object");
    return this.transaction(async (client, published) => {
      const duplicate = await this.duplicateOperation(operationId, client);
      if (duplicate) return duplicate;
      const currentRevision = await this.revision(client);
      if (expectedRevision != null && expectedRevision !== currentRevision) {
        return { ok: false, conflict: true, revision: currentRevision };
      }
      const timestamp = this.now();
      const currentTree = await this.stateTree(client);
      const completeTree = await this.completeTree(
        baseTree ? mergeSessionTree(baseTree, tree, currentTree) : tree,
        client
      );
      const index = await this.rebuildIndexFromTree(completeTree, client);
      const revision = await this.bumpRevision(client, timestamp, {
        tree: completeTree,
        index
      });
      const event = await this.recordEvent("tree.updated", {
        revision,
        sourceClientId,
        payload: { changes: sessionTreeChanges(currentTree, completeTree) },
        timestamp
      }, client, published);
      const result = { ok: true, revision, tree: completeTree, index, event_sequence: event.sequence };
      await this.recordOperation(operationId, "tree", 0, result, timestamp, client);
      return result;
    }, transactionOptions);
  }

  async readSession(sessionId, client = this.pool, options = {}) {
    if (client && typeof client.query !== "function") { options = client; client = this.pool; }
    if (client === this.pool) return this.consistentRead(tx => this.readSession(sessionId, tx, options));
    const id = normalizeId(sessionId);
    const current = await this.currentSession(id, client, options);
    if (current.exists) {
      return {
        id,
        text: normalizeConversationTextForDisplay(current.text),
        meta: { ...current.meta, id },
        session_revision: current.revision,
        content_hash: current.contentHash || contentHash(current.text, current.meta),
        updated_at: current.updatedAt
      };
    }
    const result = await client.query(
      `SELECT revision, deleted_at FROM runtime_workbench_tombstones
       WHERE space_id = $1 AND id = $2`,
      [this.spaceId, id]
    );
    const tombstone = result.rows[0];
    return tombstone ? {
      id,
      deleted: true,
      session_revision: Number(tombstone.revision),
      deleted_at: Number(tombstone.deleted_at)
    } : null;
  }

  async readSessionCardDetails(sessionId, requests, client = this.pool) {
    if (client === this.pool) return this.consistentRead(tx => this.readSessionCardDetails(sessionId, requests, tx));
    const id = normalizeId(sessionId);
    if (!Array.isArray(requests) || !requests.length || requests.length > 100
      || requests.some(r => !["tools", "thinking"].includes(r?.kind)
        || typeof r.id !== "string" || !/^[a-f0-9]{64}$/.test(r.ref || "")
        || (r.storage != null && r.storage !== "body"))) {
      throw Object.assign(new Error("Invalid card detail request"), { statusCode: 400 });
    }
    const current = await client.query(
      `SELECT m.meta_json,h.revision FROM runtime_workbench_metadata m
       LEFT JOIN runtime_workbench_session_heads h ON h.space_id=m.space_id AND h.id=m.id
       WHERE m.space_id=$1 AND m.id=$2`, [this.spaceId, id]);
    if (!current.rowCount) return null;
    const meta = jsonValue(current.rows[0].meta_json, {});
    const yCards = new Map();
    if (requests.some(request => request.storage === "body")) {
      const state = await this.readCollaborationDocument(id, client);
      const document = new Y.Doc();
      try {
        if (state?.state) Y.applyUpdate(document, state.state);
        for (const [key, card] of document.getMap("cards")) yCards.set(key, card);
      } finally { document.destroy(); }
    }
    const details = [];
    for (const request of requests) {
      const projected = yCards.get(request.id);
      const metadataCard = meta.annotations?.[request.kind]?.find(item => item.id === request.id);
      const card = request.storage === "body" ? projected || metadataCard : metadataCard;
      const actualKind = card?.kind === "tool" ? "tools" : card?.kind === "thinking" ? "thinking" : request.kind;
      if (request.storage === "body") {
        if (actualKind !== request.kind || !card?.bodyRef || card.bodyRef !== request.ref) throw Object.assign(
          new Error("卡片内容已变化，请重新打开会话后重试。"), { statusCode: 409, code: "CARD_DETAIL_CHANGED" });
        details.push({ ...request, body: await readSessionCardBody(client, this.spaceId, id, request.kind, card) });
      } else {
        let transportCard = card;
        if (card?.bodyRef) {
          const body = await readSessionCardBody(client, this.spaceId, id, request.kind, card);
          // Legacy transport hashes were computed from JSONB metadata values.
          // Reproduce that field order after the canonical immutable body read.
          transportCard = (await client.query("SELECT $1::jsonb AS card",
            [JSON.stringify(hydratedSessionCard(card, body))])).rows[0].card;
        }
        details.push(...sessionCardDetails({ id, meta: { annotations: { [request.kind]: transportCard ? [transportCard] : [] } } },
          [request]).details);
      }
    }
    return { session_revision: Number(current.rows[0].revision || 0), details };
  }

  async updateSession(sessionId, input = {}, transactionOptions) {
    const id = normalizeId(sessionId);
    return this.transaction((client, published) =>
      this.updateSessionInTransaction(id, input, client, published), transactionOptions
    );
  }

  async updateSessionInTransaction(id, input, client, published) {
    const duplicate = await this.duplicateOperation(input.operation_id, client);
    if (duplicate) return duplicate;
    const globalRevision = await this.revision(client);
    if (input.expected_revision != null && input.expected_revision !== globalRevision) {
      return { ok: false, conflict: true, revision: globalRevision };
    }
    const current = await this.currentSession(id, client);
    if (!current.exists && input.reason !== "restore") {
      const tombstone = await this.readSession(id, client);
      if (tombstone?.deleted) {
        const error = new Error("Session has been deleted");
        error.statusCode = 410;
        throw error;
      }
    }
    const metadataOnly = Array.isArray(input.meta_changes)
      && input.text == null && input.title == null && input.meta == null;
    if (
      input.expected_session_revision != null
      && Number(input.expected_session_revision) !== current.revision
      && !metadataOnly
    ) {
      return {
        ok: false,
        conflict: true,
        revision: globalRevision,
        session_revision: current.revision
      };
    }
    const timestamp = this.now();
    const nextText = input.text == null ? current.text : String(input.text);
    const explicitMeta = isObject(input.meta) ? input.meta : {};
    let metaCandidate = input.meta == null
      ? { ...current.meta }
      : { ...current.meta, ...explicitMeta, id };
    if (input.meta_changes != null) {
      // Validate all paths even when an automatic title intent will supersede
      // its comparison values. Manual metadata edits retain field-level CAS.
      let merged = applySessionMetadataChanges(current.meta, input.meta_changes);
      // Older clients persist derived previews. An obsolete preview cannot
      // block a real edit or replace the newer preview from another window.
      const derivedFields = new Set(["documentPreview", "documentPreviewVersion"]);
      if (metadataOnly && merged.conflicts.some(path => derivedFields.has(path))) {
        merged = applySessionMetadataChanges(current.meta,
          input.meta_changes.filter(change => !derivedFields.has(change.path[0])));
      }
      if (metadataOnly && input.automatic_title === true) {
        const titleFields = new Set(["title", "titleAuto"]);
        const remaining = input.meta_changes.filter(change =>
          !titleFields.has(change.path[0]) && !derivedFields.has(change.path[0]));
        merged = applySessionMetadataChanges(current.meta, remaining);
        if (current.meta.titleAuto === true) {
          // Derive from the committed document, never from a stale window's
          // proposed title. A concurrent manual rename always wins.
          const derived = deriveSessionTitleFromContent(current.text);
          if (derived) merged.meta.title = derived;
        }
      }
      if (merged.conflicts.length) return {
        ok: false, conflict: true, revision: globalRevision,
        session_revision: current.revision, metadata_conflicts: merged.conflicts
      };
      const changes = sessionMetadataChanges(current.meta, merged.meta);
      if (metadataOnly && current.exists && !changes.length) {
        const result = { ok: true, unchanged: true, revision: globalRevision,
          session_revision: current.revision };
        await this.recordOperation(input.operation_id, id, current.revision, result, timestamp, client);
        return result;
      }
      metaCandidate = { ...merged.meta, id };
      // Card state and derived previews do not represent conversation activity.
      // Loading an old session must not move it above recently edited sessions.
      if (changes.some(change => ![
        "annotations", "documentPreview", "documentPreviewVersion",
        "autoRenameChatTriggeredAt"
      ].includes(change.path?.[0]))) metaCandidate.updatedAt = timestamp;
    }
    if (input.title != null) metaCandidate.title = String(input.title || "");
    if (input.text != null) {
      if (!Object.prototype.hasOwnProperty.call(explicitMeta, "size")) delete metaCandidate.size;
      if (!Object.prototype.hasOwnProperty.call(explicitMeta, "hash")) delete metaCandidate.hash;
      if (!Object.prototype.hasOwnProperty.call(explicitMeta, "updatedAt")) {
        delete metaCandidate.updatedAt;
      }
    }
    const metaTimestamp = input.meta == null && input.meta_changes == null && input.title == null && input.text == null
      ? Number(current.meta?.updatedAt || timestamp) || timestamp
      : timestamp;
    const next = {
      text: nextText,
      meta: normalizeSessionMeta(id, nextText, metaCandidate, metaTimestamp)
    };
    if (metadataOnly && current.exists) {
      const storedMeta = await prepareSessionCardMetadata(client, this.spaceId, id, next.meta, timestamp);
      await client.query(
        `INSERT INTO runtime_workbench_metadata (space_id, id, meta_json, updated_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (space_id, id) DO UPDATE
           SET meta_json = EXCLUDED.meta_json, updated_at = EXCLUDED.updated_at`,
        [this.spaceId, id, JSON.stringify(storedMeta), timestamp]
      );
    } else {
      await this.writeSessionRows(id, next.text, next.meta, timestamp, client);
    }
    const sessionRevision = current.revision + 1;
    const reason = String(input.reason || "update");
    await this.saveSessionRevision(
      id,
      next,
      sessionRevision,
      reason,
      input.operation_id,
      timestamp,
      {
        snapshot: await this.shouldSnapshotSessionRevision(
          id,
          next,
          reason,
          timestamp,
          { sourceClientId: input.source_client_id },
          client
        )
      },
      client
    );
    const currentTree = await this.stateTree(client);
    const title = next.meta.title || id;
    const titleUpdate = updateSessionNodeTitle(currentTree, id, title);
    const tree = titleUpdate.found
      ? titleUpdate.tree
      : upsertSessionNode(currentTree, id, {
          parentId: input.parent_id || input.parentId || "root",
          title
        });
    const revision = await this.bumpRevision(client, timestamp, {
      tree,
      index: await this.updateSessionIndex(tree, id, this.sessionIndexEntry(id, next.meta, next.text), client)
    });
    const event = await this.recordEvent(current.exists ? "session.updated" : "session.created", {
      sessionId: id,
      revision,
      sessionRevision,
      sourceClientId: input.source_client_id,
      payload: {
        reason,
        changed: [
          ...(input.text == null ? [] : ["document"]),
          ...(input.meta == null && input.meta_changes == null && input.title == null ? [] : ["metadata"])
        ],
        indexEntry: this.sessionIndexEntry(id, next.meta, next.text)
      },
      timestamp
    }, client, published);
    const result = {
      ok: true,
      revision,
      session_revision: sessionRevision,
      event_sequence: event.sequence
    };
    await this.recordOperation(
      input.operation_id,
      id,
      sessionRevision,
      result,
      timestamp,
      client
    );
    return result;
  }

  async deleteSession(sessionId, input = {}, transactionOptions) {
    const id = normalizeId(sessionId);
    return this.transaction((client, published) =>
      this.deleteSessionInTransaction(id, input, client, published), transactionOptions);
  }

  async deleteSessionInTransaction(id, input, client, published) {
      const duplicate = await this.duplicateOperation(input.operation_id, client);
      if (duplicate) return duplicate;
      const globalRevision = await this.revision(client);
      if (input.expected_revision != null && input.expected_revision !== globalRevision) {
        return { ok: false, conflict: true, revision: globalRevision };
      }
      const current = await this.currentSession(id, client);
      if (
        input.expected_session_revision != null
        && Number(input.expected_session_revision) !== current.revision
      ) {
        return {
          ok: false,
          conflict: true,
          revision: globalRevision,
          session_revision: current.revision
        };
      }
      const timestamp = this.now();
      const sessionRevision = current.revision + 1;
      if (current.exists) {
        await this.saveSessionRevision(
          id,
          current,
          sessionRevision,
          "delete",
          input.operation_id,
          timestamp,
          {},
          client
        );
      }
      await client.query(
        `DELETE FROM runtime_workbench_documents
         WHERE space_id = $1 AND id = $2`,
        [this.spaceId, id]
      );
      await client.query(
        `DELETE FROM runtime_workbench_metadata
         WHERE space_id = $1 AND id = $2`,
        [this.spaceId, id]
      );
      await client.query(
        `DELETE FROM runtime_collaboration_documents
         WHERE space_id = $1 AND session_id = $2`,
        [this.spaceId, id]
      );
      await client.query(
        `INSERT INTO runtime_workbench_session_heads
         (space_id, id, revision, content_hash, updated_at)
         VALUES ($1, $2, $3, '', $4)
         ON CONFLICT (space_id, id) DO UPDATE SET
           revision = EXCLUDED.revision,
           content_hash = '',
           updated_at = EXCLUDED.updated_at`,
        [this.spaceId, id, sessionRevision, timestamp]
      );
      await client.query(
        `INSERT INTO runtime_workbench_tombstones
         (space_id, id, revision, deleted_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (space_id, id) DO UPDATE SET
           revision = EXCLUDED.revision,
           deleted_at = EXCLUDED.deleted_at`,
        [this.spaceId, id, sessionRevision, timestamp]
      );
      const tree = await this.stateTree(client);
      removeSessionNode(tree, id);
      const revision = await this.bumpRevision(client, timestamp, {
        tree,
        index: await this.updateSessionIndex(tree, id, null, client)
      });
      const event = await this.recordEvent("session.deleted", {
        sessionId: id,
        revision,
        sessionRevision,
        sourceClientId: input.source_client_id,
        payload: { deletedAt: timestamp },
        timestamp
      }, client, published);
      const result = {
        ok: true,
        revision,
        session_revision: sessionRevision,
        event_sequence: event.sequence
      };
      await this.recordOperation(
        input.operation_id,
        id,
        sessionRevision,
        result,
        timestamp,
        client
      );
      return result;
  }

  async deleteFolder(folderId, input = {}, transactionOptions) {
    const id = normalizeId(folderId, "folder id");
    if (id === "root" || !isObject(input.base_tree) || !input.operation_id) {
      throw Object.assign(new Error("Folder deletion requires a base tree and operation id"), { statusCode: 400 });
    }
    return this.transaction(async (client, published) => {
      const duplicate = await this.duplicateOperation(input.operation_id, client);
      if (duplicate) return duplicate;
      const tree = await this.stateTree(client);
      const { node, parent } = findNodeAndParent(tree, id);
      const expected = findNodeAndParent(input.base_tree, id).node;
      if (!expected || expected.type !== "folder") {
        throw Object.assign(new Error("Folder is missing from the deletion base"), { statusCode: 400 });
      }
      if (!node) return { ok: true, tree, index: await this.rebuildIndexFromTree(tree, client), deleted_session_ids: [] };
      if (node.type !== "folder" || !parent) {
        throw Object.assign(new Error("Invalid folder deletion"), { statusCode: 400 });
      }
      const layout = folder => {
        const result = [];
        const visit = (entry, parentId) => {
          result.push([entry.id, entry.type, parentId]);
          for (const child of entry.children || []) visit(child, entry.id);
        };
        visit(folder, null);
        return result.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      };
      if (JSON.stringify(layout(expected)) !== JSON.stringify(layout(node))) {
        throw Object.assign(new Error("Folder contents changed in another window; refresh before deleting"), { statusCode: 409 });
      }
      const sessionIds = layout(node).filter(([, type]) => type === "session").map(([sessionId]) => sessionId);
      for (const sessionId of sessionIds) {
        await this.deleteSessionInTransaction(sessionId, {
          operation_id: `${input.operation_id}:session:${sessionId}`,
          source_client_id: input.source_client_id
        }, client, published);
      }
      const remaining = await this.stateTree(client);
      const target = findNodeAndParent(remaining, id);
      target.parent.children = target.parent.children.filter(child => child.id !== id);
      const timestamp = this.now();
      const index = await this.rebuildIndexFromTree(remaining, client);
      const revision = await this.bumpRevision(client, timestamp, { tree: remaining, index });
      const event = await this.recordEvent("tree.updated", {
        revision, sourceClientId: input.source_client_id,
        payload: { reason: "folder-delete", folderId: id, sessionIds }, timestamp
      }, client, published);
      const result = { ok: true, revision, tree: remaining, index, event_sequence: event.sequence,
        deleted_session_ids: sessionIds };
      await this.recordOperation(input.operation_id, `folder:${id}`, 0, result, timestamp, client);
      return result;
    }, transactionOptions);
  }

  async listSessionRevisions(sessionId) {
    const result = await this.pool.query(
      `SELECT session_id, revision, content_hash, reason, operation_id, created_at
       FROM runtime_workbench_session_revisions
       WHERE space_id = $1 AND session_id = $2
       ORDER BY revision DESC`,
      [this.spaceId, normalizeId(sessionId)]
    );
    return result.rows.map((row) => ({
      session_id: row.session_id,
      revision: Number(row.revision),
      content_hash: row.content_hash,
      reason: row.reason,
      operation_id: row.operation_id,
      created_at: Number(row.created_at)
    }));
  }

  async restoreSessionRevision(sessionId, revision, operationId = null, transactionOptions) {
    const id = normalizeId(sessionId);
    return this.transaction(async (client, published) => {
      const result = await client.query(
        `SELECT text, meta_json FROM runtime_workbench_session_revisions
         WHERE space_id = $1 AND session_id = $2 AND revision = $3`,
        [this.spaceId, id, Number(revision)]
      );
      const row = result.rows[0];
      if (!row) {
        const error = new Error("session revision not found");
        error.statusCode = 404;
        throw error;
      }
      return this.updateSessionInTransaction(id, {
        text: row.text,
        meta: await this.hydrateRevisionMeta(
          jsonValue(row.meta_json, {}),
          client, id
        ),
        operation_id: operationId,
        reason: "restore"
      }, client, published);
    }, transactionOptions);
  }

  async readKV(key, client = this.pool) {
    const normalized = normalizeId(key, "key");
    const result = await client.query(
      `SELECT value_json, updated_at FROM runtime_workbench_kv
       WHERE space_id = $1 AND key = $2`,
      [this.spaceId, normalized]
    );
    const row = result.rows[0];
    return row ? {
      key: normalized,
      value: jsonValue(row.value_json),
      updated_at: Number(row.updated_at)
    } : null;
  }

  async writeKV(key, value, {
    sourceClientId = "",
    expectedValue
  } = {}) {
    return this.transaction((client, published) =>
      this.writeKVInTransaction(key, value, { sourceClientId, expectedValue }, client, published));
  }

  // Related catalog/source rows and selection changes commit under one Space
  // lock, including when more than one Runtime process serves the Space.
  async withKVTransaction(operation) {
    return this.transaction((client, published) => operation({
      readKV: (key) => this.readKV(key, client),
      writeKV: (key, value, options = {}) =>
        this.writeKVInTransaction(key, value, options, client, published)
    }));
  }

  async writeKVInTransaction(key, value, {
    sourceClientId = "", expectedValue
  }, client, published) {
    const normalized = normalizeId(key, "key");
    const timestamp = this.now();
    const existing = await this.readKV(normalized, client);
    if (expectedValue !== undefined
      && JSON.stringify(existing?.value ?? null) !== JSON.stringify(expectedValue)) {
      throw Object.assign(new Error("State changed; read its current revision before updating"), {
        statusCode: 409, code: "revision_conflict"
      });
    }
    if (
      existing
      && JSON.stringify(existing.value) === JSON.stringify(value)
    ) {
      return {
        ok: true,
        duplicate: true,
        key: normalized,
        updated_at: existing.updated_at,
        revision: await this.revision(client),
        event_sequence: 0
      };
    }
    await client.query(
      `INSERT INTO runtime_workbench_kv (space_id, key, value_json, updated_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (space_id, key) DO UPDATE SET
         value_json = EXCLUDED.value_json,
         updated_at = EXCLUDED.updated_at`,
      [this.spaceId, normalized, JSON.stringify(value), timestamp]
    );
    const revision = await this.bumpRevision(client, timestamp);
    const event = await this.recordEvent("kv.updated", {
      revision,
      sourceClientId,
      payload: { key: normalized },
      timestamp
    }, client, published);
    return {
      ok: true,
      key: normalized,
      updated_at: timestamp,
      revision,
      event_sequence: event.sequence
    };
  }

  async deleteKV(key, { expectedValue } = {}) {
    const normalized = normalizeId(key, "key");
    if (expectedValue === undefined) throw new Error("KV deletion requires the previous value");
    return this.transaction(async (client, published) => {
      const result = await client.query(`DELETE FROM runtime_workbench_kv
        WHERE space_id=$1 AND key=$2 AND value_json=$3::jsonb`,
      [this.spaceId, normalized, JSON.stringify(expectedValue)]);
      if (!result.rowCount) return false;
      const timestamp = this.now();
      const revision = await this.bumpRevision(client, timestamp);
      await this.recordEvent("kv.updated", { revision, payload: { key: normalized }, timestamp }, client, published);
      return true;
    });
  }

  async migrateBrowserStorage(sourceId, snapshot, fingerprint, transactionOptions) {
    const source = normalizeId(sourceId, "source id");
    const marker = normalizeId(fingerprint, "fingerprint");
    return this.transaction(async (client, published) => {
      const existing = await client.query(
        `SELECT result_json FROM runtime_state_migrations
         WHERE space_id = $1 AND source = $2 AND fingerprint = $3`,
        [this.spaceId, source, marker]
      );
      if (existing.rows[0]) {
        return {
          ...jsonValue(existing.rows[0].result_json, {}),
          duplicate: true
        };
      }
      const current = (await this.readSnapshot(client))?.snapshot;
      let report;
      if (!current) {
        const write = await this.writeSnapshotInTransaction(
          snapshot || {},
          null,
          "",
          client,
          published
        );
        report = {
          ...write,
          verified: write.ok === true,
          imported: (snapshot?.docs || [])
            .map((item) => String(item?.id || ""))
            .filter(Boolean),
          archived: []
        };
      } else {
        const known = new Set([
          ...(current.docs || []).map((item) => String(item.id)),
          ...(current.metas || []).map((item) => String(item.id))
        ]);
        const imported = [];
        const archived = [];
        const docs = [];
        const metas = [];
        for (const item of snapshot?.docs || []) {
          const id = String(item?.id || "").trim();
          if (!id) continue;
          if (known.has(id)) archived.push(id);
          else {
            imported.push(id);
            docs.push(item);
          }
        }
        for (const item of snapshot?.metas || []) {
          if (imported.includes(String(item?.id || ""))) metas.push(item);
        }
        const importedMetas = new Map(
          metas.map((item) => [String(item.id), item.meta || {}])
        );
        const importedIndex = (snapshot?.index || [])
          .filter((item) => imported.includes(String(item?.id || "")));
        const knownIndexIds = new Set(
          (current.index || []).map((item) => String(item?.id || ""))
        );
        const write = await this.writeSnapshotInTransaction({
          docs,
          metas,
          kv: snapshot?.kv || {},
          tree: appendMissingSessionsToTree(
            isObject(snapshot?.tree)
              ? mergeMigratedSessionTree(current.tree, snapshot.tree)
              : current.tree,
            imported.map((id) => ({
              id,
              title: importedMetas.get(id)?.title || id
            }))
          ),
          index: [
            ...(current.index || []),
            ...importedIndex.filter((item) =>
              !knownIndexIds.has(String(item?.id || ""))
            )
          ]
        }, null, "", client, published);
        report = {
          ...write,
          verified: write.ok === true,
          imported: [...new Set(imported)],
          archived: [...new Set(archived)]
        };
      }
      await client.query(
        `INSERT INTO runtime_state_migrations
         (space_id, source, fingerprint, result_json, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [
          this.spaceId,
          source,
          marker,
          JSON.stringify(report),
          this.now()
        ]
      );
      return report;
    }, transactionOptions);
  }

  async hasMigration(source, fingerprint, client = this.pool) {
    const result = await client.query(
      `SELECT 1 FROM runtime_state_migrations
       WHERE space_id = $1 AND source = $2 AND fingerprint = $3`,
      [this.spaceId, String(source), String(fingerprint)]
    );
    return result.rowCount > 0;
  }

  async hasMigrationSource(source) {
    const result = await this.pool.query(
      `SELECT 1 FROM runtime_state_migrations
       WHERE space_id = $1 AND source = $2 LIMIT 1`,
      [this.spaceId, String(source)]
    );
    return result.rowCount > 0;
  }

  async recordMigration(source, fingerprint, result, client = this.pool) {
    await client.query(
      `INSERT INTO runtime_state_migrations
       (space_id, source, fingerprint, result_json, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (space_id, source, fingerprint) DO UPDATE SET
         result_json = EXCLUDED.result_json,
         created_at = EXCLUDED.created_at`,
      [
        this.spaceId,
        String(source),
        String(fingerprint),
        JSON.stringify(result),
        this.now()
      ]
    );
  }

  async close() {
    this.eventListeners.clear();
  }
}
