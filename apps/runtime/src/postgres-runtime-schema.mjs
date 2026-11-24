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
const migration009 = join(moduleDirectory, "postgres/migrations/009_identity_contexts.sql");
const migration011 = join(moduleDirectory, "postgres/migrations/011_shared_spaces.sql");
const migration012 = join(moduleDirectory, "postgres/migrations/012_account_sharing.sql");
const migration013 = join(moduleDirectory, "postgres/migrations/013_content_run_grants.sql");
const migration014 = join(moduleDirectory, "postgres/migrations/014_share_recipient_roles.sql");
const migration015 = join(moduleDirectory, "postgres/migrations/015_document_links.sql");
const migration016 = join(moduleDirectory, "postgres/migrations/016_revision_annotation_lookup.sql");
const migration017 = join(moduleDirectory, "postgres/migrations/017_immutable_message_blobs.sql");
const migration018 = join(moduleDirectory, "postgres/migrations/018_message_segments.sql");
const migration019 = join(moduleDirectory, "postgres/migrations/019_model_detail_capacity.sql");
const migration020 = join(moduleDirectory, "postgres/migrations/020_run_event_archives.sql");
const migration021 = join(moduleDirectory, "postgres/migrations/021_receipt_bodies.sql");
const migration022 = join(moduleDirectory, "postgres/migrations/022_observability_start.sql");
const migration023 = join(moduleDirectory, "postgres/migrations/023_collaboration_updates.sql");
const migration024 = join(moduleDirectory, "postgres/migrations/024_session_card_bodies.sql");

const migrations = [
  [2, migration002],
  [3, migration003],
  [4, migration004],
  [5, migration005],
  [6, migration006],
  [7, migration007],
  [8, migration008],
  [9, migration009],
  [11, migration011],
  [12, migration012],
  [13, migration013],
  [14, migration014],
  [15, migration015],
  [16, migration016],
  [17, migration017],
  [18, migration018],
  [19, migration019],
  [20, migration020],
  [21, migration021],
  [22, migration022],
  [23, migration023],
  [24, migration024]
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
