import { createHash } from "node:crypto";
import { validateSandboxBindings } from "./sandbox-tool-broker.mjs";
import { fingerprint } from "../../../../packages/sandbox/src/provider.mjs";

export function provisioningError(code, statusCode = 503) {
  return Object.assign(new Error(
    code === "sandbox_provisioning_busy"
      ? "你的云端工作区正在准备，请稍后重试。"
      : "云端工作区暂时无法开通，请稍后重试。"
  ), { code, statusCode });
}

/** One durable volume per account. Connection locks serialize cloud mutations;
 * each completed step is committed independently so restarts can reconcile it. */
export class AccountWorkspaceProvisioner {
  constructor({ pool, cloud, bindings = [], now = Date.now, onError = () => {} }) {
    this.pool = pool;
    this.cloud = cloud;
    this.bindings = bindings;
    this.now = now;
    this.onError = onError;
    this.pending = new Map();
    this.active = 0;
    this.waiters = [];
  }

  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS runtime_account_workspaces (
      account_id TEXT PRIMARY KEY REFERENCES account_users(id),
      workspace_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      resources JSONB NOT NULL DEFAULT '{}',
      binding JSONB,
      error_code TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      retry_at BIGINT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS runtime_account_workspace_mount
      ON runtime_account_workspaces ((((binding->'storageMetadata'->>'fc.sandbox.storage.agenticfs')::jsonb)
        ->'mountPoints'->0->>'serverAddr'))
      WHERE binding IS NOT NULL`);
    for (const binding of this.bindings) {
      await this.pool.query(`INSERT INTO runtime_account_workspaces
        (account_id,workspace_id,status,binding,updated_at) VALUES ($1,$2,'ready',$3,$4)
        ON CONFLICT(account_id) DO NOTHING`,
      [binding.accountId, binding.workspaceId, binding, this.now()]);
      const row = (await this.pool.query(
        "SELECT binding FROM runtime_account_workspaces WHERE account_id=$1", [binding.accountId]
      )).rows[0];
      if (fingerprint(row.binding) !== fingerprint(binding)) {
        throw new Error("Existing account volume differs from imported binding; migration required");
      }
    }
    const ready = (await this.pool.query(
      "SELECT binding FROM runtime_account_workspaces WHERE status='ready'"
    )).rows.map((row) => row.binding);
    if (ready.length) validateSandboxBindings(ready);
    this.bindings.splice(0, this.bindings.length, ...ready);
    return this;
  }

  remember(binding) {
    const previous = this.bindings.find((item) => item.accountId === binding.accountId);
    if (previous && fingerprint(previous) !== fingerprint(binding)) {
      throw new Error("Account volume binding changed; migration required");
    }
    if (!previous) {
      validateSandboxBindings([...this.bindings, binding]);
      this.bindings.push(binding);
    }
    return binding;
  }

  ensure(accountId) {
    if (this.pending.has(accountId)) return this.pending.get(accountId);
    const operation = this.provision(accountId).finally(() => this.pending.delete(accountId));
    this.pending.set(accountId, operation);
    return operation;
  }

  async provision(accountId) {
    const user = (await this.pool.query(
      "SELECT status FROM account_users WHERE id=$1", [accountId]
    )).rows[0];
    if (user?.status !== "active") throw provisioningError("account_disabled", 403);
    const ready = (await this.pool.query(
      "SELECT binding FROM runtime_account_workspaces WHERE account_id=$1 AND status='ready'", [accountId]
    )).rows[0];
    if (ready) return this.remember(ready.binding);
    // Leave pool connections available for authentication and existing Runs.
    if (this.active >= 2) await new Promise((resolve) => this.waiters.push(resolve));
    else this.active++;
    const releaseSlot = () => {
      if (this.waiters.length) this.waiters.shift()();
      else this.active--;
    };
    let client;
    try { client = await this.pool.connect(); }
    catch (error) { releaseSlot(); throw error; }
    const digest = createHash("sha256").update(`zion-account-volume:${accountId}`).digest();
    const lockId = digest.readBigInt64BE().toString();
    const key = digest.toString("hex").slice(0, 32);
    let locked = false;
    let lost = false;
    const onLost = () => { lost = true; };
    client.on("error", onLost);
    const query = (...args) => {
      if (lost) throw provisioningError("sandbox_provisioning_connection_lost");
      return client.query(...args);
    };
    try {
      locked = (await query(
        "SELECT pg_try_advisory_lock($1::bigint) AS locked", [lockId]
      )).rows[0].locked;
      if (!locked) throw provisioningError("sandbox_provisioning_busy");
      await query(`INSERT INTO runtime_account_workspaces
        (account_id,workspace_id,status,updated_at) VALUES ($1,$2,'pending',$3)
        ON CONFLICT(account_id) DO NOTHING`, [accountId, `workspace:account-${key}`, this.now()]);
      const row = (await query(
        "SELECT * FROM runtime_account_workspaces WHERE account_id=$1", [accountId]
      )).rows[0];
      if (row.status === "ready") return this.remember(row.binding);
      if (Number(row.retry_at) > this.now()) throw provisioningError(row.error_code || "sandbox_provisioning_busy");
      await query(`UPDATE runtime_account_workspaces SET
        status='provisioning',attempts=attempts+1,error_code=NULL,updated_at=$2 WHERE account_id=$1`,
      [accountId, this.now()]);
      const resources = { ...row.resources };
      const save = async (patch) => {
        await query("SELECT pg_backend_pid()");
        Object.assign(resources, patch);
        await query(`UPDATE runtime_account_workspaces SET resources=$2,updated_at=$3
          WHERE account_id=$1`, [accountId, resources, this.now()]);
      };
      const binding = await this.cloud.provision({
        accountId, workspaceId: row.workspace_id, key, resources, save,
        assertOwned: () => query("SELECT pg_backend_pid()")
      });
      validateSandboxBindings([...this.bindings.filter((b) => b.accountId !== accountId), binding]);
      await query(`UPDATE runtime_account_workspaces SET
        status='ready',binding=$2,error_code=NULL,retry_at=0,updated_at=$3 WHERE account_id=$1`,
      [accountId, binding, this.now()]);
      return this.remember(binding);
    } catch (error) {
      const code = /^[a-z_]{1,80}$/.test(error?.code || "")
        ? error.code : "sandbox_provisioning_failed";
      if (locked && !lost) {
        await client.query(`UPDATE runtime_account_workspaces SET
          status='failed',error_code=$2,retry_at=$3,updated_at=$4 WHERE account_id=$1 AND status<>'ready'`,
        [accountId, code, this.now() + 30_000, this.now()]).catch(() => {});
      }
      this.onError({ accountId, code });
      throw provisioningError(code);
    } finally {
      if (locked && !lost) {
        try { await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]); }
        catch { lost = true; }
      }
      client.removeListener("error", onLost);
      client.release(lost);
      releaseSlot();
    }
  }
}
