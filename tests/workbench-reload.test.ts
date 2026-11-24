import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginManager } from "../src/plugin/manager";
import { EventBus } from "../src/core/event-bus";
import { createSessionDocRepo } from "../extensions/dev.session-manager/storage/docs.js";
import { hydrateSessionCatalog } from "../extensions/dev.session-manager/storage/catalog.js";
import { registerSessionDocCommands } from "../extensions/dev.session-manager/commands/doc-apis.js";
import { projectRunEventToSession } from "../extensions/dev.langchain-chat/programmatic-session.js";
import { createChatAnnotationsApi } from "../src/chat/annotations";

function plugin(id: string, dependencies: string[] = []): any {
  return {
    id, name: id, version: "1.0.0", origin: "builtin", path: `/extensions/${id}`,
    enabled: true, state: "installed", dependencies, peerDependencies: [],
    manifest: { name: id, version: "1.0.0", zion: { id, name: id, version: "1.0.0", main: "./main.js" } }
  };
}
function state(initial: Record<string, any> = {}) {
  const values = new Map(Object.entries(initial));
  return { get: (key: string) => values.get(key), set: (key: string, value: any) => values.set(key, value) };
}
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function repoFixture(initial = {}, loader = vi.fn()) {
  const values = state(initial);
  const persist = vi.fn().mockResolvedValue(true);
  const repo = createSessionDocRepo({
    getZion: () => ({ state: values }), now: () => 1,
    onLoad: loader, onPersist: persist
  });
  return { values, persist, repo };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("Workbench reload lifecycle", () => {
  it("registers the complete catalog before dependency-ordered activation", async () => {
    localStorage.setItem("zion.pluginStates", JSON.stringify({ enabled: ["chat", "sessions", "removed"], disabled: ["off"] }));
    const manager = new PluginManager({ pluginDir: "", logLevel: "error" });
    const activated: string[] = [];
    vi.spyOn((manager as any).loader, "loadModule").mockImplementation(async (info: any) => ({
      activate: () => {
        expect(manager.list().map((item) => item.id)).toEqual(["chat", "sessions", "off"]);
        activated.push(info.id);
      }
    }));
    await manager.initialize({ beforeActivate: async () => manager.registerBuiltinCatalog([
      plugin("chat", ["sessions"]), plugin("sessions"), plugin("off")
    ]) });
    expect(activated).toEqual(["sessions", "chat"]);
    expect(manager.get("off")?.enabled).toBe(false);
    expect(manager.getActivePlugins()).toHaveLength(2);
  });

  it("preserves external overrides when registering builtins", async () => {
    const manager = new PluginManager({ pluginDir: "", activationAllowed: () => false });
    await manager.installFromInfo({ ...plugin("custom"), origin: "external", version: "2" });
    manager.registerBuiltinCatalog([plugin("custom")]);
    expect(manager.get("custom")?.version).toBe("2");
  });

  it("deduplicates activation and disposes partial registration before retry", async () => {
    const manager = new PluginManager({ pluginDir: "", logLevel: "error" });
    manager.registerBuiltinCatalog([plugin("sessions")]);
    const gate = deferred();
    const dispose = vi.fn();
    const activate = vi.fn(async (ctx) => {
      ctx.subscriptions.push({ dispose });
      await gate.promise;
      throw new Error("storage offline");
    }).mockImplementationOnce(async (ctx) => {
      ctx.subscriptions.push({ dispose });
      await gate.promise;
      throw new Error("storage offline");
    });
    vi.spyOn((manager as any).loader, "loadModule").mockResolvedValue({ activate });
    const a = manager.activate("sessions");
    const b = manager.activate("sessions");
    const result = Promise.allSettled([a, b]);
    gate.resolve(null);
    expect((await result).map((item) => item.status)).toEqual(["rejected", "rejected"]);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.get("sessions")?.state).toBe("error");
    expect(manager.getActivePlugins()).toEqual([]);
    activate.mockResolvedValue(undefined);
    await manager.activate("sessions");
    expect(manager.get("sessions")?.state).toBe("active");
    expect(manager.get("sessions")?.error).toBeUndefined();
  });

  it("rejects missing, disabled and cyclic dependencies without loading dependents", async () => {
    const manager = new PluginManager({ pluginDir: "", logLevel: "error" });
    manager.registerBuiltinCatalog([plugin("chat", ["sessions"])]);
    await expect(manager.activate("chat")).rejects.toThrow("unavailable");
    manager.registerBuiltinCatalog([{ ...plugin("sessions"), enabled: false }]);
    await expect(manager.activate("chat")).rejects.toThrow("unavailable");
    manager.registerBuiltinCatalog([plugin("a", ["b"]), plugin("b", ["a"])]);
    await expect(manager.activate("a")).rejects.toThrow("cycle");
  });
});

