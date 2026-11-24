import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresSharedSpaceStore } from "../src/spaces/postgres-shared-space-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { SpaceExecutionStore } from "../src/spaces/space-execution-store.mjs";
import { createConversationInputSnapshot } from "../src/conversation-input.mjs";

let db;
beforeAll(async () => { db = await createPostgresTestDatabase("message_segments"); });
afterAll(async () => { await db?.close(); });

it("shares large prefixes across rounds and branches while preserving order, duplicates, nulls and empty arrays", async () => {
  const spaceId = db.nextSpaceId();
  const store = new PostgresRunStore(db.pool, { spaceId });
  const history = [{ role: "system", content: "long context ".repeat(20000) }];
  const a = { role: "user", content: "A" }, b = { role: "assistant", content: "B" };
  const arrays = [history, [...history, a], [...history, a, b], [...history, b, a, a, null], []];
  for (const [i, messages] of arrays.entries()) {
    await store.create({ id: `r${i}`, status: "completed", updatedAt: 1, inputMessages: messages });
  }
  const state = (await db.pool.query(`SELECT
    (SELECT count(*)::int FROM runtime_message_segments WHERE space_id=$1) AS segments,
    (SELECT count(*)::int FROM runtime_message_blobs WHERE space_id=$1 AND messages_json IS NULL) AS manifests,
    (SELECT sum(octet_length(message_json::text)) FROM runtime_message_segments WHERE space_id=$1) AS body_bytes`,
  [spaceId])).rows[0];
  expect(state.segments).toBe(4);
  expect(state.manifests).toBe(5);
  expect(Number(state.body_bytes)).toBeLessThan(Buffer.byteLength(JSON.stringify(history)) + 100);
  const restarted = new PostgresRunStore(db.pool, { spaceId });
  for (const [i, messages] of arrays.entries()) expect(await restarted.getRunInputMessages(`r${i}`)).toEqual(messages);
  expect(await new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId() }).getRunInputMessages("r0")).toBeNull();
  const ref = (await db.pool.query("SELECT messages_ref FROM runtime_run_inputs WHERE space_id=$1 AND run_id='r0'", [spaceId])).rows[0].messages_ref;
  await expect(db.pool.query("SELECT runtime_read_message_blob($1,$2)", [db.nextSpaceId(), ref])).rejects.toMatchObject({ code: "XX001" });
});

it("converts legacy arrays and inline inputs in bounded batches without changing fingerprints or accepted receipts", async () => {
  const store = new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId() });
  await store.createSession({ id: "doc", status: "active", createdAt: 1, updatedAt: 1 });
  const messages = [{ content: "frozen", role: "user" }];
  const snapshot = createConversationInputSnapshot({ id: "input", sessionId: "doc",
    command: { clientRequestId: "client" }, request: { messages, sessionHistory: [] } });
  await store.reserveConversationInput(snapshot);
  await store.create({ id: "accepted", attemptId: "a", sessionId: "doc", status: "completed", updatedAt: 1,
    inputMessages: messages, metadata: { conversationInputId: snapshot.id } });
  await db.pool.query(`UPDATE runtime_conversation_inputs SET
    payload_json=payload_json || jsonb_build_object('messages',runtime_read_message_blob(space_id,messages_ref),
      'contextMessages',runtime_read_message_blob(space_id,context_ref)),messages_ref=NULL,context_ref=NULL WHERE space_id=$1`,
  [store.spaceId]);
  await db.pool.query(`UPDATE runtime_message_blobs SET messages_json=runtime_read_message_blob(space_id,ref),segment_refs=NULL
    WHERE space_id=$1`, [store.spaceId]);
  for (let i = 0; i < 3; i++) {
    await store.create({ id: `legacy${i}`, status: "failed", updatedAt: 1 });
    await db.pool.query("INSERT INTO runtime_run_inputs (space_id,run_id,messages_json) VALUES ($1,$2,$3::jsonb)",
      [store.spaceId, `legacy${i}`, JSON.stringify(messages)]);
  }
  const first = await store.runStorageMaintenanceBatch({ maxRows: 1 });
  expect(first.inputs.rewrittenRows).toBe(3);
  expect(first.inputs.complete).toBe(false);
  for (let i = 0; i < 10; i++) {
    if ((await store.runStorageMaintenanceBatch({ maxRows: 1 })).inputs.complete) break;
    expect(i).toBeLessThan(9);
  }
  const remaining = (await db.pool.query(`SELECT
    (SELECT count(*)::int FROM runtime_message_blobs WHERE space_id=$1 AND segment_refs IS NULL) AS blobs,
    (SELECT count(*)::int FROM runtime_run_inputs WHERE space_id=$1 AND messages_ref IS NULL) AS inputs`, [store.spaceId])).rows[0];
  expect(remaining).toEqual({ blobs: 0, inputs: 0 });
  for (let i = 0; i < 3; i++) expect(await store.getRunInputMessages(`legacy${i}`)).toEqual(messages);
  const loaded = await store.getRunConversationInput("accepted");
  expect(loaded.fingerprint).toBe(snapshot.fingerprint);
  expect(loaded.messages).toEqual(messages);
  expect(loaded.contextMessages).toEqual([]);
  expect(loaded.status).toBe("accepted");
  expect((await store.reserveConversationInput(snapshot)).reserved).toBe(false);
});

