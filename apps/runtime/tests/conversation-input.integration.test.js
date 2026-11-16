import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentExecutor } from "../../../packages/runtime/src/index";
import { PostgresRunStore } from "../src/postgres-run-store.mjs";
import { createRuntimeServer } from "../src/server.mjs";
import { createConversationInputSnapshot } from "../src/conversation-input.mjs";
import { createPostgresTestDatabase } from "./helpers/postgres-test-database.mjs";

let database;
const servers = [];
beforeAll(async () => { database = await createPostgresTestDatabase("conversation_input"); });
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});
afterAll(async () => { await database?.close(); });

async function fixture({ store = new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() }), ...options } = {}) {
  const received = [];
  const executor = createAgentExecutor({
    runs: store,
    tools: { async listTools() { return []; }, async invoke() { throw new Error("unexpected tool"); } },
    engine: {
      id: "local-test",
      async *streamTurn(request) {
        received.push(structuredClone(request.messages));
        yield { type: "message.delta", delta: `answer-${received.length}` };
      }
    }
  });
  const server = createRuntimeServer({ executor, runs: store, port: 0, ...options });
  servers.push(server);
  const { url } = await server.start();
  const post = async (path, body) => {
    const response = await fetch(`${url}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const finish = async (runId, sessionId = "doc") => {
    await vi.waitFor(async () => {
      const messages = await store.getSessionMessages(sessionId);
      expect(messages.some(message => message.runId === runId && message.role === "assistant")).toBe(true);
    }, { timeout: 2000, interval: 5 });
  };
  return { store, server, url, post, received, finish };
}

function input(clientRequestId, messages, extra = {}) {
  return {
    sessionId: "doc", messages, policy: { preset: "read-only", allowedTools: [] },
    conversationInput: { schemaVersion: 1, mode: "snapshot", clientRequestId },
    ...extra
  };
}

describe("versioned conversation admission", () => {
  it("replaces edited or truncated context and continues from that version through the normal Session API", async () => {
    const f = await fixture();
    const first = await f.post("/v1/runs", input("first", [{ role: "user", content: "obsolete" }]));
    expect(first.status).toBe(202);
    await f.finish(first.body.runId);
    const edited = [{ role: "user", content: "edited question" }, { role: "assistant", content: "my rewritten answer" }];
    const second = await f.post("/v1/runs", input("edited", edited));
    expect(second.status).toBe(202);
    await f.finish(second.body.runId);
    expect((await f.store.getSessionTranscript("doc")).map(m => m.content))
      .toEqual(["edited question", "my rewritten answer", "answer-2"]);
    const third = await f.post("/v1/sessions/doc/messages", { content: "continue" });
    expect(third.status).toBe(202);
    await f.finish(third.body.runId);
    expect(f.received[2].map(m => m.content))
      .toEqual(["edited question", "my rewritten answer", "answer-2", "continue"]);
    const oldInput = await (await fetch(`${f.url}/v1/runs/${first.body.runId}/input`)).json();
    expect(oldInput.input.messages).toEqual([{ role: "user", content: "obsolete" }]);
    expect((await f.store.getRunConversationInput(second.body.runId)).messages).toEqual(edited);
  });

  it("attaches assistant-only input to a Session without inventing a user message", async () => {
    const f = await fixture();
    const submitted = await f.post("/v1/runs", input("assistant", [{ role: "assistant", content: "continue this draft" }]));
    expect(submitted.status).toBe(202);
    await f.finish(submitted.body.runId);
    expect((await f.store.getSessionTranscript("doc")).map(m => [m.role, m.content]))
      .toEqual([["assistant", "continue this draft"], ["assistant", "answer-1"]]);
    expect(await f.store.getSessionMessages("doc")).toHaveLength(1);
  });

  it("replays a durable receipt after restarting the server without invoking the model again", async () => {
    const f = await fixture();
    const body = input("stable", [{ role: "user", content: "once only" }]);
    const submitted = await f.post("/v1/runs", body);
    await f.finish(submitted.body.runId);
    await f.server.close();
    servers.splice(servers.indexOf(f.server), 1);
    const g = await fixture({ store: new PostgresRunStore(database.pool, { spaceId: f.store.spaceId }) });
    const replayed = await g.post("/v1/runs", body);
    expect(replayed).toMatchObject({ status: 202, body: { ...submitted.body, replayed: true } });
    expect(g.received).toHaveLength(0);
    const receipt = await (await fetch(`${g.url}/v1/sessions/doc/inputs/stable`)).json();
    expect(receipt.input).toMatchObject({ status: "accepted", runId: submitted.body.runId });
  });

  it("rejects reuse of a submission ID with changed content or tool policy", async () => {
    const f = await fixture();
    const original = input("key", [{ role: "user", content: "original" }]);
    const submitted = await f.post("/v1/runs", original);
    await f.finish(submitted.body.runId);
    for (const body of [
      { ...original, messages: [{ role: "user", content: "different" }] },
      { ...original, policy: { preset: "read-only", allowedTools: ["read"] } }
    ]) {
      expect(await f.post("/v1/runs", body)).toMatchObject({ status: 409, body: { code: "INPUT_ID_CONFLICT" } });
    }
    expect(f.received).toHaveLength(1);
  });

  it("deduplicates simultaneous HTTP submissions", async () => {
    const f = await fixture();
    const body = input("simultaneous", [{ role: "user", content: "one model call" }]);
    const results = await Promise.all([f.post("/v1/runs", body), f.post("/v1/runs", body)]);
    const accepted = results.find(result => result.status === 202);
    expect(accepted).toBeDefined();
    expect(results.every(result => [202, 409].includes(result.status))).toBe(true);
    await f.finish(accepted.body.runId);
    expect(await f.post("/v1/runs", body)).toMatchObject({ status: 202, body: { runId: accepted.body.runId } });
    expect(f.received).toHaveLength(1);
  });

  it("forks the current context version without resurrecting previous input", async () => {
    const f = await fixture();
    const old = await f.post("/v1/runs", input("old", [{ role: "user", content: "discarded" }]));
    await f.finish(old.body.runId);
    const current = await f.post("/v1/runs", input("new", [{ role: "assistant", content: "only this" }]));
    await f.finish(current.body.runId);
    await f.store.forkSession("doc", { id: "fork" });
    expect((await f.store.getSessionTranscript("fork")).map(m => m.content))
      .toEqual(["only this", "answer-2"]);
  });

  it("returns a context version and rejects stale transcript cursors", async () => {
    const f = await fixture();
    const result = await f.post("/v1/runs", input("version", [{ role: "user", content: "hello" }]));
    await f.finish(result.body.runId);
    const stale = await fetch(`${f.url}/v1/sessions/doc/transcript?after=1`);
    expect(stale.status).toBe(409);
    const current = await (await fetch(`${f.url}/v1/sessions/doc/transcript?after=1&inputSnapshotId=${result.body.inputSnapshotId}`)).json();
    expect(current.inputSnapshotId).toBe(result.body.inputSnapshotId);
    expect(current.messages.map(m => m.content)).toEqual(["answer-1"]);
  });

  it("reads a single consistent context version while another client submits an edit", async () => {
    const f = await fixture();
    const first = await f.post("/v1/runs", input("v1", [{ role: "user", content: "first" }]));
    await f.finish(first.body.runId);
    const original = f.store.getSessionMessages.bind(f.store);
    const spy = vi.spyOn(f.store, "getSessionMessages").mockImplementationOnce(async (...args) => {
      const rows = await original(...args);
      const next = await f.post("/v1/runs", input("v2", [{ role: "assistant", content: "edited" }]));
      expect(next.status).toBe(202);
      await f.finish(next.body.runId);
      return rows;
    });
    try {
      const version = await f.store.getSessionTranscriptVersion("doc");
      expect(version.inputSnapshotId).toBe(first.body.inputSnapshotId);
      expect(version.messages.map(m => m.content)).toEqual(["first", "answer-1"]);
    } finally {
      spy.mockRestore();
    }
    expect((await f.store.getSessionTranscript("doc")).map(m => m.content))
      .toEqual(["edited", "answer-2"]);
  });

  it("does not let an external metadata field claim another submission", async () => {
    const f = await fixture();
    const accepted = await f.post("/v1/runs", input("real", [{ role: "user", content: "real" }]));
    await f.finish(accepted.body.runId);
    const raw = await f.post("/v1/runs", {
      prompt: "independent",
      metadata: { conversationInputId: accepted.body.inputSnapshotId }
    });
    expect(raw.status).toBe(202);
    expect((await f.store.getConversationInput("doc", "real")).runId).toBe(accepted.body.runId);
  });

  it("keeps receipt identities scoped to the authenticated account", async () => {
    let actor = "alice";
    const f = await fixture({
      accessControl: {
        async authorizeRuntimeRequest() { return { user: { id: actor } }; },
        async authorizeExistingRun() {}
      }
    });
    const body = input("private", [{ role: "user", content: "alice input" }]);
    const accepted = await f.post("/v1/runs", body);
    await f.finish(accepted.body.runId);
    expect((await f.store.getConversationInput("doc", "private")).principalId).toBe("alice");
    actor = "bob";
    expect((await f.post("/v1/runs", body)).status).toBe(403);
    expect((await fetch(`${f.url}/v1/sessions/doc/inputs/private`)).status).toBe(403);
    expect(f.received).toHaveLength(1);
  });

  it("rejects a changed cookie identity before admitting or saving captured input", async () => {
    let actor = "bob";
    let spaceId = "space-a";
    const f = await fixture({
      accessControl: {
        async authorizeRuntimeRequest() { return { kind: "account", user: { id: actor }, space: { id: spaceId } }; },
        async authorizeExistingRun() {}
      }
    });
    const body = input("captured-account", [{ role: "user", content: "alice private input" }]);
    body.conversationInput.expectedAccount = { userId: "alice", spaceId: "space-a" };
    expect(await f.post("/v1/runs", body)).toMatchObject({
      status: 403, body: { code: "INPUT_SUBMISSION_ACCOUNT_CHANGED" }
    });
    actor = "alice";
    spaceId = "space-b";
    expect((await f.post("/v1/runs", body)).status).toBe(403);
    expect(await f.store.getConversationInput("doc", "captured-account")).toBeNull();
    expect(f.received).toHaveLength(0);
    const receipt = await fetch(`${f.url}/v1/sessions/doc/inputs/captured-account?expectedUserId=alice&expectedSpaceId=space-a`);
    expect(receipt.status).toBe(403);
    spaceId = "space-a";
    const accepted = await f.post("/v1/runs", body);
    expect(accepted.status).toBe(202);
    await f.finish(accepted.body.runId);
    expect(f.received).toHaveLength(1);
  });

  it("reads accepted input and receipts after execution grants expire while enforcing current ownership", async () => {
    let actor = "alice";
    const authorizeExistingRun = vi.fn(async (principal, run, options) => {
      if (principal.user.id !== "alice") throw Object.assign(new Error("Owner required"), { statusCode: 403 });
      if (!options?.allowRevoked) throw Object.assign(new Error("grant_inactive"), { statusCode: 403 });
    });
    const f = await fixture({
      accessControl: {
        async authorizeRuntimeRequest() { return { user: { id: actor } }; },
        authorizeExistingRun
      }
    });
    const body = input("expired-grant", [{ role: "user", content: "history" }]);
    const accepted = await f.post("/v1/runs", body);
    await f.finish(accepted.body.runId);
    const path = `/v1/runs/${accepted.body.runId}/input`;
    expect((await fetch(`${f.url}${path}`)).status).toBe(200);
    expect((await fetch(`${f.url}/v1/sessions/doc/inputs/expired-grant`)).status).toBe(200);
    expect((await f.post("/v1/runs", body)).status).toBe(202);
    expect(authorizeExistingRun).toHaveBeenCalledTimes(3);
    actor = "bob";
    expect((await fetch(`${f.url}${path}`)).status).toBe(403);
    expect((await fetch(`${f.url}/v1/sessions/doc/inputs/expired-grant`)).status).toBe(403);
  });
});

describe("durable input reservations", () => {
  it("serializes competing writers and prevents duplicate claims during admission", async () => {
    const f = await fixture();
    await f.store.createSession({ id: "doc", status: "active", createdAt: 1, updatedAt: 1 });
    const snapshot = createConversationInputSnapshot({
      id: "input", sessionId: "doc", command: { clientRequestId: "command" },
      request: { messages: [{ role: "user", content: "hello" }] }, createdAt: 1
    });
    const secondStore = new PostgresRunStore(database.pool, { spaceId: f.store.spaceId });
    const claims = await Promise.all([
      f.store.reserveConversationInput(snapshot), secondStore.reserveConversationInput(snapshot)
    ]);
    expect(claims.map(c => c.reserved).sort()).toEqual([false, true]);
    await expect(secondStore.reserveConversationInput({
      ...snapshot, id: "other", clientRequestId: "other"
    })).rejects.toMatchObject({ statusCode: 409 });
    expect((await f.store.getConversationInput("doc", "command")).status).toBe("reserved");
    expect(await new PostgresRunStore(database.pool, { spaceId: database.nextSpaceId() })
      .getConversationInput("doc", "command")).toBeNull();
    await f.store.rejectConversationInput("input");
    expect((await f.store.getConversationInput("doc", "command")).status).toBe("rejected");
  });

  it("fences expired admission before execution and permits a new explicit submission", async () => {
    const f = await fixture();
    await f.store.createSession({ id: "doc", status: "active", createdAt: 1, updatedAt: 1 });
    const snapshot = createConversationInputSnapshot({
      id: "expired", sessionId: "doc", command: { clientRequestId: "old-command" },
      request: { messages: [{ role: "user", content: "never executed" }] }
    });
    await f.store.reserveConversationInput(snapshot);
    await database.pool.query(
      "UPDATE runtime_conversation_inputs SET reserved_until = 0 WHERE space_id = $1 AND id = $2",
      [f.store.spaceId, snapshot.id]
    );
    await expect(f.store.create({
      id: "late-run", attemptId: "attempt", sessionId: "doc", status: "queued",
      metadata: { conversationInputId: snapshot.id }, createdAt: 1, updatedAt: 1
    })).rejects.toThrow("no longer reserved");
    expect(await f.store.get("late-run")).toBeNull();
    const receipt = await f.store.getConversationInput("doc", "old-command");
    expect(receipt.status).toBe("rejected");
    const next = await f.post("/v1/runs", input("new-command", [{ role: "user", content: "try again" }]));
    expect(next.status).toBe(202);
    await f.finish(next.body.runId);
    expect(f.received).toHaveLength(1);
  });
});
