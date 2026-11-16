import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentFsMemoryClient } from "../src/agentfs-memory-client.mjs";
import { createPluginFileService } from "../src/plugin-file-service.mjs";
import { PostgresIdentityContextStore } from "../src/identity-context-store.mjs";
import { RuntimeIdentityContextProvider, activateRuntimePlugin } from "../../../extensions/dev.identity/runtime.js";
import { stampBiographyDigest } from "../../../extensions/dev.identity/identity-context-loader.js";
import { buildBiographyDigest, parseBiographyEventsJsonl } from "../../../extensions/dev.identity/identity-core.js";
import { contentHash } from "../../../packages/local-tools-client/src/plugin-data-files.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

const cleanup = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
const root = "/memory/dev.identity";
const eventsText = (summary) => JSON.stringify({
  kind: "lesson", summary, sessionId: "source-session", runId: `source-${summary}`, at: "2026-11-16T00:00:00Z"
}) + "\n";
async function fixture() {
  const db = await createPostgresTestDatabase("identity_context");
  cleanup.push(() => db.close());
  const events = eventsText("Original lesson");
  const files = new Map([
    [`${root}/identity.md`, "Zion"],
    [`${root}/user.md`, "Original user"],
    [`${root}/biography/events.jsonl`, events],
    [`${root}/biography/digest.md`, stampBiographyDigest(buildBiographyDigest(parseBiographyEventsJsonl(events)), events)],
    [`${root}/projects/index.md`, ""], [`${root}/projects/inbox.md`, ""], [`${root}/projects/attention.md`, ""]
  ]);
  let fail = false;
  const responses = [];
  const fetchImpl = vi.fn(async (url) => {
    if (fail) return Response.json({ error: "test_unavailable" }, { status: 503 });
    const input = new URL(url);
    const specs = JSON.parse(input.searchParams.get("files"));
    const result = specs.map(spec => {
      const content = files.get(spec.path);
      const hash = content === undefined ? null : contentHash(content);
      return { path: spec.path, content_hash: hash, missing: content === undefined,
        ...(content !== undefined && !spec.metadata_only && spec.known_hash !== hash ? { content } : {}) };
    });
    responses.push(result);
    return Response.json({ ok: true, plugin_data_version: 1, batch_version: 1, files: result });
  });
  const fileService = createPluginFileService({
    dataLocation: { root, nodeId: "" },
    fileClient: createAgentFsMemoryClient({ baseUrl: "https://memory.test", secret: "a".repeat(32), fetchImpl })
  });
  const contextStore = new PostgresIdentityContextStore(db.pool);
  const createProvider = () => new RuntimeIdentityContextProvider({
    fileService, contextStore, memoryRoot: root, dataLocation: { root, backend: "agent-fs" },
    scopeMode: "account", bindingKey: "https://memory.test|mcp", state: { get() {}, set() {} }
  });
  const context = (sessionId, userId = "alice", spaceId = "personal") => ({
    runId: `run-${sessionId}`, request: { sessionId, principal: { userId, spaceId },
      policy: { preset: "read-only", fileRoots: [] } }
  });
  const contribute = async (provider, sessionId, userId, spaceId) =>
    (await provider.contribute([{ role: "user", content: "hello" }], context(sessionId, userId, spaceId)))[0].content;
  return { db, files, responses, fetchImpl, fileService, contextStore, createProvider, context, contribute,
    setFail(value) { fail = value; } };
}

