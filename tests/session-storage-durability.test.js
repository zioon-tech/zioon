import { describe, expect, it, vi } from "vitest";
import { createSessionDocRepo } from "../extensions/dev.session-manager/storage/docs.js";

function createState(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key),
    set: (key, value) => values.set(key, value),
    values
  };
}

function createRepo({ onLoad, onPersist, state, warnStorageIssue = vi.fn() }) {
  return {
    repo: createSessionDocRepo({
      onLoad,
      onPersist,
      warnStorageIssue,
      now: () => 1,
      getZion: () => ({ state })
    }),
    warnStorageIssue
  };
}

describe("session storage durability", () => {
  it("marks a document saved only after durable storage acknowledges the commit", async () => {
    const state = createState({ "sessions.doc.s1": "before" });
    const onPersist = vi.fn().mockResolvedValue({ ok: true, session_revision: 2 });
    const { repo } = createRepo({
      state,
      onPersist
    });

    await expect(repo.saveDoc("s1", "after")).resolves.toBe(true);

    expect(state.get("sessions.doc.s1")).toBe("after");
    expect(onPersist).toHaveBeenCalledWith("doc", "s1", "after");
  });

  it("keeps the latest in-memory document when durable storage is offline", async () => {
    const state = createState({ "sessions.doc.s1": "before" });
    const { repo, warnStorageIssue } = createRepo({
      state,
      onPersist: vi.fn().mockRejectedValue(new Error("service offline"))
    });

    await expect(repo.saveDoc("s1", "after")).resolves.toBe(false);

    expect(state.get("sessions.doc.s1")).toBe("after");
    expect(warnStorageIssue).toHaveBeenCalledWith(
      "saveDoc",
      expect.objectContaining({ message: "service offline" })
    );
  });

  it("loads an uncached document from durable storage", async () => {
    const state = createState();
    const onLoad = vi.fn().mockResolvedValue({
      id: "s1",
      text: "durable",
      meta: { id: "s1", title: "Durable" }
    });
    const { repo } = createRepo({
      state,
      onLoad,
      onPersist: vi.fn()
    });

    await expect(repo.loadDocAsync("s1")).resolves.toBe("durable");
    await expect(repo.loadMetaAsync("s1")).resolves.toEqual({
      id: "s1",
      title: "Durable"
    });

    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(state.get("sessions.doc.s1")).toBe("durable");
    expect(state.get("sessions.meta.s1").title).toBe("Durable");
  });

  it("does not report a missing session read as a storage write failure", async () => {
    const state = createState();
    const missing = Object.assign(new Error("session not found"), { status: 404 });
    const { repo, warnStorageIssue } = createRepo({
      state,
      onLoad: vi.fn().mockRejectedValue(missing),
      onPersist: vi.fn()
    });

    expect(repo.loadMeta("missing").id).toBe("missing");
    await expect(repo.loadDocAsync("missing")).rejects.toBe(missing);
    await vi.waitFor(() => expect(warnStorageIssue).not.toHaveBeenCalled());
  });

  it("still reports genuine session read failures", async () => {
    const state = createState();
    const unavailable = new TypeError("Failed to fetch");
    const { repo, warnStorageIssue } = createRepo({
      state,
      onLoad: vi.fn().mockRejectedValue(unavailable),
      onPersist: vi.fn()
    });

    await expect(repo.loadDocAsync("s1")).rejects.toBe(unavailable);
    expect(warnStorageIssue).toHaveBeenCalledWith("loadDocAsync", unavailable);
  });
});