it("rolls back failed conversion and rejects missing segments rather than silently shortening a frozen input", async () => {
  const store = new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId() });
  await expect(store.transaction(async client => {
    await store.storeMessages(client, [{ role: "user", content: "must roll back" }]);
    throw new Error("cancel");
  })).rejects.toThrow("cancel");
  expect((await db.pool.query("SELECT count(*)::int AS n FROM runtime_message_segments WHERE space_id=$1", [store.spaceId])).rows[0].n).toBe(0);
  await store.create({ id: "r", status: "completed", updatedAt: 1, inputMessages: [{ role: "user", content: "saved" }] });
  await db.pool.query("DELETE FROM runtime_message_segments WHERE space_id=$1", [store.spaceId]);
  await expect(store.getRunInputMessages("r")).rejects.toMatchObject({ code: "XX001" });
});

it("serializes concurrent shared histories and finishes legacy conversion for an inactive owner", async () => {
  const store = new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId() });
  const shared = [{ role: "system", content: "shared ".repeat(500) }, { role: "user", content: "same" }];
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.create({
    id: `concurrent${i}`, status: "completed", updatedAt: 1, inputMessages: [...shared, { role: "user", content: String(i) }]
  })));
  expect((await db.pool.query("SELECT count(*)::int AS n FROM runtime_message_segments WHERE space_id=$1", [store.spaceId])).rows[0].n).toBe(10);
  await db.pool.query(`UPDATE runtime_message_blobs SET messages_json=runtime_read_message_blob(space_id,ref),segment_refs=NULL
    WHERE space_id=$1`, [store.spaceId]);
  const other = new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId() });
  let complete = false;
  for (let i = 0; i < 20; i++) {
    complete = (await other.runStorageMaintenanceBatch({ maxRows: 1 })).inputs.complete;
    if (complete) break;
  }
  expect(complete).toBe(true);
  expect((await db.pool.query("SELECT count(*)::int AS n FROM runtime_message_blobs WHERE space_id=$1 AND segment_refs IS NULL", [store.spaceId])).rows[0].n).toBe(0);
  expect(await store.getRunInputMessages("concurrent7")).toEqual([...shared, { role: "user", content: "7" }]);
});

