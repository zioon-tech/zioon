import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { convertSessionCardStorage, fenceSessionCardStorage, listSessionCardStorageDocuments }
  from "../src/session-card-maintenance.mjs";
import { collaborationDocumentCache } from "../src/collaboration-update-log.mjs";
import { createRuntimeCollaborationService } from "../src/collaboration-service.mjs";
import { createSessionDocumentProjector } from "../../../extensions/dev.session-manager/session-document-projector.js";
import { sessionRenderProjection } from "../src/session-card-projection.mjs";

let database;
const docs = [];
const document = () => { const doc = new Y.Doc(); docs.push(doc); return doc; };
const tool = () => ({ id: "tool:run:call", kind: "tool", runId: "run", sequence: 1,
  args: { z: "参数".repeat(3000), nullable: null, empty: [] }, result: { detail: "结果".repeat(3000) },
  status: "completed", ok: true, expanded: true, anchor: { line: 2 } });
const owner = () => new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
const rawMeta = async (state, id) => (await database.pool.query(
  "SELECT meta_json FROM runtime_workbench_metadata WHERE space_id=$1 AND id=$2",
  [state.spaceId, id])).rows[0]?.meta_json;
const revisions = async (state, id) => (await database.pool.query(
  "SELECT revision,meta_json,content_hash FROM runtime_workbench_session_revisions WHERE space_id=$1 AND session_id=$2 ORDER BY revision",
  [state.spaceId, id])).rows;
async function convertAll(state, id, mode, revisionLimit = 1) {
  let nextRevision = 0, current = true;
  const batches = [];
  do {
    const result = await convertSessionCardStorage(database.pool,
      { spaceId: state.spaceId, sessionId: id, mode, revisionAfter: nextRevision, revisionLimit, current });
    batches.push(result);
    if (result.complete) return batches;
    nextRevision = result.nextRevision;
    current = false;
  } while (batches.length < 32);
  throw new Error("Migration did not terminate");
}
beforeAll(async () => { database = await createPostgresTestDatabase("card_maintenance"); });
beforeEach(async () => { await fenceSessionCardStorage(database.pool, "inline"); });
afterEach(() => { collaborationDocumentCache.clear(); for (const doc of docs.splice(0)) doc.destroy(); });
afterAll(async () => { await database.close(); });

