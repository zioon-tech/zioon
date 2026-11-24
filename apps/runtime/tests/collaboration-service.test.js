import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import {
  appendAssistantTokenToYText,
  applyAssistantOutputToYText,
  createSessionDocumentProjector,
  prepareRunInYText,
  projectAssistantOutputText,
  reconcileSessionMessagesInYText
} from "../../../extensions/dev.session-manager/session-document-projector.js";
import {
  COLLABORATION_TEXT_KEY,
  createRuntimeCollaborationService
} from "../src/collaboration-service.mjs";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { PostgresWorkbenchStateStore } from "../src/postgres-workbench-state-store.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

vi.mock("yjs", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, mergeUpdates: vi.fn(actual.mergeUpdates) };
});

const resources = [];
let database;

beforeAll(async () => {
  database = await createPostgresTestDatabase("collaboration");
});

afterAll(async () => {
  await database.close();
});

function createCollaboration(options) {
  return createRuntimeCollaborationService({
    ...options,
    documentProjector: createSessionDocumentProjector()
  });
}

function waitFor(predicate, timeoutMs = 3_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Timed out waiting for collaboration state"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function syncedProvider(url, name, document, token = "") {
  return new Promise((resolve, reject) => {
    let provider;
    provider = new HocuspocusProvider({
      url,
      name,
      document,
      token,
      WebSocketPolyfill: WebSocket,
      onSynced() {
        resolve(provider);
      },
      onAuthenticationFailed({ reason }) {
        reject(new Error(reason || "Collaboration authentication failed"));
      }
    });
  });
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    try { resource.provider?.destroy(); } catch {}
    try { resource.secondProvider?.destroy(); } catch {}
    try { await resource.collaboration?.close(); } catch {}
    try { await resource.server?.close(); } catch {}
    try { await resource.workbenchState?.close(); } catch {}
    try { await resource.runs?.close(); } catch {}
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("Runtime collaboration service", () => {
  it("notifies a mixed revoked document to stop same-provider replay and accepts fresh rejoin edits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-reset-"));
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({ id: "reset", text: "committed" });
    const revoked = new Set();
    const check = context => {
      if (revoked.has(context?.principal?.user?.id)) {
        throw Object.assign(new Error("revoked contributor"), { statusCode: 403 });
      }
    };
    const collaboration = createCollaboration({
      store: workbenchState, debounceMs: 5_000, maxDebounceMs: 10_000,
      authenticate: ({ token }) => {
        const context = { principal: { user: { id: token } } };
        check(context);
        return context;
      },
      reauthorize: check,
      authorizeOutbound: check,
      withPersistence: async ({ context, contributors = [] }, action) => {
        for (const contributor of [context, ...contributors]) check(contributor);
        return action();
      }
    });
    const runs = new PostgresRunStore(database.pool, { spaceId: workbenchState.spaceId });
    const server = createRuntimeServer({ port: 0, runs,
      executor: { execute() { throw new Error("No runs in this provider test"); } },
      upgradeHandlers: [collaboration.handleUpgrade] });
    const resource = { directory, workbenchState, collaboration, server, runs };
    resources.push(resource);
    const { url: httpUrl } = await server.start();
    const url = httpUrl.replace(/^http/, "ws") + "/v1/collaboration?protocol=8";
    const alice = new Y.Doc(), bob = new Y.Doc();
    const closed = [];
    const joinProvider = (document, token) => new Promise((resolve, reject) => {
      let provider;
      provider = new HocuspocusProvider({
        url, name: "reset", document, token, WebSocketPolyfill: WebSocket,
        onSynced() { resolve(provider); },
        onAuthenticationFailed({ reason }) { reject(new Error(reason)); },
        onClose({ event }) {
          if (event.reason === "collaboration_document_reset") {
            closed.push(token);
            provider.disconnect();
          }
        }
      });
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let freshProvider, fresh;
    try {
      resource.provider = await joinProvider(alice, "alice");
      resource.secondProvider = await joinProvider(bob, "bob");
      alice.getText("content").insert(9, " rejected");
      await waitFor(() => bob.getText("content").toString().includes("rejected"));
      bob.getText("content").insert(bob.getText("content").length, " mixed");
      await waitFor(() => collaboration.hocuspocus.documents.get("reset").getText("content").toString().includes("mixed"));
      revoked.add("alice");
      collaboration.hocuspocus.flushPendingStores();
      await waitFor(() => closed.includes("bob"));
      await waitFor(() => closed.includes("alice"));
      expect(resource.provider.configuration.websocketProvider.shouldConnect).toBe(false);
      expect(resource.secondProvider.configuration.websocketProvider.shouldConnect).toBe(false);
      expect(bob.getText("content").toString()).toContain("rejected mixed");
      expect((await workbenchState.readSession("reset")).text).toBe("committed");
      await waitFor(() => !collaboration.hocuspocus.documents.has("reset"));
      revoked.clear();
      expect(resource.provider.configuration.websocketProvider.shouldConnect).toBe(false);
      fresh = new Y.Doc();
      freshProvider = await joinProvider(fresh, "bob");
      expect(fresh.getText("content").toString()).toBe("committed");
      fresh.getText("content").insert(9, " accepted");
      await waitFor(() => collaboration.hocuspocus.documents.get("reset").getText("content").toString() === "committed accepted");
      collaboration.hocuspocus.flushPendingStores();
      await waitFor(async () => (await workbenchState.readSession("reset")).text === "committed accepted");
      expect((await workbenchState.readSession("reset")).text).not.toContain("rejected");
    } finally {
      revoked.clear();
      freshProvider?.destroy(); fresh?.destroy();
      resource.provider?.destroy(); resource.secondProvider?.destroy();
      alice.destroy(); bob.destroy();
      consoleError.mockRestore();
    }
  });

  it("persists a large paste and subsequent edits with bounded coalescing work", async () => {
    const committed = new Y.Doc();
    let text = "", version = 0;
    const store = {
      collaborationUpdates: true,
      async readSession() { return { text, updated_at: 0 }; },
      async readCollaborationDocument() {
        return version ? { state: Y.encodeStateAsUpdate(committed), version, updatedAt: 1 } : null;
      },
      async writeCollaborationDocument(id, state) {
        Y.applyUpdate(committed, state);
        text = committed.getText("content").toString();
        return { sessionId: id, version: ++version, state: Y.encodeStateAsUpdate(committed) };
      }
    };
    const collaboration = createRuntimeCollaborationService({ store, debounceMs: 60_000, maxDebounceMs: 120_000 });
    const connection = await collaboration.hocuspocus.openDirectConnection("large-pending", { clientId: "large-pending" });
    const merge = vi.mocked(Y.mergeUpdates);
    merge.mockClear();
    try {
      await connection.transact(doc => doc.getText("content").insert(0, "a".repeat(3_500_000)));
      for (let i = 0; i < 200; i++) {
        await connection.transact(doc => doc.getText("content").insert(doc.getText("content").length, "x"));
      }
      await connection.disconnect();
      expect(merge.mock.calls.length).toBeLessThan(10);
      expect(text).toBe("a".repeat(3_500_000) + "x".repeat(200));
    } finally {
      merge.mockClear();
      await connection.disconnect(); await collaboration.close(); committed.destroy();
    }
  });

  it("keeps edits arriving during a blocked incremental save and clears only captured contributors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-store-queue-"));
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({ id: "blocked", text: "base" });
    let release, entered, blockedOnce = false;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const contributors = [];
    const collaboration = createCollaboration({
      store: workbenchState,
      withPersistence: async ({ kind, contributors: contexts = [] }, action) => {
        if (kind === "store") {
          contributors.push(contexts.map(value => value.clientId));
          if (!blockedOnce) { blockedOnce = true; entered(); await gate; }
        }
        return action();
      }
    });
    resources.push({ directory, workbenchState, collaboration });
    const alice = await collaboration.hocuspocus.openDirectConnection("blocked", { clientId: "alice" });
    const bob = await collaboration.hocuspocus.openDirectConnection("blocked", { clientId: "bob" });
    let saving;
    try {
      await alice.transact(document => document.getText("content").insert(4, " first"));
      saving = alice.disconnect();
      await started;
      await bob.transact(document => document.getText("content").insert(10, " second"));
      release();
      await saving;
      await bob.disconnect();
      expect((await workbenchState.readSession("blocked")).text).toBe("base first second");
      expect(contributors).toEqual([["alice"], ["bob"]]);
      const stored = await workbenchState.readCollaborationDocument("blocked");
      const restored = new Y.Doc();
      Y.applyUpdate(restored, stored.state);
      expect(restored.getText("content").toString()).toBe("base first second");
      restored.destroy();
    } finally { release(); await saving; await bob.disconnect(); }
  });

  it("converges two separate Runtime owners on their next accepted save", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-two-owners-"));
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({ id: "owners", text: "base" });
    const first = createCollaboration({ store: workbenchState });
    const second = createCollaboration({ store: new PostgresWorkbenchStateStore(database.pool, { spaceId: workbenchState.spaceId }) });
    resources.push({ directory, workbenchState, collaboration: first });
    const left = await first.hocuspocus.openDirectConnection("owners", { clientId: "left" });
    const right = await second.hocuspocus.openDirectConnection("owners", { clientId: "right" });
    try {
      await left.transact(d => d.getText("content").insert(4, " left"));
      await right.transact(d => d.getText("content").insert(0, "right "));
      await Promise.all([left.disconnect(), right.disconnect()]);
      expect((await workbenchState.readSession("owners")).text).toBe("right base left");
      const next = await first.hocuspocus.openDirectConnection("owners", { clientId: "left" });
      await next.transact(d => {
        expect(d.getText("content").toString()).toBe("right base left");
        d.getText("content").insert(d.getText("content").length, " next");
      });
      await next.disconnect();
      expect((await workbenchState.readSession("owners")).text).toBe("right base left next");
    } finally { await left.disconnect(); await right.disconnect(); await second.close(); }
  });

  it("queues live text while the previous document flush is blocked", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-live-queue-"));
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({ id: "queue", text: "user question" });
    const collaboration = createCollaboration({ store: workbenchState });
    resources.push({ directory, workbenchState, collaboration });
    await collaboration.prepareRun("queue", { runId: "live", userContent: "question" });
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const open = collaboration.hocuspocus.openDirectConnection.bind(collaboration.hocuspocus);
    const opening = vi.spyOn(collaboration.hocuspocus, "openDirectConnection").mockImplementationOnce(async (...args) => {
      await blocked;
      return open(...args);
    });
    try {
      const event = (sequence, type, data = {}) => ({ runId: "live", sequence, type, data });
      await collaboration.applyRunEvent("queue", event(1, "run.started"), { deferFlush: true });
      await collaboration.applyRunEvent("queue", event(2, "message.delta", { delta: "answer" }), { deferFlush: true });
      await collaboration.applyRunEvent("queue", event(3, "message.completed", { content: "answer" }), { deferFlush: true });
      expect(opening).toHaveBeenCalledOnce();
      const terminal = collaboration.applyRunEvent("queue", event(4, "run.completed", { output: "answer" }), { deferFlush: true });
      release();
      await terminal;
      await waitFor(async () => (await workbenchState.readSession("queue")).text.includes("answer"));
      const stored = await workbenchState.readCollaborationDocument("queue");
      const document = new Y.Doc();
      Y.applyUpdate(document, stored.state);
      expect(document.getMap("runProjection").get("live").lastSequence).toBe(4);
      expect(document.getText("content").toString()).toContain("answer");
      document.destroy();
    } finally { release(); opening.mockRestore(); }
  });

  it("requires a resolved snapshot anchor before terminal replay", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-anchor-"));
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({ id: "snapshot", title: "Snapshot", text: "user question\nuser later" });
    const collaboration = createCollaboration({ store: workbenchState });
    resources.push({ directory, workbenchState, collaboration });
    const input = { runId: "fast", mode: "final", events: [{
      schemaVersion: 1, runId: "fast", attemptId: "attempt", sequence: 1,
      eventId: "complete", type: "run.completed", timestamp: Date.now(), data: { output: "answer" }
    }] };
    await expect(collaboration.applyRunEvents("snapshot", input)).rejects.toThrow("anchor is not prepared");
    await collaboration.prepareRun("snapshot", { runId: "fast", mode: "final",
      documentAnchor: { fallback: { offset: 13, before: "user question", after: "\nuser later" } } });
    await expect(collaboration.applyRunEvents("snapshot", input)).resolves.toBeUndefined();
  });

  it.each(["live", "final"])("keeps an attached %s snapshot retryable until its anchor arrives", async mode => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-pending-"));
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({ id: "pending", text: "user question" });
    const collaboration = createCollaboration({ store: workbenchState });
    resources.push({ directory, workbenchState, collaboration });
    const input = { runId: "pending-run", mode, events: [
      { runId: "pending-run", sequence: 1, type: "message.delta", data: { delta: "answer" } },
      { runId: "pending-run", sequence: 2, type: "run.completed", data: {} }
    ] };
    await collaboration.prepareRun("pending", { runId: input.runId, mode,
      documentAnchor: { fallback: { offset: 13, before: "user missing", after: "" } } });
    await expect(collaboration.applyRunEvents("pending", input)).rejects.toThrow("anchor is not prepared");
    await collaboration.prepareRun("pending", { runId: input.runId, mode,
      documentAnchor: { fallback: { offset: 13, before: "user question", after: "" } } });
    await expect(collaboration.applyRunEvents("pending", {
      ...input, mode: mode === "live" ? "final" : "live"
    })).rejects.toThrow("anchor is not prepared");
    await expect(collaboration.applyRunEvents("pending", input)).resolves.toBeUndefined();
    const connection = await collaboration.hocuspocus.openDirectConnection("pending");
    try {
      await connection.transact(document => {
        expect(document.getText("content").toString()).toContain("answer");
        expect(document.getMap("runProjection").get(input.runId).pendingAnchor).toBeNull();
      });
    } finally { await connection.disconnect({ unloadImmediately: false }); }
  });

  it.each(["live", "final"])("finishes %s replay without restoring a detached working copy", async mode => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-detached-"));
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    const original = "user question";
    const edited = "user my edited working copy";
    const runId = "detached-run";
    await workbenchState.createSession({ id: "detached", text: edited });
    const collaboration = createCollaboration({ store: workbenchState });
    resources.push({ directory, workbenchState, collaboration });
    const documentAnchor = { fallback: { offset: original.length, before: original, after: "" } };
    const projection = { runId, mode, detached: true, status: "detached",
      pendingAnchor: documentAnchor, lastSequence: 1 };
    const connection = await collaboration.hocuspocus.openDirectConnection("detached");
    try {
      await connection.transact(document => document.getMap("runProjection").set(runId, projection));
      const events = [
        { runId, sequence: 2, type: "message.delta", data: { delta: "canonical answer" } },
        { runId, sequence: 3, type: "run.completed", data: {} }
      ];
      await expect(collaboration.applyRunEvents("detached", { runId, mode, events })).resolves.toBeUndefined();
      await connection.transact(document => {
        expect(document.getText("content").toString()).toBe(edited);
        expect(document.getMap("runProjection").get(runId)).toEqual(projection);
        // Restoring matching text does not restore Runtime's ownership.
        const text = document.getText("content");
        text.delete(0, text.length);
        text.insert(0, original);
      });
      await collaboration.prepareRun("detached", { runId, mode, documentAnchor });
      await collaboration.applyRunEvents("detached", { runId, mode, events });
      await collaboration.reconcileTranscript("detached", [
        { role: "user", runId, content: "question" },
        { role: "assistant", runId, content: "canonical answer" }
      ]);
      await connection.transact(document => {
        expect(document.getText("content").toString()).toBe(original);
        expect(document.getMap("runProjection").get(runId)).toEqual(projection);
      });
    } finally { await connection.disconnect({ unloadImmediately: false }); }
  });

  it("rejects an oversized peer message without terminating Runtime HTTP", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-payload-"));
    const spaceId = database.nextSpaceId();
    const runs = new PostgresRunStore(database.pool, { spaceId });
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId });
    const collaboration = createCollaboration({ store: workbenchState });
    const executor = createAgentExecutor({
      engine: { id: "payload-test", async *streamTurn() {} },
      tools: { async listTools() { return []; }, async invoke() { throw new Error("No tools"); } },
      runs
    });
    const server = createRuntimeServer({ executor, runs, port: 0,
      upgradeHandlers: [collaboration.handleUpgrade] });
    resources.push({ directory, runs, workbenchState, collaboration, server });
    const { url } = await server.start();
    const closed = await new Promise((resolve, reject) => {
      const peer = new WebSocket(url.replace(/^http/, "ws") + "/v1/collaboration?protocol=8");
      const timer = setTimeout(() => { peer.terminate(); reject(new Error("Oversized peer did not close")); }, 3000);
      peer.once("error", reject);
      peer.once("open", () => peer.send(Buffer.alloc(4 * 1024 * 1024 + 1)));
      peer.once("close", (code) => { clearTimeout(timer); resolve(code); });
    });
    expect(closed).toBe(1009);
    const health = await fetch(url + "/health");
    expect(health.status).toBe(200);
    expect((await health.json()).ok).toBe(true);
  });

  it("keeps a newer intentionally empty Yjs checkpoint authoritative", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-recovery-"));
    const path = join(directory, "runtime");
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({
      id: "recovery-session",
      title: "Recovery",
      text: "user preserved content"
    });
    const emptyDocument = new Y.Doc();
    await workbenchState.writeCollaborationDocument(
      "recovery-session",
      Y.encodeStateAsUpdate(emptyDocument),
      { timestamp: Date.now() + 10_000 }
    );
    emptyDocument.destroy();
    const collaboration = createCollaboration({
      store: workbenchState,
      debounceMs: 25,
      maxDebounceMs: 50
    });
    resources.push({
      directory,
      workbenchState,
      collaboration
    });

    await collaboration.prepareRun("recovery-session", {
      runId: "run-recovery",
      userContent: "next question"
    });
    await waitFor(async () =>
      (await workbenchState.readSession("recovery-session")).text
        .includes("next question"),
      5_000
    );

    expect((await workbenchState.readSession("recovery-session")).text)
      .not.toContain("user preserved content");
    expect((await workbenchState.readSession("recovery-session")).text)
      .toContain("next question");
  });

  it("persists an intentional empty collaboration update", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-empty-"));
    const path = join(directory, "runtime");
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({
      id: "protected-session",
      title: "Protected",
      text: "user keep this"
    });
    const collaboration = createCollaboration({
      store: workbenchState,
      debounceMs: 25,
      maxDebounceMs: 50
    });
    resources.push({
      directory,
      workbenchState,
      collaboration
    });
    const connection = await collaboration.hocuspocus.openDirectConnection(
      "protected-session",
      { clientId: "workbench-a" }
    );
    await connection.transact((document) => {
      const text = document.getText(COLLABORATION_TEXT_KEY);
      text.delete(0, text.length);
    });
    await connection.disconnect({ unloadImmediately: false });

    await waitFor(async () => (await workbenchState.readSession("protected-session")).text === "");
    expect((await workbenchState.readSession("protected-session")).text).toBe("");
    const stored = await workbenchState.readCollaborationDocument(
      "protected-session"
    );
    const restored = new Y.Doc();
    Y.applyUpdate(restored, stored.state);
    expect(restored.getText(COLLABORATION_TEXT_KEY).toString())
      .toBe("");
    restored.destroy();
  });

  it("rejects an outdated collaboration protocol before upgrading", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-protocol-"));
    const path = join(directory, "runtime");
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    const collaboration = createCollaboration({ store: workbenchState });
    const executor = createAgentExecutor({
      engine: {
        id: "collaboration-protocol-test",
        async *streamTurn() {
          yield { type: "message.delta", delta: "unused" };
        }
      },
      tools: {
        async listTools() { return []; },
        async invoke() { throw new Error("No tools configured"); }
      },
      runs
    });
    const server = createRuntimeServer({
      executor,
      runs,
      port: 0,
      upgradeHandlers: [collaboration.handleUpgrade]
    });
    resources.push({
      directory,
      runs,
      workbenchState,
      collaboration,
      server
    });
    const address = await server.start();
    const response = await new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `${address.url.replace(/^http/, "ws")}`
        + "/v1/collaboration?client_id=old&protocol=7"
      );
      socket.once("unexpected-response", (_request, upgrade) => {
        resolve(upgrade);
      });
      socket.once("open", () => {
        socket.terminate();
        reject(new Error("Outdated collaboration client was accepted"));
      });
      socket.once("error", () => {});
    });

    expect(response.statusCode).toBe(426);
    expect(response.headers["x-zion-collaboration-protocol"]).toBe("8");
    expect(response.headers["clear-site-data"]).toBe("\"executionContexts\"");
    response.resume();
  });

  it("reauthorizes every authenticated client message", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-auth-"));
    const path = join(directory, "runtime");
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({
      id: "authenticated-session",
      title: "Authenticated",
      text: "hello"
    });
    const reauthorize = vi.fn();
    const collaboration = createCollaboration({
      store: workbenchState,
      authenticate({ token }) {
        if (token !== "valid-client") throw new Error("unauthorized");
        return { principal: { credentialId: "credential:test" } };
      },
      reauthorize
    });
    const executor = createAgentExecutor({
      engine: {
        id: "collaboration-auth-test",
        async *streamTurn() {
          yield { type: "message.delta", delta: "unused" };
        }
      },
      tools: {
        async listTools() { return []; },
        async invoke() { throw new Error("No tools configured"); }
      },
      runs
    });
    const server = createRuntimeServer({
      executor,
      runs,
      port: 0,
      upgradeHandlers: [collaboration.handleUpgrade]
    });
    const resource = {
      directory,
      runs,
      workbenchState,
      collaboration,
      server
    };
    resources.push(resource);
    const address = await server.start();
    const url = `${address.url.replace(/^http/, "ws")}/v1/collaboration?client_id=auth&protocol=8`;
    const document = new Y.Doc();
    const provider = await syncedProvider(
      url,
      "authenticated-session",
      document,
      "valid-client"
    );
    resource.provider = provider;
    document.getText(COLLABORATION_TEXT_KEY).insert(5, " world");

    await waitFor(() => reauthorize.mock.calls.length > 0);
    expect(reauthorize).toHaveBeenCalledWith({
      principal: { credentialId: "credential:test" },
      clientId: "auth"
    });
  });

  it("syncs a Runtime-backed Session between Yjs clients", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-"));
    const path = join(directory, "runtime");
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({
      id: "shared-session",
      title: "Shared",
      text: "hello"
    });
    const collaboration = createCollaboration({
      store: workbenchState,
      debounceMs: 25,
      maxDebounceMs: 50
    });
    const executor = createAgentExecutor({
      engine: {
        id: "collaboration-test",
        async *streamTurn() {
          yield { type: "message.delta", delta: "unused" };
        }
      },
      tools: {
        async listTools() { return []; },
        async invoke() { throw new Error("No tools configured"); }
      },
      runs
    });
    const server = createRuntimeServer({
      executor,
      runs,
      port: 0,
      upgradeHandlers: [collaboration.handleUpgrade],
      sessionEventStore: workbenchState,
      sessionDocumentService: collaboration
    });
    resources.push({
      directory,
      runs,
      workbenchState,
      collaboration,
      server
    });
    const address = await server.start();
    const url = `${address.url.replace(/^http/, "ws")}/v1/collaboration?client_id=test-client&protocol=8`;
    const firstDocument = new Y.Doc();
    const secondDocument = new Y.Doc();
    const provider = await syncedProvider(url, "shared-session", firstDocument);
    resources[0].provider = provider;
    const secondProvider = await syncedProvider(url, "shared-session", secondDocument);
    resources[0].secondProvider = secondProvider;

    expect(firstDocument.getText(COLLABORATION_TEXT_KEY).toString()).toBe("hello");
    expect(secondDocument.getText(COLLABORATION_TEXT_KEY).toString()).toBe("hello");

    firstDocument.getText(COLLABORATION_TEXT_KEY).insert(5, " world");
    await waitFor(() =>
      secondDocument.getText(COLLABORATION_TEXT_KEY).toString() === "hello world"
    );
    await waitFor(async () =>
      (await workbenchState.readSession("shared-session")).text === "hello world"
    );
    expect(await workbenchState.readCollaborationDocument("shared-session"))
      .toMatchObject({ version: 2 });

    await workbenchState.updateSession("shared-session", {
      text: "updated through HTTP",
      source_client_id: "cli"
    });
    await waitFor(() =>
      secondDocument.getText(COLLABORATION_TEXT_KEY).toString()
        === "updated through HTTP"
    );

    const accepted = await fetch(`${address.url}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "shared-session",
        messages: [{ role: "user", content: "project output" }]
      })
    }).then((response) => response.json());
    await waitFor(() =>
      secondDocument.getText(COLLABORATION_TEXT_KEY).toString()
        .includes("unused")
    );
    const projectedDocument = secondDocument
      .getText(COLLABORATION_TEXT_KEY)
      .toString();
    expect(projectedDocument).toContain("user project output");
    expect(projectedDocument)
      .toContain(`assistant <!-- zion-assistant:id=${accepted.runId} -->`);
    await waitFor(async () => {
      const events = (await workbenchState.listEvents(0)).events;
      return ["run.started", "run.completed"].every(type =>
        events.some(event => event.type === type && event.runId === accepted.runId)
      );
    });
    expect((await workbenchState.listEvents(0)).events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run.started",
          runId: accepted.runId
        }),
        expect.objectContaining({
          type: "run.completed",
          runId: accepted.runId
        })
      ])
    );
  });

  it("preserves an acknowledged owner edit when Runtime projection detaches", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-writer-"));
    const path = join(directory, "runtime");
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({
      id: "writer-session",
      title: "Writer",
      text: "user hello"
    });
    const collaboration = createCollaboration({
      store: workbenchState,
      debounceMs: 25,
      maxDebounceMs: 50
    });
    const executor = createAgentExecutor({
      engine: {
        id: "collaboration-writer-test",
        async *streamTurn() {
          yield { type: "message.delta", delta: "unused" };
        }
      },
      tools: {
        async listTools() { return []; },
        async invoke() { throw new Error("No tools configured"); }
      },
      runs
    });
    const server = createRuntimeServer({
      executor,
      runs,
      port: 0,
      upgradeHandlers: [collaboration.handleUpgrade]
    });
    const resource = {
      directory,
      runs,
      workbenchState,
      collaboration,
      server
    };
    resources.push(resource);
    const address = await server.start();
    const url = `${address.url.replace(/^http/, "ws")}/v1/collaboration?client_id=writer-client&protocol=8`;
    const document = new Y.Doc();
    const provider = await syncedProvider(
      url,
      "writer-session",
      document
    );
    resource.provider = provider;

    await collaboration.prepareRun("writer-session", {
      runId: "run-writer",
      userContent: "hello"
    });
    await waitFor(() =>
      document.getText(COLLABORATION_TEXT_KEY).toString()
        .includes("zion-assistant:id=run-writer")
    );
    document.getText(COLLABORATION_TEXT_KEY).insert(
      document.getText(COLLABORATION_TEXT_KEY).length,
      "owner output"
    );
    // Remove the network ordering race: the existing projector detaches after
    // an accepted owner edit changes its captured assistant block.
    await waitFor(async () => (await workbenchState.readSession("writer-session")).text.includes("owner output"));

    await collaboration.applyRunEvent("writer-session", {
      runId: "run-writer",
      sequence: 10,
      type: "message.delta",
      data: { turn: 1, delta: "runtime stale output" }
    });
    await collaboration.applyRunEvent("writer-session", {
      runId: "run-writer",
      sequence: 11,
      type: "run.aborted",
      data: { reason: "user" }
    });
    await waitFor(() => document.getMap("runProjection").get("run-writer")?.detached === true);

    expect(document.getText(COLLABORATION_TEXT_KEY).toString())
      .toContain("owner output");
    expect(document.getText(COLLABORATION_TEXT_KEY).toString())
      .not.toContain("runtime stale output");
    expect((await workbenchState.readSession("writer-session")).text).toContain("owner output");
  });

  it("preserves the submitted user message without a connected Workbench", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-headless-"));
    const path = join(directory, "runtime");
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    const initialText = [
      "user earlier",
      "assistant previous answer",
      "user "
    ].join("\n");
    await workbenchState.createSession({
      id: "headless-session",
      title: "Headless",
      text: initialText
    });
    const collaboration = createCollaboration({
      store: workbenchState,
      debounceMs: 25,
      maxDebounceMs: 50
    });
    const executor = createAgentExecutor({
      engine: {
        id: "headless-collaboration-test",
        async *streamTurn() {
          yield { type: "message.delta", delta: "final answer" };
        }
      },
      tools: {
        async listTools() { return []; },
        async invoke() { throw new Error("No tools configured"); }
      },
      runs
    });
    const server = createRuntimeServer({
      executor,
      runs,
      port: 0,
      upgradeHandlers: [collaboration.handleUpgrade],
      sessionEventStore: workbenchState,
      sessionDocumentService: collaboration
    });
    resources.push({
      directory,
      runs,
      workbenchState,
      collaboration,
      server
    });
    const address = await server.start();

    const accepted = await fetch(`${address.url}/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "headless-session",
        messages: [{ role: "user", content: "submitted while detached" }]
      })
    }).then((response) => response.json());
    await waitFor(async () =>
      (await workbenchState.readSession("headless-session")).text
        .includes("final answer")
    );

    const text = (await workbenchState.readSession("headless-session")).text;
    expect(text).toContain("user earlier\nassistant previous answer");
    expect(text).toContain("user submitted while detached");
    expect(text).toContain(
      `assistant <!-- zion-assistant:id=${accepted.runId} --> final answer`
    );
  });

  it("converges and persists concurrent edits made across a reconnect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-reconnect-"));
    const path = join(directory, "runtime");
    const runs = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() });
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({
      id: "reconnected-session",
      title: "Reconnected",
      text: "hello"
    });
    const collaboration = createCollaboration({
      store: workbenchState,
      debounceMs: 25,
      maxDebounceMs: 50
    });
    const executor = createAgentExecutor({
      engine: {
        id: "collaboration-reconnect-test",
        async *streamTurn() {
          yield { type: "message.delta", delta: "unused" };
        }
      },
      tools: {
        async listTools() { return []; },
        async invoke() { throw new Error("No tools configured"); }
      },
      runs
    });
    const server = createRuntimeServer({
      executor,
      runs,
      port: 0,
      upgradeHandlers: [collaboration.handleUpgrade]
    });
    const resource = {
      directory,
      runs,
      workbenchState,
      collaboration,
      server
    };
    resources.push(resource);
    const address = await server.start();
    const url = `${address.url.replace(/^http/, "ws")}/v1/collaboration?client_id=reconnect&protocol=8`;
    const firstDocument = new Y.Doc();
    const secondDocument = new Y.Doc();
    const provider = await syncedProvider(
      url,
      "reconnected-session",
      firstDocument
    );
    resource.provider = provider;
    const secondProvider = await syncedProvider(
      url,
      "reconnected-session",
      secondDocument
    );
    resource.secondProvider = secondProvider;

    provider.disconnect();
    await waitFor(() =>
      provider.configuration.websocketProvider.status === "disconnected"
    );
    firstDocument.getText(COLLABORATION_TEXT_KEY).insert(5, " offline");
    secondDocument.getText(COLLABORATION_TEXT_KEY).insert(0, "online ");
    await waitFor(() =>
      secondDocument.getText(COLLABORATION_TEXT_KEY).toString()
        .includes("online")
    );

    await provider.connect();
    await waitFor(() => provider.isSynced);
    await waitFor(() =>
      firstDocument.getText(COLLABORATION_TEXT_KEY).toString()
        === secondDocument.getText(COLLABORATION_TEXT_KEY).toString()
    );
    const converged = firstDocument
      .getText(COLLABORATION_TEXT_KEY)
      .toString();
    expect(converged).toContain("offline");
    expect(converged).toContain("online");
    await waitFor(async () =>
      (await workbenchState.readSession("reconnected-session")).text === converged
    );
    expect(await workbenchState.readCollaborationDocument("reconnected-session"))
      .toMatchObject({ state: expect.any(Uint8Array) });
  });

  it("stores reasoning in a card while keeping it out of plain document text", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-gating-"));
    const path = join(directory, "runtime");
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({
      id: "reasoning-session",
      title: "Reasoning",
      text: "user hello"
    });
    const collaboration = createCollaboration({
      store: workbenchState,
      debounceMs: 25,
      maxDebounceMs: 50,
      runProjectionDebounceMs: 25
    });
    resources.push({
      directory,
      workbenchState,
      collaboration
    });

    for (let sequence = 1; sequence <= 100; sequence += 1) {
      await collaboration.applyRunEvent("reasoning-session", {
        runId: "run-reasoning",
        sequence,
        type: "reasoning.delta",
        data: { delta: "private reasoning" }
      });
    }
    await waitFor(async () => {
      const stored = await workbenchState.readCollaborationDocument(
        "reasoning-session"
      );
      if (!stored?.state) return false;
      const document = new Y.Doc();
      try {
        Y.applyUpdate(document, stored.state);
        return document
          .getText(COLLABORATION_TEXT_KEY)
          .toString()
          .includes("zion-thinking:id=thinking:run-reasoning:1");
      } finally {
        document.destroy();
      }
    });

    const storedReasoning = await workbenchState.readCollaborationDocument(
      "reasoning-session"
    );
    const reasoningDocument = new Y.Doc();
    Y.applyUpdate(reasoningDocument, storedReasoning.state);
    const reasoningText = reasoningDocument
      .getText(COLLABORATION_TEXT_KEY)
      .toString();
    expect(reasoningText).toContain(
      "思考 <!-- zion-thinking:id=thinking:run-reasoning:1 -->"
    );
    expect(reasoningText).not.toContain("private reasoning");
    expect(
      reasoningDocument
        .getMap("cards")
        .get("thinking:run-reasoning:1")
        .text
    ).toBe("private reasoning".repeat(100));
    reasoningDocument.destroy();

    await collaboration.applyRunEvent("reasoning-session", {
      runId: "run-reasoning",
      sequence: 101,
      type: "message.delta",
      data: { delta: "visible" }
    });
    await waitFor(async () =>
      (await workbenchState.readSession("reasoning-session")).text.includes("visible")
    );

    await collaboration.applyRunEvent("reasoning-session", {
      runId: "run-reasoning",
      sequence: 102,
      type: "message.completed",
      data: { content: "visible" }
    });
    await waitFor(async () =>
      (await workbenchState.readSession("reasoning-session")).text.includes("visible")
    );

    expect((await workbenchState.listEvents(0)).events.map((event) => event.type))
      .toContain("collaboration.updated");
  });

  it("coalesces durable document checkpoint events after collaboration settles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-checkpoint-"));
    const path = join(directory, "runtime");
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({
      id: "checkpoint-session",
      title: "Checkpoint",
      text: "user hello"
    });
    const initial = new Y.Doc();
    initial.getText(COLLABORATION_TEXT_KEY).insert(0, "user hello");
    await workbenchState.writeCollaborationDocument(
      "checkpoint-session",
      Y.encodeStateAsUpdate(initial),
      { text: "user hello" }
    );
    const baseline = (await workbenchState.eventBounds()).latestSequence;
    const collaboration = createCollaboration({
      store: workbenchState,
      debounceMs: 25,
      maxDebounceMs: 50,
      checkpointDebounceMs: 100
    });
    resources.push({
      directory,
      workbenchState,
      collaboration
    });

    await collaboration.projectAssistantOutput("checkpoint-session", {
      runId: "run-checkpoint",
      output: "first"
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await collaboration.projectAssistantOutput("checkpoint-session", {
      runId: "run-checkpoint",
      output: "second"
    });
    await waitFor(async () =>
      (await workbenchState.listEvents(baseline)).events.some((event) =>
        event.type === "document.checkpointed"
      )
    );

    const events = (await workbenchState.listEvents(baseline)).events;
    expect(events.filter((event) =>
      event.type === "document.checkpointed"
    )).toHaveLength(1);
    expect(events.some((event) =>
      event.type === "collaboration.updated"
    )).toBe(false);
  });

  it("projects a completed assistant result idempotently", () => {
    const initial = [
      "user hello",
      "",
      "assistant <!-- zion-assistant:id=run-1 --> partial"
    ].join("\n");
    const projected = projectAssistantOutputText(initial, {
      runId: "run-1",
      output: "final answer"
    });
    expect(projected).toContain(
      "assistant <!-- zion-assistant:id=run-1 --> final answer"
    );
    expect(projectAssistantOutputText(projected, {
      runId: "run-1",
      output: "final answer"
    })).toBe(projected);
  });

  it("applies assistant output incrementally inside the existing block", () => {
    const document = new Y.Doc();
    const ytext = document.getText(COLLABORATION_TEXT_KEY);
    ytext.insert(0, "user hello");

    expect(applyAssistantOutputToYText(ytext, {
      runId: "run-1",
      output: "hel"
    })).toBe(true);
    expect(ytext.toString()).toBe(
      "user hello\nassistant <!-- zion-assistant:id=run-1 --> hel"
    );

    expect(applyAssistantOutputToYText(ytext, {
      runId: "run-1",
      output: "hello"
    })).toBe(true);
    expect(ytext.toString()).toBe(
      "user hello\nassistant <!-- zion-assistant:id=run-1 --> hello"
    );
    expect(applyAssistantOutputToYText(ytext, {
      runId: "run-1",
      output: "hello"
    })).toBe(false);
    expect(ytext.toString()).toBe(
      "user hello\nassistant <!-- zion-assistant:id=run-1 --> hello"
    );
  });

  it("keeps block Markdown parseable while appending split stream tokens", () => {
    const document = new Y.Doc();
    const ytext = document.getText(COLLABORATION_TEXT_KEY);
    ytext.insert(
      0,
      "user hello\nassistant <!-- zion-assistant:id=run-heading --> "
    );

    expect(appendAssistantTokenToYText(ytext, {
      runId: "run-heading",
      token: "#"
    })).toBe(true);
    expect(appendAssistantTokenToYText(ytext, {
      runId: "run-heading",
      token: "# Heading"
    })).toBe(true);
    expect(ytext.toString()).toBe([
      "user hello",
      "assistant <!-- zion-assistant:id=run-heading --> ",
      "## Heading"
    ].join("\n"));
  });

  it("does not replace streamed text interleaved with card markers", () => {
    const initial = [
      "user hello",
      "assistant <!-- zion-assistant:id=run-cards --> before tool",
      "调用 read <!-- zion-tool:id=tool:run-cards:1 -->",
      "after tool"
    ].join("\n");

    expect(projectAssistantOutputText(initial, {
      runId: "run-cards",
      output: "before toolafter tool"
    })).toBe(initial);
  });

  it("projects reasoning, text, and tools in Runtime event order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-order-"));
    const path = join(directory, "runtime");
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({
      id: "ordered-session",
      title: "Ordered",
      text: "user inspect the project"
    });
    const collaboration = createCollaboration({
      store: workbenchState,
      debounceMs: 25,
      maxDebounceMs: 50
    });
    resources.push({
      directory,
      workbenchState,
      collaboration
    });
    await collaboration.prepareRun("ordered-session", {
      runId: "run-ordered",
      userContent: "inspect the project"
    });

    const events = [
      ["reasoning.started", { turn: 1 }],
      ["reasoning.delta", { turn: 1, delta: "Check the files." }],
      ["reasoning.completed", { turn: 1 }],
      ["message.delta", { turn: 1, delta: "I found a lead." }],
      ["message.completed", { turn: 1, content: "I found a lead." }],
      ["tool.requested", {
        turn: 1,
        callId: "call-1",
        name: "read",
        arguments: { path: "package.json" }
      }],
      ["tool.completed", {
        turn: 1,
        callId: "call-1",
        name: "read",
        ok: true,
        result: "package contents"
      }],
      ["message.delta", { turn: 2, delta: "The answer is ready." }],
      ["message.completed", { turn: 2, content: "The answer is ready." }],
      ["run.completed", { output: "I found a lead.The answer is ready." }]
    ];
    for (let index = 0; index < events.length; index += 1) {
      const [type, data] = events[index];
      await collaboration.applyRunEvent("ordered-session", {
        runId: "run-ordered",
        sequence: index + 1,
        type,
        data
      });
    }
    await waitFor(async () =>
      (await workbenchState.readSession("ordered-session")).text
        .includes("The answer is ready.")
    );

    const stored = await workbenchState.readCollaborationDocument("ordered-session");
    const document = new Y.Doc();
    Y.applyUpdate(document, stored.state);
    expect(document.getText(COLLABORATION_TEXT_KEY).toString()).toBe([
      "user inspect the project",
      "assistant <!-- zion-assistant:id=run-ordered --> ",
      "思考 <!-- zion-thinking:id=thinking:run-ordered:1 -->",
      "I found a lead.",
      "调用 read <!-- zion-tool:id=tool:run-ordered:call-1 -->",
      "The answer is ready."
    ].join("\n"));
    expect(document.getMap("cards").get("thinking:run-ordered:1"))
      .toMatchObject({
        kind: "thinking",
        text: "Check the files."
      });
    expect(document.getMap("cards").get("tool:run-ordered:call-1"))
      .toMatchObject({
        kind: "tool",
        name: "read",
        args: { path: "package.json" },
        result: "package contents",
        ok: true
      });
    expect(document.getMap("runProjection").get("run-ordered"))
      .toMatchObject({
        lastSequence: 10,
        status: "completed"
      });
    document.destroy();
  });

  it("prepares a Run by filling a trailing user prompt without replacing history", () => {
    const document = new Y.Doc();
    const ytext = document.getText(COLLABORATION_TEXT_KEY);
    ytext.insert(0, [
      "user earlier",
      "assistant previous answer",
      "user "
    ].join("\n"));

    expect(prepareRunInYText(ytext, {
      runId: "run-next",
      userContent: "latest question"
    })).toBe(true);
    expect(ytext.toString()).toBe([
      "user earlier",
      "assistant previous answer",
      "user latest question",
      "assistant <!-- zion-assistant:id=run-next --> "
    ].join("\n"));
    expect(prepareRunInYText(ytext, {
      runId: "run-next",
      userContent: "latest question"
    })).toBe(false);

    const preanchored = new Y.Doc();
    const preanchoredText = preanchored.getText(COLLABORATION_TEXT_KEY);
    preanchoredText.insert(0, [
      "user earlier",
      "assistant previous answer",
      "user ",
      "assistant <!-- zion-assistant:id=run-ready --> "
    ].join("\n"));
    expect(prepareRunInYText(preanchoredText, {
      runId: "run-ready",
      userContent: "preserved question"
    })).toBe(true);
    expect(preanchoredText.toString()).toBe([
      "user earlier",
      "assistant previous answer",
      "user preserved question",
      "assistant <!-- zion-assistant:id=run-ready --> "
    ].join("\n"));

    const implicitUser = new Y.Doc();
    const implicitUserText = implicitUser.getText(COLLABORATION_TEXT_KEY);
    implicitUserText.insert(0, "implicit user question");
    expect(prepareRunInYText(implicitUserText, {
      runId: "run-implicit",
      userContent: "implicit user question"
    })).toBe(true);
    expect(implicitUserText.toString()).toBe([
      "implicit user question",
      "assistant <!-- zion-assistant:id=run-implicit --> "
    ].join("\n"));
    expect(prepareRunInYText(implicitUserText, {
      runId: "run-implicit",
      userContent: "implicit user question"
    })).toBe(false);

    const positioned = new Y.Doc();
    const positionedText = positioned.getText(COLLABORATION_TEXT_KEY);
    positionedText.insert(0, [
      "first question",
      "user later question"
    ].join("\n"));
    expect(prepareRunInYText(positionedText, {
      runId: "run-positioned",
      userContent: "first question",
      insertAt: "first question".length
    })).toBe(true);
    expect(positionedText.toString()).toBe([
      "first question",
      "assistant <!-- zion-assistant:id=run-positioned --> ",
      "user later question"
    ].join("\n"));

    const unmarkedSuffix = new Y.Doc();
    const unmarkedSuffixText = unmarkedSuffix.getText(COLLABORATION_TEXT_KEY);
    unmarkedSuffixText.insert(0, [
      "first question",
      "preserve this paragraph",
      "and this paragraph too"
    ].join("\n"));
    expect(prepareRunInYText(unmarkedSuffixText, {
      runId: "run-preserve-suffix",
      userContent: "first question",
      insertAt: "first question".length
    })).toBe(true);
    expect(applyAssistantOutputToYText(unmarkedSuffixText, {
      runId: "run-preserve-suffix",
      output: "inserted answer"
    })).toBe(true);
    expect(unmarkedSuffixText.toString()).toBe([
      "first question",
      "assistant <!-- zion-assistant:id=run-preserve-suffix --> inserted answer",
      "user <!-- zion-continuation:id=run-preserve-suffix -->",
      "preserve this paragraph",
      "and this paragraph too"
    ].join("\n"));

    const cardBeforeAnswer = new Y.Doc();
    const cardBeforeAnswerText = cardBeforeAnswer.getText(
      COLLABORATION_TEXT_KEY
    );
    cardBeforeAnswerText.insert(0, [
      "first question",
      "assistant <!-- zion-assistant:id=run-with-card --> ",
      "思考 <!-- zion-thinking:id=thinking:run-with-card:1 -->",
      "user <!-- zion-continuation:id=run-with-card -->",
      "preserved suffix"
    ].join("\n"));
    expect(applyAssistantOutputToYText(cardBeforeAnswerText, {
      runId: "run-with-card",
      output: "answer after card"
    })).toBe(true);
    expect(cardBeforeAnswerText.toString()).toBe([
      "first question",
      "assistant <!-- zion-assistant:id=run-with-card --> ",
      "思考 <!-- zion-thinking:id=thinking:run-with-card:1 -->",
      "answer after card",
      "user <!-- zion-continuation:id=run-with-card -->",
      "preserved suffix"
    ].join("\n"));
  });

  it("preserves missing editable context when no projection ownership baseline exists", () => {
    const document = new Y.Doc();
    const ytext = document.getText(COLLABORATION_TEXT_KEY);
    ytext.insert(0, [
      "user first question",
      "assistant <!-- zion-assistant:id=run-1 --> first answer",
      "assistant <!-- zion-assistant:id=run-2 --> "
    ].join("\n"));
    const messages = [
      { role: "user", runId: "run-1", content: "first question" },
      { role: "assistant", runId: "run-1", content: "first answer" },
      { role: "user", runId: "run-2", content: "second question" },
      { role: "assistant", runId: "run-2", content: "second answer" }
    ];

    expect(reconcileSessionMessagesInYText(ytext, messages)).toBe(false);
    expect(ytext.toString()).toBe([
      "user first question",
      "assistant <!-- zion-assistant:id=run-1 --> first answer",
      "assistant <!-- zion-assistant:id=run-2 --> "
    ].join("\n"));
    expect(reconcileSessionMessagesInYText(ytext, messages)).toBe(false);
  });

  it("does not treat stale Runtime owner metadata as proof that an empty block is unedited", () => {
    const document = new Y.Doc();
    const ytext = document.getText(COLLABORATION_TEXT_KEY);
    ytext.insert(0, [
      "user question",
      "assistant <!-- zion-assistant:id=run-stale --> "
    ].join("\n"));
    document.getMap("runs").set("run-stale", {
      textOwner: "runtime",
      committedOutputLength: 999,
      lastSequence: 99
    });

    expect(reconcileSessionMessagesInYText(ytext, [
      { role: "user", runId: "run-stale", content: "question" },
      { role: "assistant", runId: "run-stale", content: "recovered answer" }
    ])).toBe(false);
    expect(ytext.toString()).toBe("user question\nassistant <!-- zion-assistant:id=run-stale --> ");
    document.destroy();
  });

  it("does not resurrect historical Runs removed from the editable document", () => {
    const document = new Y.Doc();
    const ytext = document.getText(COLLABORATION_TEXT_KEY);
    ytext.insert(0, [
      "user current question",
      "assistant <!-- zion-assistant:id=run-current --> "
    ].join("\n"));
    document.getMap("runProjection").set("run-current", { projectedOutput: "" });

    expect(reconcileSessionMessagesInYText(ytext, [
      { role: "user", runId: "run-removed", content: "removed question" },
      { role: "assistant", runId: "run-removed", content: "removed answer" },
      { role: "user", runId: "run-current", content: "current question" },
      { role: "assistant", runId: "run-current", content: "current answer" }
    ])).toBe(true);
    expect(ytext.toString()).toBe([
      "user current question",
      "assistant <!-- zion-assistant:id=run-current --> current answer"
    ].join("\n"));
    expect(ytext.toString()).not.toContain("removed");
    document.destroy();
  });

  it("resolves a Yjs relative Run anchor before inserting the assistant block", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-anchor-"));
    const path = join(directory, "runtime");
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    const source = [
      "first question",
      "user later question"
    ].join("\n");
    await workbenchState.createSession({
      id: "anchor-session",
      title: "Anchor",
      text: source
    });
    const seeded = new Y.Doc();
    const seededText = seeded.getText(COLLABORATION_TEXT_KEY);
    seededText.insert(0, source);
    const relative = Y.createRelativePositionFromTypeIndex(
      seededText,
      "first question".length,
      1
    );
    await workbenchState.writeCollaborationDocument(
      "anchor-session",
      Y.encodeStateAsUpdate(seeded),
      { text: source }
    );
    seeded.destroy();
    const collaboration = createCollaboration({
      store: workbenchState,
      debounceMs: 25,
      maxDebounceMs: 50
    });
    resources.push({
      directory,
      workbenchState,
      collaboration
    });

    await collaboration.prepareRun("anchor-session", {
      runId: "run-anchor",
      userContent: "first question",
      documentAnchor: {
        kind: "y-relative-position-v1",
        encoded: Buffer.from(
          Y.encodeRelativePosition(relative)
        ).toString("base64"),
        fallback: {
          offset: "first question".length,
          before: "first question",
          after: "\nuser later question"
        }
      }
    });
    await waitFor(async () =>
      (await workbenchState.readSession("anchor-session")).text.includes("run-anchor")
    );

    expect((await workbenchState.readSession("anchor-session")).text).toBe([
      "user first question",
      "assistant <!-- zion-assistant:id=run-anchor --> ",
      "user later question"
    ].join("\n"));
  });

  it("does not replace projected text with a terminal aggregate", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-final-"));
    const path = join(directory, "runtime");
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, { spaceId: database.nextSpaceId() });
    await workbenchState.createSession({
      id: "final-session",
      title: "Final",
      text: "user latest question"
    });
    const collaboration = createCollaboration({
      store: workbenchState,
      debounceMs: 25,
      maxDebounceMs: 50
    });
    resources.push({
      directory,
      workbenchState,
      collaboration
    });

    await collaboration.prepareRun("final-session", {
      runId: "run-final",
      userContent: "latest question"
    });
    await collaboration.applyRunEvent("final-session", {
      runId: "run-final",
      sequence: 10,
      type: "message.delta",
      data: { delta: "final answer" }
    });
    await collaboration.applyRunEvent("final-session", {
      runId: "run-final",
      sequence: 11,
      type: "message.completed",
      data: { content: "final answer" }
    });
    await collaboration.applyRunEvent("final-session", {
      runId: "run-final",
      sequence: 12,
      type: "run.completed",
      data: { output: "intermediate textfinal answer" }
    }, {
      appendUserPrompt: true
    });
    await waitFor(async () =>
      (await workbenchState.readSession("final-session")).text.includes("final answer")
    );

    const text = (await workbenchState.readSession("final-session")).text;
    expect(text).toContain("user latest question");
    expect(text).toContain("final answer");
    expect(text).not.toContain("intermediate text");
    expect(text.endsWith("\nuser ")).toBe(false);
  });
});
