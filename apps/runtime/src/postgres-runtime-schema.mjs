import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const migration002 = join(moduleDirectory, "postgres/migrations/002_runtime_data.sql");
const migration003 = join(moduleDirectory, "postgres/migrations/003_assets.sql");
const migration004 = join(moduleDirectory, "postgres/migrations/004_run_event_details.sql");
const migration005 = join(moduleDirectory, "postgres/migrations/005_run_outbox.sql");
const migration006 = join(moduleDirectory, "postgres/migrations/006_runtime_webhooks.sql");
const migration007 = join(moduleDirectory, "postgres/migrations/007_conversation_inputs.sql");
const migration008 = join(moduleDirectory, "postgres/migrations/008_run_completion_tasks.sql");

const migrations = [
  [2, migration002],
  [3, migration003],
  [4, migration004],
  [5, migration005],
  [6, migration006],
  [7, migration007],
  [8, migration008]
];

export async function initializePostgresRuntimeSchema(pool, {
  now = () => Date.now()
} = {}) {
  if (!pool?.connect) throw new Error("PostgreSQL Runtime schema requires a Pool");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(983724611)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS runtime_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at BIGINT NOT NULL
      )
    `);
    for (const [version, path] of migrations) {
      const applied = await client.query(
        "SELECT 1 FROM runtime_schema_migrations WHERE version = $1",
        [version]
      );
      if (applied.rowCount) continue;
      await client.query(await readFile(path, "utf8"));
      await client.query(
        `INSERT INTO runtime_schema_migrations (version, applied_at)
         VALUES ($1, $2)`,
        [version, now()]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
