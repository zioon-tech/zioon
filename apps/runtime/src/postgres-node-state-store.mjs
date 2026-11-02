function jsonValue(value) {
  if (typeof value === "string") return JSON.parse(value);
  return JSON.parse(JSON.stringify(value));
}

function receiptFromRow(row) {
  return row && {
    invocationId: String(row.invocation_id),
    nodeId: String(row.node_id),
    result: jsonValue(row.result_json),
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

  async loadState({ receiptLimit = 1_000 } = {}) {
    const limit = Number.isSafeInteger(receiptLimit) && receiptLimit > 0
      ? receiptLimit
      : 1_000;
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
        `SELECT invocation_id, node_id, result_json, completed_at
         FROM (
           SELECT invocation_id, node_id, result_json, completed_at
           FROM runtime_invocation_receipts
           WHERE space_id = $1
           ORDER BY completed_at DESC, invocation_id DESC
           LIMIT $2
         ) recent
         ORDER BY completed_at ASC, invocation_id ASC`,
        [this.spaceId, limit]
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
      receipts: receipts.rows.map(receiptFromRow)
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
      `SELECT invocation_id, node_id, result_json, completed_at
       FROM runtime_invocation_receipts
       WHERE space_id = $1 AND invocation_id = $2`,
      [this.spaceId, invocationId]
    );
    return receiptFromRow(result.rows[0]);
  }

  async saveReceipt({ invocationId, nodeId, result, completedAt }) {
    const write = await this.pool.query(
      `INSERT INTO runtime_invocation_receipts
       (space_id, invocation_id, node_id, result_json, completed_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (space_id, invocation_id) DO NOTHING`,
      [
        this.spaceId,
        invocationId,
        nodeId,
        JSON.stringify(result),
        completedAt
      ]
    );
    const receipt = await this.getReceipt(invocationId);
    if (!receipt) {
      throw new Error(`Invocation receipt was not persisted: ${invocationId}`);
    }
    return { ...receipt, duplicate: write.rowCount === 0 };
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
