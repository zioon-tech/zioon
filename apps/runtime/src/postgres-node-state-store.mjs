import {
  RECEIPT_CACHE_MAX_BYTES, encodeReceiptBody, hydrateReceiptRows, receiptReadSql, storeReceiptBody
} from "./receipt-bodies.mjs";

function jsonValue(value) {
  if (typeof value === "string") return JSON.parse(value);
  return JSON.parse(JSON.stringify(value));
}

function receiptFromRow(row) {
  return row && {
    invocationId: String(row.invocation_id),
    nodeId: String(row.node_id),
    result: JSON.parse(JSON.stringify(row.result_json)),
    completedAt: Number(row.completed_at)
  };
}

export class PostgresNodeStateStore {
  backend = "postgres";

  constructor(pool, { spaceId } = {}) {
    if (!pool?.query || !pool?.connect) {
      throw new Error("PostgreSQL Node state store requires a Pool");
    }
    if (!spaceId) throw new Error("PostgreSQL Node state store requires a Space ID");
    this.pool = pool;
    this.spaceId = String(spaceId);
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

  async loadState({ receiptLimit = 1_000, receiptMaxBytes = RECEIPT_CACHE_MAX_BYTES } = {}) {
    const limit = Number.isSafeInteger(receiptLimit) && receiptLimit > 0
      ? receiptLimit
      : 1_000;
    const byteLimit = Number.isSafeInteger(receiptMaxBytes) && receiptMaxBytes >= 0
      ? receiptMaxBytes : RECEIPT_CACHE_MAX_BYTES;
    const [nodes, bindings, receipts] = await Promise.all([
      this.pool.query(
        `SELECT registration_json, last_seen_at
         FROM runtime_device_nodes
         WHERE space_id = $1 ORDER BY node_id ASC`,
        [this.spaceId]
      ),
      this.pool.query(
        `SELECT project_id, node_id, resource_id, updated_at
         FROM runtime_project_bindings
         WHERE space_id = $1
         ORDER BY project_id ASC, node_id ASC, resource_id ASC`,
        [this.spaceId]
      ),
      this.pool.query(
        receiptReadSql(`WITH recent AS MATERIALIZED (
          SELECT r.*,CASE WHEN r.result_ref IS NULL THEN octet_length(r.result_json::text)
            ELSE COALESCE(b.raw_bytes,0) END AS result_bytes
          FROM (SELECT * FROM runtime_invocation_receipts WHERE space_id=$1
            ORDER BY completed_at DESC,invocation_id DESC LIMIT $2) r
          LEFT JOIN runtime_receipt_bodies b ON b.space_id=r.space_id AND b.ref=r.result_ref
        ), sized AS (
          SELECT *,sum(result_bytes) OVER (ORDER BY completed_at DESC,invocation_id DESC) AS total
          FROM recent WHERE result_bytes<=$3
        ) SELECT * FROM sized WHERE total<=$3`),
        [this.spaceId, limit, byteLimit]
      )
    ]);
    return {
      nodes: nodes.rows.map((row) => ({
        registration: jsonValue(row.registration_json),
        lastSeenAt: Number(row.last_seen_at)
      })),
      projectBindings: bindings.rows.map((row) => ({
        projectId: String(row.project_id),
        nodeId: String(row.node_id),
        resourceId: String(row.resource_id),
        updatedAt: Number(row.updated_at)
      })),
      receipts: (await hydrateReceiptRows(receipts.rows))
        .sort((a, b) => Number(a.completed_at) - Number(b.completed_at)
          || String(a.invocation_id).localeCompare(String(b.invocation_id)))
        .map(receiptFromRow)
    };
  }

  async registerNode(registration, observedAt) {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO runtime_device_nodes
         (space_id, node_id, registration_json, last_seen_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $4)
         ON CONFLICT (space_id, node_id) DO UPDATE SET
           registration_json = EXCLUDED.registration_json,
           last_seen_at = EXCLUDED.last_seen_at,
           updated_at = EXCLUDED.updated_at`,
        [
          this.spaceId,
          registration.nodeId,
          JSON.stringify(registration),
          observedAt
        ]
      );
      await client.query(
        `DELETE FROM runtime_project_bindings
         WHERE space_id = $1 AND node_id = $2`,
        [this.spaceId, registration.nodeId]
      );
      for (const resource of registration.resources) {
        if (!resource.projectId) continue;
        await client.query(
          `INSERT INTO runtime_project_bindings
           (space_id, project_id, node_id, resource_id, updated_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            this.spaceId,
            resource.projectId,
            registration.nodeId,
            resource.resourceId,
            observedAt
          ]
        );
      }
    });
  }

  async touchNode(nodeId, observedAt) {
    await this.pool.query(
      `UPDATE runtime_device_nodes
       SET last_seen_at = $1, updated_at = $1
       WHERE space_id = $2 AND node_id = $3`,
      [observedAt, this.spaceId, nodeId]
    );
  }

  async getReceipt(invocationId) {
    const result = await this.pool.query(
      receiptReadSql(`SELECT * FROM runtime_invocation_receipts
        WHERE space_id=$1 AND invocation_id=$2`),
      [this.spaceId, invocationId]
    );
    return receiptFromRow((await hydrateReceiptRows(result.rows))[0]);
  }

  async saveReceipt({ invocationId, nodeId, result, completedAt }) {
    const encoded = await encodeReceiptBody(result);
    const write = await this.transaction(async client => {
      const inserted = await client.query(
      `INSERT INTO runtime_invocation_receipts
       (space_id, invocation_id, node_id, result_json, completed_at, result_skip_reason)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (space_id, invocation_id) DO NOTHING
       RETURNING invocation_id, node_id, completed_at`,
      [
        this.spaceId,
        invocationId,
        nodeId,
        JSON.stringify(encoded.body ? encoded.header : encoded.value),
        completedAt,
        encoded.skipReason || null
      ]
      );
      if (inserted.rowCount && encoded.body) await storeReceiptBody(client, "runtime_invocation_receipts",
        this.spaceId, invocationId, result, encoded);
      return inserted;
    });
    if (write.rowCount) {
      // The caller already owns the result; avoid transferring it back from
      // PostgreSQL. A competing write still uses the committed receipt.
      return { invocationId, nodeId, result, completedAt, duplicate: false };
    }
    const receipt = await this.getReceipt(invocationId);
    if (!receipt) {
      throw new Error(`Invocation receipt was not persisted: ${invocationId}`);
    }
    return { ...receipt, duplicate: true };
  }

  async countReceipts() {
    const result = await this.pool.query(
      `SELECT COUNT(*) AS count FROM runtime_invocation_receipts
       WHERE space_id = $1`,
      [this.spaceId]
    );
    return Number(result.rows[0].count);
  }

  async close() {}
}