describe("Lazy session hydration", () => {
  it("deduplicates doc and meta reads and preserves a concurrent local write", async () => {
    const gate = deferred();
    const loader = vi.fn(() => gate.promise);
    const { repo, values } = repoFixture({}, loader);
    const doc = repo.loadDocAsync("s");
    const meta = repo.loadMetaAsync("s");
    await repo.saveDoc("s", "local edit");
    gate.resolve({ text: "old", meta: { id: "s", annotations: { tools: [{ id: "keep" }] } } });
    expect(await doc).toBe("local edit");
    expect((await meta).annotations.tools).toHaveLength(1);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(values.get("sessions.doc.s")).toBe("local edit");
  });

  it("does not hydrate a deleted session from a late response", async () => {
    const gate = deferred();
    const { repo, values } = repoFixture({}, vi.fn(() => gate.promise));
    const pending = repo.loadDocAsync("s");
    repo.invalidate("s");
    gate.resolve({ text: "deleted", meta: {} });
    await expect(pending).rejects.toThrow("changed");
    expect(values.get("sessions.doc.s")).toBeUndefined();
  });

  it("merges a summary edit into full metadata without losing annotations", async () => {
    const loader = vi.fn().mockResolvedValue({
      text: "history", meta: { title: "Before", annotations: { tools: [{ id: "result", result: "complete" }] }, config: { model: "m" } }
    });
    const { repo, persist } = repoFixture({ "sessions.summary.s": { id: "s", title: "Before" } }, loader);
    const meta = repo.loadMeta("s");
    meta.title = "Renamed";
    await expect(repo.saveMeta("s", meta)).resolves.toBe(true);
    expect(persist).toHaveBeenCalledWith("meta", "s", expect.objectContaining({
      title: "Renamed", annotations: { tools: [{ id: "result", result: "complete" }] }, config: { model: "m" }
    }), expect.objectContaining({ changes: expect.any(Array) }));
  });

  it("does not persist an empty replacement when a lazy read fails", async () => {
    const { repo, persist } = repoFixture(
      { "sessions.summary.s": { id: "s", title: "Before" } },
      vi.fn().mockRejectedValue(new Error("offline"))
    );
    expect(await repo.saveMeta("s", { title: "After" })).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    await expect(repo.loadDocAsync("s")).rejects.toThrow("offline");
  });

  it("retains unchanged loaded docs while catalog entries have no bodies", () => {
    const { repo, values } = repoFixture({ "sessions.doc.s": "keep", "sessions.meta.s": { annotations: { tools: ["keep"] } } });
    const ids = new Set(["s"]);
    hydrateSessionCatalog({
      sessions: [{ id: "s", session_revision: 2 }, { id: "unloaded", session_revision: 1 }],
      metas: [{ id: "s", meta: { title: "s" } }], index: [{ id: "s" }]
    }, { state: values, durableIds: ids, revisions: new Map([["s", 2]]), invalidate: repo.invalidate });
    expect(values.get("sessions.doc.s")).toBe("keep");
    expect(values.get("sessions.meta.s").annotations.tools).toEqual(["keep"]);
    expect(values.get("sessions.doc.unloaded")).toBeUndefined();
    expect(ids).toEqual(new Set(["s", "unloaded"]));
  });
  it("hydrates a partial metadata catalog without requesting or deleting unseen sessions", () => {
    const loader = vi.fn();
    const { repo, values } = repoFixture({}, loader);
    const ids = new Set(["unseen"]);
    hydrateSessionCatalog({
      metadataPartial: true,
      sessions: [{ id: "seen", session_revision: 1 }, { id: "unseen", session_revision: 1 }],
      metas: [{ id: "seen", meta: { title: "Seen" } }],
      index: [{ id: "seen", title: "Seen" }, { id: "unseen", title: "Unseen", size: 12 }]
    }, { state: values, durableIds: ids, revisions: new Map(), invalidate: repo.invalidate });
    expect(repo.loadMeta("unseen")).toMatchObject({ title: "Unseen", size: 12 });
    expect(ids.has("unseen")).toBe(true);
    expect(loader).not.toHaveBeenCalled();
  });

  it("hydrates before a transform and serializes metadata patches", async () => {
    const { repo, values, persist } = repoFixture({ "sessions.summary.s": { title: "s" } },
      vi.fn().mockResolvedValue({ text: "history", meta: { id: "s", title: "s", annotations: { tools: ["result"] } } }));
    const commands = new Map();
    registerSessionDocCommands({
      ...repo, zion: { state: values, commands: { registerCommand: (id, fn) => commands.set(id, fn) }, window: {} },
      now: () => 1, hashString: () => "hash"
    });
    await commands.get("zion.sessions.transformDoc")({ id: "s", transform: (doc) => `${doc}\nnew` });
    await commands.get("zion.sessions.patchMeta")({ id: "s", patch: { title: "new title" } });
    expect(values.get("sessions.doc.s")).toBe("history\nnew");
    expect(values.get("sessions.meta.s").annotations.tools).toEqual(["result"]);
    expect(persist).toHaveBeenCalled();
  });
});

