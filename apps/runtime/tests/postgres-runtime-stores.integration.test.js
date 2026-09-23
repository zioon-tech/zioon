import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAccountStore } from "../src/accounts/postgres-account-store.mjs";
import { PostgresAccessStore } from "../src/postgres-access-store.mjs";
import { PostgresAssetStore } from "../src/postgres-asset-store.mjs";
import { PostgresNodeStateStore } from "../src/postgres-node-state-store.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { initializePostgresRuntimeSchema } from "../src/postgres-runtime-schema.mjs";
import { PostgresSchedulerStore } from "../src/postgres-scheduler-store.mjs";
import {
  PostgresWorkbenchStateStore
} from "../src/postgres-workbench-state-store.mjs";
import {
  PostgresObservabilityProjection
} from "../src/observability/postgres-projection.mjs";

const { Pool } = pg;
const connectionString = process.env.ZION_TEST_POSTGRES_URL || "";
const suite = connectionString ? describe : describe.skip;
const schema = `zion_runtime_test_${randomBytes(8).toString("hex")}`;

function runRecord(id, sessionId, timestamp = Date.now()) {
  return {
    schemaVersion: 1,
    id,
    attemptId: `${id}:attempt`,
    sessionId,
    status: "queued",
    prompt: "test",
    policy: { preset: "read-only", allowedTools: [] },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function runEvent(run, sequence, type, timestamp = Date.now()) {
  return {
    schemaVersion: 1,
    eventId: `${run.id}:event:${sequence}`,
    runId: run.id,
    attemptId: run.attemptId,
    sequence,
    type,
    timestamp,
    data: type === "run.completed"
      ? { output: "done", usage: { input: 1, output: 2 } }
      : {}
  };
}

function schedulerTask(title) {
  return {
    title,
    taskType: "agent",
    prompt: "inspect",
    schedule: { kind: "interval", intervalMinutes: 5 },
    capability: {
      preset: "read-only",
      allowedTools: ["read"],
      fileRoots: [],
      allowedCommandPrefixes: [],
      allowedTerminalSessionIds: [],
      allowedRecipients: [],
      maxMailPerRun: 0,
      maxToolCalls: 5
    }
  };
}

suite("PostgreSQL Runtime stores", () => {
  let admin;
  let pool;
  let accounts;
  let spaceA;
  let spaceB;

  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString,
      max: 8,
      options: `-c search_path=${schema}`
    });
    accounts = await new PostgresAccountStore({ pool }).initialize();
    const alice = await accounts.resolveIdentity({
      issuer: "https://identity.test",
      subject: "runtime-alice",
      name: "Alice",
      email: "alice-runtime@example.test",
      emailVerified: true
    });
    const bob = await accounts.resolveIdentity({
      issuer: "https://identity.test",
      subject: "runtime-bob",
      name: "Bob",
      email: "bob-runtime@example.test",
      emailVerified: true
    });
    [spaceA] = await accounts.listSpaces(alice.id);
    [spaceB] = await accounts.listSpaces(bob.id);
    await initializePostgresRuntimeSchema(pool);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("persists Run, Session, receipt, artifact, and todo data by Space", async () => {
    const a = new PostgresRunStore(pool, { spaceId: spaceA.id });
    const b = new PostgresRunStore(pool, { spaceId: spaceB.id });
    const timestamp = Date.now();
    const session = {
      id: "session:shared-name",
      status: "active",
      title: "A",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const run = runRecord("run:shared-name", session.id, timestamp);
    await a.createSession(session);
    await a.create(run);
    await a.append(runEvent(run, 1, "run.started", timestamp + 1));
    await a.append(runEvent(run, 2, "run.completed", timestamp + 2), {
      status: "completed",
      completedAt: timestamp + 2,
      output: "done"
    });
    await a.appendSessionMessages(session.id, [{
      id: "message:a",
      sessionId: session.id,
      runId: run.id,
      role: "user",
      content: "hello",
      createdAt: timestamp
    }]);
    await a.saveToolReceipt({
      invocationId: "invocation:a",
      runId: run.id,
      toolName: "read",
      requestHash: "hash",
      result: { ok: true, content: "ok" },
      completedAt: timestamp + 2
    });
    await a.saveRunArtifacts({
      runId: run.id,
      invocationId: "invocation:a",
      artifacts: [{ id: "artifact:a", createdAt: timestamp + 2 }],
      changes: []
    });
    await a.saveTodoList(
      "session:shared-name",
      [{ content: "ship" }],
      timestamp + 3
    );

    expect((await a.get(run.id)).status).toBe("completed");
    expect(await a.getEvents(run.id)).toHaveLength(2);
    expect(await a.getSessionMessages(session.id)).toHaveLength(1);
    expect(await a.countToolReceipts()).toBe(1);
    expect((await a.listRunArtifacts(run.id)).artifacts).toHaveLength(1);
    expect((await a.getTodoList(session.id)).todos).toHaveLength(1);
    expect(await b.get(run.id)).toBeNull();
    expect(await b.getSession(session.id)).toBeNull();
    expect(await b.getToolReceipt("invocation:a")).toBeNull();
  });

  it("stores model request details compressed outside the event payload", async () => {
    const a = new PostgresRunStore(pool, { spaceId: spaceA.id });
    const b = new PostgresRunStore(pool, { spaceId: spaceB.id });
    const timestamp = Date.now();
    const run = runRecord("run:model-request-detail", "", timestamp);
    const request = {
      model: "test-model",
      messages: [
        { role: "system", content: "injected context ".repeat(2_000) },
        { role: "user", content: "inspect" }
      ],
      tools: [{
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } }
        }
      }]
    };
    await a.create(run);
    await a.append({
      ...runEvent(run, 1, "model.request", timestamp + 1),
      data: { turn: 1, payload: request }
    });

    const [summary] = await a.getEvents(run.id);
    expect(summary.data).toMatchObject({
      summaryVersion: 1,
      messageCount: 2,
      toolCount: 1,
      detailAvailable: true,
      rawRunId: run.id,
      rawEventSequence: 1
    });
    expect(summary.data.payload).toBeUndefined();

    expect(await a.getEvent(run.id, 1)).toMatchObject({
      type: "model.request",
      data: { payload: request }
    });
    expect(await b.getEvent(run.id, 1)).toBeNull();

    const stored = await pool.query(
      `SELECT uncompressed_bytes, compressed_bytes
       FROM runtime_run_event_details
       WHERE space_id = $1 AND run_id = $2 AND sequence = 1`,
      [spaceA.id, run.id]
    );
    expect(Number(stored.rows[0].compressed_bytes))
      .toBeLessThan(Number(stored.rows[0].uncompressed_bytes));
  });

  it("persists Asset metadata without exposing it across Spaces", async () => {
    const a = new PostgresAssetStore(pool, { spaceId: spaceA.id });
    const b = new PostgresAssetStore(pool, { spaceId: spaceB.id });
    const created = await a.create({
      id: "asset:shared-name",
      ownerId: "user:a",
      state: "ready",
      mediaKind: "image",
      mediaType: "image/png",
      byteLength: 128,
      sha256: "a".repeat(64),
      blobKey: `sha256/aa/${"a".repeat(64)}`,
      originalName: "screen.png",
      createdAt: Date.now()
    });

    expect(created).toMatchObject({
      id: "asset:shared-name",
      mediaType: "image/png",
      byteLength: 128
    });
    expect(await b.get(created.id)).toBeNull();
  });

  it("serializes Workbench revisions and isolates equal Session IDs", async () => {
    const a = await new PostgresWorkbenchStateStore(pool, {
      spaceId: spaceA.id
    }).initialize();
    const b = await new PostgresWorkbenchStateStore(pool, {
      spaceId: spaceB.id
    }).initialize();
    await a.createSession({ id: "session:same", text: "A" });
    await b.createSession({ id: "session:same", text: "B" });
    expect((await a.readSession("session:same")).text).toBe("A");
    expect((await b.readSession("session:same")).text).toBe("B");

    const expected = (await a.readSession("session:same")).session_revision;
    const writes = await Promise.all([
      a.updateSession("session:same", {
        text: "A1",
        expected_session_revision: expected
      }),
      a.updateSession("session:same", {
        text: "A2",
        expected_session_revision: expected
      })
    ]);
    expect(writes.filter((result) => result.ok)).toHaveLength(1);
    expect(writes.filter((result) => result.conflict)).toHaveLength(1);
    expect((await a.listEvents(0)).events.length).toBeGreaterThanOrEqual(2);
  });

  it("claims Scheduler work once and preserves Space isolation", async () => {
    const a = new PostgresSchedulerStore(pool, {
      spaceId: spaceA.id,
      availableTools: ["read"]
    });
    const b = new PostgresSchedulerStore(pool, {
      spaceId: spaceB.id,
      availableTools: ["read"]
    });
    const task = await a.createTask(schedulerTask("A task"));
    const run = await a.runNow(task.id);
    const [first, second] = await Promise.all([
      a.claim({ workerId: "worker:a", availableTools: ["read"] }),
      a.claim({ workerId: "worker:b", availableTools: ["read"] })
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const claimed = first || second;
    expect(claimed.id).toBe(run.id);
    await a.complete(claimed.id, claimed.workerId, {
      status: "success",
      output: "done"
    });
    expect((await a.getRun(run.id)).status).toBe("success");
    expect(await b.listTasks()).toEqual([]);
  });

  it("keeps pairing credentials and Node state inside their Space", async () => {
    const accessA = new PostgresAccessStore(pool, { spaceId: spaceA.id });
    const accessB = new PostgresAccessStore(pool, { spaceId: spaceB.id });
    const pairing = await accessA.createPairing({
      kind: "resource",
      delivery: "bearer",
      label: "Node A"
    });
    await expect(accessB.inspectPairing(pairing)).rejects.toThrow("invalid");
    const exchanged = await accessA.exchangePairing({
      ...pairing,
      deviceId: "node:a"
    });
    expect(await accessA.authenticate(exchanged.credential)).toBeTruthy();
    expect(await accessB.authenticate(exchanged.credential)).toBeNull();

    const nodesA = new PostgresNodeStateStore(pool, { spaceId: spaceA.id });
    const nodesB = new PostgresNodeStateStore(pool, { spaceId: spaceB.id });
    await nodesA.registerNode({
      nodeId: "node:a",
      resources: [{ projectId: "project:a", resourceId: "resource:a" }]
    }, 100);
    await nodesA.saveReceipt({
      invocationId: "node-invocation:a",
      nodeId: "node:a",
      result: { ok: true, content: "done" },
      completedAt: 101
    });
    expect((await nodesA.loadState()).nodes).toHaveLength(1);
    expect((await nodesA.loadState()).projectBindings).toHaveLength(1);
    expect(await nodesA.countReceipts()).toBe(1);
    expect((await nodesB.loadState()).nodes).toEqual([]);
  });

  it("rebuilds the sanitized observability projection per Space", async () => {
    const runsA = new PostgresRunStore(pool, { spaceId: spaceA.id });
    const runsB = new PostgresRunStore(pool, { spaceId: spaceB.id });
    const projectionA = await new PostgresObservabilityProjection({
      pool,
      runs: runsA,
      spaceId: spaceA.id
    }).initialize();
    const projectionB = await new PostgresObservabilityProjection({
      pool,
      runs: runsB,
      spaceId: spaceB.id
    }).initialize();
    await projectionA.flush();
    await projectionB.flush();
    expect((await projectionA.status()).counts.runs).toBeGreaterThanOrEqual(1);
    expect((await projectionB.status()).counts.runs).toBe(0);

    const role = await pool.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
    );
    if (!role.rows[0].rolsuper && !role.rows[0].rolbypassrls) {
      const result = await projectionA.query({
        sql: "SELECT run_id, status FROM obs_runs ORDER BY timestamp DESC"
      });
      expect(result.rows.some((row) => row.run_id === "run:shared-name")).toBe(true);
    } else {
      await expect(projectionA.query({
        sql: "SELECT run_id FROM obs_runs"
      })).rejects.toThrow("BYPASSRLS");
    }
  });
});
