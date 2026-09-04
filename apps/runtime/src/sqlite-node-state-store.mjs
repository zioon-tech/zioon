import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require(["node", "sqlite"].join(":"));

function encode(value) {
  return JSON.stringify(value);
}

function decode(value) {
  return JSON.parse(String(value));
}

export class SqliteNodeStateStore {
  constructor(path) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 30000;

      CREATE TABLE IF NOT EXISTS runtime_device_nodes (
        node_id TEXT PRIMARY KEY,
        registration_json TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_project_bindings (
        project_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, node_id, resource_id)
      );

      CREATE TABLE IF NOT EXISTS runtime_invocation_receipts (
        invocation_id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        completed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS runtime_project_bindings_node
        ON runtime_project_bindings(node_id);
      CREATE INDEX IF NOT EXISTS runtime_invocation_receipts_completed
        ON runtime_invocation_receipts(completed_at DESC);
    `);
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Some filesystems do not support POSIX permissions.
      }
    }
  }

  loadState({ receiptLimit = 1_000 } = {}) {
    const limit = Number.isSafeInteger(receiptLimit) && receiptLimit > 0
      ? receiptLimit
      : 1_000;
    const nodes = this.db.prepare(`
      SELECT registration_json, last_seen_at
      FROM runtime_device_nodes
      ORDER BY node_id ASC
    `).all().map((row) => ({
      registration: decode(row.registration_json),
      lastSeenAt: Number(row.last_seen_at)
    }));
    const projectBindings = this.db.prepare(`
      SELECT project_id, node_id, resource_id, updated_at
      FROM runtime_project_bindings
      ORDER BY project_id ASC, node_id ASC, resource_id ASC
    `).all().map((row) => ({
      projectId: String(row.project_id),
      nodeId: String(row.node_id),
      resourceId: String(row.resource_id),
      updatedAt: Number(row.updated_at)
    }));
    const receipts = this.db.prepare(`
      SELECT invocation_id, node_id, result_json, completed_at
      FROM runtime_invocation_receipts
      ORDER BY completed_at DESC, invocation_id DESC
      LIMIT ?
    `).all(limit).reverse().map((row) => ({
      invocationId: String(row.invocation_id),
      nodeId: String(row.node_id),
      result: decode(row.result_json),
      completedAt: Number(row.completed_at)
    }));
    return { nodes, projectBindings, receipts };
  }

  registerNode(registration, observedAt) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO runtime_device_nodes
          (node_id, registration_json, last_seen_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          registration_json = excluded.registration_json,
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
      `).run(
        registration.nodeId,
        encode(registration),
        observedAt,
        observedAt
      );
      this.db.prepare(
        "DELETE FROM runtime_project_bindings WHERE node_id = ?"
      ).run(registration.nodeId);
      const insertBinding = this.db.prepare(`
        INSERT INTO runtime_project_bindings
          (project_id, node_id, resource_id, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const resource of registration.resources) {
        if (!resource.projectId) continue;
        insertBinding.run(
          resource.projectId,
          registration.nodeId,
          resource.resourceId,
          observedAt
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  touchNode(nodeId, observedAt) {
    this.db.prepare(`
      UPDATE runtime_device_nodes
      SET last_seen_at = ?, updated_at = ?
      WHERE node_id = ?
    `).run(observedAt, observedAt, nodeId);
  }

  getReceipt(invocationId) {
    const row = this.db.prepare(`
      SELECT invocation_id, node_id, result_json, completed_at
      FROM runtime_invocation_receipts
      WHERE invocation_id = ?
    `).get(invocationId);
    return row
      ? {
          invocationId: String(row.invocation_id),
          nodeId: String(row.node_id),
          result: decode(row.result_json),
          completedAt: Number(row.completed_at)
        }
      : null;
  }

  saveReceipt({ invocationId, nodeId, result, completedAt }) {
    const write = this.db.prepare(`
      INSERT INTO runtime_invocation_receipts
        (invocation_id, node_id, result_json, completed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(invocation_id) DO NOTHING
    `).run(invocationId, nodeId, encode(result), completedAt);
    const receipt = this.getReceipt(invocationId);
    if (!receipt) {
      throw new Error(`Invocation receipt was not persisted: ${invocationId}`);
    }
    return {
      ...receipt,
      duplicate: Number(write.changes) === 0
    };
  }

  countReceipts() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM runtime_invocation_receipts
    `).get();
    return Number(row.count);
  }

  close() {
    this.db.close();
  }
}
