import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createRuntimeCollaborationService
} from "../apps/runtime/src/collaboration-service.mjs";
import { PostgresRunStore } from "../apps/runtime/src/postgres-run-store.mjs";
import {
  PostgresWorkbenchStateStore
} from "../apps/runtime/src/postgres-workbench-state-store.mjs";
import { createRuntimeServer } from "../apps/runtime/src/server.mjs";
import {
  createPostgresTestDatabase
} from "../apps/runtime/tests/helpers/postgres-test-database.mjs";
import { createAgentExecutor } from "../packages/runtime/src/index";
import {
  createSessionCollaborationManager
} from "../extensions/dev.session-manager/collaboration-client.js";

const resources: Array<any> = [];
let database: any;

beforeAll(async () => {
  database = await createPostgresTestDatabase("root_collaboration");
});

afterAll(async () => {
  await database.close();
});

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000) {
  const startedAt = Date.now();
  return new Promise<void>((resolve, reject) => {
    const poll = async () => {
      if (await predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Timed out waiting for collaborative editor state"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function editorHarness(sessionId: string, initialText = "") {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: initialText }),
    parent
  });
  return {
    sessionId,
    getView: () => view,
    getValue: () => view.state.doc.toString(),
    setValue(value: string) {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: String(value)
        },
        annotations: Transaction.addToHistory.of(false)
      });
    },
    addVisualExtension(extension: unknown) {
      view.dispatch({
        effects: StateEffect.appendConfig.of(extension as never)
      });
    },
    dispose() {
      view.destroy();
      parent.remove();
    }
  };
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    try { resource.bindingA?.dispose(); } catch {}
    try { resource.bindingB?.dispose(); } catch {}
    try { resource.managerA?.dispose(); } catch {}
    try { resource.managerB?.dispose(); } catch {}
    try { resource.editorA?.dispose(); } catch {}
    try { resource.editorB?.dispose(); } catch {}
    try { await resource.collaboration?.close(); } catch {}
    try { await resource.server?.close(); } catch {}
    try { await resource.workbenchState?.close(); } catch {}
    try { await resource.runs?.close(); } catch {}
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe("Workbench collaboration E2E", () => {
  it("synchronizes two CodeMirror editors through Runtime and PostgreSQL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zion-workbench-collab-e2e-"));
    const spaceId = database.nextSpaceId();
    const runs = new PostgresRunStore(database.pool, { spaceId });
    const workbenchState = new PostgresWorkbenchStateStore(database.pool, {
      spaceId
    });
    await workbenchState.createSession({
      id: "editor-session",
      title: "Editors",
      text: "shared"
    });
    const collaboration = createRuntimeCollaborationService({
      store: workbenchState,
      debounceMs: 25,
      maxDebounceMs: 50
    });
    const executor = createAgentExecutor({
      engine: {
        id: "editor-collaboration",
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
    const address = await server.start();
    const runtimeConfig = {
      mode: "runtime" as const,
      enabled: true,
      baseUrl: address.url
    };
    const providerFactory = (options: any) => new HocuspocusProvider({
      ...options,
      WebSocketPolyfill: WebSocket
    });
    const stateValues = new Map<string, unknown>();
    const zion = {
      state: {
        get: (key: string) => stateValues.get(key),
        set: (key: string, value: unknown) => stateValues.set(key, value)
      }
    };
    const managerA = createSessionCollaborationManager({
      zion,
      clientId: "editor-a",
      runtimeConfig,
      createProvider: providerFactory,
      createPersistence: () => ({
        whenSynced: Promise.resolve(),
        destroy() {}
      })
    });
    const managerB = createSessionCollaborationManager({
      zion,
      clientId: "editor-b",
      runtimeConfig,
      createProvider: providerFactory,
      createPersistence: () => ({
        whenSynced: Promise.resolve(),
        destroy() {}
      })
    });
    const editorA = editorHarness("editor-session");
    const editorB = editorHarness("editor-session");
    const bindingA = managerA.bindEditor(editorA);
    const bindingB = managerB.bindEditor(editorB);
    resources.push({
      directory,
      runs,
      workbenchState,
      collaboration,
      server,
      managerA,
      managerB,
      editorA,
      editorB,
      bindingA,
      bindingB
    });

    await waitFor(() =>
      editorA.getValue() === "shared"
      && editorB.getValue() === "shared"
    );
    editorA.getView().dispatch({
      changes: { from: 6, insert: " document" }
    });

    await waitFor(() => editorB.getValue() === "shared document");
    await waitFor(async () =>
      (await workbenchState.readSession("editor-session")).text === "shared document"
    );
    expect(editorA.getValue()).toBe("shared document");

    editorA.getView().dispatch({
      changes: { from: 0, insert: "A" }
    });
    editorB.getView().dispatch({
      changes: { from: 0, insert: "B" }
    });
    await waitFor(() =>
      editorA.getValue() === editorB.getValue()
      && editorA.getValue().includes("A")
      && editorA.getValue().includes("B")
    );
    await waitFor(async () =>
      (await workbenchState.readSession("editor-session")).text === editorA.getValue()
    );

    editorA.getView().dispatch({
      changes: { from: 0, to: editorA.getValue().length, insert: "" }
    });
    await waitFor(async () =>
      editorA.getValue() === ""
      && editorB.getValue() === ""
      && (await workbenchState.readSession("editor-session")).text === ""
    );
  });
});