it("keeps real execution queue frozen hashes valid after conversion and fails a subsequently changed input", async () => {
  const user = await db.accounts.resolveIdentity({ issuer: "https://queue.test", subject: "owner", name: "Owner" });
  const team = await db.accounts.createTeamSpace(user.id, { name: "Segments queue" });
  const spaces = new PostgresSharedSpaceStore({ accounts: db.accounts });
  const execution = new SpaceExecutionStore({ spaces });
  const document = "queue-doc";
  await spaces.registerDocument(user.id, team.id, document);
  const workbench = new PostgresWorkbenchStateStore(db.pool, { spaceId: team.id });
  await workbench.updateSession(document, { text: "user hello" });
  const revision = (await spaces.content(team.id, document)).revision;
  const store = new PostgresRunStore(db.pool, { spaceId: team.id });
  const messages = [{ role: "user", content: "frozen hello" }];
  for (const runId of ["run1", "run2"]) {
    await store.create({ id: runId, status: "queued", updatedAt: 1, sessionId: document,
      principal: { userId: user.id }, inputMessages: messages });
    await db.pool.query(`UPDATE runtime_message_blobs SET
      messages_json=runtime_read_message_blob(space_id,ref),segment_refs=NULL WHERE space_id=$1 AND segment_refs IS NOT NULL`,
    [team.id]);
    await execution.enqueue({ userId: user.id, spaceId: team.id, documentId: document, runId,
      inputRevision: revision, frozenInput: true });
  }
  const hashBefore = (await db.pool.query("SELECT frozen_input_hash FROM space_run_queue WHERE space_id=$1 AND run_id='run1'", [team.id])).rows[0].frozen_input_hash;
  expect(hashBefore).toBe(createHash("sha256").update(JSON.stringify(await store.getRunInputMessages("run1"))).digest("hex"));
  await store.runStorageMaintenanceBatch({ maxRows: 1 });
  expect((await execution.claim(team.id, "run1")).status).toBe("running");
  await db.pool.query("UPDATE space_run_queue SET status='completed' WHERE space_id=$1 AND run_id='run1'", [team.id]);
  const changedRef = await store.transaction(client => store.storeMessages(client, [{ role: "user", content: "changed" }]));
  await db.pool.query("UPDATE runtime_run_inputs SET messages_ref=$2 WHERE space_id=$1 AND run_id='run2'", [team.id, changedRef]);
  expect(await execution.claim(team.id, "run2")).toMatchObject({ status: "failed", reason: "document_changed_while_queued" });
});

it("advances other owners when the first owner's writer remains busy", async () => {
  const ids = [db.nextSpaceId(), db.nextSpaceId()].sort();
  const owners = ids.map(spaceId => new PostgresRunStore(db.pool, { spaceId }));
  for (const owner of owners) {
    await owner.create({ id: "r", status: "completed", updatedAt: 1, inputMessages: [{ role: "user", content: owner.spaceId }] });
    await db.pool.query("UPDATE runtime_message_blobs SET messages_json=runtime_read_message_blob(space_id,ref),segment_refs=NULL WHERE space_id=$1", [owner.spaceId]);
  }
  const worker = new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId() });
  const lock = await db.pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 73198425))", [owners[0].spaceId]);
    expect((await worker.runStorageMaintenanceBatch({ maxRows: 1 })).inputs.busy).toBe(true);
    expect((await worker.runStorageMaintenanceBatch({ maxRows: 1 })).inputs.rewrittenRows).toBe(1);
    expect((await db.pool.query("SELECT segment_refs IS NOT NULL AS converted FROM runtime_message_blobs WHERE space_id=$1", [owners[1].spaceId])).rows[0].converted).toBe(true);
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
  expect((await worker.runStorageMaintenanceBatch({ maxRows: 1 })).inputs.complete).toBe(true);
});

it("retains an existing frozen input on resume without storing an unused checkpoint-derived body", async () => {
  const store = new PostgresRunStore(db.pool, { spaceId: db.nextSpaceId() });
  const original = [{ role: "user", content: "original frozen input" }];
  await store.create({ id: "r", attemptId: "old", status: "failed", updatedAt: 1, inputMessages: original });
  await db.pool.query(`INSERT INTO runtime_run_checkpoints VALUES ($1,'r',1,'old',$2::jsonb,1)`,
    [store.spaceId, JSON.stringify({ runId: "r", messages: [{ role: "user", content: "checkpoint continuation" }] })]);
  const before = (await db.pool.query("SELECT count(*)::int AS n FROM runtime_message_segments WHERE space_id=$1", [store.spaceId])).rows[0].n;
  expect(await store.claimResume({ runId: "r", previousAttemptId: "old", attemptId: "new", checkpointSequence: 1 })).toBe(true);
  expect(await store.getRunInputMessages("r")).toEqual(original);
  expect((await db.pool.query("SELECT count(*)::int AS n FROM runtime_message_segments WHERE space_id=$1", [store.spaceId])).rows[0].n).toBe(before);
});
