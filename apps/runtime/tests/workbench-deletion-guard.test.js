import { describe, expect, it, vi } from "vitest";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";

describe("deleted Workbench session persistence", () => {
  function fixture(deleted = true) {
    const store = Object.create(PostgresWorkbenchStateStore.prototype);
    const client = { query: vi.fn(async () => ({ rows: [] })) };
    Object.assign(store, {
      spaceId: "s", now: () => 1,
      duplicateOperation: async () => null,
      revision: async () => "r",
      currentSession: async () => ({ exists: false, revision: 4, text: "", meta: {} }),
      readSession: async () => deleted ? { deleted: true, session_revision: 4 } : null,
      writeSessionRows: vi.fn(),
      saveSessionRevision: async () => {}, shouldSnapshotSessionRevision: async () => false,
      stateTree: async () => ({ id: "root", type: "folder", children: [] }),
      rebuildIndexFromTree: async () => [], bumpRevision: async () => "r2",
      recordEvent: async () => ({ sequence: 1 }), recordOperation: async () => {},
      transaction: action => action(client, [])
    });
    return { store, client };
  }

  it.each([{ meta: { title: "old" } }, { text: "" }, { text: "late", reason: "collaboration" }])(
    "rejects stale updates after deletion: %j", async input => {
      const { store, client } = fixture();
      await expect(store.updateSessionInTransaction("deleted", input, client, []))
        .rejects.toMatchObject({ statusCode: 410 });
      expect(store.writeSessionRows).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])("allows a new session or explicit revision restore: deleted=%s", async deleted => {
    const { store, client } = fixture(deleted);
    await expect(store.updateSessionInTransaction("s", {
      text: "restored", ...(deleted ? { reason: "restore" } : {})
    }, client, [])).resolves.toMatchObject({ ok: true });
    expect(store.writeSessionRows).toHaveBeenCalledOnce();
  });

  it("ignores delayed collaboration persistence for a deleted session", async () => {
    const { store, client } = fixture();
    await expect(store.writeCollaborationDocument("deleted", new Uint8Array([0, 0]), { text: "" }))
      .resolves.toMatchObject({ ok: true, skipped: true, deleted: true });
    expect(client.query.mock.calls.every(([sql]) => !sql.includes("INSERT"))).toBe(true);
    expect(store.writeSessionRows).not.toHaveBeenCalled();
  });
});
