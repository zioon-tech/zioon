import { describe, expect, it, vi } from "vitest";
import { createRuntimeCollaborationService } from "../src/collaboration-service.mjs";

function memoryStore() {
  let text = "committed", state = null, fail = false;
  const store = {
    fail(value) { fail = value; },
    async readSession() { return { text, updated_at: 0 }; },
    async readCollaborationDocument() { return state && { state, updatedAt: Date.now() }; },
    async writeCollaborationDocument(_id, bytes, input) {
      if (fail) throw new Error("injected database unavailable");
      state = Buffer.from(bytes); text = input.text;
      return { sessionId: "doc", version: 1, stateHash: "hash", session_revision: 1 };
    },
    async checkpointSessionRevision() {},
    async appendEvent() {}
  };
  return store;
}

describe("actual Hocuspocus persistence boundaries", () => {
  it("propagates a database failure to projection callers and retains the unsaved buffer for retry", async () => {
    const store = memoryStore(), service = createRuntimeCollaborationService({ store, debounceMs: 50 });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await service.replaceDocument("doc", "committed");
      store.fail(true);
      await expect(service.replaceDocument("doc", "new answer")).rejects.toThrow("injected database unavailable");
      expect(service.hocuspocus.documents.get("doc").getText("content").toString()).toBe("new answer");
      expect((await store.readSession()).text).toBe("committed");
      store.fail(false);
      await service.replaceDocument("doc", "new answer");
      expect((await store.readSession()).text).toBe("new answer");
    } finally { store.fail(false); await service.close(); consoleError.mockRestore(); }
  });

  it("does not save a revoked peer's buffered changes under another editor's later context", async () => {
    const store = memoryStore(), revoked = new Set();
    const service = createRuntimeCollaborationService({
      store, debounceMs: 1000,
      withPersistence: async ({ context, contributors = [] }, action) => {
        for (const contributor of [context, ...contributors]) {
          if (revoked.has(contributor?.principal?.user?.id)) {
            throw Object.assign(new Error("revoked"), { statusCode: 403 });
          }
        }
        return action();
      }
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let alice, bob;
    try {
      alice = await service.hocuspocus.openDirectConnection("doc", { principal: { user: { id: "alice" } } });
      bob = await service.hocuspocus.openDirectConnection("doc", { principal: { user: { id: "bob" } } });
      await alice.transact(doc => doc.getText("content").insert(doc.getText("content").length, " unauthorized"));
      revoked.add("alice");
      await bob.transact(doc => doc.getText("content").insert(doc.getText("content").length, " later"));
      await bob.disconnect();
      expect((await store.readSession()).text).toBe("committed");
      expect(service.hocuspocus.documents.get("doc").getText("content").toString()).toBe("committed");
    } finally {
      revoked.clear();
      await alice?.disconnect();
      await service.close();
      consoleError.mockRestore();
    }
  });
});
