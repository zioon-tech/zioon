import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  encodeReceiptBody, decodeReceiptBody, receiptReadSql, hydrateReceiptRows,
  PostgresReceiptMaintenanceStore, restoreReceiptBodyBatch, RECEIPT_BODY_MAX_BYTES
} from "../src/receipt-bodies.mjs";
import { PostgresNodeStateStore } from "../src/postgres-node-state-store.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { NodeBroker } from "../src/node-broker.mjs";
import { SpaceExecutionStore } from "../src/spaces/space-execution-store.mjs";
import { CancellationController } from "../../../packages/runtime/src/index";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

let db;
beforeAll(async () => { db = await createPostgresTestDatabase("receipt_bodies"); });
afterAll(async () => { await db?.close(); });
const large = (suffix = "") => ({ ok: true, retryable: false, content: ("中文执行输出\n" + suffix).repeat(500) });
const nodeStore = spaceId => new PostgresNodeStateStore(db.pool, { spaceId });
const runStore = spaceId => new PostgresRunStore(db.pool, { spaceId });
async function save(store, id, result, extra = {}) {
  return store.saveReceipt
    ? store.saveReceipt({ invocationId: id, nodeId: "device", result, completedAt: 100, ...extra })
    : store.saveToolReceipt({ invocationId: id, runId: "run", toolName: "Bash", requestHash: "request",
      result, completedAt: 100, ...extra });
}
async function raw(table, spaceId, id) {
  return (await db.pool.query(`SELECT * FROM ${table} WHERE space_id=$1 AND invocation_id=$2`, [spaceId, id])).rows[0];
}
async function transaction(action) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const value = await action(client);
    await client.query("COMMIT");
    return value;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function legacy(spaceId, id, result, table = "runtime_invocation_receipts") {
  const columns = table === "runtime_invocation_receipts" ? "node_id" : "run_id,tool_name,request_hash";
  const values = table === "runtime_invocation_receipts" ? "'device'" : "'run','Bash','request'";
  await db.pool.query(`INSERT INTO ${table}(space_id,invocation_id,${columns},result_json,completed_at)
    VALUES ($1,$2,${values},$3::jsonb,100)`, [spaceId, id, JSON.stringify(result)]);
}