describe("bounded card migration and downgrade on real PostgreSQL", () => {
  it.each(["tools", "thinking"])("keeps frozen %s transport references valid after body-only conversion", async kind => {
    const state = owner();
    const card = kind === "tools" ? { ...tool(), expanded: false,
      result: { zz: "完整结果".repeat(2048), a: false, nullable: null, "中": "中文" } } : {
      id: "thinking:run:transport", kind: "thinking", runId: "run", status: "completed",
      expanded: false, text: "完整思考".repeat(2048)
    };
    await state.createSession({ id: "doc", text: "user question", meta: { annotations: { [kind]: [card] } } });
    const frozen = sessionRenderProjection(await state.readSession("doc")).meta.annotations[kind][0];
    expect(frozen.detailRef).toMatch(/^[a-f0-9]{64}$/);
    const request = [{ kind, id: card.id, ref: frozen.detailRef }];
    await fenceSessionCardStorage(database.pool, "references");
    await convertAll(state, "doc", "references");
    expect((await rawMeta(state, "doc")).annotations[kind][0]).toHaveProperty("bodyRef");
    expect((await state.readSessionCardDetails("doc", request)).details[0].body).toEqual(
      kind === "tools" ? { result: card.result } : { text: card.text });
    const changed = { ...card, ...(kind === "tools" ? { result: "真正变化".repeat(2048) } : { text: "真正变化".repeat(2048) }) };
    await state.updateSession("doc", { meta: { annotations: { [kind]: [changed] } } });
    await expect(state.readSessionCardDetails("doc", request)).rejects.toMatchObject({ code: "CARD_DETAIL_CHANGED" });
  });

  it("keeps mismatched inline legacy Y identities through conversion, later edits and downgrade", async () => {
    const state = owner(), source = document();
    const legacy = { id: "legacy-value-id", kind: "tool", runId: "legacy-run",
      args: { exact: "旧正文".repeat(2048), nullable: null }, result: null };
    await state.createSession({ id: "doc", text: "user" });
    source.getText("content").insert(0, "user");
    source.getMap("cards").set("legacy-map-key", legacy);
    await state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(source));
    await fenceSessionCardStorage(database.pool, "references");
    await convertAll(state, "doc", "references");
    const current = document();
    Y.applyUpdate(current, (await state.readCollaborationDocument("doc")).state);
    expect(current.getMap("cards").get("legacy-map-key")).toEqual(legacy);
    const updates = [];
    current.on("update", update => updates.push(update));
    current.getText("content").insert(4, "!");
    const saved = await state.writeCollaborationDocument("doc", Y.mergeUpdates(updates));
    const edited = document();
    Y.applyUpdate(edited, saved.state);
    expect(edited.getText("content").toString()).toBe("user!");
    expect(edited.getMap("cards").get("legacy-map-key")).toEqual(legacy);
    await fenceSessionCardStorage(database.pool, "inline");
    await convertAll(state, "doc", "inline");
    const downgraded = document();
    Y.applyUpdate(downgraded, (await state.readCollaborationDocument("doc")).state);
    expect(downgraded.getMap("cards").get("legacy-map-key")).toEqual(legacy);
    expect(downgraded.getText("content").toString()).toBe("user!");
  });

  it("keeps all historical slots and the session head for unchanged full and compact snapshots", async () => {
    const state = owner();
    await state.createSession({ id: "doc", text: "user first version", meta: {
      annotations: { tools: [tool()], thinking: [] }
    } });
    await state.updateSession("doc", { text: "user second version" });
    await fenceSessionCardStorage(database.pool, "references");
    await convertAll(state, "doc", "references");
    const original = await state.readSession("doc"), history = await revisions(state, "doc");
    const full = (await state.readSnapshot()).snapshot;
    const compact = { metas: [{ id: "doc", meta: await rawMeta(state, "doc") }] };
    for (let index = 0; index < 22; index++) await state.writeSnapshot(index % 2 ? compact : full);
    expect((await state.readSession("doc")).session_revision).toBe(original.session_revision);
    expect(await revisions(state, "doc")).toEqual(history);
    expect((await state.readSession("doc")).meta).toEqual(original.meta);
    const changed = structuredClone(full);
    changed.metas.find(item => item.id === "doc").meta.annotations.tools[0].expanded = false;
    await state.writeSnapshot(changed);
    expect((await state.readSession("doc")).session_revision).toBe(original.session_revision + 1);
    expect((await state.readSession("doc")).meta.annotations.tools[0]).toEqual({ ...tool(), expanded: false });
    expect(await revisions(state, "doc")).toHaveLength(history.length + 1);
  });

  it("skips body preparation for message-only projection and reads only a touched card predecessor", async () => {
    const state = owner(), source = document(), projector = createSessionDocumentProjector();
    const cards = Array.from({ length: 100 }, (_, i) => ({ ...tool(), id: `tool:run:${i}`, expanded: false }));
    await fenceSessionCardStorage(database.pool, "references");
    await state.createSession({ id: "doc", text: "user question", meta: { annotations: { tools: cards } } });
    source.getText("content").insert(0, "user question");
    for (const card of (await rawMeta(state, "doc")).annotations.tools) source.getMap("cards").set(card.id, card);
    await state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(source));
    const prepare = state.prepareRunCardBodies.bind(state);
    let preparations = 0;
    state.prepareRunCardBodies = (...args) => { preparations++; return prepare(...args); };
    const service = createRuntimeCollaborationService({ store: state, documentProjector: projector });
    try {
      await service.applyRunEvents("doc", { runId: "run", events: [
        { runId: "run", type: "message.delta", sequence: 1, data: { delta: "answer" } }
      ] });
      expect(preparations).toBe(0);
      const restored = document();
      Y.applyUpdate(restored, (await state.readCollaborationDocument("doc")).state);
      expect(restored.getText("content").toString()).toContain("answer");
      const before = restored.getMap("cards").get("tool:run:0");
      await state.transaction(async client => {
        const query = client.query.bind(client);
        let reads = 0;
        client.query = (...args) => {
          if (/^\s*SELECT\b/.test(String(args[0])) && String(args[0]).includes("runtime_session_card_bodies")) reads++;
          return query(...args);
        };
        try {
          const prepared = await prepare("doc", { document: restored, projector, runId: "run", events: [
            { runId: "run", type: "tool.completed", sequence: 2, data: { callId: "0", result: "changed" } }
          ] }, { client });
          expect(prepared.readCard("tool:run:0").args).toEqual(cards[0].args);
          expect(prepared.prepareCard({ id: "tool:run:0" }).bodyRef).not.toBe(before.bodyRef);
          expect(reads).toBeLessThanOrEqual(3);
        } finally { client.query = query; }
      });
    } finally { await service.close(); }
  });

  it("applies the inline fence to compact snapshot imports and rejects conflicting duplicate bodies", async () => {
    const state = owner(), card = tool();
    await fenceSessionCardStorage(database.pool, "references");
    await state.createSession({ id: "doc", text: "", meta: { annotations: { tools: [card] } } });
    const compactMeta = await rawMeta(state, "doc");
    await expect(state.writeSnapshot({ metas: [{ id: "doc", meta: { ...compactMeta,
      annotations: { tools: [{ ...compactMeta.annotations.tools[0], result: "conflicting result" }] } } }] }))
      .rejects.toMatchObject({ code: "CARD_BODY_DUPLICATE" });
    await fenceSessionCardStorage(database.pool, "inline");
    await convertAll(state, "doc", "inline");
    await state.writeSnapshot({ metas: [{ id: "doc", meta: compactMeta }] });
    expect((await rawMeta(state, "doc")).annotations.tools[0]).toEqual(card);
    expect((await rawMeta(state, "doc")).annotations.tools[0]).not.toHaveProperty("bodyRef");
  });

  it("bounds body query round trips for a small edit with 200 unchanged cards", async () => {
    const state = owner(), source = document();
    const cards = Array.from({ length: 200 }, (_, i) => ({ ...tool(), id: `tool:run:${i}`, expanded: false }));
    await fenceSessionCardStorage(database.pool, "references");
    await state.createSession({ id: "doc", text: "user", meta: { annotations: { tools: cards } } });
    source.getText("content").insert(0, "user");
    for (const card of (await rawMeta(state, "doc")).annotations.tools) source.getMap("cards").set(card.id, card);
    await state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(source));
    const updates = [];
    source.on("update", update => updates.push(update));
    source.getText("content").insert(4, "a");
    const connect = database.pool.connect.bind(database.pool);
    let bodyQueries = 0;
    database.pool.connect = async (...args) => {
      const client = await connect(...args), query = client.query.bind(client), release = client.release.bind(client);
      client.query = (...queryArgs) => {
        if (String(queryArgs[0]).includes("runtime_session_card_bodies")) bodyQueries++;
        return query(...queryArgs);
      };
      client.release = (...releaseArgs) => {
        client.query = query;
        client.release = release;
        return release(...releaseArgs);
      };
      return client;
    };
    let saved;
    try { saved = await state.writeCollaborationDocument("doc", Y.mergeUpdates(updates), { text: "projection" }); }
    finally { database.pool.connect = connect; }
    expect(saved.storage.compacted).toBe(false);
    expect(saved.storage.writtenStateBytes).toBeLessThan(100);
    expect(bodyQueries).toBeLessThanOrEqual(12);
    const persisted = document();
    Y.applyUpdate(persisted, saved.state);
    expect(persisted.getText("content").toString()).toBe("usera");
    expect(persisted.getMap("cards").size).toBe(200);
    expect(Number((await database.pool.query("SELECT count(*) FROM runtime_session_card_bodies WHERE space_id=$1",
      [state.spaceId])).rows[0].count)).toBe(200);
  });

  it("retargets shared historical bundles per document and preserves full metadata, hashes, Y anchors and bodies", async () => {
    const state = owner(), card = tool(), annotations = { tools: [card], thinking: [] };
    for (const id of ["first", "second"]) {
      await state.createSession({ id, text: "user 历史正文", meta: { annotations } });
    }
    const initial = await revisions(state, "first"), sibling = await revisions(state, "second");
    expect(initial[0].meta_json.__zionRevisionAnnotations.ref).toBe(sibling[0].meta_json.__zionRevisionAnnotations.ref);
    const fullSecond = (await state.readSession("second")).meta;
    await state.updateSession("first", { title: "第二版本" });
    const historical = await revisions(state, "first");
    const historicalFull = await Promise.all(historical.map(row =>
      state.hydrateRevisionMeta(row.meta_json, database.pool, "first")));
    const source = document();
    source.getText("content").insert(0, "user 历史正文");
    source.getMap("cards").set(card.id, card);
    source.getMap("runProjection").set("run", { lastSequence: 1, unknown: { retained: true } });
    source.getMap("unrelated").set("value", { nullable: null, exact: "保留" });
    const anchor = Y.createRelativePositionFromTypeIndex(source.getText("content"), 6);
    await state.writeCollaborationDocument("first", Y.encodeStateAsUpdate(source));
    await fenceSessionCardStorage(database.pool, "references");
    const batches = await convertAll(state, "first", "references");
    expect(batches).toHaveLength(2);
    expect(batches[0].changedCards).toBe(1);
    expect(batches[0].stateBytes).toBeGreaterThan(0);
    const compact = (await rawMeta(state, "first")).annotations.tools[0];
    expect(compact).toMatchObject({ bodySessionId: "first", bodyKind: "tools", expanded: true });
    expect(compact).not.toHaveProperty("args");
    expect(compact).not.toHaveProperty("result");
    expect((await rawMeta(state, "second")).annotations).toEqual(annotations);
    expect((await revisions(state, "second"))[0].meta_json).toEqual(sibling[0].meta_json);
    const convertedHistory = await revisions(state, "first");
    expect(convertedHistory.map(row => row.content_hash)).toEqual(historical.map(row => row.content_hash));
    expect(await Promise.all(convertedHistory.map(row => state.hydrateRevisionMeta(row.meta_json, database.pool, "first"))))
      .toEqual(historicalFull);
    const migrated = document();
    Y.applyUpdate(migrated, (await state.readCollaborationDocument("first")).state);
    expect(migrated.getMap("cards").get(card.id).bodyRef).toBe(compact.bodyRef);
    expect(migrated.getMap("runProjection").toJSON()).toEqual(source.getMap("runProjection").toJSON());
    expect(migrated.getMap("unrelated").toJSON()).toEqual(source.getMap("unrelated").toJSON());
    expect(Y.createAbsolutePositionFromRelativePosition(anchor, migrated).index).toBe(6);
    await convertAll(state, "second", "references");
    expect((await rawMeta(state, "second")).annotations.tools[0].bodySessionId).toBe("second");
    expect((await state.readSession("second")).meta.annotations).toEqual(annotations);
    await fenceSessionCardStorage(database.pool, "inline");
    await convertAll(state, "first", "inline");
    await convertAll(state, "second", "inline");
    const restored = document();
    Y.applyUpdate(restored, (await state.readCollaborationDocument("first")).state);
    expect(restored.getMap("cards").get(card.id)).toEqual(card);
    expect(Y.createAbsolutePositionFromRelativePosition(anchor, restored).index).toBe(6);
    expect((await rawMeta(state, "first")).annotations).toEqual(annotations);
    expect((await state.readSession("second")).meta).toEqual(fullSecond);
    expect(await Promise.all((await revisions(state, "first")).map(row =>
      state.hydrateRevisionMeta(row.meta_json, database.pool, "first")))).toEqual(historicalFull);
    const unchanged = await convertAll(state, "first", "inline");
    expect(unchanged.every(batch => batch.changedCards === 0 && !batch.changedMetadata && batch.changedRevisions === 0)).toBe(true);
  });

  it("keeps an accepted stale owner's edit after conversion and normalizes a later inline card write", async () => {
    const state = owner(), source = document(), card = tool();
    await state.createSession({ id: "doc", text: "user original", meta: { annotations: { tools: [card] } } });
    source.getText("content").insert(0, "user original");
    source.getMap("cards").set(card.id, card);
    await state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(source));
    const updates = [];
    source.on("update", update => updates.push(update));
    source.getText("content").insert(source.getText("content").length, " accepted");
    await fenceSessionCardStorage(database.pool, "references");
    await convertAll(state, "doc", "references");
    const saved = await state.writeCollaborationDocument("doc", Y.mergeUpdates(updates), { text: "projection" });
    const current = document();
    Y.applyUpdate(current, saved.state);
    expect(current.getText("content").toString()).toBe("user original accepted");
    expect(current.getMap("cards").get(card.id)).toHaveProperty("bodyRef");
    const next = [], updatedCard = { ...card, result: { detail: "new".repeat(3000), nullable: null } };
    current.on("update", update => next.push(update));
    current.getMap("cards").set(card.id, updatedCard);
    const changed = await state.writeCollaborationDocument("doc", Y.mergeUpdates(next));
    expect(changed.storage.compacted).toBe(true);
    const last = document();
    Y.applyUpdate(last, changed.state);
    expect(last.getMap("cards").get(card.id)).not.toHaveProperty("result");
    expect((await state.readSessionCardDetails("doc", [{ kind: "tools", id: card.id, storage: "body",
      ref: last.getMap("cards").get(card.id).bodyRef }])).details[0].body)
      .toEqual({ args: updatedCard.args, result: updatedCard.result });
  });

  it("rolls back all current Y, metadata and body writes when a historical bundle is missing", async () => {
    const state = owner(), source = document(), card = tool();
    await state.createSession({ id: "doc", text: "", meta: { annotations: { tools: [card] } } });
    source.getMap("cards").set(card.id, card);
    await state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(source));
    const beforeY = await state.readCollaborationDocument("doc"), beforeMeta = await rawMeta(state, "doc");
    await database.pool.query("DELETE FROM runtime_workbench_revision_annotations WHERE space_id=$1", [state.spaceId]);
    await fenceSessionCardStorage(database.pool, "references");
    await expect(convertAll(state, "doc", "references")).rejects.toMatchObject({ code: "CARD_STORAGE_MIGRATION_INVALID" });
    expect(await state.readCollaborationDocument("doc")).toEqual(beforeY);
    expect(await rawMeta(state, "doc")).toEqual(beforeMeta);
    expect(Number((await database.pool.query("SELECT count(*) FROM runtime_session_card_bodies WHERE space_id=$1",
      [state.spaceId])).rows[0].count)).toBe(0);
  });

  it("requires the committed fence and paginates document headers including historical sessions", async () => {
    const state = owner();
    await state.createSession({ id: "first", text: "" });
    await state.createSession({ id: "second", text: "" });
    await database.pool.query("DELETE FROM runtime_workbench_metadata WHERE space_id=$1 AND id='second'", [state.spaceId]);
    await expect(convertAll(state, "first", "references")).rejects.toMatchObject({ code: "CARD_STORAGE_MIGRATION_INVALID" });
    const first = await listSessionCardStorageDocuments(database.pool, { after: [state.spaceId, ""], limit: 1 });
    const second = await listSessionCardStorageDocuments(database.pool,
      { after: [first[0].space_id, first[0].session_id], limit: 1 });
    expect(first).toEqual([{ space_id: state.spaceId, session_id: "first" }]);
    expect(second).toEqual([{ space_id: state.spaceId, session_id: "second" }]);
    const following = await listSessionCardStorageDocuments(database.pool,
      { after: [second[0].space_id, second[0].session_id], limit: 1 });
    expect(following.filter(row => row.space_id === state.spaceId)).toEqual([]);
  });
});
