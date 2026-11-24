import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { createRuntimeCollaborationService } from "../src/collaboration-service.mjs";
import {
  prepareSessionCardBody, readSessionCardBody
} from "../src/session-card-bodies.mjs";
import { createSessionDocumentProjector } from "../../../extensions/dev.session-manager/session-document-projector.js";
import { collaborationDocumentCache } from "../src/collaboration-update-log.mjs";

let database;
const documents = [];
const document = () => { const value = new Y.Doc(); documents.push(value); return value; };
const store = () => new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
const card = () => ({ id: "tool:run:c", kind: "tool", runId: "run", name: "read", status: "completed",
  args: { z: "中文参数".repeat(1000), a: { nullable: null, count: 0 } },
  result: { exact: "中文结果".repeat(1000), nullable: null, values: [], ok: false }, ok: true, sequence: 1 });
const bodyCount = async state => Number((await database.pool.query(
  "SELECT count(*) FROM runtime_session_card_bodies WHERE space_id=$1", [state.spaceId])).rows[0].count);
const storedMeta = async state => (await database.pool.query(
  "SELECT meta_json FROM runtime_workbench_metadata WHERE space_id=$1 AND id='doc'", [state.spaceId])).rows[0].meta_json;

beforeAll(async () => { database = await createPostgresTestDatabase("session_card_bodies"); });
beforeEach(async () => {
  await database.pool.query("UPDATE runtime_session_card_storage_mode SET mode='references' WHERE id='global'");
});
afterEach(() => { collaborationDocumentCache.clear(); for (const value of documents.splice(0)) value.destroy(); });
afterAll(async () => { await database.close(); });

