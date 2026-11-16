import { createHash } from "node:crypto";

// Account/Space/backend binding is supplied by the provider. No public KV route
// can read these projections; identical source versions share one stored body.
export class PostgresIdentityContextStore {
  constructor(pool) { this.pool = pool; }
  scopeKey(scope) { return createHash("sha256").update(scope).digest("hex"); }
  async read(scope, sessionId = "", cached = null) {
    const result = await this.pool.query(
      `SELECT b.revision, CASE WHEN b.revision = $3 THEN NULL
        ELSE c.snapshot_json END AS snapshot_json FROM runtime_identity_context_bindings b
       JOIN runtime_identity_contexts c USING (scope_key, revision)
       WHERE b.scope_key = $1 AND b.session_id = $2`,
      [this.scopeKey(scope), sessionId, cached?.revision || null]
    );
    return result.rows[0]?.snapshot_json
      || (result.rows[0]?.revision === cached?.revision ? cached : null);
  }
  async reserveRefresh(scope, sessionId) {
    const result = await this.pool.query(
      `INSERT INTO runtime_identity_context_bindings (scope_key, session_id, refresh_epoch)
       VALUES ($1, $2, 1) ON CONFLICT (scope_key, session_id)
       DO UPDATE SET refresh_epoch = runtime_identity_context_bindings.refresh_epoch + 1
       RETURNING refresh_epoch`, [this.scopeKey(scope), sessionId]
    );
    return String(result.rows[0].refresh_epoch);
  }
  async publish(scope, sessionId, snapshot, { force = false, refreshEpoch } = {}) {
    const key = this.scopeKey(scope);
    const revision = createHash("sha256").update(JSON.stringify([
      snapshot.sourceHashes, snapshot.content, snapshot.sourceRoot
    ])).digest("hex");
    const value = { ...snapshot, revision };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize publication for this scope, including first-session races,
      // latest pointers and removal of superseded, unreferenced projections.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
      if (refreshEpoch !== undefined) {
        const selected = await client.query(
          `SELECT refresh_epoch FROM runtime_identity_context_bindings
           WHERE scope_key = $1 AND session_id = $2`, [key, sessionId]
        );
        if (String(selected.rows[0]?.refresh_epoch) !== String(refreshEpoch)) {
          throw Object.assign(new Error("Identity refresh superseded by a newer request"), { statusCode: 409 });
        }
      }
      await client.query(
        `INSERT INTO runtime_identity_contexts VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`, [key, revision, value]
      );
      for (const id of new Set(["", sessionId || ""])) {
        await client.query(
          `INSERT INTO runtime_identity_context_bindings (scope_key, session_id, revision) VALUES ($1, $2, $3)
           ON CONFLICT (scope_key, session_id) ${!id || force
            ? "DO UPDATE SET revision = EXCLUDED.revision"
            : "DO UPDATE SET revision = EXCLUDED.revision WHERE runtime_identity_context_bindings.revision IS NULL"}`,
          [key, id, revision]
        );
      }
      const result = await client.query(
        `SELECT c.snapshot_json FROM runtime_identity_context_bindings b
         JOIN runtime_identity_contexts c USING (scope_key, revision)
         WHERE b.scope_key = $1 AND b.session_id = $2`, [key, sessionId || ""]
      );
      await client.query(
        `DELETE FROM runtime_identity_contexts c WHERE scope_key = $1
         AND NOT EXISTS (SELECT 1 FROM runtime_identity_context_bindings b
           WHERE b.scope_key = c.scope_key AND b.revision = c.revision)`, [key]
      );
      await client.query("COMMIT");
      return result.rows[0].snapshot_json;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}
