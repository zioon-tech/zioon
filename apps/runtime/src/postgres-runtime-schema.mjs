import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

const migration002 = fileURLToPath(
  new URL("./postgres/migrations/002_runtime_data.sql", import.meta.url)
);
const migration003 = fileURLToPath(
  new URL("./postgres/migrations/003_assets.sql", import.meta.url)
);
const migration004 = fileURLToPath(
  new URL("./postgres/migrations/004_run_event_details.sql", import.meta.url)
);

const migrations = [
  [2, migration002],
  [3, migration003],
  [4, migration004]
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
