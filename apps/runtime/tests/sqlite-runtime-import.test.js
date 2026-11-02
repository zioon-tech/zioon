import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectSqliteSource,
  migrateSqliteRuntime
} from "../../../scripts/import-sqlite-runtime-to-postgres.mjs";
import {
  createPostgresTestDatabase
} from "./helpers/postgres-test-database.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require(["node", "sqlite"].join(":"));
const { Pool } = pg;

const resources = [];

afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) {
    if (typeof resource === "function") await resource();
  }
});

function tempDir() {
  const directory = mkdtempSync(join(tmpdir(), "zion-sqlite-import-"));
  resources.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function createFixtureSqlite() {
  const directory = tempDir();
  const sqlitePath = join(directory, "runtime.sqlite3");
  const db = new DatabaseSync(sqlitePath);
  db.exec(`
    CREATE TABLE runtime_runs (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE runtime_run_events (
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, sequence)
    );
    CREATE TABLE runtime_sessions (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE runtime_session_messages (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, sequence),
      UNIQUE (session_id, run_id, role)
    );
    CREATE TABLE runtime_workbench_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      tree_json TEXT NOT NULL,
      index_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE runtime_workbench_documents (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE runtime_workbench_metadata (
      id TEXT PRIMARY KEY,
      meta_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE runtime_workbench_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      session_id TEXT,
      run_id TEXT,
      revision TEXT,
      session_revision INTEGER,
      source_client_id TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE runtime_scheduler_tasks (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      next_run INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE runtime_invocation_receipts (
      invocation_id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO runtime_runs (id, payload_json, status, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(
    "run:1",
    JSON.stringify({ id: "run:1", status: "completed", updatedAt: 20 }),
    "completed",
    20
  );
  db.prepare(`
    INSERT INTO runtime_run_events
      (run_id, sequence, event_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "run:1",
    1,
    "event:1",
    JSON.stringify({ runId: "run:1", sequence: 1, type: "run.completed" }),
    21
  );
  db.prepare(`
    INSERT INTO runtime_run_events
      (run_id, sequence, event_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "run:1",
    2,
    "event:model-request",
    JSON.stringify({
      runId: "run:1",
      sequence: 2,
      type: "model.request",
      data: {
        turn: 1,
        providerId: "test",
        payload: {
          model: "test-model",
          messages: [{ role: "user", content: "PRIVATE_PROMPT".repeat(200) }],
          tools: [{ type: "function", function: { name: "search" } }],
          temperature: 0.2
        }
      }
    }),
    22
  );
  db.prepare(`
    INSERT INTO runtime_sessions (id, payload_json, status, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(
    "session:1",
    JSON.stringify({ id: "session:1", status: "active", updatedAt: 30 }),
    "active",
    30
  );
  db.prepare(`
    INSERT INTO runtime_session_messages
      (session_id, sequence, message_id, run_id, role, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    "session:1",
    1,
    "message:1",
    "run:1",
    "assistant",
    JSON.stringify({ id: "message:1", content: "done" }),
    31
  );
  db.prepare(`
    INSERT INTO runtime_workbench_state
      (id, version, revision, tree_json, index_json, updated_at)
    VALUES (1, ?, ?, ?, ?, ?)
  `).run(
    1,
    7,
    JSON.stringify({ id: "root", type: "folder", children: [] }),
    JSON.stringify([{ id: "session:1", title: "Imported" }]),
    40
  );
  db.prepare(`
    INSERT INTO runtime_workbench_documents (id, text, updated_at)
    VALUES (?, ?, ?)
  `).run("session:1", "# Imported", 41);
  db.prepare(`
    INSERT INTO runtime_workbench_metadata (id, meta_json, updated_at)
    VALUES (?, ?, ?)
  `).run("session:1", JSON.stringify({ title: "Imported" }), 41);
  db.prepare(`
    INSERT INTO runtime_workbench_events
      (type, session_id, run_id, revision, session_revision, source_client_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "session.updated",
    "session:1",
    null,
    "7",
    7,
    "test",
    JSON.stringify({ id: "session:1" }),
    42
  );
  db.prepare(`
    INSERT INTO runtime_scheduler_tasks
      (id, payload_json, enabled, next_run, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    "task:1",
    JSON.stringify({ id: "task:1", title: "Import task" }),
    1,
    100,
    50,
    51
  );
  db.prepare(`
    INSERT INTO runtime_invocation_receipts
      (invocation_id, node_id, result_json, completed_at)
    VALUES (?, ?, ?, ?)
  `).run(
    "receipt:1",
    "node:1",
    JSON.stringify({ ok: true, content: "cache-only" }),
    60
  );
  db.close();
  return { sqlitePath, directory };
}

function createLegacySchedulerSqlite() {
  const directory = tempDir();
  const sqlitePath = join(directory, "runtime.sqlite3");
  const db = new DatabaseSync(sqlitePath);
  db.exec(`
    CREATE TABLE runtime_scheduler_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO runtime_scheduler_state (id, payload_json, updated_at)
    VALUES (1, ?, ?)
  `).run(JSON.stringify({
    tasks: [{
      id: "legacy-task",
      title: "Legacy Task",
      enabled: true,
      nextRun: 123,
      createdAt: 100,
      updatedAt: 101
    }],
    runs: [{
      id: "legacy-run",
      taskId: "legacy-task",
      occurrenceId: "legacy-occurrence",
      status: "pending",
      createdAt: 110,
      updatedAt: 111
    }]
  }), 120);
  db.close();
  return { sqlitePath, directory };
}

describe("SQLite Runtime import inspection", () => {
  it("reports table counts and stable hashes without PostgreSQL", () => {
    const { sqlitePath } = createFixtureSqlite();
    const first = inspectSqliteSource(sqlitePath, { chunkSize: 2 });
    const second = inspectSqliteSource(sqlitePath, { chunkSize: 3 });

    expect(first.integrity).toBe("ok");
    expect(first.sourceHash).toBe(second.sourceHash);
    expect(first.tables.find((table) => table.table === "runtime_runs")).toMatchObject({
      status: "ready",
      count: 1
    });
    expect(first.tables.find((table) => table.table === "runtime_run_events"))
      .toMatchObject({ status: "ready", count: 2, compactedRows: 1 });
    expect(first.tables.find((table) => table.table === "runtime_run_events").compactedBytesAfter)
      .toBeLessThan(
        first.tables.find((table) => table.table === "runtime_run_events").compactedBytesBefore
      );
    expect(first.tables.find((table) => table.table === "runtime_access_devices")).toMatchObject({
      status: "missing",
      count: 0
    });
    expect(first.tables.find((table) => table.table === "runtime_invocation_receipts"))
      .toMatchObject({ status: "skipped-internal-cache", count: 1 });

    const raw = inspectSqliteSource(sqlitePath, {
      chunkSize: 2,
      compactModelRequests: false
    });
    expect(raw.tables.find((table) => table.table === "runtime_run_events").hash)
      .not.toBe(first.tables.find((table) => table.table === "runtime_run_events").hash);
    const counted = inspectSqliteSource(sqlitePath, {
      chunkSize: 2,
      verify: "count"
    });
    expect(counted.tables.find((table) => table.table === "runtime_run_events"))
      .toMatchObject({ status: "ready", count: 2, hash: "count:2" });
  });

  it("detects legacy Scheduler snapshot rows when normalized tables are absent", () => {
    const { sqlitePath } = createLegacySchedulerSqlite();
    const report = inspectSqliteSource(sqlitePath, { chunkSize: 1 });

    expect(report.tables.find((table) => table.table === "runtime_scheduler_tasks"))
      .toMatchObject({ status: "legacy-snapshot", count: 1 });
    expect(report.tables.find((table) => table.table === "runtime_scheduler_runs"))
      .toMatchObject({ status: "legacy-snapshot", count: 1 });
  });
});

const integrationSuite = process.env.ZION_TEST_POSTGRES_URL ? describe : describe.skip;

integrationSuite("SQLite Runtime import to PostgreSQL", () => {
  it("imports legacy rows into one owner-managed Space and verifies hashes", async () => {
    const database = await createPostgresTestDatabase("sqlite_import");
    resources.push(() => database.close());
    const previousPgOptions = process.env.PGOPTIONS;
    process.env.PGOPTIONS = database.childEnvironment.PGOPTIONS;
    resources.push(() => {
      if (previousPgOptions == null) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = previousPgOptions;
    });
    const { sqlitePath, directory } = createFixtureSqlite();
    const spaceId = `space:import:${randomBytes(4).toString("hex")}`;

    const report = await migrateSqliteRuntime({
      sqlitePath,
      databaseUrl: process.env.ZION_TEST_POSTGRES_URL,
      spaceId,
      spaceName: "Imported Production",
      ownerIssuer: "https://identity.test",
      ownerSubject: "owner:import",
      ownerName: "Import Owner",
      backupDir: join(directory, "backup"),
      apply: true,
      chunkSize: 2
    });

    expect(report.ok).toBe(true);
    expect(report.backup).toHaveLength(1);
    expect(report.owner).toMatchObject({ spaceId, role: "owner" });
    expect(report.tables.find((table) => table.table === "runtime_runs")).toMatchObject({
      imported: 1,
      targetCount: 1
    });

    const pool = new Pool({
      connectionString: process.env.ZION_TEST_POSTGRES_URL,
      max: 1,
      options: database.childEnvironment.PGOPTIONS
    });
    resources.push(() => pool.end());
    const runs = await pool.query(
      "SELECT payload_json FROM runtime_runs WHERE space_id = $1",
      [spaceId]
    );
    const modelRequests = await pool.query(
      `SELECT payload_json FROM runtime_run_events
       WHERE space_id = $1 AND event_id = 'event:model-request'`,
      [spaceId]
    );
    const space = await pool.query(
      `SELECT s.id, m.role
       FROM account_spaces s
       JOIN account_memberships m ON m.space_id = s.id
       WHERE s.id = $1`,
      [spaceId]
    );
    expect(runs.rows[0].payload_json).toMatchObject({ id: "run:1" });
    expect(modelRequests.rows[0].payload_json.data).toMatchObject({
      summaryVersion: 1,
      messageCount: 1,
      toolCount: 1,
      config: { model: "test-model", temperature: 0.2 }
    });
    expect(JSON.stringify(modelRequests.rows[0].payload_json))
      .not.toContain("PRIVATE_PROMPT");
    expect(space.rows[0]).toMatchObject({ id: spaceId, role: "owner" });
  });
});
