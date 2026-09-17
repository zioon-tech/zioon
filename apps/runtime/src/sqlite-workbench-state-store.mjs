import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require(["node", "sqlite"].join(":"));
const MAX_SESSION_REVISIONS = 20;
const MAX_WORKBENCH_EVENTS = 50_000;

function encode(value) {
  return JSON.stringify(value);
}

function decode(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
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
    .update(encode(meta || {}))
    .digest("hex");
}

function documentHash(text) {
  return createHash("sha256")
    .update(String(text || ""))
    .digest("hex");
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

function appendMissingSessionsToTree(tree, sessions) {
  const root = isObject(tree) ? decode(encode(tree), defaultTree()) : defaultTree();
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

function cloneValue(value, fallback = null) {
  return decode(encode(value), fallback);
}

function titleFromText(text, fallback = "Untitled Session") {
  const firstLine = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return String(firstLine || fallback).slice(0, 80);
}

function normalizeSessionMeta(sessionId, text, meta = {}, timestamp = nowMs()) {
  const current = isObject(meta) ? meta : {};
  const title = String(current.title || titleFromText(text, sessionId)).trim() || sessionId;
  const hasSize = Object.prototype.hasOwnProperty.call(current, "size");
  const hasCreatedAt = Object.prototype.hasOwnProperty.call(current, "createdAt");
  const hasUpdatedAt = Object.prototype.hasOwnProperty.call(current, "updatedAt");
  return {
    ...current,
    id: sessionId,
    title,
    createdAt: Number(hasCreatedAt ? current.createdAt : timestamp) || timestamp,
    updatedAt: Number(hasUpdatedAt ? current.updatedAt : timestamp) || timestamp,
    size: hasSize ? Number(current.size) || 0 : String(text || "").length,
    hash: String(current.hash || documentHash(text))
  };
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
  const root = isObject(tree) ? cloneValue(tree, defaultTree()) : defaultTree();
  if (!Array.isArray(root.children)) root.children = [];
  removeSessionNode(root, sessionId);
  const parentTarget = String(parentId || "root").trim() || "root";
  const found = findNodeAndParent(root, parentTarget);
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
  const root = isObject(tree) ? cloneValue(tree, defaultTree()) : defaultTree();
  const found = findNodeAndParent(root, sessionId);
  if (isSessionNode(found.node)) {
    found.node.title = String(title || sessionId);
    return { tree: root, found: true };
  }
  return { tree: root, found: false };
}

export class SqliteWorkbenchStateStore {
  constructor(path) {
    this.path = path;
    this.transactionDepth = 0;
    this.pendingPublishedEvents = [];
    this.eventListeners = new Set();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 30000;

      CREATE TABLE IF NOT EXISTS runtime_workbench_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        tree_json TEXT NOT NULL,
        index_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_workbench_documents (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_workbench_metadata (
        id TEXT PRIMARY KEY,
        meta_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_workbench_session_heads (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_workbench_session_revisions (
        session_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        text TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        operation_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, revision)
      );

      CREATE TABLE IF NOT EXISTS runtime_workbench_operations (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        session_revision INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_workbench_tombstones (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        deleted_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_workbench_kv (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_workbench_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        session_id TEXT,
        run_id TEXT,
        revision TEXT,
        session_revision INTEGER,
        source_client_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS runtime_workbench_events_session_sequence
      ON runtime_workbench_events(session_id, sequence);

      CREATE TABLE IF NOT EXISTS runtime_collaboration_documents (
        session_id TEXT PRIMARY KEY,
        state_blob BLOB NOT NULL,
        state_hash TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_state_migrations (
        source TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source, fingerprint)
      );
    `);
    this.pruneSessionRevisions();
    this.pruneEvents();
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Some filesystems do not support POSIX permissions.
      }
    }
  }

  transaction(callback) {
    if (this.transactionDepth > 0) return callback();
    const eventStart = this.pendingPublishedEvents.length;
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = callback();
      this.db.exec("COMMIT");
      const committedEvents = this.pendingPublishedEvents.splice(eventStart);
      for (const event of committedEvents) {
        queueMicrotask(() => {
          for (const listener of this.eventListeners) {
            try { listener(event); } catch {}
          }
        });
      }
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.pendingPublishedEvents.splice(eventStart);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  state() {
    return this.db.prepare(
      "SELECT version, revision, tree_json, index_json, updated_at FROM runtime_workbench_state WHERE id = 1"
    ).get() || null;
  }

  ensureState(timestamp = nowMs()) {
    this.db.prepare(`
      INSERT OR IGNORE INTO runtime_workbench_state
        (id, version, revision, tree_json, index_json, updated_at)
      VALUES (1, 1, 0, ?, '[]', ?)
    `).run(encode(defaultTree()), timestamp);
    return this.state();
  }

  revision() {
    const row = this.state();
    return row ? `runtime:${Number(row.revision)}` : null;
  }

  bumpRevision(timestamp = nowMs(), patch = {}) {
    const current = this.ensureState(timestamp);
    this.db.prepare(`
      UPDATE runtime_workbench_state
      SET version = ?, revision = revision + 1, tree_json = ?, index_json = ?, updated_at = ?
      WHERE id = 1
    `).run(
      Number(patch.version ?? current.version ?? 1),
      encode(patch.tree ?? decode(current.tree_json, defaultTree())),
      encode(patch.index ?? decode(current.index_json, [])),
      timestamp
    );
    return this.revision();
  }

  currentSession(sessionId) {
    const document = this.db.prepare(
      "SELECT text FROM runtime_workbench_documents WHERE id = ?"
    ).get(sessionId);
    const metadata = this.db.prepare(
      "SELECT meta_json FROM runtime_workbench_metadata WHERE id = ?"
    ).get(sessionId);
    const head = this.db.prepare(
      "SELECT revision, updated_at FROM runtime_workbench_session_heads WHERE id = ?"
    ).get(sessionId);
    return {
      exists: !!document || !!metadata,
      text: String(document?.text || ""),
      meta: decode(metadata?.meta_json, {}),
      revision: Number(head?.revision || 0),
      updatedAt: Number(head?.updated_at || 0)
    };
  }

  saveSessionRevision(sessionId, session, revision, reason, operationId, timestamp) {
    const hash = contentHash(session.text, session.meta);
    this.db.prepare(`
      INSERT OR IGNORE INTO runtime_workbench_session_revisions
        (session_id, revision, text, meta_json, content_hash, reason, operation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      revision,
      session.text,
      encode(session.meta),
      hash,
      reason,
      operationId || null,
      timestamp
    );
    this.db.prepare(`
      INSERT INTO runtime_workbench_session_heads (id, revision, content_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        revision = excluded.revision,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `).run(sessionId, revision, hash, timestamp);
    this.pruneSessionRevisions(sessionId);
    return hash;
  }

  recordEvent(type, {
    sessionId = "",
    runId = "",
    revision = this.revision(),
    sessionRevision = null,
    sourceClientId = "",
    payload = {},
    timestamp = nowMs()
  } = {}) {
    const result = this.db.prepare(`
      INSERT INTO runtime_workbench_events
        (
          type,
          session_id,
          run_id,
          revision,
          session_revision,
          source_client_id,
          payload_json,
          created_at
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizeId(type, "event type"),
      String(sessionId || "") || null,
      String(runId || "") || null,
      String(revision || "") || null,
      Number.isFinite(Number(sessionRevision)) ? Number(sessionRevision) : null,
      String(sourceClientId || "") || null,
      encode(isObject(payload) ? payload : {}),
      Number(timestamp) || nowMs()
    );
    this.pruneEvents();
    const event = this.readEvent(Number(result.lastInsertRowid));
    if (event) {
      if (this.transactionDepth > 0) {
        this.pendingPublishedEvents.push(event);
      } else {
        queueMicrotask(() => {
          for (const listener of this.eventListeners) {
            try { listener(event); } catch {}
          }
        });
      }
    }
    return event;
  }

  appendEvent(type, input = {}) {
    return this.transaction(() => this.recordEvent(type, input));
  }

  readEvent(sequence) {
    const row = this.db.prepare(`
      SELECT
        sequence,
        type,
        session_id,
        run_id,
        revision,
        session_revision,
        source_client_id,
        payload_json,
        created_at
      FROM runtime_workbench_events
      WHERE sequence = ?
    `).get(Number(sequence));
    return row ? {
      sequence: Number(row.sequence),
      type: row.type,
      sessionId: row.session_id || null,
      runId: row.run_id || null,
      revision: row.revision || null,
      sessionRevision: row.session_revision == null
        ? null
        : Number(row.session_revision),
      sourceClientId: row.source_client_id || null,
      data: decode(row.payload_json, {}),
      createdAt: Number(row.created_at)
    } : null;
  }

  listEvents(afterSequence = 0, {
    limit = 500,
    sessionId = ""
  } = {}) {
    const after = Math.max(0, Number(afterSequence) || 0);
    const boundedLimit = Math.max(1, Math.min(2_000, Number(limit) || 500));
    const targetSessionId = String(sessionId || "").trim();
    const where = targetSessionId
      ? "WHERE sequence > ? AND (session_id = ? OR session_id IS NULL)"
      : "WHERE sequence > ?";
    const rows = this.db.prepare(`
      SELECT sequence
      FROM runtime_workbench_events
      ${where}
      ORDER BY sequence ASC
      LIMIT ?
    `).all(
      ...(targetSessionId
        ? [after, targetSessionId, boundedLimit]
        : [after, boundedLimit])
    );
    const bounds = this.eventBounds();
    return {
      events: rows.map((row) => this.readEvent(row.sequence)).filter(Boolean),
      oldestSequence: bounds.oldestSequence,
      latestSequence: bounds.latestSequence,
      resetRequired: after > 0
        && bounds.oldestSequence > 0
        && after < bounds.oldestSequence - 1
    };
  }

  eventBounds() {
    const row = this.db.prepare(`
      SELECT MIN(sequence) AS oldest_sequence, MAX(sequence) AS latest_sequence
      FROM runtime_workbench_events
    `).get();
    return {
      oldestSequence: Number(row?.oldest_sequence || 0),
      latestSequence: Number(row?.latest_sequence || 0)
    };
  }

  subscribeEvents(listener) {
    if (typeof listener !== "function") {
      throw new Error("Workbench event listener must be a function");
    }
    this.eventListeners.add(listener);
    return {
      dispose: () => this.eventListeners.delete(listener)
    };
  }

  pruneEvents() {
    const latestSequence = Number(this.db.prepare(
      "SELECT MAX(sequence) AS sequence FROM runtime_workbench_events"
    ).get()?.sequence || 0);
    if (latestSequence <= MAX_WORKBENCH_EVENTS) return 0;
    const result = this.db.prepare(
      "DELETE FROM runtime_workbench_events WHERE sequence <= ?"
    ).run(latestSequence - MAX_WORKBENCH_EVENTS);
    return Number(result.changes || 0);
  }

  readCollaborationDocument(sessionId) {
    const id = normalizeId(sessionId);
    const row = this.db.prepare(`
      SELECT state_blob, state_hash, version, updated_at
      FROM runtime_collaboration_documents
      WHERE session_id = ?
    `).get(id);
    return row ? {
      sessionId: id,
      state: new Uint8Array(row.state_blob),
      stateHash: row.state_hash,
      version: Number(row.version),
      updatedAt: Number(row.updated_at)
    } : null;
  }

  writeCollaborationDocument(sessionId, state, {
    text,
    sourceClientId = "",
    timestamp = nowMs(),
    emitEvent = true
  } = {}) {
    const id = normalizeId(sessionId);
    const bytes = Buffer.from(state || []);
    if (!bytes.length) throw new Error("collaboration document state required");
    const stateHash = createHash("sha256").update(bytes).digest("hex");
    const existing = this.db.prepare(`
      SELECT state_hash, version
      FROM runtime_collaboration_documents
      WHERE session_id = ?
    `).get(id);
    const currentSession = this.currentSession(id);
    const nextText = text == null ? null : String(text);
    if (
      existing?.state_hash === stateHash
      && (nextText == null || currentSession.text === nextText)
    ) {
      return {
        ok: true,
        duplicate: true,
        sessionId: id,
        stateHash,
        version: Number(existing.version)
      };
    }

    return this.transaction(() => {
      const version = Number(existing?.version || 0) + 1;
      this.db.prepare(`
        INSERT INTO runtime_collaboration_documents
          (session_id, state_blob, state_hash, version, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          state_blob = excluded.state_blob,
          state_hash = excluded.state_hash,
          version = excluded.version,
          updated_at = excluded.updated_at
      `).run(id, bytes, stateHash, version, timestamp);

      let sessionRevision = currentSession.revision;
      let event = null;
      if (nextText != null && (!currentSession.exists || currentSession.text !== nextText)) {
        if (!currentSession.exists) {
          const sessionResult = this.updateSession(id, {
            text: nextText,
            reason: "collaboration",
            source_client_id: sourceClientId
          });
          sessionRevision = sessionResult.session_revision;
        } else {
          const metaCandidate = { ...currentSession.meta };
          delete metaCandidate.size;
          delete metaCandidate.hash;
          delete metaCandidate.updatedAt;
          const nextMeta = normalizeSessionMeta(id, nextText, metaCandidate, timestamp);
          this.db.prepare(`
            INSERT INTO runtime_workbench_documents (id, text, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
          `).run(id, nextText, timestamp);
          this.db.prepare(`
            INSERT INTO runtime_workbench_metadata (id, meta_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET meta_json = excluded.meta_json, updated_at = excluded.updated_at
          `).run(id, encode(nextMeta), timestamp);
          this.db.prepare("DELETE FROM runtime_workbench_tombstones WHERE id = ?").run(id);
          sessionRevision = currentSession.revision + 1;
          this.saveSessionRevision(
            id,
            { text: nextText, meta: nextMeta },
            sessionRevision,
            "collaboration",
            null,
            timestamp
          );
          const tree = this.stateTree();
          this.db.prepare(`
            UPDATE runtime_workbench_state
            SET index_json = ?, updated_at = ?
            WHERE id = 1
          `).run(encode(this.rebuildIndexFromTree(tree)), timestamp);
        }
      }
      if (emitEvent) {
        event = this.recordEvent("collaboration.updated", {
          sessionId: id,
          revision: this.revision(),
          sessionRevision,
          sourceClientId,
          payload: { version, stateHash },
          timestamp
        });
      }
      return {
        ok: true,
        sessionId: id,
        stateHash,
        version,
        session_revision: sessionRevision,
        event_sequence: event?.sequence ?? 0
      };
    });
  }

  deleteCollaborationDocument(sessionId) {
    const id = normalizeId(sessionId);
    const result = this.db.prepare(
      "DELETE FROM runtime_collaboration_documents WHERE session_id = ?"
    ).run(id);
    return Number(result.changes || 0) > 0;
  }

  pruneSessionRevisions(sessionId = "") {
    const id = String(sessionId || "").trim();
    const filter = id ? "WHERE session_id = ?" : "";
    const statement = this.db.prepare(`
      DELETE FROM runtime_workbench_session_revisions
      WHERE rowid IN (
        SELECT rowid
        FROM (
          SELECT
            rowid,
            ROW_NUMBER() OVER (
              PARTITION BY session_id
              ORDER BY revision DESC
            ) AS revision_rank
          FROM runtime_workbench_session_revisions
          ${filter}
        )
        WHERE revision_rank > ?
      )
    `);
    const result = id
      ? statement.run(id, MAX_SESSION_REVISIONS)
      : statement.run(MAX_SESSION_REVISIONS);
    return Number(result.changes || 0);
  }

  recordOperation(operationId, sessionId, sessionRevision, result, timestamp) {
    if (!operationId) return;
    this.db.prepare(`
      INSERT OR IGNORE INTO runtime_workbench_operations
        (operation_id, session_id, session_revision, result_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(operationId, sessionId, sessionRevision, encode(result), timestamp);
  }

  duplicateOperation(operationId) {
    if (!operationId) return null;
    const row = this.db.prepare(
      "SELECT result_json FROM runtime_workbench_operations WHERE operation_id = ?"
    ).get(operationId);
    return row ? { ...decode(row.result_json, {}), duplicate: true } : null;
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

  rebuildIndexFromTree(tree) {
    const root = isObject(tree) ? tree : defaultTree();
    const index = [];
    const visit = (node) => {
      if (!node) return;
      if (isSessionNode(node)) {
        const id = String(node.id || "");
        if (!id) return;
        const current = this.currentSession(id);
        if (!current.exists) return;
        index.push(this.sessionIndexEntry(id, {
          ...current.meta,
          title: current.meta?.title || node.title || id
        }, current.text));
        return;
      }
      if (isFolderNode(node) && Array.isArray(node.children)) {
        for (const child of node.children) visit(child);
      }
    };
    visit(root);
    return index;
  }

  stateTree() {
    const state = this.ensureState();
    return decode(state.tree_json, defaultTree());
  }

  createSession(input = {}) {
    return this.transaction(() => {
      const duplicate = this.duplicateOperation(input.operation_id);
      if (duplicate) return duplicate;
      const globalRevision = this.revision();
      if (input.expected_revision != null && input.expected_revision !== globalRevision) {
        return { ok: false, conflict: true, revision: globalRevision };
      }
      const requestedId = String(input.id || "").trim();
      const id = requestedId || `session_${randomUUID()}`;
      const current = this.currentSession(id);
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
      const timestamp = nowMs();
      const text = String(input.text ?? input.doc ?? "");
      const baseMeta = isObject(input.meta) ? { ...input.meta } : {};
      if (input.title != null) baseMeta.title = String(input.title || "");
      const meta = normalizeSessionMeta(id, text, baseMeta, timestamp);
      this.db.prepare(`
        INSERT INTO runtime_workbench_documents (id, text, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
      `).run(id, text, timestamp);
      this.db.prepare(`
        INSERT INTO runtime_workbench_metadata (id, meta_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET meta_json = excluded.meta_json, updated_at = excluded.updated_at
      `).run(id, encode(meta), timestamp);
      this.db.prepare("DELETE FROM runtime_workbench_tombstones WHERE id = ?").run(id);
      const sessionRevision = current.revision + 1;
      this.saveSessionRevision(
        id,
        { text, meta },
        sessionRevision,
        String(input.reason || "create"),
        input.operation_id,
        timestamp
      );
      const tree = upsertSessionNode(this.stateTree(), id, {
        parentId: input.parent_id || input.parentId || "root",
        title: meta.title
      });
      const revision = this.bumpRevision(timestamp, {
        tree,
        index: this.rebuildIndexFromTree(tree)
      });
      const event = this.recordEvent("session.created", {
        sessionId: id,
        revision,
        sessionRevision,
        sourceClientId: input.source_client_id,
        payload: {
          indexEntry: this.sessionIndexEntry(id, meta, text),
          parentId: String(input.parent_id || input.parentId || "root")
        },
        timestamp
      });
      const result = {
        ok: true,
        id,
        revision,
        session_revision: sessionRevision,
        event_sequence: event.sequence
      };
      this.recordOperation(input.operation_id, id, sessionRevision, result, timestamp);
      return result;
    });
  }

  readSnapshot() {
    const state = this.state();
    if (!state) return null;
    const docs = this.db.prepare(`
      SELECT
        documents.id,
        documents.text,
        COALESCE(heads.revision, 0) AS session_revision,
        COALESCE(heads.content_hash, '') AS content_hash
      FROM runtime_workbench_documents AS documents
      LEFT JOIN runtime_workbench_session_heads AS heads
        ON heads.id = documents.id
      ORDER BY documents.id
    `).all().map((row) => ({
      id: row.id,
      text: row.text,
      session_revision: Number(row.session_revision || 0),
      content_hash: row.content_hash
    }));
    const metas = this.db.prepare(
      "SELECT id, meta_json FROM runtime_workbench_metadata ORDER BY id"
    ).all().map((row) => ({ id: row.id, meta: decode(row.meta_json, {}) }));
    const tombstones = this.db.prepare(
      "SELECT id, revision, deleted_at FROM runtime_workbench_tombstones ORDER BY deleted_at"
    ).all().map((row) => ({
      id: row.id,
      revision: Number(row.revision),
      deletedAt: Number(row.deleted_at)
    }));
    const kv = Object.fromEntries(this.db.prepare(
      "SELECT key, value_json FROM runtime_workbench_kv ORDER BY key"
    ).all().map((row) => [row.key, decode(row.value_json)]));
    const snapshot = {
      version: Number(state.version || 1),
      updatedAt: Number(state.updated_at || 0),
      tree: decode(state.tree_json, defaultTree()),
      index: decode(state.index_json, []),
      docs,
      metas,
      tombstones,
      kv
    };
    return {
      snapshot,
      revision: this.revision(),
      event_cursor: this.eventBounds().latestSequence,
      updated_at: snapshot.updatedAt
    };
  }

  readCatalog() {
    const tree = this.readTree();
    const sessions = this.db.prepare(`
      SELECT documents.id, COALESCE(heads.revision, 0) AS session_revision
      FROM runtime_workbench_documents AS documents
      LEFT JOIN runtime_workbench_session_heads AS heads ON heads.id = documents.id
      ORDER BY documents.id
    `).all();
    const metas = this.db.prepare(`
      SELECT id, json_remove(meta_json, '$.annotations') AS summary_json
      FROM runtime_workbench_metadata ORDER BY id
    `).all().map((row) => ({ id: row.id, meta: decode(row.summary_json, {}) }));
    const kv = Object.fromEntries(this.db.prepare(
      "SELECT key, value_json FROM runtime_workbench_kv ORDER BY key"
    ).all().map((row) => [row.key, decode(row.value_json)]));
    return { ...tree, catalog: { tree: tree.tree, index: tree.index, sessions, metas, kv } };
  }

  readStatus() {
    const state = this.state();
    return {
      ok: true,
      service: "zion-runtime",
      revision: this.revision(),
      event_cursor: this.eventBounds().latestSequence,
      updated_at: Number(state?.updated_at || 0),
      documents: Number(this.db.prepare(
        "SELECT COUNT(*) AS count FROM runtime_workbench_documents"
      ).get().count),
      metadata: Number(this.db.prepare(
        "SELECT COUNT(*) AS count FROM runtime_workbench_metadata"
      ).get().count)
    };
  }

  readSessionMeta(sessionId) {
    const id = normalizeId(sessionId);
    const row = this.db.prepare(
      "SELECT meta_json FROM runtime_workbench_metadata WHERE id = ?"
    ).get(id);
    return row ? { ...decode(row.meta_json, {}), id } : null;
  }

  readTree() {
    const state = this.ensureState();
    return {
      tree: decode(state.tree_json, defaultTree()),
      index: decode(state.index_json, []),
      revision: this.revision(),
      event_cursor: this.eventBounds().latestSequence,
      updated_at: Number(state.updated_at || 0)
    };
  }

  writeSnapshot(snapshot, expectedRevision = null, sourceClientId = "") {
    if (!isObject(snapshot)) throw new Error("snapshot must be an object");
    return this.transaction(() => {
      const currentRevision = this.revision();
      if (expectedRevision != null && expectedRevision !== currentRevision) {
        return {
          ok: false,
          conflict: true,
          revision: currentRevision,
          snapshot: this.readSnapshot()?.snapshot || null
        };
      }
      const timestamp = Number(snapshot.updatedAt) || nowMs();
      this.ensureState(timestamp);
      const docs = Array.isArray(snapshot.docs) ? snapshot.docs : [];
      const metas = Array.isArray(snapshot.metas) ? snapshot.metas : [];
      const changedIds = new Set();
      for (const item of docs) {
        const id = normalizeId(item?.id);
        const text = String(item?.text || "");
        const previous = this.currentSession(id);
        if (!previous.exists || previous.text !== text) changedIds.add(id);
        this.db.prepare(`
          INSERT INTO runtime_workbench_documents (id, text, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
        `).run(id, text, timestamp);
      }
      for (const item of metas) {
        const id = normalizeId(item?.id);
        const meta = isObject(item?.meta) ? { ...item.meta, id } : { id };
        const previous = this.currentSession(id);
        if (!previous.exists || encode(previous.meta) !== encode(meta)) changedIds.add(id);
        this.db.prepare(`
          INSERT INTO runtime_workbench_metadata (id, meta_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET meta_json = excluded.meta_json, updated_at = excluded.updated_at
        `).run(id, encode(meta), timestamp);
      }
      for (const id of changedIds) {
        const session = this.currentSession(id);
        this.saveSessionRevision(
          id,
          session,
          session.revision + 1,
          "snapshot-merge",
          null,
          timestamp
        );
        this.db.prepare("DELETE FROM runtime_workbench_tombstones WHERE id = ?").run(id);
      }
      for (const [key, value] of Object.entries(snapshot.kv || {})) {
        this.db.prepare(`
          INSERT INTO runtime_workbench_kv (key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `).run(key, encode(value), timestamp);
      }
      for (const item of Array.isArray(snapshot.tombstones) ? snapshot.tombstones : []) {
        const id = String(item?.id || "").trim();
        if (!id || this.currentSession(id).exists) continue;
        const revision = Math.max(1, Number(item.revision) || 1);
        const deletedAt = Number(item.deletedAt ?? item.deleted_at) || timestamp;
        this.db.prepare(`
          INSERT INTO runtime_workbench_tombstones (id, revision, deleted_at)
          VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            revision = MAX(revision, excluded.revision),
            deleted_at = MAX(deleted_at, excluded.deleted_at)
        `).run(id, revision, deletedAt);
        this.db.prepare(`
          INSERT INTO runtime_workbench_session_heads (id, revision, content_hash, updated_at)
          VALUES (?, ?, '', ?)
          ON CONFLICT(id) DO UPDATE SET
            revision = MAX(revision, excluded.revision),
            updated_at = MAX(updated_at, excluded.updated_at)
        `).run(id, revision, deletedAt);
      }
      const revision = this.bumpRevision(timestamp, {
        version: Number(snapshot.version) || 1,
        tree: isObject(snapshot.tree)
          ? snapshot.tree
          : decode(this.state()?.tree_json, defaultTree()),
        index: Array.isArray(snapshot.index)
          ? snapshot.index
          : decode(this.state()?.index_json, [])
      });
      let eventSequence = 0;
      for (const id of changedIds) {
        const current = this.currentSession(id);
        const event = this.recordEvent("session.updated", {
          sessionId: id,
          revision,
          sessionRevision: current.revision,
          sourceClientId,
          payload: {
            reason: "snapshot-merge",
            indexEntry: this.sessionIndexEntry(id, current.meta, current.text)
          },
          timestamp
        });
        eventSequence = Math.max(eventSequence, event.sequence);
      }
      const treeEvent = this.recordEvent("tree.updated", {
        revision,
        sourceClientId,
        payload: { reason: "snapshot-merge" },
        timestamp
      });
      eventSequence = Math.max(eventSequence, treeEvent.sequence);
      return {
        ok: true,
        path: this.path,
        updated_at: timestamp,
        revision,
        event_sequence: eventSequence
      };
    });
  }

  writeTree(tree, index = [], expectedRevision = null, sourceClientId = "") {
    if (!isObject(tree)) throw new Error("tree must be an object");
    return this.transaction(() => {
      const currentRevision = this.revision();
      if (expectedRevision != null && expectedRevision !== currentRevision) {
        return { ok: false, conflict: true, revision: currentRevision };
      }
      const timestamp = nowMs();
      const revision = this.bumpRevision(timestamp, {
        tree,
        index: Array.isArray(index) ? index : []
      });
      const event = this.recordEvent("tree.updated", {
        revision,
        sourceClientId,
        timestamp
      });
      return { ok: true, revision, event_sequence: event.sequence };
    });
  }

  readSession(sessionId) {
    const id = normalizeId(sessionId);
    const current = this.currentSession(id);
    if (current.exists) {
      return {
        id,
        text: current.text,
        meta: { ...current.meta, id },
        session_revision: current.revision,
        content_hash: contentHash(current.text, current.meta),
        updated_at: current.updatedAt
      };
    }
    const tombstone = this.db.prepare(
      "SELECT revision, deleted_at FROM runtime_workbench_tombstones WHERE id = ?"
    ).get(id);
    return tombstone ? {
      id,
      deleted: true,
      session_revision: Number(tombstone.revision),
      deleted_at: Number(tombstone.deleted_at)
    } : null;
  }

  updateSession(sessionId, input = {}) {
    const id = normalizeId(sessionId);
    return this.transaction(() => {
      const duplicate = this.duplicateOperation(input.operation_id);
      if (duplicate) return duplicate;
      const globalRevision = this.revision();
      if (input.expected_revision != null && input.expected_revision !== globalRevision) {
        return { ok: false, conflict: true, revision: globalRevision };
      }
      const current = this.currentSession(id);
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
      const timestamp = nowMs();
      const nextText = input.text == null ? current.text : String(input.text);
      const explicitMeta = isObject(input.meta) ? input.meta : {};
      const metaCandidate = input.meta == null
        ? { ...current.meta }
        : { ...explicitMeta, id };
      if (input.title != null) metaCandidate.title = String(input.title || "");
      if (input.text != null) {
        if (!Object.prototype.hasOwnProperty.call(explicitMeta, "size")) delete metaCandidate.size;
        if (!Object.prototype.hasOwnProperty.call(explicitMeta, "hash")) delete metaCandidate.hash;
        if (!Object.prototype.hasOwnProperty.call(explicitMeta, "updatedAt")) delete metaCandidate.updatedAt;
      }
      const metaTimestamp = input.meta == null && input.title == null && input.text == null
        ? Number(current.meta?.updatedAt || timestamp) || timestamp
        : timestamp;
      const next = {
        text: nextText,
        meta: normalizeSessionMeta(id, nextText, metaCandidate, metaTimestamp)
      };
      this.db.prepare(`
        INSERT INTO runtime_workbench_documents (id, text, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
      `).run(id, next.text, timestamp);
      this.db.prepare(`
        INSERT INTO runtime_workbench_metadata (id, meta_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET meta_json = excluded.meta_json, updated_at = excluded.updated_at
      `).run(id, encode(next.meta), timestamp);
      this.db.prepare("DELETE FROM runtime_workbench_tombstones WHERE id = ?").run(id);
      const sessionRevision = current.revision + 1;
      this.saveSessionRevision(
        id,
        next,
        sessionRevision,
        String(input.reason || "update"),
        input.operation_id,
        timestamp
      );
      const currentTree = this.stateTree();
      const title = next.meta.title || id;
      const titleUpdate = updateSessionNodeTitle(currentTree, id, title);
      const tree = titleUpdate.found
        ? titleUpdate.tree
        : upsertSessionNode(currentTree, id, {
            parentId: input.parent_id || input.parentId || "root",
            title
          });
      const revision = this.bumpRevision(timestamp, {
        tree,
        index: this.rebuildIndexFromTree(tree)
      });
      const event = this.recordEvent(current.exists ? "session.updated" : "session.created", {
        sessionId: id,
        revision,
        sessionRevision,
        sourceClientId: input.source_client_id,
        payload: {
          reason: String(input.reason || "update"),
          changed: [
            ...(input.text == null ? [] : ["document"]),
            ...(input.meta == null && input.title == null ? [] : ["metadata"])
          ],
          indexEntry: this.sessionIndexEntry(id, next.meta, next.text)
        },
        timestamp
      });
      const result = {
        ok: true,
        revision,
        session_revision: sessionRevision,
        event_sequence: event.sequence
      };
      this.recordOperation(input.operation_id, id, sessionRevision, result, timestamp);
      return result;
    });
  }

  deleteSession(sessionId, input = {}) {
    const id = normalizeId(sessionId);
    return this.transaction(() => {
      const duplicate = this.duplicateOperation(input.operation_id);
      if (duplicate) return duplicate;
      const globalRevision = this.revision();
      if (input.expected_revision != null && input.expected_revision !== globalRevision) {
        return { ok: false, conflict: true, revision: globalRevision };
      }
      const current = this.currentSession(id);
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
      const timestamp = nowMs();
      const sessionRevision = current.revision + 1;
      if (current.exists) {
        this.saveSessionRevision(
          id,
          current,
          sessionRevision,
          "delete",
          input.operation_id,
          timestamp
        );
      }
      this.db.prepare("DELETE FROM runtime_workbench_documents WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM runtime_workbench_metadata WHERE id = ?").run(id);
      this.db.prepare(
        "DELETE FROM runtime_collaboration_documents WHERE session_id = ?"
      ).run(id);
      this.db.prepare(`
        INSERT INTO runtime_workbench_session_heads (id, revision, content_hash, updated_at)
        VALUES (?, ?, '', ?)
        ON CONFLICT(id) DO UPDATE SET
          revision = excluded.revision,
          content_hash = '',
          updated_at = excluded.updated_at
      `).run(id, sessionRevision, timestamp);
      this.db.prepare(`
        INSERT INTO runtime_workbench_tombstones (id, revision, deleted_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, deleted_at = excluded.deleted_at
      `).run(id, sessionRevision, timestamp);
      const tree = this.stateTree();
      removeSessionNode(tree, id);
      const revision = this.bumpRevision(timestamp, {
        tree,
        index: this.rebuildIndexFromTree(tree)
      });
      const event = this.recordEvent("session.deleted", {
        sessionId: id,
        revision,
        sessionRevision,
        sourceClientId: input.source_client_id,
        payload: { deletedAt: timestamp },
        timestamp
      });
      const result = {
        ok: true,
        revision,
        session_revision: sessionRevision,
        event_sequence: event.sequence
      };
      this.recordOperation(input.operation_id, id, sessionRevision, result, timestamp);
      return result;
    });
  }

  listSessionRevisions(sessionId) {
    const id = normalizeId(sessionId);
    return this.db.prepare(`
      SELECT session_id, revision, content_hash, reason, operation_id, created_at
      FROM runtime_workbench_session_revisions
      WHERE session_id = ?
      ORDER BY revision DESC
    `).all(id).map((row) => ({
      session_id: row.session_id,
      revision: Number(row.revision),
      content_hash: row.content_hash,
      reason: row.reason,
      operation_id: row.operation_id,
      created_at: Number(row.created_at)
    }));
  }

  restoreSessionRevision(sessionId, revision, operationId = null) {
    const id = normalizeId(sessionId);
    const row = this.db.prepare(`
      SELECT text, meta_json
      FROM runtime_workbench_session_revisions
      WHERE session_id = ? AND revision = ?
    `).get(id, Number(revision));
    if (!row) {
      const error = new Error("session revision not found");
      error.statusCode = 404;
      throw error;
    }
    return this.updateSession(id, {
      text: row.text,
      meta: decode(row.meta_json, {}),
      operation_id: operationId,
      reason: "restore"
    });
  }

  readKV(key) {
    const normalized = normalizeId(key, "key");
    const row = this.db.prepare(
      "SELECT value_json, updated_at FROM runtime_workbench_kv WHERE key = ?"
    ).get(normalized);
    return row ? {
      key: normalized,
      value: decode(row.value_json),
      updated_at: Number(row.updated_at)
    } : null;
  }

  writeKV(key, value, {
    sourceClientId = ""
  } = {}) {
    const normalized = normalizeId(key, "key");
    return this.transaction(() => {
      const timestamp = nowMs();
      const valueJson = encode(value);
      const existing = this.db.prepare(
        "SELECT value_json, updated_at FROM runtime_workbench_kv WHERE key = ?"
      ).get(normalized);
      if (existing?.value_json === valueJson) {
        return {
          ok: true,
          duplicate: true,
          key: normalized,
          updated_at: Number(existing.updated_at || 0),
          revision: this.revision(),
          event_sequence: 0
        };
      }
      this.db.prepare(`
        INSERT INTO runtime_workbench_kv (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(normalized, valueJson, timestamp);
      const revision = this.bumpRevision(timestamp);
      const event = this.recordEvent("kv.updated", {
        revision,
        sourceClientId,
        payload: { key: normalized },
        timestamp
      });
      return {
        ok: true,
        key: normalized,
        updated_at: timestamp,
        revision,
        event_sequence: event.sequence
      };
    });
  }

  migrateBrowserStorage(sourceId, snapshot, fingerprint) {
    const source = normalizeId(sourceId, "source id");
    const marker = normalizeId(fingerprint, "fingerprint");
    const existing = this.db.prepare(`
      SELECT result_json FROM runtime_state_migrations
      WHERE source = ? AND fingerprint = ?
    `).get(source, marker);
    if (existing) return { ...decode(existing.result_json, {}), duplicate: true };

    const current = this.readSnapshot()?.snapshot;
    if (!current) {
      const result = this.writeSnapshot(snapshot || {});
      const imported = (snapshot?.docs || []).map((item) => String(item?.id || "")).filter(Boolean);
      const report = { ...result, verified: result.ok === true, imported, archived: [] };
      this.db.prepare(`
        INSERT INTO runtime_state_migrations (source, fingerprint, result_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(source, marker, encode(report), nowMs());
      return report;
    }

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
    const knownIndexIds = new Set((current.index || []).map((item) => String(item?.id || "")));
    const write = this.writeSnapshot({
      docs,
      metas,
      kv: snapshot?.kv || {},
      tree: appendMissingSessionsToTree(
        current.tree,
        imported.map((id) => ({
          id,
          title: importedMetas.get(id)?.title || id
        }))
      ),
      index: [
        ...(current.index || []),
        ...importedIndex.filter((item) => !knownIndexIds.has(String(item?.id || "")))
      ]
    });
    const report = {
      ...write,
      verified: write.ok === true,
      imported: [...new Set(imported)],
      archived: [...new Set(archived)]
    };
    this.db.prepare(`
      INSERT INTO runtime_state_migrations (source, fingerprint, result_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(source, marker, encode(report), nowMs());
    return report;
  }

  hasMigration(source, fingerprint) {
    return !!this.db.prepare(`
      SELECT 1 FROM runtime_state_migrations WHERE source = ? AND fingerprint = ?
    `).get(String(source), String(fingerprint));
  }

  hasMigrationSource(source) {
    return !!this.db.prepare(`
      SELECT 1 FROM runtime_state_migrations WHERE source = ? LIMIT 1
    `).get(String(source));
  }

  recordMigration(source, fingerprint, result) {
    this.db.prepare(`
      INSERT OR REPLACE INTO runtime_state_migrations
        (source, fingerprint, result_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(String(source), String(fingerprint), encode(result), nowMs());
  }

  close() {
    this.eventListeners.clear();
    this.pendingPublishedEvents.length = 0;
    this.db.close();
  }
}
