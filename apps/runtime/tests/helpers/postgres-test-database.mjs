import { randomBytes } from "node:crypto";
import pg from "pg";
import { PostgresAccountStore } from "../../src/accounts/postgres-account-store.mjs";
import { initializePostgresRuntimeSchema } from "../../src/postgres-runtime-schema.mjs";

const { Pool } = pg;

export const postgresTestUrl = String(
  process.env.ZION_TEST_POSTGRES_URL
  || process.env.ZION_DATABASE_URL
  || "postgresql://zion@127.0.0.1:55432/zion?sslmode=disable"
).trim();

export async function createPostgresTestDatabase(prefix = "runtime") {
  const safePrefix = String(prefix).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 24);
  const schema = `zion_${safePrefix}_${randomBytes(8).toString("hex")}`;
  const admin = new Pool({
    connectionString: postgresTestUrl,
    max: 1,
    application_name: "zion-test-schema-admin"
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: postgresTestUrl,
    max: 12,
    options: `-c search_path=${schema}`,
    application_name: `zion-test-${safePrefix}`
  });
  const accounts = await new PostgresAccountStore({ pool }).initialize();
  await initializePostgresRuntimeSchema(pool);
  const defaultUser = await accounts.resolveIdentity({
    issuer: "https://tests.zion.invalid",
    subject: `${safePrefix}:${randomBytes(8).toString("hex")}`,
    name: "Runtime Test"
  });
  const defaultSpace = await accounts.personalSpace(defaultUser.id);
  const availableSpaceIds = Array.from(
    { length: 64 },
    (_, index) => `space:test:${safePrefix}:${index}:${randomBytes(4).toString("hex")}`
  );
  await pool.query(
    `INSERT INTO account_spaces (id, name, kind, created_by, created_at)
     SELECT id, 'Runtime Test', 'team', $2, $3
     FROM unnest($1::text[]) AS id`,
    [availableSpaceIds, defaultUser.id, Date.now()]
  );
  let spaceCursor = 0;
  return {
    accounts,
    connectionString: postgresTestUrl,
    pool,
    schema,
    defaultSpaceId: defaultSpace.id,
    nextSpaceId() {
      const spaceId = availableSpaceIds[spaceCursor];
      if (!spaceId) throw new Error("PostgreSQL test Space pool is exhausted");
      spaceCursor += 1;
      return spaceId;
    },
    childEnvironment: {
      ZION_DATABASE_URL: postgresTestUrl,
      PGOPTIONS: `-c search_path=${schema}`
    },
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  };
}

export async function resetPostgresTestRuntime(database) {
  const result = await database.pool.query(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = current_schema()
       AND (
         tablename LIKE 'runtime\\_%' ESCAPE '\\'
         OR tablename LIKE 'obs\\_%' ESCAPE '\\'
         OR tablename LIKE 'local\\_identity\\_%' ESCAPE '\\'
       )
       AND tablename NOT IN ('runtime_schema_migrations')
     ORDER BY tablename`
  );
  if (!result.rowCount) return;
  const tables = result.rows.map(({ tablename }) =>
    `"${String(tablename).replaceAll('"', '""')}"`
  );
  await database.pool.query(`TRUNCATE TABLE ${tables.join(", ")} CASCADE`);
}

export async function provisionTestTeam(database, {
  spaceId = "space:test",
  spaceName = "Test Space",
  issuer = "https://identity.test",
  ownerSubject = "owner",
  ownerName = "Owner"
} = {}) {
  const owner = await database.accounts.resolveIdentity({
    issuer,
    subject: ownerSubject,
    name: ownerName
  });
  const createdAt = Date.now();
  await database.pool.query(
    `INSERT INTO account_spaces (id, name, kind, created_by, created_at)
     VALUES ($1, $2, 'team', $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [spaceId, spaceName, owner.id, createdAt]
  );
  await database.pool.query(
    `INSERT INTO account_memberships
     (space_id, user_id, role, status, revision, created_at, updated_at)
     VALUES ($1, $2, 'owner', 'active', 1, $3, $3)
     ON CONFLICT (space_id, user_id) DO UPDATE SET
       role = 'owner', status = 'active',
       revision = account_memberships.revision + 1,
       updated_at = EXCLUDED.updated_at`,
    [spaceId, owner.id, createdAt]
  );
  return owner;
}
