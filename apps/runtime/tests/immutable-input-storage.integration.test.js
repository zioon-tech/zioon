import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { createConversationInputSnapshot } from "../src/conversation-input.mjs";
let db;
beforeAll(async () => { db = await createPostgresTestDatabase("immutable_input_storage"); });
afterAll(async () => { await db.close(); });

it("stores one immutable array for snapshot context, snapshot input and run recovery, including after restart", async () => {
  const store = new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId() });
  await store.createSession({ id: "doc", status: "active", createdAt: 1, updatedAt: 1 });
  const messages = [{ role: "user", content: "large frozen history ".repeat(3000) }];
  const snapshot = createConversationInputSnapshot({
    id: "input", sessionId: "doc", command: { clientRequestId: "client" }, request: { messages }
  });
  const reserved = await store.reserveConversationInput(snapshot);
  expect(reserved.input.messages).toEqual(messages);
  await store.create({ id: "run", attemptId: "a", sessionId: "doc", status: "queued", updatedAt: 1,
    inputMessages: messages, metadata: { conversationInputId: "input" } });
  const stored = (await db.pool.query(`SELECT
    (SELECT count(*)::int FROM runtime_message_blobs WHERE space_id=$1) AS blobs,
    (SELECT payload_json FROM runtime_conversation_inputs WHERE space_id=$1 AND id='input') AS snapshot,
    (SELECT messages_json FROM runtime_run_inputs WHERE space_id=$1 AND run_id='run') AS input`, [store.spaceId])).rows[0];
  expect(stored.blobs).toBe(1);
  expect(stored.snapshot.messages).toBeUndefined();
  expect(stored.snapshot.contextMessages).toBeUndefined();
  expect(stored.input).toBeNull();
  const restarted = new PostgresRunStore(db.pool, { spaceId: store.spaceId });
  expect(await restarted.getRunInputMessages("run")).toEqual(messages);
  expect((await restarted.getConversationInput("doc", "client")).contextMessages).toEqual(messages);
  expect((await restarted.getLatestConversationInput("doc")).messages).toEqual(messages);
  expect((await restarted.getRunConversationInput("run")).contextMessages).toEqual(messages);
  expect((await restarted.reserveConversationInput(snapshot)).reserved).toBe(false);
  expect(await new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId() }).getRunInputMessages("run")).toBeNull();

  // Old releases can be restored after materializing references, without
  // reverting schema or losing the accepted idempotency receipt.
  await db.pool.query(`UPDATE runtime_message_blobs SET
    messages_json=runtime_read_message_blob(space_id,ref),segment_refs=NULL
    WHERE space_id=$1 AND segment_refs IS NOT NULL`, [store.spaceId]);
  await db.pool.query(`UPDATE runtime_run_inputs i SET messages_json=b.messages_json,messages_ref=NULL
    FROM runtime_message_blobs b WHERE i.space_id=$1 AND b.space_id=i.space_id AND b.ref=i.messages_ref`, [store.spaceId]);
  await db.pool.query(`UPDATE runtime_conversation_inputs c SET
    payload_json=c.payload_json || jsonb_build_object('messages',m.messages_json,'contextMessages',h.messages_json),
    messages_ref=NULL,context_ref=NULL FROM runtime_message_blobs m,runtime_message_blobs h
    WHERE c.space_id=$1 AND m.space_id=c.space_id AND m.ref=c.messages_ref
      AND h.space_id=c.space_id AND h.ref=c.context_ref`, [store.spaceId]);
  expect(await restarted.getRunInputMessages("run")).toEqual(messages);
  expect((await restarted.getRunConversationInput("run")).messages).toEqual(messages);
});

it("retains distinct submitted context and leaves inline legacy inputs readable", async () => {
  const store = new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId() });
  await store.createSession({ id: "doc", status: "active", createdAt: 1, updatedAt: 1 });
  const messages = [{ role: "system", content: "model instructions" }, { role: "user", content: "edited" }];
  const sessionHistory = [{ role: "user", content: "edited" }];
  const snapshot = createConversationInputSnapshot({ id: "input", sessionId: "doc",
    command: { clientRequestId: "client" }, request: { messages, sessionHistory } });
  await store.reserveConversationInput(snapshot);
  expect((await store.getConversationInput("doc", "client")).contextMessages).toEqual(sessionHistory);
  expect((await db.pool.query("SELECT count(*)::int AS n FROM runtime_message_blobs WHERE space_id=$1", [store.spaceId])).rows[0].n).toBe(2);
  await store.create({ id: "legacy", status: "failed", updatedAt: 1 });
  await db.pool.query(`INSERT INTO runtime_run_inputs (space_id,run_id,messages_json) VALUES ($1,'legacy',$2)`,
    [store.spaceId, JSON.stringify(sessionHistory)]);
  expect(await store.getRunInputMessages("legacy")).toEqual(sessionHistory);
});

it("bounds retention work and preserves every resumable or unfinished checkpoint and frozen input", async () => {
  const now = Date.now();
  const old = now - 45 * 86400000;
  const store = new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId(), now: () => now });
  const states = ["completed", "completed", "waiting", "running", "failed", "aborted", "interrupted", "completed"];
  for (const [index, status] of states.entries()) {
    const id = `r${index}`;
    await store.create({ id, attemptId: "a", status, updatedAt: old, inputMessages: [{ role: "user", content: id }] });
    await db.pool.query(`INSERT INTO runtime_run_checkpoints VALUES ($1,$2,1,'a',$3,$4)`,
      [store.spaceId, id, JSON.stringify({ runId: id, pending: { tool: "unresolved" } }), old]);
  }
  await db.pool.query(`INSERT INTO runtime_run_completion_tasks
    (space_id,run_id,attempt_id,terminal_sequence,payload_json,available_at)
    VALUES ($1,'r7','a',2,'{}',1)`, [store.spaceId]);
  const first = await store.runStorageMaintenanceBatch({ maxRows: 1 });
  expect(first.checkpoints.deletedRows).toBe(1);
  expect(first.complete).toBe(false);
  expect((await store.runStorageMaintenanceBatch({ maxRows: 1 })).checkpoints.deletedRows).toBe(1);
  expect((await store.runStorageMaintenanceBatch({ maxRows: 1 })).complete).toBe(true);
  const retained = (await db.pool.query("SELECT run_id FROM runtime_run_checkpoints WHERE space_id=$1 ORDER BY run_id",
    [store.spaceId])).rows.map(row => row.run_id);
  expect(retained).toEqual(["r2", "r3", "r4", "r5", "r6", "r7"]);
  expect(store.maintenanceStats.totalDeletedCheckpoints).toBe(2);
  expect(await store.getRunInputMessages("r0")).toEqual([{ role: "user", content: "r0" }]);
});
