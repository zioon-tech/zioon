import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { createRuntimeServer } from "../src/server.mjs";
import { SqliteRunStore } from "../src/sqlite-run-store.mjs";
import { SqliteWorkbenchStateStore } from "../src/sqlite-workbench-state-store.mjs";

const resources = [];

function createCollaboration(options) {
  return createRuntimeCollaborationService({
    ...options,
    documentProjector: createSessionDocumentProjector()
  });
}

function waitFor(predicate, timeoutMs = 3_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
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
    try { resource.workbenchState?.close(); } catch {}
    try { resource.runs?.close(); } catch {}
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("Runtime collaboration service", () => {
  it("rejects an outdated collaboration protocol before upgrading", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-protocol-"));
    const path = join(directory, "runtime.sqlite3");
    const runs = new SqliteRunStore(path);
    const workbenchState = new SqliteWorkbenchStateStore(path);
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
        + "/v1/collaboration?client_id=old&protocol=4"
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
    expect(response.headers["x-zion-collaboration-protocol"]).toBe("5");
    expect(response.headers["clear-site-data"]).toBe("\"executionContexts\"");
    response.resume();
  });

  it("reauthorizes every authenticated client message", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-auth-"));
    const path = join(directory, "runtime.sqlite3");
    const runs = new SqliteRunStore(path);
    const workbenchState = new SqliteWorkbenchStateStore(path);
    workbenchState.createSession({
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
    const url = `${address.url.replace(/^http/, "ws")}/v1/collaboration?client_id=auth&protocol=5`;
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
    const path = join(directory, "runtime.sqlite3");
    const runs = new SqliteRunStore(path);
    const workbenchState = new SqliteWorkbenchStateStore(path);
    workbenchState.createSession({
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
    const url = `${address.url.replace(/^http/, "ws")}/v1/collaboration?client_id=test-client&protocol=5`;
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
    await waitFor(() =>
      workbenchState.readSession("shared-session").text === "hello world"
    );
    expect(workbenchState.readCollaborationDocument("shared-session"))
      .toMatchObject({ version: 2 });

    workbenchState.updateSession("shared-session", {
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
    expect(workbenchState.listEvents(0).events).toEqual(
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

  it("does not race the connected document writer at Run termination", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-writer-"));
    const path = join(directory, "runtime.sqlite3");
    const runs = new SqliteRunStore(path);
    const workbenchState = new SqliteWorkbenchStateStore(path);
    workbenchState.createSession({
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
    const url = `${address.url.replace(/^http/, "ws")}/v1/collaboration?client_id=writer-client&protocol=5`;
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

    await collaboration.applyRunEvent("writer-session", {
      runId: "run-writer",
      sequence: 10,
      type: "message.delta",
      data: { turn: 1, delta: "runtime stale output" }
    }, {
      documentWriterClientId: "writer-client"
    });
    await collaboration.applyRunEvent("writer-session", {
      runId: "run-writer",
      sequence: 11,
      type: "run.aborted",
      data: { reason: "user" }
    }, {
      documentWriterClientId: "writer-client"
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(document.getText(COLLABORATION_TEXT_KEY).toString())
      .toContain("owner output");
    expect(document.getText(COLLABORATION_TEXT_KEY).toString())
      .not.toContain("runtime stale output");
  });

  it("preserves the submitted user message without a connected Workbench", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-headless-"));
    const path = join(directory, "runtime.sqlite3");
    const runs = new SqliteRunStore(path);
    const workbenchState = new SqliteWorkbenchStateStore(path);
    const initialText = [
      "user earlier",
      "assistant previous answer",
      "user "
    ].join("\n");
    workbenchState.createSession({
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
    await waitFor(() =>
      workbenchState.readSession("headless-session").text
        .includes("final answer")
    );

    const text = workbenchState.readSession("headless-session").text;
    expect(text).toContain("user earlier\nassistant previous answer");
    expect(text).toContain("user submitted while detached");
    expect(text).toContain(
      `assistant <!-- zion-assistant:id=${accepted.runId} --> final answer`
    );
  });

  it("converges and persists concurrent edits made across a reconnect", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-reconnect-"));
    const path = join(directory, "runtime.sqlite3");
    const runs = new SqliteRunStore(path);
    const workbenchState = new SqliteWorkbenchStateStore(path);
    workbenchState.createSession({
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
    const url = `${address.url.replace(/^http/, "ws")}/v1/collaboration?client_id=reconnect&protocol=5`;
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
    await waitFor(() =>
      workbenchState.readSession("reconnected-session").text === converged
    );
    expect(workbenchState.readCollaborationDocument("reconnected-session"))
      .toMatchObject({ state: expect.any(Uint8Array) });
  });

  it("does not project reasoning-only Run events into the Yjs document", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-gating-"));
    const path = join(directory, "runtime.sqlite3");
    const workbenchState = new SqliteWorkbenchStateStore(path);
    workbenchState.createSession({
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
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(workbenchState.readCollaborationDocument("reasoning-session"))
      .toBeNull();
    expect(workbenchState.listEvents(0).events.map((event) => event.type))
      .toEqual(["session.created"]);

    await collaboration.applyRunEvent("reasoning-session", {
      runId: "run-reasoning",
      sequence: 101,
      type: "message.delta",
      data: { delta: "visible" }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(workbenchState.readCollaborationDocument("reasoning-session"))
      .toBeNull();

    await collaboration.applyRunEvent("reasoning-session", {
      runId: "run-reasoning",
      sequence: 102,
      type: "message.completed",
      data: { content: "visible" }
    });
    await waitFor(() =>
      workbenchState.readSession("reasoning-session").text.includes("visible")
    );

    expect(workbenchState.listEvents(0).events.map((event) => event.type))
      .toContain("collaboration.updated");
  });

  it("coalesces durable document checkpoint events after collaboration settles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-checkpoint-"));
    const path = join(directory, "runtime.sqlite3");
    const workbenchState = new SqliteWorkbenchStateStore(path);
    workbenchState.createSession({
      id: "checkpoint-session",
      title: "Checkpoint",
      text: "user hello"
    });
    const initial = new Y.Doc();
    initial.getText(COLLABORATION_TEXT_KEY).insert(0, "user hello");
    workbenchState.writeCollaborationDocument(
      "checkpoint-session",
      Y.encodeStateAsUpdate(initial),
      { text: "user hello" }
    );
    const baseline = workbenchState.eventBounds().latestSequence;
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
    await waitFor(() =>
      workbenchState.listEvents(baseline).events.some((event) =>
        event.type === "document.checkpointed"
      )
    );

    const events = workbenchState.listEvents(baseline).events;
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

  it("repairs missing multi-turn document blocks from canonical messages", () => {
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

    expect(reconcileSessionMessagesInYText(ytext, messages)).toBe(true);
    expect(ytext.toString()).toBe([
      "user first question",
      "assistant <!-- zion-assistant:id=run-1 --> first answer",
      "user second question",
      "assistant <!-- zion-assistant:id=run-2 --> second answer"
    ].join("\n"));
    expect(reconcileSessionMessagesInYText(ytext, messages)).toBe(false);
  });

  it("resolves a Yjs relative Run anchor before inserting the assistant block", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-anchor-"));
    const path = join(directory, "runtime.sqlite3");
    const workbenchState = new SqliteWorkbenchStateStore(path);
    const source = [
      "first question",
      "user later question"
    ].join("\n");
    workbenchState.createSession({
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
    workbenchState.writeCollaborationDocument(
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
    await waitFor(() =>
      workbenchState.readSession("anchor-session").text.includes("run-anchor")
    );

    expect(workbenchState.readSession("anchor-session").text).toBe([
      "first question",
      "assistant <!-- zion-assistant:id=run-anchor --> ",
      "user later question"
    ].join("\n"));
  });

  it("keeps text from tool-calling turns in the aggregate Run output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-collaboration-final-"));
    const path = join(directory, "runtime.sqlite3");
    const workbenchState = new SqliteWorkbenchStateStore(path);
    workbenchState.createSession({
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
    await waitFor(() =>
      workbenchState.readSession("final-session").text.includes("final answer")
    );

    const text = workbenchState.readSession("final-session").text;
    expect(text).toContain("user latest question");
    expect(text).toContain("intermediate textfinal answer");
    expect(text.endsWith("\nuser ")).toBe(false);
  });
});