describe("durable session card bodies with real PostgreSQL", () => {
  it("stores one body across metadata and revision history and preserves all full readers", async () => {
    const state = store(), tool = card(), annotations = { tools: [tool], thinking: [] };
    await state.createSession({ id: "doc", text: "user 原始", meta: { annotations } });
    const raw = await storedMeta(state), compact = raw.annotations.tools[0];
    expect(compact).toMatchObject({ id: tool.id, bodyKind: "tools", bodySessionId: "doc" });
    expect(compact).not.toHaveProperty("args");
    expect(compact).not.toHaveProperty("result");
    expect(await bodyCount(state)).toBe(1);
    expect((await state.readSession("doc")).meta.annotations).toEqual(annotations);
    expect((await state.readSessionMeta("doc")).annotations).toEqual(annotations);
    expect((await state.readSessionMetadataRecord("doc")).meta.annotations).toEqual(annotations);
    expect((await state.readSessionMetadataRecord("doc", { cardView: "render" })).meta.annotations.tools[0]).toEqual(compact);
    expect((await state.readSnapshot()).snapshot.metas.find(row => row.id === "doc").meta.annotations).toEqual(annotations);
    const revisions = await state.listSessionRevisions("doc");
    await state.updateSession("doc", { title: "later" });
    await state.restoreSessionRevision("doc", revisions[0].revision);
    expect((await state.readSession("doc")).meta.annotations).toEqual(annotations);
    expect(await bodyCount(state)).toBe(1);
    const detail = await state.readSessionCardDetails("doc",
      [{ kind: "tools", id: tool.id, ref: compact.bodyRef, storage: "body" }]);
    expect(detail.details[0].body).toEqual({ args: tool.args, result: tool.result });
  });

  it("reuses canonical body identities across Y and JSONB object-key order", async () => {
    const state = store(), tool = card();
    await state.createSession({ id: "doc", text: "" });
    const first = await state.transaction(client => prepareSessionCardBody(client, state.spaceId, "doc", "tools", tool));
    const reordered = { ...tool, args: { a: { count: 0, nullable: null }, z: tool.args.z },
      result: { ok: false, values: [], nullable: null, exact: tool.result.exact } };
    const second = await state.transaction(client => prepareSessionCardBody(client, state.spaceId, "doc", "tools", reordered));
    expect(second.card.bodyRef).toBe(first.card.bodyRef);
    expect(first.writtenBytes).toBe(first.card.bodyBytes);
    expect(second).toMatchObject({ writtenBytes: 0, reused: true });
    expect(await bodyCount(state)).toBe(1);
  });

  it("serializes simultaneous first preparations without duplicate body writes", async () => {
    const state = store(), other = new PostgresWorkbenchStateStore(database.pool, { spaceId: state.spaceId });
    await state.createSession({ id: "doc", text: "" });
    const values = await Promise.all([state, other].map(owner =>
      owner.transaction(client => prepareSessionCardBody(client, state.spaceId, "doc", "tools", card()))));
    expect(values[0].card.bodyRef).toBe(values[1].card.bodyRef);
    expect(values.filter(value => value.writtenBytes > 0)).toHaveLength(1);
    expect(values.reduce((sum, value) => sum + value.writtenBytes, 0)).toBe(values[0].card.bodyBytes);
    expect(await bodyCount(state)).toBe(1);
  });

  it("rejects cross-document references and rolls back the entire destination creation", async () => {
    const state = store();
    await state.createSession({ id: "doc", text: "secret", meta: { annotations: { tools: [card()] } } });
    const compact = (await storedMeta(state)).annotations.tools[0];
    await expect(state.createSession({ id: "visible", text: "visible", meta: { annotations: { tools: [compact] } } }))
      .rejects.toMatchObject({ statusCode: 403, code: "CARD_BODY_SCOPE_MISMATCH" });
    expect(await state.readSession("visible")).toBeNull();
    await expect(readSessionCardBody(database.pool, database.nextSpaceId(), "doc", "tools", compact))
      .rejects.toMatchObject({ code: "CARD_BODY_MISSING" });
    expect(await bodyCount(state)).toBe(1);
  });

  it.each(["missing", "corrupt"])("fails full reads when a referenced body is %s", async kind => {
    const state = store();
    await state.createSession({ id: "doc", text: "user preserved", meta: { annotations: { tools: [card()] } } });
    if (kind === "missing") await database.pool.query(
      "DELETE FROM runtime_session_card_bodies WHERE space_id=$1", [state.spaceId]);
    else await database.pool.query(
      "UPDATE runtime_session_card_bodies SET body_json=$2,byte_size=octet_length($2) WHERE space_id=$1",
      [state.spaceId, JSON.stringify({ args: {}, result: "changed" })]);
    await expect(state.readSession("doc")).rejects.toMatchObject({
      code: kind === "missing" ? "CARD_BODY_MISSING" : "CARD_BODY_CORRUPT" });
    expect((await database.pool.query(
      "SELECT text FROM runtime_workbench_documents WHERE space_id=$1 AND id='doc'", [state.spaceId])).rows[0].text)
      .toBe("user preserved");
  });

  it("commits tool bodies before publishing references and preserves resumed reasoning", async () => {
    const state = store(), projector = createSessionDocumentProjector();
    await state.createSession({ id: "doc", text: "user question" });
    const service = createRuntimeCollaborationService({ store: state, documentProjector: projector });
    const connection = await service.hocuspocus.openDirectConnection("doc", { clientId: "observer", committedSnapshot: true });
    const observations = [];
    const observer = event => {
      for (const id of event.keysChanged) {
        const value = connection.document.getMap("cards").get(id);
        if (value?.bodyRef) observations.push(database.pool.query(
          "SELECT 1 FROM runtime_session_card_bodies WHERE space_id=$1 AND session_id='doc' AND ref=$2",
          [state.spaceId, value.bodyRef]).then(result => expect(result.rowCount).toBe(1)));
      }
    };
    connection.document.getMap("cards").observe(observer);
    try {
      const tool = card();
      await service.applyRunEvents("doc", { runId: "run", events: [
        { runId: "run", type: "tool.requested", sequence: 1, data: { callId: "c", name: "read", arguments: tool.args } },
        { runId: "run", type: "tool.completed", sequence: 2, data: { callId: "c", result: tool.result } },
        { runId: "run", type: "reasoning.completed", sequence: 3, data: { reasoningSegmentId: "seg", content: "思考".repeat(2000) } }
      ] });
      await Promise.all(observations);
      expect(observations.length).toBe(2);
      const compact = connection.document.getMap("cards").get(tool.id);
      expect(compact).not.toHaveProperty("args");
      expect(compact).not.toHaveProperty("result");
      await service.applyRunEvents("doc", { runId: "run", events: [
        { runId: "run", type: "reasoning.delta", sequence: 4, data: { reasoningSegmentId: "seg", delta: "继续" } },
        { runId: "run", type: "reasoning.completed", sequence: 5, data: { reasoningSegmentId: "seg" } }
      ] });
      const thought = connection.document.getMap("cards").get("thinking:run:seg");
      expect((await readSessionCardBody(database.pool, state.spaceId, "doc", "thinking", thought)).text)
        .toBe("思考".repeat(2000) + "继续");
    } finally {
      connection.document.getMap("cards").unobserve(observer);
      await connection.disconnect();
      await service.close();
    }
  });

  it("rejects a card mutation arriving during predecessor hydration", async () => {
    const state = store(), source = document(), tool = card();
    await state.createSession({ id: "doc", text: "" });
    const prepared = await state.transaction(client =>
      prepareSessionCardBody(client, state.spaceId, "doc", "tools", tool));
    source.getMap("cards").set(tool.id, prepared.card);
    source.getMap("runProjection").set("run", { lastSequence: 1 });
    await state.transaction(async client => {
      const query = client.query.bind(client);
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { entered = resolve; });
      client.query = async (...args) => {
        if (String(args[0]).includes("SELECT body_json, byte_size")) { entered(); await gate; }
        return query(...args);
      };
      try {
        const pending = state.prepareRunCardBodies("doc", { document: source, runId: "run",
          projector: createSessionDocumentProjector(), events: [
            { runId: "run", type: "tool.completed", sequence: 2, data: { callId: "c", result: "event" } }
          ] }, { client });
        await ready;
        source.getMap("cards").set(tool.id, { ...tool, result: "newer edit" });
        release();
        await expect(pending).rejects.toMatchObject({ code: "collaboration_projection_changed" });
      } finally { client.query = query; release(); }
    });
    expect(source.getMap("cards").get(tool.id).result).toBe("newer edit");
    expect(await bodyCount(state)).toBe(1);
  });

  it("fences new references and materializes accepted Y bodies for a legacy next write", async () => {
    const state = store(), source = document(), tool = card();
    await state.createSession({ id: "doc", text: "user baseline", meta: { annotations: { tools: [tool] } } });
    const compact = (await storedMeta(state)).annotations.tools[0];
    source.getText("content").insert(0, "user baseline");
    source.getMap("cards").set(tool.id, compact);
    const anchor = Y.createRelativePositionFromTypeIndex(source.getText("content"), 5);
    await state.writeCollaborationDocument("doc", Y.encodeStateAsUpdate(source), { text: "user baseline" });
    await database.pool.query("UPDATE runtime_session_card_storage_mode SET mode='inline' WHERE id='global'");
    const updates = [];
    source.on("update", value => updates.push(value));
    source.getText("content").insert(source.getText("content").length, " accepted");
    const saved = await state.writeCollaborationDocument("doc", Y.mergeUpdates(updates), { text: "projection" });
    expect(saved.storage.compacted).toBe(true);
    const restored = document();
    Y.applyUpdate(restored, (await state.readCollaborationDocument("doc")).state);
    expect(restored.getMap("cards").get(tool.id)).toEqual(tool);
    expect(restored.getMap("cards").get(tool.id)).not.toHaveProperty("bodyRef");
    expect(Y.createAbsolutePositionFromRelativePosition(anchor, restored).index).toBe(5);
    await state.updateSession("doc", { title: "legacy compatible" });
    expect((await storedMeta(state)).annotations.tools[0]).toEqual(tool);
  });
});