describe("versioned Identity context integration", () => {
  it("checks freshness once per new session, skips event bodies and returns only changed profiles", async () => {
    const f = await fixture(), provider = f.createProvider();
    expect(await f.contribute(provider, "first")).toContain("Original lesson");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.responses[0].find(file => file.path.endsWith("events.jsonl")).content).toBeUndefined();
    expect(await f.contribute(provider, "second")).toContain("Original user");
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.responses[1].every(file => file.content === undefined)).toBe(true);
    f.files.set(`${root}/user.md`, "Externally edited user");
    expect(await f.contribute(provider, "third")).toContain("Externally edited user");
    expect(f.responses[2].filter(file => file.content !== undefined).map(file => file.path)).toEqual([`${root}/user.md`]);
    expect(await f.contribute(provider, "first")).toContain("Original user");
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps the selected version after process recreation and cache eviction, and refreshes it explicitly", async () => {
    const f = await fixture(), provider = f.createProvider();
    await f.contribute(provider, "old");
    f.files.set(`${root}/user.md`, "New profile");
    const restarted = f.createProvider();
    expect(await f.contribute(restarted, "old")).toContain("Original user");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    const refreshed = await restarted.refreshSession(f.context("old"));
    expect(refreshed.content).toContain("New profile");
    restarted.scopedSessionSnapshots.clear();
    expect(await f.contribute(f.createProvider(), "old")).toContain("New profile");
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    const otherWorker = f.createProvider();
    expect(await f.contribute(otherWorker, "old")).toContain("New profile");
    f.files.set(`${root}/user.md`, "Refreshed on another worker");
    await restarted.refreshSession(f.context("old"));
    expect(await f.contribute(otherWorker, "old")).toContain("Refreshed on another worker");
  });

  it("detects stale digest publication and external event edits without writing on the send path", async () => {
    const f = await fixture(), provider = f.createProvider();
    await f.contribute(provider, "before");
    f.files.set(`${root}/biography/events.jsonl`, eventsText("Externally added lesson"));
    const content = await f.contribute(provider, "after");
    expect(content).toContain("Externally added lesson");
    expect(content).not.toContain("Original lesson");
    expect(f.fetchImpl).toHaveBeenCalledTimes(3); // metadata check + coherent repair read
    expect(await f.contribute(provider, "unchanged")).toContain("Externally added lesson");
    expect(f.fetchImpl).toHaveBeenCalledTimes(4);
    expect(f.responses.at(-1).every(file => file.content === undefined)).toBe(true);
    expect(f.files.get(`${root}/biography/digest.md`)).toContain("Original lesson");
    expect(content).not.toContain("zion-biography-source");
  });

  it("merges simultaneous loads and never freezes or publishes an unsuccessful refresh", async () => {
    const f = await fixture(), provider = f.createProvider();
    const [left, right] = await Promise.all([f.contribute(provider, "same"), f.contribute(provider, "same")]);
    expect(left).toBe(right);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    f.setFail(true);
    await expect(provider.refreshSession(f.context("same"))).rejects.toMatchObject({ statusCode: 503 });
    expect(await f.contribute(f.createProvider(), "same")).toContain("Original user");
    await expect(f.contribute(provider, "new")).rejects.toMatchObject({ statusCode: 503 });
    f.setFail(false);
    f.files.set(`${root}/user.md`, "");
    expect(await f.contribute(provider, "new")).not.toContain("Original user");
    expect(await f.contribute(provider, "new")).not.toContain("<user_profile");
  });

  it("starts a fresh revision check for explicit refresh instead of joining an older projection read", async () => {
    const f = await fixture(), provider = f.createProvider();
    await f.contribute(provider, "old");
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const observed = new Promise(resolve => { started = resolve; });
    const normalRead = f.fetchImpl.getMockImplementation();
    f.fetchImpl.mockImplementationOnce(async (...args) => {
      const response = await normalRead(...args);
      started();
      await gate;
      return response;
    });
    const older = f.contribute(provider, "other");
    try {
      await observed;
      f.files.set(`${root}/user.md`, "Fresh revision");
      expect((await provider.refreshSession(f.context("old"))).content).toContain("Fresh revision");
    } finally { release(); await older; }
    expect(await f.contribute(f.createProvider(), "old")).toContain("Fresh revision");
  });

  it("serializes local refreshes and rejects stale publication from another worker", async () => {
    const f = await fixture(), provider = f.createProvider();
    await f.contribute(provider, "session");
    const normalRead = f.fetchImpl.getMockImplementation();
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const observed = new Promise(resolve => { started = resolve; });
    f.fetchImpl.mockImplementationOnce(async (...args) => {
      const response = await normalRead(...args);
      started();
      await gate;
      return response;
    });
    const older = provider.refreshSession(f.context("session"));
    const oldResult = older.then(() => "published", error => error.statusCode);
    try {
      await observed;
      f.files.set(`${root}/user.md`, "Newer worker revision");
      const newest = await f.createProvider().refreshSession(f.context("session"));
      expect(newest.content).toContain("Newer worker revision");
    } finally { release(); }
    expect(await oldResult).toBe(409);
    expect(await f.contribute(provider, "session")).toContain("Newer worker revision");

    f.files.set(`${root}/user.md`, "Serialized local revision");
    const local = await Promise.all([provider.refreshSession(f.context("session")), provider.refreshSession(f.context("session"))]);
    expect(local.every(snapshot => snapshot.content.includes("Serialized local revision"))).toBe(true);
  });

  it("isolates selected versions by account, Space and service binding", async () => {
    const f = await fixture(), provider = f.createProvider();
    await f.contribute(provider, "shared-id");
    f.files.set(`${root}/user.md`, "Other scope");
    expect(await f.contribute(provider, "shared-id", "bob")).toContain("Other scope");
    expect(await f.contribute(provider, "shared-id", "alice", "other-space")).toContain("Other scope");
    expect(await f.contribute(provider, "shared-id")).toContain("Original user");
    const rebound = f.createProvider();
    rebound.bindingKey = "https://other-memory.test|mcp";
    expect(await f.contribute(rebound, "shared-id")).toContain("Other scope");
  });

  it("keeps epoch validation and publication atomic against a concurrent reservation", async () => {
    const f = await fixture(), scope = "refresh-lock-test", sessionId = "session";
    const snapshot = content => ({
      content, sourceRoot: root, sourceHashes: { user: contentHash(content) }
    });
    await f.contextStore.publish(scope, sessionId, snapshot("Original"));
    const epoch = await f.contextStore.reserveRefresh(scope, sessionId);
    let release, selected, publisherPid;
    const gate = new Promise(resolve => { release = resolve; });
    const observed = new Promise(resolve => { selected = resolve; });
    const pausedPublisher = new PostgresIdentityContextStore({
      async connect() {
        const client = await f.db.pool.connect();
        publisherPid = client.processID;
        return {
          async query(...args) {
            const result = await client.query(...args);
            if (String(args[0]).includes("SELECT refresh_epoch")) {
              selected();
              await gate;
            }
            return result;
          },
          release() { client.release(); }
        };
      }
    });
    const contenderClient = await f.db.pool.connect();
    const contender = new PostgresIdentityContextStore({
      query: (...args) => contenderClient.query(...args)
    });
    const older = pausedPublisher.publish(scope, sessionId, snapshot("Older"), {
      force: true, refreshEpoch: epoch
    });
    let reservation;
    try {
      await observed;
      reservation = contender.reserveRefresh(scope, sessionId);
      await vi.waitFor(async () => {
        const result = await f.db.pool.query(
          "SELECT pg_blocking_pids($1) AS blockers", [contenderClient.processID]
        );
        expect(result.rows[0].blockers).toContain(publisherPid);
      }, { timeout: 1500, interval: 10 });
      release();
      await older;
      const newerEpoch = await reservation;
      expect(BigInt(newerEpoch)).toBe(BigInt(epoch) + 1n);
      await f.contextStore.publish(scope, sessionId, snapshot("Newest"), {
        force: true, refreshEpoch: newerEpoch
      });
      expect((await f.contextStore.read(scope, sessionId)).content).toBe("Newest");
    } finally {
      release();
      await Promise.allSettled([older, reservation]);
      contenderClient.release();
    }
  });

  it("atomically chooses one first-session version across workers and deduplicates immutable bodies", async () => {
    const f = await fixture();
    const scope = "concurrent-test";
    const snapshots = ["left", "right"].map(content => ({
      content, sourceRoot: root, sourceHashes: { user: contentHash(content) }
    }));
    const results = await Promise.all(snapshots.map(snapshot => f.contextStore.publish(scope, "session", snapshot)));
    expect(results[0].revision).toBe(results[1].revision);
    expect((await f.contextStore.read(scope, "session")).revision).toBe(results[0].revision);
    const current = await f.contextStore.read(scope);
    await f.contextStore.publish(scope, "second", current);
    const count = await f.db.pool.query("SELECT count(*)::integer AS count FROM runtime_identity_contexts");
    expect(count.rows[0].count).toBeLessThanOrEqual(2);
  });

  it("registers refresh as a Runtime command and rejects changes while an answer is active", async () => {
    const f = await fixture();
    let command;
    const registration = activateRuntimePlugin({
      plugin: { id: "dev.identity", version: "test" },
      locations: { scopeMode: "account", forRequest: async () => ({ root, backend: "agent-fs" }) },
      config: { fileService: f.fileService, contextStore: f.contextStore },
      state: { namespace: () => ({ get() {}, set() {} }) },
      context: { registerProvider: () => ({ dispose() {} }) },
      tools: { registerTool: () => ({ dispose() {} }) },
      runs: { registerCommands(handler) { command = handler; return { dispose() {} }; } }
    });
    try {
      await expect(command({ action: "refresh_context" }, { ...f.context("session").request, activeRunId: "active" }))
        .rejects.toMatchObject({ statusCode: 409 });
      const result = await command({ action: "refresh_context" }, f.context("session").request);
      expect(result.ok).toBe(true);
      expect(result.snapshot.content).toContain("Original user");
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    } finally { await registration.dispose(); }
  });
});