describe("lossless receipt bodies with real PostgreSQL", () => {
  it.each(["node", "tool"])("preserves exact legacy/new JSON values and metadata (%s)", async kind => {
    const spaceId = db.nextSpaceId(), store = kind === "node" ? nodeStore(spaceId) : runStore(spaceId);
    const read = id => kind === "node" ? store.getReceipt(id) : store.getToolReceipt(id);
    const table = kind === "node" ? "runtime_invocation_receipts" : "runtime_tool_invocation_receipts";
    for (const [i, result] of [null, false, 42, "字符串", ["x", null], {}, large()].entries()) {
      await legacy(spaceId, `old-${i}`, result, table);
      await save(store, `new-${i}`, result);
      expect((await read(`old-${i}`)).result).toEqual(result);
      expect((await read(`new-${i}`)).result).toEqual(result);
    }
    const row = await raw(table, spaceId, "new-6");
    expect(row.result_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(row.result_json).toEqual({ ok: true, retryable: false });
    if (kind === "tool") {
      expect(await store.findToolReceiptByRequestHash("run", "Bash", "request")).toMatchObject({
        requestHash: "request", runId: "run", toolName: "Bash", completedAt: 100
      });
      expect(await store.getToolReceiptForSpace("new-6", "run", db.nextSpaceId())).toBeNull();
      expect(await store.getToolReceiptForSpace("new-6", "wrong", spaceId)).toBeNull();
    }
  });

  it("deduplicates across receipt kinds only inside the owner and transfers one body per snapshot", async () => {
    const spaceId = db.nextSpaceId(), other = db.nextSpaceId();
    const result = large(), reordered = { content: result.content, retryable: false, ok: true };
    await save(nodeStore(spaceId), "one", result);
    await save(nodeStore(spaceId), "two", reordered);
    await save(runStore(spaceId), "tool", result);
    await save(nodeStore(other), "one", result);
    expect(Number((await db.pool.query("SELECT count(*) FROM runtime_receipt_bodies WHERE space_id=$1", [spaceId])).rows[0].count)).toBe(1);
    const query = await db.pool.query(receiptReadSql("SELECT * FROM runtime_invocation_receipts WHERE space_id=$1"), [spaceId]);
    expect(query.rows.filter(row => row.row_kind === "body")).toHaveLength(1);
    const restored = await hydrateReceiptRows(query.rows);
    restored[0].result_json.content = "caller mutation";
    expect(restored[1].result_json).toEqual(result);
    expect(await nodeStore(db.nextSpaceId()).getReceipt("one")).toBeUndefined();
    const row = await raw("runtime_invocation_receipts", spaceId, "one");
    await legacy(other, "foreign-ref", {});
    await db.pool.query("DELETE FROM runtime_invocation_receipts WHERE space_id=$1 AND invocation_id='one'", [other]);
    await db.pool.query("DELETE FROM runtime_receipt_bodies WHERE space_id=$1", [other]);
    await expect(db.pool.query(`UPDATE runtime_invocation_receipts SET result_ref=$2
      WHERE space_id=$1 AND invocation_id='foreign-ref'`, [other, row.result_ref])).rejects.toMatchObject({ code: "23503" });
    await expect(db.pool.query("DELETE FROM runtime_receipt_bodies WHERE space_id=$1", [spaceId])).rejects.toMatchObject({ code: "23503" });
  });

  it.each(["node", "tool"])("keeps the first committed identity under concurrent different-result writes (%s)", async kind => {
    const spaceId = db.nextSpaceId(), store = kind === "node" ? nodeStore(spaceId) : runStore(spaceId);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => save(store, "race", large(`-${i}`),
      kind === "node" ? { nodeId: `node-${i}`, completedAt: i + 1 } :
        { runId: `run-${i}`, requestHash: `hash-${i}`, completedAt: i + 1 })));
    expect(results.filter(row => !row.duplicate)).toHaveLength(1);
    const winner = results.find(row => !row.duplicate);
    for (const row of results) expect(row).toEqual({ ...winner, duplicate: row.duplicate });
    expect(Number((await db.pool.query("SELECT count(*) FROM runtime_receipt_bodies WHERE space_id=$1", [spaceId])).rows[0].count)).toBe(1);
  });

  it("rolls back a body insert failure without leaving a receipt or orphan", async () => {
    const spaceId = db.nextSpaceId();
    const pool = {
      query: db.pool.query.bind(db.pool),
      async connect() {
        const client = await db.pool.connect();
        return { release: () => client.release(), async query(sql, args) {
          if (sql.startsWith("INSERT INTO runtime_receipt_bodies")) throw new Error("body write failed");
          return client.query(sql, args);
        } };
      }
    };
    await expect(save(new PostgresNodeStateStore(pool, { spaceId }), "rollback", large())).rejects.toThrow("body write failed");
    expect(await nodeStore(spaceId).getReceipt("rollback")).toBeUndefined();
    expect(Number((await db.pool.query("SELECT count(*) FROM runtime_receipt_bodies WHERE space_id=$1", [spaceId])).rows[0].count)).toBe(0);
  });

  it("rejects codec, length, hash, gzip and header corruption rather than treating a result as absent", async () => {
    const encoded = await encodeReceiptBody(large());
    expect(await decodeReceiptBody(encoded.body)).toEqual(large());
    for (const changed of [{ codec: "unknown" }, { raw_bytes: 1 }, { raw_bytes: encoded.body.raw_bytes + 1 },
      { ref: "0".repeat(64) }, { payload_blob: Buffer.from("invalid") },
      { payload_blob: gzipSync(Buffer.alloc(RECEIPT_BODY_MAX_BYTES + 1)) }]) {
      await expect(decodeReceiptBody({ ...encoded.body, ...changed })).rejects.toMatchObject({ code: "receipt_body_corrupt" });
    }
    const spaceId = db.nextSpaceId();
    await save(nodeStore(spaceId), "corrupt", large());
    await db.pool.query(`UPDATE runtime_invocation_receipts SET result_json='{"ok":false}' WHERE space_id=$1`, [spaceId]);
    await expect(nodeStore(spaceId).getReceipt("corrupt")).rejects.toMatchObject({ code: "receipt_body_corrupt" });
    const rows = (await db.pool.query(receiptReadSql("SELECT * FROM runtime_invocation_receipts WHERE space_id=$1"), [spaceId])).rows;
    await expect(hydrateReceiptRows(rows.filter(row => row.row_kind !== "body"))).rejects.toMatchObject({ code: "receipt_body_corrupt" });
  });

  it("enforces admission without rewriting tiny history and fairly visits inactive owners and both tables", async () => {
    const owners = [db.nextSpaceId(), db.nextSpaceId()];
    for (const owner of owners) {
      await legacy(owner, "tiny", { ok: true });
      await legacy(owner, "large", large(owner));
      await legacy(owner, "tool", large(owner), "runtime_tool_invocation_receipts");
    }
    const noBenefit = { content: randomBytes(1500).toString("base64") };
    expect((await encodeReceiptBody(noBenefit)).skipReason).toBe("no-benefit");
    const oversized = { content: "x".repeat(RECEIPT_BODY_MAX_BYTES) };
    await legacy(owners[0], "oversized", oversized);
    await legacy(owners[0], "no-benefit", noBenefit);
    const maintenance = new PostgresReceiptMaintenanceStore(db.pool);
    let complete = false;
    for (let i = 0; i < 100 && !complete; i++) complete = (await maintenance.runStorageMaintenanceBatch({ maxRows: 2 })).complete;
    expect(complete).toBe(true);
    for (const owner of owners) {
      expect((await raw("runtime_invocation_receipts", owner, "tiny")).result_skip_reason).toBeNull();
      expect((await raw("runtime_invocation_receipts", owner, "large")).result_ref).toBeTruthy();
      expect((await runStore(owner).getToolReceipt("tool")).result).toEqual(large(owner));
    }
    expect((await raw("runtime_invocation_receipts", owners[0], "oversized")).result_skip_reason).toBe("oversized");
    expect((await raw("runtime_invocation_receipts", owners[0], "no-benefit")).result_skip_reason).toBe("no-benefit");
  }, 20000);

  it("uses the partial candidate index without reading every tiny historical body", async () => {
    const spaceId = db.nextSpaceId();
    await db.pool.query(`INSERT INTO runtime_invocation_receipts
      (space_id,invocation_id,node_id,result_json,completed_at)
      SELECT $1,'tiny-'||n,'node','{"ok":true}',100 FROM generate_series(1,5000) n`, [spaceId]);
    await legacy(spaceId, "large", large());
    const plan = await transaction(async client => {
      await client.query("SET LOCAL enable_seqscan=off");
      return (await client.query(`EXPLAIN (ANALYZE,FORMAT JSON) SELECT space_id FROM runtime_invocation_receipts
        WHERE result_ref IS NULL AND result_skip_reason IS NULL AND octet_length(result_json::text)>=512
        AND space_id=$1 ORDER BY space_id,invocation_id LIMIT 1`, [spaceId])).rows[0]["QUERY PLAN"];
    });
    expect(JSON.stringify(plan)).toContain("runtime_invocation_receipts_body_pending");
    expect(JSON.stringify(plan)).not.toContain("Seq Scan");
    await save(nodeStore(spaceId), "reference", large());
    const ref = (await raw("runtime_invocation_receipts", spaceId, "reference")).result_ref;
    for (const [query, parameters] of [
      ["SELECT space_id,result_ref,invocation_id FROM runtime_invocation_receipts WHERE result_ref IS NOT NULL ORDER BY space_id,result_ref,invocation_id LIMIT 1", []],
      ["SELECT 1 FROM runtime_invocation_receipts WHERE space_id=$1 AND result_ref=$2 LIMIT 1", [spaceId, ref]]
    ]) {
      const referencedPlan = await transaction(async client => {
        await client.query("SET LOCAL enable_seqscan=off");
        return (await client.query("EXPLAIN (ANALYZE,FORMAT JSON) " + query, parameters)).rows[0]["QUERY PLAN"];
      });
      expect(JSON.stringify(referencedPlan)).toContain("runtime_invocation_receipts_body_refs");
      expect(JSON.stringify(referencedPlan)).not.toContain("Seq Scan");
    }
  });

  it("defers conversions below the disk floor before acquiring a database connection", async () => {
    const pool = { connect: vi.fn() };
    const maintenance = new PostgresReceiptMaintenanceStore(pool, { storageHeadroom: async () => 1024 });
    expect(await maintenance.runStorageMaintenanceBatch()).toMatchObject({
      complete: false, receipts: { deferred: "disk-headroom" }
    });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(maintenance.maintenanceStats).toMatchObject({ phase: "headroom", availableBytes: 1024 });
  });

  it("rolls back a real timeout, advances fairness and shrinks only the failed owner's probe", async () => {
    const clean = await createPostgresTestDatabase("receipt_timeout");
    try {
      const owners = [clean.nextSpaceId(), clean.nextSpaceId()].sort();
      await clean.pool.query(`INSERT INTO runtime_invocation_receipts
        (space_id,invocation_id,node_id,result_json,completed_at)
        SELECT space_id,'large','node',$2::jsonb,100 FROM unnest($1::text[]) space_id`,
      [owners, JSON.stringify(large())]);
      let delayed = false;
      const pool = { async connect() {
        const client = await clean.pool.connect();
        return { release: () => client.release(), async query(sql, args) {
          if (!delayed && sql.startsWith("WITH candidates AS MATERIALIZED")) {
            delayed = true;
            await client.query("SET LOCAL statement_timeout='10ms'");
            await client.query("SELECT pg_sleep(0.1)");
          }
          return client.query(sql, args);
        } };
      } };
      const maintenance = new PostgresReceiptMaintenanceStore(pool);
      await expect(maintenance.runStorageMaintenanceBatch()).rejects.toMatchObject({
        code: "57014", maintenancePhase: "select"
      });
      expect(maintenance.ownerCursors.get("runtime_invocation_receipts")).toBe(owners[0]);
      expect(maintenance.probeLimits.get(JSON.stringify(["runtime_invocation_receipts", owners[0]]))).toBe(16);
      await maintenance.runStorageMaintenanceBatch(); // Other table.
      await maintenance.runStorageMaintenanceBatch(); // Next owner.
      expect((await clean.pool.query("SELECT result_ref FROM runtime_invocation_receipts WHERE space_id=$1", [owners[1]])).rows[0].result_ref).toBeTruthy();
      expect((await clean.pool.query("SELECT result_ref FROM runtime_invocation_receipts WHERE space_id=$1", [owners[0]])).rows[0].result_ref).toBeNull();
      await maintenance.runStorageMaintenanceBatch();
      await maintenance.runStorageMaintenanceBatch();
      expect((await clean.pool.query("SELECT result_ref FROM runtime_invocation_receipts WHERE space_id=$1", [owners[0]])).rows[0].result_ref).toBeTruthy();
    } finally { await clean.close(); }
  });

  it("limits startup and durable cache bytes while preserving fallback and in-memory replay", async () => {
    const spaceId = db.nextSpaceId(), store = nodeStore(spaceId);
    await save(store, "huge", large(), { completedAt: 300 });
    await save(store, "small-one", { ok: true, content: "one" }, { completedAt: 100 });
    await save(store, "small-two", { ok: true, content: "two" }, { completedAt: 200 });
    const state = await store.loadState({ receiptMaxBytes: 80 });
    expect(state.receipts.map(row => row.invocationId)).toEqual(["small-one", "small-two"]);
    const broker = await new NodeBroker({ stateStore: store, maxReceiptBytes: 80 }).initialize();
    expect(broker.snapshot().receiptBytes).toBeLessThanOrEqual(80);
    expect(await broker.findReceipt("huge")).toEqual(large());
    expect(broker.receipts.has("huge")).toBe(false);
    broker.rememberReceipt("small-two", { ok: true, content: "replacement" });
    expect(broker.receiptBytes).toBe([...broker.receipts.values()].reduce((n, value) => n + Buffer.byteLength(JSON.stringify(value)), 0));
    broker.close();
    const memory = new NodeBroker({ maxReceiptBytes: 1 });
    memory.rememberReceipt("keep", large());
    expect(memory.findReceipt("keep")).toEqual(large());
    memory.close();
  });

  it.each([false, true])("never evicts an unpersisted unknown outcome during byte pressure (writeFails=%s)", async writeFails => {
    const spaceId = db.nextSpaceId(), store = nodeStore(spaceId);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const broker = await new NodeBroker({
      maxReceiptBytes: 1200, scheduleTimeout: () => ({ dispose() {} }),
      stateStore: {
        getReceipt: store.getReceipt.bind(store),
        async saveReceipt(receipt) {
          if (receipt.result.failureCode === "execution_outcome_unknown") {
            await gate;
            if (writeFails) throw new Error("durable write unavailable");
          }
          return store.saveReceipt(receipt);
        }
      }
    }).initialize();
    await broker.registerNode({
      protocolVersion: 1, nodeId: "device", instanceId: "instance", label: "Device", platform: "linux",
      capabilities: [{ name: "operation", version: "1", risk: "execute", description: "Execute",
        inputSchema: { type: "object" }, hostKind: "local-tools",
        execution: { effect: "external", idempotency: "reconcile" } }],
      resources: [{ resourceId: "workspace", kind: "workspace", projectId: "project", localRoot: "/project" }]
    });
    const input = id => ({ invocationId: id, runId: "run", attemptId: "attempt", projectId: "project",
      policy: { allowedTools: ["operation"], fileRoots: ["/project"], allowedTerminalSessionIds: [] },
      toolCall: { id: `call-${id}`, name: "operation", arguments: {} } });
    const uncertain = broker.invoke(input("unknown"), new CancellationController().signal);
    await vi.waitFor(() => expect(broker.pending.has("unknown")).toBe(true));
    expect(await broker.nextCommand("device", "instance")).toMatchObject({ type: "tool.invoke" });
    broker.expireInvocation("unknown");
    await expect(uncertain).resolves.toMatchObject({ failureCode: "execution_outcome_unknown" });
    await broker.nextCommand("device", "instance"); // Timeout cancellation.
    for (const id of ["large-one", "large-two"]) {
      const completion = broker.invoke(input(id), new CancellationController().signal);
      await vi.waitFor(() => expect(broker.pending.has(id)).toBe(true));
      expect(await broker.nextCommand("device", "instance")).toMatchObject({ invocationId: id });
      await broker.completeInvocation("device", "instance", id, { ok: true, content: "x".repeat(900) });
      await completion;
    }
    expect(broker.snapshot().pinnedReceipts).toBe(1);
    expect(await broker.invoke(input("unknown"), new CancellationController().signal))
      .toMatchObject({ failureCode: "execution_outcome_unknown" });
    expect(broker.snapshot().pendingInvocations).toBe(0);
    release();
    await broker.close(); // Flush pending safety-fact writes before shutdown.
    if (writeFails) {
      expect(broker.snapshot().pinnedReceipts).toBe(1);
      expect(broker.snapshot().receiptPersistenceFailures).toBe(1);
      expect(await broker.findReceipt("unknown")).toMatchObject({ failureCode: "execution_outcome_unknown" });
    } else {
      expect((await store.getReceipt("unknown")).result).toMatchObject({ failureCode: "execution_outcome_unknown" });
      expect(broker.snapshot().pinnedReceipts).toBe(0);
      const restarted = await new NodeBroker({ stateStore: store, maxReceiptBytes: 1200 }).initialize();
      expect(await restarted.findReceipt("unknown")).toMatchObject({ failureCode: "execution_outcome_unknown" });
      await restarted.close();
    }
  });

  it.each(["completion", "reconnect"])("drains the %s receipt write before shutdown returns", async kind => {
    const spaceId = db.nextSpaceId(), store = nodeStore(spaceId);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const broker = new NodeBroker({
      scheduleTimeout: () => ({ dispose() {} }),
      stateStore: { getReceipt: store.getReceipt.bind(store),
        async saveReceipt(value) { await gate; return store.saveReceipt(value); } }
    });
    const registration = instanceId => ({
      protocolVersion: 1, nodeId: "device", instanceId, label: "Device", platform: "linux",
      capabilities: [{ name: "operation", version: "1", risk: "execute", description: "Execute",
        inputSchema: { type: "object" }, hostKind: "local-tools" }],
      resources: [{ resourceId: "workspace", kind: "workspace", projectId: "project", localRoot: "/project" }]
    });
    await broker.registerNode(registration("old"));
    const completion = broker.invoke({
      invocationId: "drain", runId: "run", attemptId: "attempt", projectId: "project",
      policy: { allowedTools: ["operation"], fileRoots: ["/project"], allowedTerminalSessionIds: [] },
      toolCall: { id: "call", name: "operation", arguments: {} }
    }, new CancellationController().signal).catch(() => {});
    await vi.waitFor(() => expect(broker.pending.has("drain")).toBe(true));
    await broker.nextCommand("device", "old");
    const accepted = kind === "completion"
      ? broker.completeInvocation("device", "old", "drain", { ok: true, content: "done" })
      : broker.registerNode(registration("new"));
    await vi.waitFor(() => expect(broker.receiptPersistenceFlights.size).toBe(1));
    let closed = false;
    const shutdown = broker.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await accepted;
    await shutdown;
    await completion;
    expect(closed).toBe(true);
    expect((await store.getReceipt("drain")).result).toMatchObject(kind === "completion"
      ? { ok: true, content: "done" } : { failureCode: "execution_outcome_unknown" });
  });

  it.each([false, true])("preserves recovery's pending unknown outcome through inline facts (referenced=%s)", async referenced => {
    const spaceId = db.nextSpaceId();
    const results = [
      { ...large(), ok: false, failureCode: "execution_outcome_unknown", retryable: false },
      large()
    ];
    for (let i = 0; i < 2; i++) {
      if (referenced) await save(runStore(spaceId), `inv-${i}`, results[i], { runId: `run-${i}` });
      else {
        await legacy(spaceId, `inv-${i}`, results[i], "runtime_tool_invocation_receipts");
        await db.pool.query("UPDATE runtime_tool_invocation_receipts SET run_id=$3 WHERE space_id=$1 AND invocation_id=$2",
          [spaceId, `inv-${i}`, `run-${i}`]);
      }
    }
    const pool = { async query(sql, args) {
      if (sql.includes("SELECT result_json FROM runtime_tool_invocation_receipts")) return db.pool.query(sql, args);
      if (sql.includes("SELECT * FROM space_usage_reservations")) return { rows: [{
        id: `reserve-${args[1]}`, run_id: args[1], step_id: `tool:inv-${args[1].slice(-1)}`, state: "dispatched"
      }] };
      if (sql.includes("runtime_run_completion_tasks")) return { rowCount: 0, rows: [] };
      throw new Error("Unexpected recovery query");
    } };
    // Exercise the actual recovery method and its production SQL, with queue
    // and settlement collaborators isolated from unrelated budget machinery.
    const execution = new SpaceExecutionStore({ spaces: { pool, now: () => 100, async transaction(_space, fn) {
      return fn({ async query(sql) {
        return sql.includes("SELECT q.*") ? { rows: [0, 1].map(i => ({
          space_id: spaceId, run_id: `run-${i}`, run_status: "interrupted"
        })) } : { rows: [] };
      } });
    } } });
    execution.pending = vi.fn(); execution.settle = vi.fn(); execution.finish = vi.fn();
    await execution.recover(spaceId);
    expect(execution.pending).toHaveBeenCalledWith(spaceId, "reserve-run-0");
    expect(execution.settle).toHaveBeenCalledWith(spaceId, "reserve-run-1", {
      id: "tool:inv-1", calls: 1, verified: true
    });
    expect(execution.settle).toHaveBeenCalledTimes(1);
  });

  it("materializes every reference for rollback while keeping all identities and original results", async () => {
    // Isolate this rollback from intentionally corrupt rows in earlier cases.
    const clean = await createPostgresTestDatabase("receipt_rollback");
    try {
      const spaceId = clean.nextSpaceId(), store = new PostgresNodeStateStore(clean.pool, { spaceId });
      const tools = new PostgresRunStore(clean.pool, { spaceId });
      await save(store, "one", large()); await save(store, "two", large()); await save(tools, "tool", large());
      const before = (await clean.pool.query("SELECT invocation_id,node_id,completed_at FROM runtime_invocation_receipts ORDER BY invocation_id")).rows;
      const client = await clean.pool.connect();
      try {
        let complete = false;
        for (let i = 0; i < 10 && !complete; i++) {
          await client.query("BEGIN");
          complete = (await restoreReceiptBodyBatch(client, { maxRows: 1 })).complete;
          await client.query("COMMIT");
        }
        expect(complete).toBe(true);
      } finally { client.release(); }
      expect((await clean.pool.query("SELECT invocation_id,node_id,completed_at FROM runtime_invocation_receipts ORDER BY invocation_id")).rows).toEqual(before);
      expect((await clean.pool.query("SELECT result_json,result_ref FROM runtime_invocation_receipts")).rows).toEqual([
        { result_json: large(), result_ref: null }, { result_json: large(), result_ref: null }
      ]);
      expect((await clean.pool.query("SELECT result_json,result_ref FROM runtime_tool_invocation_receipts")).rows).toEqual([
        { result_json: large(), result_ref: null }
      ]);
      expect((await clean.pool.query("SELECT * FROM runtime_receipt_bodies")).rowCount).toBe(0);
    } finally { await clean.close(); }
  });
});