describe("Run event acknowledgement", () => {
  it("replaces replayed reasoning instead of appending to a stored partial result", async () => {
    const events = new EventBus();
    const values = state({ "chat.thinkingVisible": true });
    const stored = { annotations: { thinking: [{
      id: "thinking:r:1", runId: "r", text: "Thinking once."
    }] } };
    const commands = {
      registerCommand: () => ({ dispose() {} }),
      executeCommand: () => "user history"
    };
    const api = createChatAnnotationsApi({ state: values, events, commands, getSessionMeta: () => stored });
    try {
      const zion = { state: values, events, commands };
      for (let round = 0; round < 2; round++) {
        for (const [type, data] of [
          ["run.started", {}],
          ["reasoning.started", { turn: 1 }],
          ["reasoning.delta", { turn: 1, delta: "Thinking once." }],
          ["reasoning.completed", { turn: 1 }]
        ]) {
          await projectRunEventToSession(zion, "s", { runId: "r", type, data }, {
            replay: true, resetProjection: true, documentWriter: false
          });
        }
        expect(values.get("sessions.annotations.s").thinking[0].text).toBe("Thinking once.");
      }
    } finally { api.dispose(); }
  });

  it("awaits async consumers before acknowledging the projection", async () => {
    const events = new EventBus();
    const gate = deferred();
    events.on("chat/toolResult", () => gate.promise);
    let acknowledged = false;
    const projecting = projectRunEventToSession({ events }, "s", {
      runId: "r", type: "tool.completed", data: { callId: "c", result: "complete" }
    }, { documentWriter: false }).then(() => { acknowledged = true; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    gate.resolve(null);
    await projecting;
    expect(acknowledged).toBe(true);
  });

  it("rejects a projection when a consumer fails", async () => {
    const events = new EventBus();
    events.on("chat/toolResult", async () => { throw new Error("consumer failed"); });
    await expect(projectRunEventToSession({ events }, "s", {
      runId: "r", type: "tool.completed", data: { callId: "c" }
    })).rejects.toThrow("consumer failed");
  });
});
