import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { SqliteWorkbenchStateStore } from "../src/sqlite-workbench-state-store.mjs";

const resources = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "zion-workbench-state-"));
  const store = new SqliteWorkbenchStateStore(join(directory, "runtime.sqlite3"));
  resources.push({ directory, store });
  return store;
}

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("SqliteWorkbenchStateStore", () => {
  it("stores snapshots incrementally without deleting omitted sessions", () => {
    const store = createStore();
    const initial = store.writeSnapshot({
      version: 1,
      updatedAt: 100,
      tree: { id: "root", type: "folder", children: [] },
      index: [],
      docs: [
        { id: "a", text: "old" },
        { id: "b", text: "keep" }
      ],
      metas: [
        { id: "a", meta: { title: "A" } },
        { id: "b", meta: { title: "B" } }
      ]
    });

    expect(initial).toMatchObject({ ok: true, revision: "runtime:1" });
    store.writeSnapshot({
      updatedAt: 200,
      docs: [{ id: "a", text: "new" }],
      metas: [{ id: "a", meta: { title: "A2" } }]
    });

    const stored = store.readSnapshot();
    expect(Object.fromEntries(stored.snapshot.docs.map((item) => [item.id, item.text])))
      .toEqual({ a: "new", b: "keep" });
    expect(Object.fromEntries(stored.snapshot.metas.map((item) => [item.id, item.meta.title])))
      .toEqual({ a: "A2", b: "B" });
    expect(store.readStatus()).toMatchObject({
      service: "zion-runtime",
      documents: 2,
      metadata: 2
    });
  });

  it("enforces revisions and makes operation ids idempotent", () => {
    const store = createStore();
    store.writeSnapshot({
      docs: [{ id: "a", text: "before" }],
      metas: [{ id: "a", meta: { title: "A" } }]
    });

    const conflict = store.updateSession("a", {
      text: "wrong",
      expected_revision: "runtime:0"
    });
    expect(conflict).toMatchObject({ ok: false, conflict: true });

    const first = store.updateSession("a", {
      text: "after",
      operation_id: "operation-1"
    });
    const duplicate = store.updateSession("a", {
      text: "must not overwrite",
      operation_id: "operation-1"
    });

    expect(first).toMatchObject({ ok: true, session_revision: 2 });
    expect(duplicate).toMatchObject({
      ok: true,
      duplicate: true,
      session_revision: 2
    });
    expect(store.readSession("a").text).toBe("after");
  });

  it("keeps session create/update/delete tree and index changes atomic", () => {
    const store = createStore();
    store.writeSnapshot({
      tree: {
        id: "root",
        type: "folder",
        title: "Sessions",
        children: [{
          id: "folder-a",
          type: "folder",
          title: "Project",
          children: []
        }]
      },
      index: []
    });

    const created = store.createSession({
      id: "runtime-created",
      title: "Runtime Created",
      text: "hello",
      parent_id: "folder-a",
      operation_id: "create-runtime-created"
    });
    const duplicate = store.createSession({
      id: "runtime-created",
      title: "Must not duplicate",
      text: "ignored",
      parent_id: "root",
      operation_id: "create-runtime-created"
    });

    expect(created).toMatchObject({
      ok: true,
      id: "runtime-created",
      session_revision: 1
    });
    expect(duplicate).toMatchObject({
      ok: true,
      duplicate: true,
      id: "runtime-created",
      session_revision: 1
    });

    let snapshot = store.readSnapshot().snapshot;
    expect(snapshot.tree.children[0].children).toEqual([
      { id: "runtime-created", type: "session", title: "Runtime Created" }
    ]);
    expect(snapshot.index).toEqual([
      expect.objectContaining({
        id: "runtime-created",
        title: "Runtime Created",
        size: 5
      })
    ]);

    const updated = store.updateSession("runtime-created", {
      text: "hello again",
      title: "Renamed",
      expected_session_revision: 1,
      operation_id: "update-runtime-created"
    });
    expect(updated).toMatchObject({ ok: true, session_revision: 2 });
    expect(store.readSession("runtime-created")).toMatchObject({
      text: "hello again",
      meta: expect.objectContaining({
        title: "Renamed",
        size: 11
      })
    });
    snapshot = store.readSnapshot().snapshot;
    expect(snapshot.tree.children[0].children[0]).toEqual({
      id: "runtime-created",
      type: "session",
      title: "Renamed"
    });
    expect(snapshot.index[0]).toMatchObject({
      id: "runtime-created",
      title: "Renamed",
      size: 11
    });

    const deleted = store.deleteSession("runtime-created", {
      expected_session_revision: 2,
      operation_id: "delete-runtime-created"
    });
    expect(deleted).toMatchObject({ ok: true, session_revision: 3 });
    expect(store.readSession("runtime-created")).toMatchObject({
      deleted: true,
      session_revision: 3
    });
    snapshot = store.readSnapshot().snapshot;
    expect(snapshot.tree.children[0].children).toEqual([]);
    expect(snapshot.index).toEqual([]);
  });

  it("restores a deleted session from revision history", () => {
    const store = createStore();
    store.writeSnapshot({
      docs: [{ id: "a", text: "recover me" }],
      metas: [{ id: "a", meta: { title: "A" } }]
    });

    const deleted = store.deleteSession("a", { operation_id: "delete-1" });
    expect(store.readSession("a")).toMatchObject({
      deleted: true,
      session_revision: deleted.session_revision
    });

    store.restoreSessionRevision("a", deleted.session_revision, "restore-1");
    expect(store.readSession("a")).toMatchObject({
      text: "recover me",
      meta: { id: "a", title: "A" }
    });
    expect(store.listSessionRevisions("a").map((item) => item.reason))
      .toEqual(["restore", "delete", "snapshot-merge"]);
  });

  it("retains only the latest 20 revisions for each Session", () => {
    const store = createStore();
    store.createSession({
      id: "bounded",
      title: "Bounded",
      text: "version 0"
    });
    for (let index = 1; index <= 25; index += 1) {
      store.updateSession("bounded", {
        text: `version ${index}`,
        operation_id: `bounded-update-${index}`
      });
    }

    const revisions = store.listSessionRevisions("bounded");
    expect(revisions).toHaveLength(20);
    expect(revisions[0].revision).toBe(26);
    expect(revisions.at(-1).revision).toBe(7);
    expect(() => store.restoreSessionRevision("bounded", 6))
      .toThrow("session revision not found");
  });

  it("imports browser state once and preserves Runtime-owned conflicts", () => {
    const store = createStore();
    store.writeSnapshot({
      docs: [{ id: "runtime", text: "runtime wins" }],
      metas: [{ id: "runtime", meta: { title: "Runtime" } }]
    });
    const candidate = {
      docs: [
        { id: "runtime", text: "browser conflict" },
        { id: "browser", text: "recovered" }
      ],
      metas: [
        { id: "runtime", meta: { title: "Old" } },
        { id: "browser", meta: { title: "Recovered" } }
      ],
      kv: { "sessions.tagCatalog": [{ path: "recovered" }] }
    };

    const first = store.migrateBrowserStorage("origin", candidate, "fingerprint");
    const second = store.migrateBrowserStorage("origin", candidate, "fingerprint");

    expect(first).toMatchObject({
      verified: true,
      imported: ["browser"],
      archived: ["runtime"]
    });
    expect(second).toMatchObject({ duplicate: true, imported: ["browser"] });
    expect(store.readSession("runtime").text).toBe("runtime wins");
    expect(store.readSession("browser").text).toBe("recovered");
    expect(store.readKV("sessions.tagCatalog").value).toEqual([{ path: "recovered" }]);
    expect(store.readSnapshot().snapshot.tree.children).toContainEqual({
      id: "browser",
      type: "session",
      title: "Recovered"
    });
  });

  it("preserves legacy tombstones during the initial import", () => {
    const store = createStore();
    store.writeSnapshot({
      docs: [],
      metas: [],
      tombstones: [{ id: "deleted", revision: 4, deletedAt: 123 }]
    });

    expect(store.readSession("deleted")).toEqual({
      id: "deleted",
      deleted: true,
      session_revision: 4,
      deleted_at: 123
    });
  });

  it("persists ordered Workbench events for resumable clients", () => {
    const store = createStore();
    const created = store.createSession({
      id: "live-session",
      title: "Live",
      text: "hello",
      source_client_id: "workbench-a"
    });
    const updated = store.updateSession("live-session", {
      text: "hello world",
      expected_session_revision: created.session_revision,
      source_client_id: "workbench-b"
    });
    const runEvent = store.appendEvent("run.started", {
      sessionId: "live-session",
      runId: "run-1",
      payload: { attemptId: "attempt-1", status: "running" }
    });

    expect(updated.session_revision).toBe(2);
    expect(runEvent.sequence).toBeGreaterThan(updated.event_sequence);
    expect(store.readStatus().event_cursor).toBe(runEvent.sequence);
    expect(store.readSnapshot().event_cursor).toBe(runEvent.sequence);

    const initial = store.listEvents(0);
    expect(initial.events.map((event) => event.type)).toEqual([
      "session.created",
      "session.updated",
      "run.started"
    ]);
    expect(initial.events[0]).toMatchObject({
      sessionId: "live-session",
      sessionRevision: 1,
      sourceClientId: "workbench-a"
    });

    const resumed = store.listEvents(created.event_sequence, {
      sessionId: "live-session"
    });
    expect(resumed.events.map((event) => event.sequence)).toEqual([
      updated.event_sequence,
      runEvent.sequence
    ]);
  });

  it("records tree and KV mutations without embedding their values", () => {
    const store = createStore();
    const treeWrite = store.writeTree({
      id: "root",
      type: "folder",
      title: "Sessions",
      children: []
    }, [], null, "workbench-a");
    const kvWrite = store.writeKV("private.preference", {
      token: "must-not-be-copied-into-events"
    }, {
      sourceClientId: "workbench-a"
    });

    expect(treeWrite.event_sequence).toBeGreaterThan(0);
    expect(kvWrite.event_sequence).toBeGreaterThan(treeWrite.event_sequence);
    expect(store.listEvents(0).events).toEqual([
      expect.objectContaining({
        type: "tree.updated",
        sourceClientId: "workbench-a",
        data: {}
      }),
      expect.objectContaining({
        type: "kv.updated",
        sourceClientId: "workbench-a",
        data: { key: "private.preference" }
      })
    ]);
    expect(JSON.stringify(store.listEvents(0)))
      .not.toContain("must-not-be-copied-into-events");
  });

  it("stores collaboration state and projects text in one transaction", () => {
    const store = createStore();
    store.createSession({
      id: "collaborative",
      title: "Collaborative",
      text: "before"
    });
    const saved = store.writeCollaborationDocument(
      "collaborative",
      new Uint8Array([1, 2, 3, 4]),
      {
        text: "after",
        sourceClientId: "workbench-a",
        timestamp: 500
      }
    );

    expect(saved).toMatchObject({
      ok: true,
      sessionId: "collaborative",
      version: 1,
      session_revision: 2
    });
    expect(store.readCollaborationDocument("collaborative")).toMatchObject({
      state: new Uint8Array([1, 2, 3, 4]),
      version: 1
    });
    expect(store.readSession("collaborative").text).toBe("after");
    expect(store.readEvent(saved.event_sequence)).toMatchObject({
      type: "collaboration.updated",
      sourceClientId: "workbench-a",
      data: { version: 1 }
    });
    expect(store.listEvents(0).events.map((event) => event.type)).toEqual([
      "session.created",
      "collaboration.updated"
    ]);

    expect(store.writeCollaborationDocument(
      "collaborative",
      new Uint8Array([1, 2, 3, 4]),
      { text: "after" }
    )).toMatchObject({
      ok: true,
      duplicate: true,
      version: 1
    });
  });

  it("does not emit KV events when the value is unchanged", () => {
    const store = createStore();
    const first = store.writeKV("stable.preference", { enabled: true }, {
      sourceClientId: "workbench-a"
    });
    const duplicate = store.writeKV("stable.preference", { enabled: true }, {
      sourceClientId: "workbench-b"
    });

    expect(first.event_sequence).toBeGreaterThan(0);
    expect(duplicate).toMatchObject({
      ok: true,
      duplicate: true,
      event_sequence: 0
    });
    expect(store.listEvents(0).events).toEqual([
      expect.objectContaining({
        type: "kv.updated",
        sourceClientId: "workbench-a",
        data: { key: "stable.preference" }
      })
    ]);
  });

  it("restores a persisted Yjs document after Runtime restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-restart-"));
    const path = join(directory, "runtime.sqlite3");
    const source = new Y.Doc();
    source.getText("content").insert(0, "offline and durable");
    const first = new SqliteWorkbenchStateStore(path);
    first.createSession({
      id: "restart-session",
      title: "Restart",
      text: "offline and durable"
    });
    first.writeCollaborationDocument(
      "restart-session",
      Y.encodeStateAsUpdate(source),
      { text: "offline and durable" }
    );
    first.close();

    const second = new SqliteWorkbenchStateStore(path);
    const restored = new Y.Doc();
    Y.applyUpdate(
      restored,
      second.readCollaborationDocument("restart-session").state
    );

    expect(restored.getText("content").toString())
      .toBe("offline and durable");
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
