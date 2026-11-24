import { afterEach, describe, expect, it } from "vitest";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { PostgresSharingStore } from "../src/sharing/postgres-sharing-store.mjs";
import { PostgresSharedSpaceStore } from "../src/spaces/postgres-shared-space-store.mjs";
import { createSharedFolderTransfer } from "../src/sharing/shared-folder-transfer.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const db = await createPostgresTestDatabase("folder_transfer"); cleanup.push(db.close);
  const owner = await db.accounts.resolveIdentity({ issuer: "https://transfer.test", subject: "owner" });
  const receiver = await db.accounts.resolveIdentity({ issuer: "https://transfer.test", subject: "receiver" });
  const origin = await db.accounts.personalSpace(receiver.id), destination = await db.accounts.personalSpace(owner.id);
  const source = await new PostgresWorkbenchStateStore(db.pool, { spaceId: origin.id }).initialize();
  const target = await new PostgresWorkbenchStateStore(db.pool, { spaceId: destination.id }).initialize();
  const sharing = new PostgresSharingStore({ accounts: db.accounts });
  const spaces = new PostgresSharedSpaceStore({ accounts: db.accounts }); spaces.sharing = sharing;
  await spaces.registerDocument(receiver.id, origin.id, "source");
  await source.updateSession("source", { text: "user original", meta: { title: "source", privateKey: "private" } });
  await target.writeTree({ id: "root", type: "folder", children: [{ id: "folder", type: "folder", title: "folder", children: [] }] });
  const { share } = await sharing.create(owner.id, { kind: "folder", sourceId: "folder", recipient: receiver.id, role: "editor" });
  const acquired = [], released = [];
  const apps = { [origin.id]: { documentStore: source }, [destination.id]: { documentStore: target } };
  const transfer = createSharedFolderTransfer({ sharing, spaces, acquireRuntime: async id => {
    acquired.push(id);
    return { app: apps[id], release: () => released.push(id) };
  } });
  const input = { action: "importDocument", id: "folder", sourceDocumentId: "source", operationId: "move" };
  const move = overrides => transfer(receiver.id, share.id, { ...input, ...overrides });
  const attachImage = async ({ simultaneous = false } = {}) => {
    await source.updateSession("source", { text: "user ![image](zion-asset://original-image)" });
    apps[origin.id].readPublicationAssets = async () => [{ id: "original-image" }];
    let sequence = 0;
    let releaseStages;
    const stagesReady = new Promise(resolve => { releaseStages = resolve; });
    apps[destination.id].stageReviewedAssets = async (userId) => {
      const id = `staged-${sequence++}`;
      await db.pool.query(`INSERT INTO runtime_assets
        (space_id,id,owner_id,state,media_kind,media_type,byte_length,sha256,blob_key,created_at)
        VALUES ($1,$2,$3,'ready','image','image/png',1,$4,'fixture',$5)`,
      [destination.id, id, userId, "a".repeat(64), Date.now()]);
      if (simultaneous) {
        if (sequence === 2) releaseStages();
        await stagesReady;
      }
      return [{ sourceId: "original-image", id }];
    };
    apps[destination.id].discardReviewedAssets = (userId, ids) => db.pool.query(
      "DELETE FROM runtime_assets WHERE space_id=$1 AND owner_id=$2 AND id=ANY($3::text[])", [destination.id, userId, ids]);
  };
  return { db, owner, receiver, origin, destination, source, target, sharing, spaces, share, input, move, acquired, released, attachImage };
}
describe("atomic inward transfers into received folders", () => {
  it.each([
    ["inline", "inline"], ["references", "inline"],
    ["inline", "references"], ["references", "references"]
  ])("preserves visible card bodies and images from %s storage into %s storage", async (from, to) => {
    const h = await fixture();
    await h.attachImage();
    await h.db.pool.query("UPDATE runtime_session_card_storage_mode SET mode=$1 WHERE id='global'", [from]);
    const text = "user original\nassistant reply\n调用 read <!-- zion-tool:id=visible -->\n思考 <!-- zion-thinking:id=thought -->";
    const result = { text: "中文结果".repeat(1000), image: "zion-asset://original-image" };
    await h.source.updateSession("source", { text, meta: {
      privateKey: "private", annotations: {
        tools: [
          { id: "visible", kind: "tool", runId: "private-run", args: { path: "/visible" }, result, ok: true, privateKey: "private" },
          { id: "hidden", kind: "tool", runId: "private-run", args: { token: "private" }, result: "private".repeat(1000) }
        ],
        thinking: [{ id: "thought", kind: "thinking", runId: "private-run", text: "中文思考".repeat(1000), privateKey: "private" }]
      }
    } });
    const sourceMeta = (await h.db.pool.query(
      "SELECT meta_json FROM runtime_workbench_metadata WHERE space_id=$1 AND id='source'",
      [h.origin.id])).rows[0].meta_json;
    if (from === "references") {
      expect(sourceMeta.annotations.tools[0]).toMatchObject({ bodySessionId: "source", bodyKind: "tools" });
      expect(sourceMeta.annotations.tools[0]).not.toHaveProperty("result");
    } else expect(sourceMeta.annotations.tools[0].result).toEqual(result);
    const before = await h.spaces.content(h.origin.id, "source");
    expect(before.cards.tools[0].result).toEqual(result);
    expect(before.cards.thinking[0].text).toBe("中文思考".repeat(1000));
    await h.db.pool.query("UPDATE runtime_session_card_storage_mode SET mode=$1 WHERE id='global'", [to]);
    const moved = await h.move();
    const destination = await h.target.readSession(moved.id);
    expect(destination.meta).not.toHaveProperty("privateKey");
    expect(destination.meta.annotations.tools).toHaveLength(1);
    expect(destination.meta.annotations.tools[0]).toMatchObject({
      id: "visible", args: { path: "/visible" },
      result: { text: result.text, image: "zion-asset://staged-0" }, ok: true
    });
    expect(destination.meta.annotations.tools[0]).not.toHaveProperty("privateKey");
    expect(destination.meta.annotations.thinking[0].text).toBe("中文思考".repeat(1000));
    const raw = (await h.db.pool.query(
      "SELECT meta_json FROM runtime_workbench_metadata WHERE space_id=$1 AND id=$2",
      [h.destination.id, moved.id])).rows[0].meta_json;
    // Imported history is local content: it cannot retain the private source
    // Run identity or a body reference scoped to the source document.
    expect(raw.annotations.tools[0]).not.toHaveProperty("bodySessionId");
    expect(raw.annotations.tools[0]).not.toHaveProperty("runId");
    expect(raw.annotations.tools[0].result.image).toBe("zion-asset://staged-0");
    expect((await h.source.readSession("source")).deleted).toBe(true);
    expect((await h.db.pool.query(
      "SELECT * FROM space_document_assets WHERE space_id=$1 AND document_id=$2",
      [h.destination.id, moved.id])).rowCount).toBe(1);
  });
  it("serializes duplicate imports and conflicting request reuse with one destination and one source deletion", async () => {
    const h = await fixture();
    const results = await Promise.all([h.move(), h.move()]);
    expect(results[0].id).toBe(results[1].id);
    expect(results.filter(result => result.duplicate)).toHaveLength(1);
    expect((await h.sharing.tree(h.destination.id)).children[0].children).toHaveLength(1);
    expect((await h.source.readSession("source")).deleted).toBe(true);
    expect((await h.target.readSession(results[0].id)).text).toBe("user original");
    expect(h.released.sort()).toEqual(h.acquired.sort());
    await expect(h.move({ sourceDocumentId: "other" })).rejects.toMatchObject({ code: "document_transfer_request_conflict" });
    await h.sharing.revoke(h.owner.id, h.share.id, { recipientId: h.receiver.id });
    await expect(h.move()).rejects.toMatchObject({ code: "share_access_revoked" });
  });
  it("rolls back both stores and emits no document changes when source deletion fails after destination creation", async () => {
    const h = await fixture(), events = [];
    await h.attachImage();
    const a = h.source.subscribeEvents(event => events.push(event)), b = h.target.subscribeEvents(event => events.push(event));
    const deleteSession = h.source.deleteSession.bind(h.source);
    h.source.deleteSession = async (...args) => { await deleteSession(...args); throw new Error("injected source failure"); };
    await expect(h.move()).rejects.toThrow("injected source failure");
    expect((await h.source.readSession("source")).text).toContain("original-image");
    expect((await h.sharing.tree(h.destination.id)).children[0].children).toEqual([]);
    expect((await h.db.pool.query("SELECT * FROM space_document_transfers")).rowCount).toBe(0);
    expect((await h.db.pool.query("SELECT * FROM space_documents WHERE space_id=$1", [h.destination.id])).rowCount).toBe(0);
    expect((await h.db.pool.query("SELECT * FROM runtime_assets WHERE space_id=$1", [h.destination.id])).rowCount).toBe(0);
    expect((await h.db.pool.query("SELECT * FROM space_document_assets WHERE space_id=$1", [h.destination.id])).rowCount).toBe(0);
    expect(events).toEqual([]); expect(h.released).toHaveLength(2);
    a.dispose(); b.dispose();
  });
  it("cleans duplicate staged assets while retaining only the committed image and inherited access", async () => {
    const h = await fixture(); await h.attachImage({ simultaneous: true });
    const results = await Promise.all([h.move(), h.move()]);
    expect(results[0].id).toBe(results[1].id);
    expect((await h.db.pool.query("SELECT * FROM runtime_assets WHERE space_id=$1", [h.destination.id])).rowCount).toBe(1);
    expect((await h.db.pool.query("SELECT * FROM space_document_assets WHERE space_id=$1", [h.destination.id])).rowCount).toBe(1);
  });
  it.each(["waiting_run", "reserved_input"])("retains a source with an active %s", async kind => {
    const h = await fixture(), now = Date.now();
    await h.db.pool.query(`INSERT INTO runtime_sessions (space_id,id,payload_json,status,updated_at)
      VALUES ($1,'source','{"id":"source"}'::jsonb,'active',$2)`, [h.origin.id, now]);
    if (kind === "waiting_run") await h.db.pool.query(`INSERT INTO runtime_runs
      (space_id,id,payload_json,status,updated_at) VALUES ($1,'waiting','{"sessionId":"source"}'::jsonb,'waiting',$2)`, [h.origin.id, now]);
    else await h.db.pool.query(`INSERT INTO runtime_conversation_inputs
      (space_id,session_id,id,client_request_id,fingerprint,principal_id,base_sequence,status,reserved_until,payload_json,created_at)
      VALUES ($1,'source','pending','pending','fingerprint',$2,0,'reserved',$3,'{}'::jsonb,$4)`,
    [h.origin.id, h.receiver.id, now + 60000, now]);
    await expect(h.move()).rejects.toMatchObject({ statusCode: 409, code: "source_document_busy" });
    expect((await h.source.readSession("source")).text).toBe("user original");
    expect((await h.sharing.tree(h.destination.id)).children[0].children).toEqual([]);
  });
  it.each(["content", "revocation", "target_removed"])("reauthorizes %s changes during the transfer before mutating either store", async change => {
    const h = await fixture();
    const transactionMany = h.spaces.transactionMany.bind(h.spaces);
    h.spaces.transactionMany = async (...args) => {
      if (change === "content") await h.source.updateSession("source", { text: "user newer" });
      else if (change === "revocation") await h.sharing.revoke(h.owner.id, h.share.id, { recipientId: h.receiver.id });
      else await h.target.writeTree({ id: "root", type: "folder", children: [] });
      return transactionMany(...args);
    };
    await expect(h.move()).rejects.toMatchObject({ statusCode: change === "content" ? 409 : change === "revocation" ? 403 : 404 });
    expect((await h.source.readSession("source")).text).toBe(change === "content" ? "user newer" : "user original");
    expect((await h.db.pool.query("SELECT * FROM space_document_transfers")).rowCount).toBe(0);
    expect((await h.db.pool.query("SELECT * FROM space_documents WHERE space_id=$1", [h.destination.id])).rowCount).toBe(0);
  });
});
