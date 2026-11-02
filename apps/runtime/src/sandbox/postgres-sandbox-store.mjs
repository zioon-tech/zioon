import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export class PostgresSandboxStore {
  constructor(pool, { spaceId }) {
    this.pool = pool;
    this.spaceId = spaceId;
    // Execution owners must not exhaust the Runtime query pool: authorization
    // and receipts still need that pool while commands are running.
    this.ownershipPool = new pool.constructor({
      ...pool.options, max: Math.max(32, pool.options.max || 10),
      allowExitOnIdle: true, application_name: "zion-sandbox-ownership"
    });
  }

  async close() { await this.ownershipPool.end(); }

  async initialize() {
    // Opt-in component: these tables are never created by local/node mode.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS runtime_sandbox_workspaces (
        space_id TEXT NOT NULL, account_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        epoch BIGINT NOT NULL DEFAULT 0, active JSONB, binding_hash TEXT,
        PRIMARY KEY (space_id, account_id, workspace_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_sandbox_operations (
        space_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
        account_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        request_hash TEXT NOT NULL, result JSONB,
        PRIMARY KEY (space_id, invocation_id)
      );
      ALTER TABLE runtime_sandbox_workspaces ADD COLUMN IF NOT EXISTS binding_hash TEXT;
      ALTER TABLE runtime_sandbox_workspaces ADD COLUMN IF NOT EXISTS instance JSONB;
      ALTER TABLE runtime_sandbox_workspaces ADD COLUMN IF NOT EXISTS last_used_at BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE runtime_sandbox_operations ADD COLUMN IF NOT EXISTS active JSONB;
      CREATE INDEX IF NOT EXISTS runtime_sandbox_active_operations
        ON runtime_sandbox_operations(space_id,account_id,workspace_id) WHERE active IS NOT NULL;
      CREATE TABLE IF NOT EXISTS runtime_sandbox_terminals (
        space_id TEXT NOT NULL, account_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        id TEXT NOT NULL, epoch BIGINT NOT NULL, pid INTEGER NOT NULL, data JSONB NOT NULL,
        PRIMARY KEY(space_id,account_id,workspace_id,id)
      )
    `);
    return this;
  }

  async workspaces() {
    return (await this.catalog()).filter((row) => row.instance || row.active);
  }
  async terminals(accountId, workspaceId) {
    return (await this.pool.query(`SELECT * FROM runtime_sandbox_terminals
      WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3`, [this.spaceId, accountId, workspaceId])).rows;
  }
  async saveTerminal(accountId, workspaceId, terminal) {
    await this.pool.query(`INSERT INTO runtime_sandbox_terminals
      (space_id,account_id,workspace_id,id,epoch,pid,data) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(space_id,account_id,workspace_id,id) DO UPDATE SET
        epoch=EXCLUDED.epoch,pid=EXCLUDED.pid,data=EXCLUDED.data`,
    [this.spaceId, accountId, workspaceId, terminal.id, terminal.epoch, terminal.pid, terminal]);
  }
  async deleteTerminal(accountId, workspaceId, id) {
    await this.pool.query(`DELETE FROM runtime_sandbox_terminals
      WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3 AND id=$4`, [this.spaceId, accountId, workspaceId, id]);
  }
  async deleteTerminals(accountId, workspaceId) {
    await this.pool.query(`DELETE FROM runtime_sandbox_terminals
      WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3`, [this.spaceId, accountId, workspaceId]);
  }
  async catalog() {
    return (await this.pool.query(this.snapshotQuery() + " WHERE w.space_id=$1", [this.spaceId])).rows;
  }
  async workspace(accountId, workspaceId) {
    return (await this.pool.query(this.snapshotQuery() + `
      WHERE w.space_id=$1 AND w.account_id=$2 AND w.workspace_id=$3`,
    [this.spaceId, accountId, workspaceId])).rows[0] || null;
  }
  snapshotQuery() {
    return `SELECT w.account_id,w.workspace_id,w.epoch,w.instance,w.last_used_at,
      COALESCE(w.active,ops.items->0) AS active,
      COALESCE(ops.items,'[]'::jsonb) AS active_operations,
      jsonb_array_length(COALESCE(ops.items,'[]'::jsonb)) + CASE WHEN w.active IS NULL THEN 0 ELSE 1 END AS active_count
      FROM runtime_sandbox_workspaces w LEFT JOIN LATERAL (
        SELECT jsonb_agg(o.active ORDER BY o.invocation_id) AS items
        FROM runtime_sandbox_operations o WHERE o.space_id=w.space_id
          AND o.account_id=w.account_id AND o.workspace_id=w.workspace_id AND o.active IS NOT NULL
      ) ops ON true`;
  }

  withWorkspace(accountId, workspaceId, task, bindingHash = null) {
    return this.withOwnership(accountId, workspaceId, task, { bindingHash });
  }
  withExecution(accountId, workspaceId, invocationId, task, bindingHash, signal) {
    return this.withOwnership(accountId, workspaceId, task, { bindingHash, invocationId, signal });
  }
  async withOwnership(accountId, workspaceId, task, { bindingHash = null, invocationId = null, signal } = {}) {
    const client = await this.ownershipPool.connect();
    const lockKey = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest().readBigInt64BE().toString();
    const key = lockKey([this.spaceId, accountId, workspaceId]);
    const claim = invocationId ? lockKey(["sandbox-invocation", this.spaceId, invocationId]) : null;
    const shared = invocationId != null;
    let locked = false;
    let claimed = false;
    // Losing a session fences DB transitions; the per-operation journal lets
    // recovery stop only the lost owner's process, without recycling the VM.
    let lost = false;
    const onError = () => { lost = true; };
    client.on("error", onError);
    const query = (...args) => {
      if (lost) throw new Error("Sandbox ownership connection was lost");
      return client.query(...args);
    };
    try {
      signal?.throwIfCancelled();
      locked = (await query(`SELECT pg_try_advisory_lock${shared ? "_shared" : ""}($1::bigint) AS locked`, [key])).rows[0].locked;
      if (!locked) {
        return {
          ok: false,
          content: "Workspace lifecycle change cannot overlap running operations.",
          failureCode: "sandbox_workspace_busy", retryable: true,
          dispatched: false, busyReason: "lifecycle_maintenance"
        };
      }
      if (claim) {
        do {
          signal?.throwIfCancelled();
          claimed = (await query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [claim])).rows[0].locked;
          if (!claimed) await delay(25);
        } while (!claimed);
      }
      const keys = [this.spaceId, accountId, workspaceId];
      await query(`INSERT INTO runtime_sandbox_workspaces(space_id, account_id, workspace_id)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, keys);
      const state = (await query(`SELECT * FROM runtime_sandbox_workspaces
        WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3`, keys)).rows[0];
      if (bindingHash) {
        if (state.binding_hash && state.binding_hash !== bindingHash) {
          throw new Error("Sandbox persistent storage binding changed; explicit migration required");
        }
        if (!state.binding_hash) await query(`UPDATE runtime_sandbox_workspaces SET binding_hash=$4
          WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3`, [...keys, bindingHash]);
      }
      let currentActive;
      return await task({
        state,
        instance: async (instance) => {
          await query(`UPDATE runtime_sandbox_workspaces SET instance=$4
            WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3`, [...keys, instance]);
          state.instance = instance;
        },
        used: async (now) => {
          await query(`UPDATE runtime_sandbox_workspaces SET last_used_at=$4
            WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3`, [...keys, now]);
          state.last_used_at = now;
        },
        assertOwned: () => query("SELECT pg_backend_pid() AS pid"),
        get: async (id) => (await query(`SELECT * FROM runtime_sandbox_operations
          WHERE space_id=$1 AND invocation_id=$2`, [this.spaceId, id])).rows[0],
        activeOperations: async () => (await query(`SELECT * FROM runtime_sandbox_operations
          WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3 AND active IS NOT NULL`, keys)).rows,
        claimOperation: async (id, reconcile) => {
          const orphanKey = lockKey(["sandbox-invocation", this.spaceId, id]);
          if (!(await query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [orphanKey])).rows[0].locked) return false;
          try { await reconcile(); return true; }
          finally { await query("SELECT pg_advisory_unlock($1::bigint)", [orphanKey]); }
        },
        findUnknown: async (hash) => (await query(`SELECT * FROM runtime_sandbox_operations
          WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3
          AND request_hash=$4 AND result->>'failureCode'='execution_outcome_unknown' LIMIT 1`,
        [...keys, hash])).rows[0],
        begin: async (active, hash) => {
          await query("BEGIN");
          try {
            await query(`INSERT INTO runtime_sandbox_operations
              (space_id, invocation_id, account_id, workspace_id, request_hash,active)
              VALUES ($1,$2,$3,$4,$5,$6)`, [this.spaceId, active.invocationId, accountId, workspaceId, hash, shared ? active : null]);
            if (!shared) await query(`UPDATE runtime_sandbox_workspaces SET active=$4, epoch=$5
                WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3`,
              [...keys, active, active.scope.epoch]);
            await query("COMMIT");
          } catch (error) { await query("ROLLBACK"); throw error; }
          currentActive = active;
          if (!shared) { state.active = active; state.epoch = active.scope.epoch; }
        },
        handle: async (handle) => {
          currentActive.handle = handle;
          await query(`UPDATE runtime_sandbox_workspaces SET active=$4
            WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3`, [...keys, currentActive]);
        },
        execution: async (execution) => {
          currentActive.execution = execution;
          await query(`UPDATE runtime_sandbox_operations SET active=$3
            WHERE space_id=$1 AND invocation_id=$2`, [this.spaceId, invocationId, currentActive]);
        },
        clearLifecycle: async () => {
          await query(`UPDATE runtime_sandbox_workspaces SET active=NULL
            WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3`, keys);
          state.active = null;
        },
        finish: async (id, result, { clear = true } = {}) => {
          await query("BEGIN");
          try {
            await query(`UPDATE runtime_sandbox_operations SET result=$3,
                active=CASE WHEN $4 THEN NULL ELSE active END
              WHERE space_id=$1 AND invocation_id=$2`, [this.spaceId, id, result, clear]);
            if (clear && state.active?.invocationId === id) await query(`UPDATE runtime_sandbox_workspaces SET active=NULL
                WHERE space_id=$1 AND account_id=$2 AND workspace_id=$3`, keys);
            await query("COMMIT");
          } catch (error) { await query("ROLLBACK"); throw error; }
          if (clear && state.active?.invocationId === id) state.active = null;
        }
      });
    } finally {
      if (locked && !lost) {
        try {
          if (claimed) await client.query("SELECT pg_advisory_unlock($1::bigint)", [claim]);
          await client.query(`SELECT pg_advisory_unlock${shared ? "_shared" : ""}($1::bigint)`, [key]);
        }
        catch { lost = true; }
      }
      client.removeListener("error", onError);
      client.release(lost);
    }
  }
}
