import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { PostgresSharedSpaceStore } from "../src/spaces/postgres-shared-space-store.mjs";
import { createSharedCollaborationPersistence } from "../src/spaces/collaboration-persistence.mjs";
import {
  collaborationDocumentCache, collaborationUpdateHash
} from "../src/collaboration-update-log.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

let database;
const documents = [];
const doc = state => {
  const value = new Y.Doc();
  if (state) Y.applyUpdate(value, state);
  documents.push(value);
  return value;
};
const capture = (document, action) => {
  let update;
  const listener = value => { update = value; };
  document.once("update", listener);
  action(document);
  document.off("update", listener);
  return update;
};
const store = () => new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
const header = async state => (await database.pool.query(
  "SELECT * FROM runtime_collaboration_documents WHERE space_id=$1 AND session_id='doc'", [state.spaceId]
)).rows[0];
beforeAll(async () => { database = await createPostgresTestDatabase("collaboration_updates"); });
afterEach(() => {
  collaborationDocumentCache.clear();
  for (const value of documents.splice(0)) value.destroy();
});
afterAll(async () => { await database.close(); });

describe("PostgresWorkbenchStateStore collaboration updates", () => {
  it.each([false, true])("validates a merged attachment and rolls back a denied binding (denied=%s)", async denied => {
    const state = store();
    await state.createSession({ id: "doc", text: "" });
    const spaces = new PostgresSharedSpaceStore({ accounts: database.accounts });
    const checked = [];
    let rejectBinding = false;
    spaces.requireDocument = async () => ({ id: "doc", lifecycle: "active" });
    spaces.invalidateKnowledge = async () => {};
    spaces.bindDocumentAssets = async (_userId, _spaceId, _documentId, assets, client) => {
      checked.push(assets);
      if (rejectBinding && assets.includes("uploaded_attachment")) {
        throw Object.assign(new Error("attachment is not authorized"), { statusCode: 403 });
      }
      // The binding operation sees the same uncommitted lock-owning transaction.
      expect((await client.query("SELECT txid_current() AS id")).rows[0].id).toBeDefined();
    };
    const persistence = createSharedCollaborationPersistence({
      spaces, store: state, access: { reauthorize: async () => {} }, runs: {}
    });
    const context = { principal: { kind: "account", user: { id: "editor" },
      space: { id: state.spaceId } }, documentId: "doc" };
    const prefix = doc(), suffix = doc();
    prefix.clientID = 1; suffix.clientID = 2;
    prefix.getText("content").insert(0, "zion-asset://");
    suffix.getText("content").insert(0, "uploaded_attachment");
    const save = source => persistence({
      sessionId: "doc", context, kind: "store", text: source.getText("content").toString()
    }, tx => state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(source),
      { text: source.getText("content").toString(), emitEvent: false }, tx));
    await save(prefix);
    const original = await state.readCollaborationDocument("doc");
    rejectBinding = denied;
    if (denied) {
      await expect(save(suffix)).rejects.toMatchObject({ statusCode: 403 });
      expect((await state.readSession("doc")).text).toBe("zion-asset://");
      expect(Buffer.from((await state.readCollaborationDocument("doc")).state)).toEqual(Buffer.from(original.state));
      expect((await header(state)).update_count).toBe(0);
      rejectBinding = false;
      await save(suffix);
    } else {
      await save(suffix);
    }
    expect(checked).toContainEqual(["uploaded_attachment"]);
    expect((await state.readSession("doc")).text).toBe("zion-asset://uploaded_attachment");
    expect(doc((await state.readCollaborationDocument("doc")).state).getText("content").toString())
      .toBe("zion-asset://uploaded_attachment");
  });

  it("reads exact legacy bytes and preserves text, cards and anchors after append and delete", async () => {
    const state = store(), source = doc();
    source.getText("content").insert(0, "中文 committed");
    const card = { args: { count: 0, nullable: null }, result: { ok: false, values: [] } };
    source.getMap("cards").set("tool", card);
    const anchor = Y.createRelativePositionFromTypeIndex(source.getText("content"), 3);
    const base = Buffer.from(Y.encodeStateAsUpdate(source));
    await state.createSession({ id: "doc", text: source.getText("content").toString() });
    await database.pool.query(`INSERT INTO runtime_collaboration_documents
      (space_id,session_id,state_blob,state_hash,version,updated_at)
      VALUES($1,'doc',$2,$3,1,1)`, [state.spaceId, base, collaborationUpdateHash(base)]);
    expect(Buffer.from((await state.readCollaborationDocument("doc")).state)).toEqual(base);
    const append = capture(source, d => d.getText("content").insert(d.getText("content").length, " appended"));
    const first = await state.writeCollaborationDocument("doc", append, { text: "caller projection" });
    expect(first.storage.writtenStateBytes).toBe(append.length);
    expect((await header(state)).state_blob).toEqual(base);
    const remove = capture(source, d => d.getText("content").delete(3, 2));
    await state.writeCollaborationDocument("doc", remove, { text: "another caller projection" });
    const restored = doc((await state.readCollaborationDocument("doc")).state);
    expect(restored.getText("content").toString()).toBe(source.getText("content").toString());
    expect(restored.getMap("cards").get("tool")).toEqual(card);
    expect(Y.createAbsolutePositionFromRelativePosition(anchor, restored).index).toBe(3);
    expect((await state.readSession("doc")).text).toBe(source.getText("content").toString());
    expect(Number((await header(state)).update_count)).toBe(2);
  });

  it("merges stale full snapshots from independent owners instead of replacing accepted edits", async () => {
    const state = store(), secondStore = new PostgresWorkbenchStateStore(database.pool, { spaceId: state.spaceId });
    const initial = doc();
    initial.getText("content").insert(0, "base");
    await state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(initial), { text: "base" });
    const left = doc(Y.encodeStateAsUpdate(initial)), right = doc(Y.encodeStateAsUpdate(initial));
    left.getText("content").insert(4, " left");
    right.getText("content").insert(0, "right ");
    await Promise.all([
      state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(left), { text: left.getText("content").toString() }),
      secondStore.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(right), { text: right.getText("content").toString() })
    ]);
    const restored = doc((await state.readCollaborationDocument("doc")).state);
    expect(restored.getText("content").toString()).toBe("right base left");
    expect((await state.readSession("doc")).text).toBe("right base left");
    const duplicate = await secondStore.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(right), { text: "stale" });
    expect(duplicate.duplicate).toBe(true);
    expect(doc(duplicate.state).getText("content").toString()).toBe("right base left");
  });

  it("serializes simultaneous first inserts and keeps the state-only contract", async () => {
    const state = store(), left = doc(), right = doc();
    left.getText("content").insert(0, "left");
    right.getText("content").insert(0, "right");
    await Promise.all([left, right].map(value =>
      state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(value))));
    const result = doc((await state.readCollaborationDocument("doc")).state);
    expect(result.getText("content").toString()).toContain("left");
    expect(result.getText("content").toString()).toContain("right");
    expect(await state.readSession("doc")).toBeNull();
  });

  it("compacts at the row limit and immediately compacts an oversized accepted update", async () => {
    const state = store(), source = doc();
    source.getText("content").insert(0, "base");
    await state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(source));
    for (let i = 0; i < 128; i++) {
      const update = capture(source, d => d.getText("content").insert(d.getText("content").length, "x"));
      const result = await state.writeCollaborationDocument("doc", update);
      expect(result.storage.updateRows).toBe(i === 127 ? 0 : i + 1);
    }
    expect((await header(state)).update_count).toBe(0);
    const large = "x".repeat(1024 * 1024 + 1);
    const update = capture(source, d => d.getMap("cards").set("large", { args: large, result: null }));
    const result = await state.writeCollaborationDocument("doc", update);
    expect(result.storage.compacted).toBe(true);
    expect(Number((await header(state)).update_bytes)).toBe(0);
    const restored = doc((await state.readCollaborationDocument("doc")).state);
    expect(restored.getMap("cards").get("large")).toEqual({ args: large, result: null });
    expect(restored.getText("content").toString()).toBe("base" + "x".repeat(128));
  }, 20_000);

  it("discards an exclusively owned cache entry when the real outer Space transaction rolls back", async () => {
    const state = store(), source = doc();
    source.getText("content").insert(0, "base");
    await state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(source), { text: "base" });
    const before = await state.readCollaborationDocument("doc");
    const update = capture(source, d => d.getText("content").insert(4, " rolled back"));
    const spaces = new PostgresSharedSpaceStore({ accounts: database.accounts });
    await expect(spaces.transaction(state.spaceId, async (client, afterCommit) => {
      await state.writeCollaborationDocument("doc", update, { text: "ignored" }, { client, afterCommit });
      expect(collaborationDocumentCache.snapshot().documents).toBe(0);
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    expect(collaborationDocumentCache.snapshot().documents).toBe(0);
    expect((await state.readSession("doc")).text).toBe("base");
    expect(Buffer.from((await state.readCollaborationDocument("doc")).state)).toEqual(Buffer.from(before.state));
  });

  it("fails on corrupt or missing persisted updates even when the accepted document is cached", async () => {
    const state = store(), source = doc();
    source.getText("content").insert(0, "base");
    await state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(source));
    const update = capture(source, d => d.getText("content").insert(4, " accepted"));
    await state.writeCollaborationDocument("doc", update);
    expect(collaborationDocumentCache.snapshot().documents).toBe(1);
    await database.pool.query("UPDATE runtime_collaboration_updates SET update_blob=$2 WHERE space_id=$1",
      [state.spaceId, Buffer.from([0, 0])]);
    await expect(state.readCollaborationDocument("doc")).rejects.toMatchObject({ code: "collaboration_state_invalid" });
    await expect(state.writeCollaborationDocument("doc", update)).rejects.toMatchObject({ code: "collaboration_state_invalid" });
    await database.pool.query("DELETE FROM runtime_collaboration_updates WHERE space_id=$1", [state.spaceId]);
    await expect(state.readCollaborationDocument("doc")).rejects.toMatchObject({ code: "collaboration_state_invalid" });
  });

  it("does not hide a changed log vector behind a warm cache even when each update hash is valid", async () => {
    const state = store(), source = doc();
    source.getText("content").insert(0, "base");
    const initial = Y.encodeStateAsUpdate(source);
    await state.writeCollaborationDocument("doc", initial);
    await state.writeCollaborationDocument("doc", capture(source, d => d.getText("content").insert(4, " accepted")));
    const other = doc(initial);
    const different = capture(other, d => d.getText("content").insert(4, " altered"));
    await database.pool.query(`UPDATE runtime_collaboration_updates SET update_blob=$2,update_hash=$3 WHERE space_id=$1`,
      [state.spaceId, Buffer.from(different), collaborationUpdateHash(different)]);
    await database.pool.query(`UPDATE runtime_collaboration_documents SET update_bytes=$2 WHERE space_id=$1`,
      [state.spaceId, different.length]);
    await expect(state.writeCollaborationDocument("doc", new Uint8Array([0, 0])))
      .rejects.toMatchObject({ code: "collaboration_state_invalid" });
  });

  it("fences stale bootstrap versions and checks the latest HTTP text under the mutation lock", async () => {
    const state = store(), seed = doc();
    await state.createSession({ id: "doc", text: "first" });
    seed.getText("content").insert(0, "first");
    await state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(seed),
      { text: "first", replaceSnapshot: true, expectedVersion: 0 });
    const other = doc(); other.getText("content").insert(0, "first");
    await expect(state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(other),
      { text: "first", replaceSnapshot: true, expectedVersion: 0 }))
      .rejects.toMatchObject({ code: "collaboration_snapshot_changed" });
    await state.updateSession("doc", { text: "HTTP changed" });
    await expect(state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(other),
      { text: "first", replaceSnapshot: true, expectedVersion: 1 }))
      .rejects.toMatchObject({ code: "collaboration_snapshot_changed" });
    expect((await state.readSession("doc")).text).toBe("HTTP changed");
  });

  it("writes complete legacy-compatible headers after the committed snapshot-mode fence", async () => {
    const state = store(), source = doc();
    source.getText("content").insert(0, "base");
    await state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(source));
    await state.writeCollaborationDocument("doc", capture(source, d => d.getText("content").insert(4, " update")));
    await database.pool.query("UPDATE runtime_collaboration_storage_mode SET mode='snapshot' WHERE id='global'");
    try {
      await state.writeCollaborationDocument("doc", new Uint8Array([0, 0]), { emitEvent: false });
      const row = await header(state);
      expect(row.base_version).toBeNull();
      expect(row.base_hash).toBeNull();
      expect(row.update_count).toBe(0);
      expect(Number(row.update_bytes)).toBe(0);
      expect((await database.pool.query("SELECT 1 FROM runtime_collaboration_updates WHERE space_id=$1", [state.spaceId])).rowCount).toBe(0);
      // Simulate a legacy writer that knows only the original six columns.
      await database.pool.query(`UPDATE runtime_collaboration_documents SET
        state_blob=$2,state_hash=$3,version=version+1 WHERE space_id=$1`,
      [state.spaceId, row.state_blob, row.state_hash]);
      expect(doc((await state.readCollaborationDocument("doc")).state).getText("content").toString()).toBe("base update");
    } finally { await database.pool.query("UPDATE runtime_collaboration_storage_mode SET mode='incremental' WHERE id='global'"); }
  });
});
