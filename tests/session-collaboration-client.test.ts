import { EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createSessionCollaborationManager
} from "../extensions/dev.session-manager/collaboration-client.js";
import {
  pendingAssistantField,
  revealPendingAssistantInView
} from "../extensions/dev.session-manager/editor/pending-assistant-plugin.js";
import {
  setConversationViewportFollowing
} from "../src/chat/conversation-viewport.js";
import { createCollaborationDraftRecovery } from "../extensions/dev.session-manager/storage/collaboration-draft.js";
import { createChatAnnotationsApi } from "../src/chat/annotations";
import { hydrateRemoteAnnotations } from "../extensions/dev.session-manager/storage/remote.js";
import { localSessionAnnotationCopy } from "../packages/runtime-client/src/session-annotations.mjs";

function annotationHarness(values: Map<string, any>) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = {
    registerCommand(id: string, handler: (...args: any[]) => any) {
      handlers.set(id, handler);
      return { dispose: () => { handlers.delete(id); } };
    },
    executeCommand: vi.fn((id: string, ...args: any[]) => handlers.get(id)?.(...args))
  };
  const state = { get: (key: string) => values.get(key), set: (key: string, value: any) => values.set(key, value) };
  const events = eventBus();
  const api = createChatAnnotationsApi({ state, commands, events, getActivePanelId: () => "p1",
    getSessionMeta: sessionId => values.get(`sessions.meta.${sessionId}`) });
  return { commands, state, events, api };
}

function editorHarness(initialText = "hello") {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc: initialText }),
    parent
  });
  return {
    sessionId: "session-1",
    parent,
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

function eventBus() {
  const listeners = new Map<string, Set<(payload: any) => void>>();
  return {
    on(topic: string, listener: (payload: any) => void) {
      const topicListeners = listeners.get(topic) || new Set();
      topicListeners.add(listener);
      listeners.set(topic, topicListeners);
      return {
        dispose() {
          topicListeners.delete(listener);
        }
      };
    },
    emit(topic: string, payload: any) {
      for (const listener of listeners.get(topic) || []) listener(payload);
    }
  };
}

describe("Session collaboration client", () => {
  it("retires the captured transport reference when a durable projection takes over", async () => {
    const values = new Map<string, any>(), id = "tool:run:transport", reference = "b".repeat(64);
    const old = { id, kind: "tool", runId: "run", name: "Bash", expanded: true,
      args: { command: "same" }, result: null, detailRef: "a".repeat(64), detailSessionId: "session-1" };
    values.set("sessions.annotations.session-1", { tools: [old], thinking: [] });
    values.set("sessions.meta.session-1", { annotations: { tools: [old] } });
    values.set("sessions.pendingRestore.tools.session-1", [old]);
    const harness = annotationHarness(values), shared = new Y.Doc();
    const body = { args: { command: "exact" }, result: "durable body" };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options: any) =>
      new Response(JSON.stringify({ details: JSON.parse(options.body).cards.map(card => ({ ...card, body })) })));
    const manager = createSessionCollaborationManager({
      zion: harness, runtimeConfig: { mode: "runtime", baseUrl: "http://card-transport.test" },
      createDocument: () => shared,
      createProvider(options) {
        options.document.getMap("cards").set(id, { id, kind: "tool", runId: "run", name: "Bash",
          bodyRef: reference, bodySessionId: "session-1", bodyKind: "tools", bodyBytes: 123 });
        queueMicrotask(options.onSynced);
        return { awareness: new Awareness(options.document), destroy() {} };
      }
    });
    const editor = editorHarness(""), binding = manager.bindEditor(editor);
    try {
      await vi.waitFor(() => expect(harness.api.getSessionAnnotations("session-1").tools?.[0]).toMatchObject({
        ...body, bodyHydratedRef: reference
      }));
      const frozen = harness.api.getSessionAnnotations("session-1");
      expect(frozen.tools?.[0]).not.toHaveProperty("detailRef");
      expect(frozen.tools?.[0]).not.toHaveProperty("bodyRef");
      expect(await hydrateRemoteAnnotations(frozen)).toEqual(frozen);
      expect(localSessionAnnotationCopy(frozen).tools?.[0]).toMatchObject(body);
      expect(fetch).toHaveBeenCalledOnce();
      values.set("sessions.meta.session-1", { annotations: {
        tools: [{ ...old, detailRef: "c".repeat(64) }]
      } });
      expect(harness.api.getSessionAnnotations("session-1").tools?.[0].detailRef).toBe("c".repeat(64));
    } finally { fetch.mockRestore(); binding.dispose(); manager.dispose(); harness.api.dispose(); editor.dispose(); }
  });

  it.each([
    { kind: "tools", cardKind: "tool", oldBody: { args: { version: "A" }, result: "A" },
      body: { args: { version: "B", nullable: null }, result: { exact: "B", values: [] } } },
    { kind: "thinking", cardKind: "thinking", oldBody: { text: "A" }, body: { text: "" } }
  ])("restores $kind from the response after a mounted snapshot changes during hydration", async ({ kind, cardKind, oldBody, body }) => {
    const values = new Map<string, any>(), id = `${cardKind}:run:card`, reference = "b".repeat(64);
    values.set("sessions.annotations.session-1", { tools: [], thinking: [],
      [kind]: [{ id, kind: cardKind, runId: "run", ...oldBody, expanded: true, bodyHydratedRef: "a".repeat(64) }] });
    const harness = annotationHarness(values), shared = new Y.Doc();
    let respond!: (response: Response) => void;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => { respond = resolve; }));
    const manager = createSessionCollaborationManager({
      zion: { ...harness, panels: { list: () => [{ id: "p1", activeTabId: "session-1" }, { id: "p2", activeTabId: "session-1" }] } },
      runtimeConfig: { mode: "runtime", baseUrl: "http://card-snapshot.test" }, createDocument: () => shared,
      createProvider(options) {
        options.document.getMap("cards").set(id, { id, kind: cardKind, runId: "run", bodyRef: reference,
          bodySessionId: "session-1", bodyKind: kind, bodyBytes: 123 });
        queueMicrotask(options.onSynced);
        return { awareness: new Awareness(options.document), destroy() {} };
      }
    });
    const editor = editorHarness(""), binding = manager.bindEditor(editor);
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      harness.commands.executeCommand("zion.chatCards.updateSessionAnnotations", {
        sessionId: "session-1", updater: previous => ({ ...previous, [kind]: previous[kind].map(card => ({
          ...card, ...oldBody, expanded: true, from: 0, to: 0, action: "accepted"
        })) })
      });
      respond(new Response(JSON.stringify({ details: [{ kind, id, ref: reference, body }] })));
      await vi.waitFor(() => expect(values.get("sessions.annotations.session-1")[kind][0]).toMatchObject({
        ...body, bodyHydratedRef: reference, expanded: true, from: 0, to: 0, action: "accepted"
      }));
      for (const panelId of ["p1", "p2"]) expect(harness.commands.executeCommand).toHaveBeenCalledWith(
        "zion.chatCards.restoreSession", expect.objectContaining({ panelId, annotations: expect.objectContaining({
          [kind]: [expect.objectContaining({ ...body, bodyHydratedRef: reference })]
        }) }));
    } finally {
      fetch.mockRestore(); binding.dispose(); manager.dispose(); harness.api.dispose(); editor.dispose();
    }
  });

  it.each([true, false])("loads a reopened record without waiting for the disposed request (old first=$oldFirst)", async oldFirst => {
    const values = new Map<string, any>(), id = "tool:run:reopened";
    const references = ["a", "b", "c"].map(character => character.repeat(64));
    values.set("sessions.annotations.session-1", { tools: [{ id, kind: "tool", runId: "run", expanded: true }], thinking: [] });
    const harness = annotationHarness(values), documents: Y.Doc[] = [];
    const responders = new Map<string, (response: Response) => void>();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((_url, options: any) => {
      const [{ ref }] = JSON.parse(options.body).cards;
      return new Promise(resolve => { responders.set(ref, resolve); });
    });
    const card = ref => ({ id, kind: "tool", runId: "run", bodyRef: ref,
      bodySessionId: "session-1", bodyKind: "tools", bodyBytes: 123 });
    const reply = ref => responders.get(ref)!(new Response(JSON.stringify({
      details: [{ kind: "tools", id, ref, body: { args: { ref }, result: ref } }]
    })));
    const manager = createSessionCollaborationManager({
      zion: { ...harness, panels: { list: () => [{ id: "p1", activeTabId: "session-1" }] } },
      runtimeConfig: { mode: "runtime", baseUrl: "http://card-reopened.test" },
      createDocument() { const doc = new Y.Doc(); documents.push(doc); return doc; },
      createProvider(options) {
        options.document.getMap("cards").set(id, card(references[documents.length - 1]));
        queueMicrotask(options.onSynced);
        return { awareness: new Awareness(options.document), destroy() {} };
      }
    });
    const a = editorHarness(""), bindingA = manager.bindEditor(a);
    let bindingB: { dispose(): void } | undefined;
    const b = editorHarness("");
    try {
      await vi.waitFor(() => expect(responders.has(references[0])).toBe(true));
      bindingA.dispose();
      bindingB = manager.bindEditor(b);
      await vi.waitFor(() => expect(responders.has(references[1])).toBe(true));
      if (oldFirst) {
        reply(references[0]);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(values.get("sessions.annotations.session-1").tools[0].bodyRef).toBe(references[1]);
      }
      documents[1].getMap("cards").set(id, card(references[2]));
      // The replacement task owns scheduling until its response completes.
      expect(fetch).toHaveBeenCalledTimes(2);
      reply(references[1]);
      await vi.waitFor(() => expect(responders.has(references[2])).toBe(true));
      if (!oldFirst) {
        reply(references[0]);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      reply(references[2]);
      await vi.waitFor(() => expect(harness.api.getSessionAnnotations("session-1").tools?.[0]).toMatchObject({
        args: { ref: references[2] }, result: references[2], bodyHydratedRef: references[2], expanded: true
      }));
      expect(fetch).toHaveBeenCalledTimes(3);
      const restores = harness.commands.executeCommand.mock.calls.filter(([name]) => name === "zion.chatCards.restoreSession");
      expect(restores.at(-1)?.[1].annotations.tools[0].result).toBe(references[2]);
      expect(restores.some(([, options]) => options.annotations.tools[0]?.result === references[0])).toBe(false);
    } finally {
      for (const ref of references) responders.get(ref)?.(new Response(JSON.stringify({ details: [] })));
      bindingA.dispose(); bindingB?.dispose(); manager.dispose(); harness.api.dispose(); a.dispose(); b.dispose(); fetch.mockRestore();
    }
  });

  it("clears a hydrated reference when a complete inline body replaces it", async () => {
    const values = new Map<string, any>();
    const id = "tool:run:call";
    const previous = { id, kind: "tool", runId: "run", result: "A",
      args: { version: "A" }, bodyHydratedRef: "a".repeat(64), expanded: false };
    values.set("sessions.annotations.session-1", { tools: [previous], thinking: [] });
    const shared = new Y.Doc();
    const manager = createSessionCollaborationManager({
      zion: { commands: { executeCommand: vi.fn() }, state: {
        get: key => values.get(key), set: (key, value) => values.set(key, value)
      } }, clientId: "card-inline",
      runtimeConfig: { mode: "runtime", baseUrl: "http://card-inline.test" },
      createDocument: () => shared,
      createProvider(options) {
        queueMicrotask(() => options.onSynced());
        return { awareness: new Awareness(options.document), destroy() {} };
      }
    });
    const editor = editorHarness("");
    const binding = manager.bindEditor(editor);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      shared.getMap("cards").set(id, { id, kind: "tool", runId: "run", args: { version: "B" }, result: "B" });
      expect(values.get("sessions.annotations.session-1").tools[0]).not.toHaveProperty("bodyHydratedRef");
      shared.getMap("cards").set(id, { id, kind: "tool", runId: "run", bodyRef: "a".repeat(64),
        bodySessionId: "session-1", bodyKind: "tools", bodyBytes: 123 });
      expect(values.get("sessions.annotations.session-1").tools[0]).toMatchObject({ bodyRef: "a".repeat(64) });
      expect(values.get("sessions.annotations.session-1").tools[0]).not.toHaveProperty("result");
    } finally { binding.dispose(); manager.dispose(); editor.dispose(); }
  });

  it("preserves loaded body and preferences when the matching reference is replayed", async () => {
    const values = new Map<string, any>();
    const id = "tool:run:call", reference = "a".repeat(64);
    values.set("sessions.annotations.session-1", { tools: [{ id, kind: "tool", runId: "run",
      result: "complete", args: { nullable: null }, expanded: true, action: "accepted", bodyHydratedRef: reference,
      detailRef: "f".repeat(64), detailSessionId: "session-1" }], thinking: [] });
    const shared = new Y.Doc();
    const manager = createSessionCollaborationManager({
      zion: { commands: { executeCommand: vi.fn() }, state: {
        get: key => values.get(key), set: (key, value) => values.set(key, value)
      } }, clientId: "card-matching",
      runtimeConfig: { mode: "runtime", baseUrl: "http://card-matching.test" }, createDocument: () => shared,
      createProvider(options) {
        options.document.getMap("cards").set(id, { id, kind: "tool", runId: "run", bodyRef: reference,
          bodySessionId: "session-1", bodyKind: "tools", bodyBytes: 123 });
        queueMicrotask(() => options.onSynced());
        return { awareness: new Awareness(options.document), destroy() {} };
      }
    });
    const editor = editorHarness(""), binding = manager.bindEditor(editor);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(values.get("sessions.annotations.session-1").tools[0]).toMatchObject({
        result: "complete", args: { nullable: null }, expanded: true, action: "accepted", bodyHydratedRef: reference });
      expect(values.get("sessions.annotations.session-1").tools[0]).not.toHaveProperty("bodyRef");
      expect(values.get("sessions.annotations.session-1").tools[0]).not.toHaveProperty("detailRef");
    } finally { binding.dispose(); manager.dispose(); editor.dispose(); }
  });

  it("loads a changed expanded card and restores its exact body in every split panel", async () => {
    const values = new Map<string, any>();
    const id = "tool:run:call", reference = "b".repeat(64);
    values.set("sessions.annotations.session-1", { tools: [{ id, kind: "tool", runId: "run",
      result: "old", args: { version: "old" }, expanded: true, bodyHydratedRef: "a".repeat(64) }], thinking: [] });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options: any) => {
      const requests = JSON.parse(options.body).cards;
      expect(requests).toEqual([{ kind: "tools", id, ref: reference, storage: "body" }]);
      return new Response(JSON.stringify({ details: requests.map(request => ({ ...request,
        body: { args: { version: "new", count: 0, nullable: null }, result: { exact: "new", values: [] } } })) }));
    });
    const restore = vi.fn(), shared = new Y.Doc();
    const manager = createSessionCollaborationManager({
      zion: { panels: { list: () => [{ id: "p1", activeTabId: "session-1" }, { id: "p2", activeTabId: "session-1" }] },
        commands: { executeCommand: restore }, state: {
          get: key => values.get(key), set: (key, value) => values.set(key, value)
        } }, clientId: "card-expanded",
      runtimeConfig: { mode: "runtime", baseUrl: "http://card-expanded.test" }, createDocument: () => shared,
      createProvider(options) {
        options.document.getMap("cards").set(id, { id, kind: "tool", runId: "run", bodyRef: reference,
          bodySessionId: "session-1", bodyKind: "tools", bodyBytes: 123, ok: true });
        queueMicrotask(() => options.onSynced());
        return { awareness: new Awareness(options.document), destroy() {} };
      }
    });
    const a = editorHarness(""), b = editorHarness("");
    const bindingA = manager.bindEditor(a), bindingB = manager.bindEditor(b);
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(values.get("sessions.annotations.session-1").tools[0]).toMatchObject({
        args: { version: "new", count: 0, nullable: null }, result: { exact: "new", values: [] },
        expanded: true, bodyHydratedRef: reference }));
      for (const panelId of ["p1", "p2"]) expect(restore).toHaveBeenCalledWith("zion.chatCards.restoreSession",
        expect.objectContaining({ panelId, annotations: expect.objectContaining({
          tools: [expect.objectContaining({ result: { exact: "new", values: [] } })] }) }));
    } finally {
      fetch.mockRestore(); bindingA.dispose(); bindingB.dispose(); manager.dispose(); a.dispose(); b.dispose();
    }
  });

  it.each([
    { primary: "", alternativeSize: 40_000, large: true },
    { primary: "", alternativeSize: 20, large: false },
    { primary: "rejected", alternativeSize: 40_000, large: true },
    { primary: "", alternativeSize: 0, large: false }
  ])("loads reset recovery with primary '$primary' and $alternativeSize-unit alternative", async ({ primary, alternativeSize, large }) => {
    const key = `empty-recovery-${primary}-${alternativeSize}`;
    const data = new Map();
    const largeStore = {
      get: async (key: string) => structuredClone(data.get(key)),
      set: async (key: string, draft: any) => { data.set(key, structuredClone(draft)); },
      delete: async (key: string) => { data.delete(key); },
      exists: async () => data.size > 0
    };
    const draft = {
      baseline: "hello", text: primary, savedAt: 1, recoveryReason: "collaboration_document_reset",
      alternatives: alternativeSize ? [{ baseline: "hello", text: "r".repeat(alternativeSize), savedAt: 1 }] : []
    };
    const writer = createCollaborationDraftRecovery({ key, storage: localStorage, largeStore, snapshot: () => draft });
    let reader: ReturnType<typeof createCollaborationDraftRecovery> | undefined;
    try {
      writer.schedule(); await writer.flush(); writer.dispose();
      expect(data.size > 0).toBe(large);
      reader = createCollaborationDraftRecovery({ key, storage: localStorage, largeStore,
        snapshot: () => ({ baseline: "remote", text: "remote", savedAt: 2 }) });
      expect(await reader.load(primary)).toEqual(draft);
      expect(await reader.clear()).toBe(false);
      expect(await reader.load("remote")).toEqual(draft);
    } finally {
      writer.dispose(); reader?.dispose();
      localStorage.removeItem(key); localStorage.removeItem(`${key}:indexeddb`);
    }
  });

  it("stops replaying a rejected document and preserves the editor draft until reopening", async () => {
    const values = new Map();
    const shared = new Y.Doc();
    shared.getText("content").insert(0, "committed");
    const disconnect = vi.fn();
    let callbacks: any;
    const manager = createSessionCollaborationManager({
      zion: { events: eventBus(), state: {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value)
      } },
      clientId: "reset-client",
      runtimeConfig: { mode: "runtime", enabled: true, baseUrl: "http://runtime.test" },
      createDocument: () => shared,
      createProvider(options: any) {
        callbacks = options;
        queueMicrotask(() => options.onSynced());
        return { awareness: new Awareness(options.document), unsyncedChanges: 1,
          disconnect, destroy() {} };
      }
    });
    const editor = editorHarness("committed");
    const binding = manager.bindEditor(editor);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      editor.getView().dispatch({ changes: { from: 9, insert: " local pending" } });
      const draftText = editor.getValue();
      callbacks.onClose?.({ event: { reason: "collaboration_document_reset" } });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(disconnect).toHaveBeenCalledOnce();
      expect(values.get("sessions.collaboration.session-1")).toMatchObject({
        connected: false, synced: false, resetRequired: true
      });
      expect(editor.getValue()).toBe(draftText);
      expect(editor.getView().state.readOnly).toBe(true);
      expect(editor.getView().dom.dataset.zionCollaborationBound).toBeUndefined();
      expect(values.get("sessions.collaborationDraft.session-1").text).toBe(draftText);
      callbacks.onUnsyncedChanges({ number: 0 });
      callbacks.onSynced();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(values.get("sessions.collaborationDraft.session-1").text).toBe(draftText);
      expect(values.get("sessions.collaboration.session-1").synced).toBe(false);
    } finally { binding.dispose(); manager.dispose(); editor.dispose(); }
  });

  it("keeps an ordinary network disconnect eligible for reconnect", async () => {
    const shared = new Y.Doc();
    const disconnect = vi.fn();
    let callbacks: any;
    const manager = createSessionCollaborationManager({
      zion: { events: eventBus(), state: { get() {}, set() {} } },
      clientId: "network-client",
      runtimeConfig: { mode: "runtime", enabled: true, baseUrl: "http://runtime.test" },
      createDocument: () => shared,
      createProvider(options: any) {
        callbacks = options;
        queueMicrotask(() => options.onSynced());
        return { awareness: new Awareness(options.document), disconnect, destroy() {} };
      }
    });
    const editor = editorHarness("");
    const binding = manager.bindEditor(editor);
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      callbacks.onClose?.({ event: { code: 1006, reason: "" } });
      expect(disconnect).not.toHaveBeenCalled();
    } finally { binding.dispose(); manager.dispose(); editor.dispose(); }
  });

  it("uses a fresh document when reopening after rejection and does not replay the retained draft", async () => {
    const values = new Map(), created: Y.Doc[] = [], callbacks: any[] = [];
    const manager = createSessionCollaborationManager({
      zion: { events: eventBus(), state: {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value)
      } },
      clientId: "reopen-client",
      runtimeConfig: { mode: "runtime", enabled: true, baseUrl: "http://reopen.test" },
      createDocument() {
        const document = new Y.Doc();
        document.getText("content").insert(0, "committed");
        created.push(document);
        return document;
      },
      createProvider(options: any) {
        callbacks.push(options);
        queueMicrotask(() => options.onSynced());
        return { awareness: new Awareness(options.document), disconnect() {}, destroy() {} };
      }
    });
    const first = editorHarness("committed");
    const firstBinding = manager.bindEditor(first);
    let reopened, reopenedBinding;
    try {
      await new Promise(resolve => setTimeout(resolve, 0));
      first.getView().dispatch({ changes: { from: 9, insert: " rejected" } });
      callbacks[0].onClose({ event: { reason: "collaboration_document_reset" } });
      await new Promise(resolve => setTimeout(resolve, 0));
      reopened = editorHarness("committed rejected");
      reopenedBinding = manager.bindEditor(reopened);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(created).toHaveLength(2);
      expect(reopened.getValue()).not.toContain("rejected");
      expect(created[1].getText("content").toString()).not.toContain("rejected");
      expect(values.get("sessions.collaborationDraft.session-1").text).toContain("rejected");
      expect(values.get("sessions.collaboration.session-1")).toMatchObject({
        connected: true, synced: true, resetRequired: false
      });
      const draftKey = Object.keys(localStorage).find(key =>
        key.startsWith("zion.collaboration.draft:http%3A%2F%2Freopen.test:") && !key.endsWith(":indexeddb"))!;
      expect(JSON.parse(localStorage.getItem(draftKey) || "null")?.text).toBe("committed rejected");
      callbacks[1].onUnsyncedChanges({ number: 0 });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(JSON.parse(localStorage.getItem(draftKey) || "null")?.text).toBe("committed rejected");
      expect(values.get("sessions.collaborationDraft.session-1")?.text).toBe("committed rejected");
      reopened.getView().dispatch({ changes: { from: 9, insert: " accepted" } });
      expect(created[1].getText("content").toString()).toContain("accepted");
    } finally {
      firstBinding.dispose(); reopenedBinding?.dispose(); manager.dispose();
      first.dispose(); reopened?.dispose();
    }
  });

  it.each([false, true])("preserves distinct split-view drafts on reset (clean first: %s)", async cleanFirst => {
    const values = new Map();
    let callbacks: any;
    const shared = new Y.Doc();
    shared.getText("content").insert(0, "remote");
    const manager = createSessionCollaborationManager({
      zion: { events: eventBus(), state: {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value)
      } },
      clientId: "split-reset",
      runtimeConfig: { mode: "runtime", baseUrl: `http://split-reset-${cleanFirst}.test` },
      createDocument: () => shared,
      createProvider(options: any) {
        callbacks = options;
        return { awareness: new Awareness(options.document), unsyncedChanges: 1,
          disconnect() {}, destroy() {} };
      }
    });
    const conflict = editorHarness("hello"), clean = editorHarness("hello");
    const editors = cleanFirst ? [clean, conflict] : [conflict, clean];
    const bindings = editors.map(editor => manager.bindEditor(editor));
    try {
      conflict.getView().dispatch({ changes: { from: 0, to: 5, insert: "local unsaved" } });
      callbacks.onSynced();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(conflict.getValue()).toBe("local unsaved");
      expect(clean.getValue()).toBe("remote");
      conflict.getView().dispatch({ changes: { from: conflict.getValue().length, insert: "!" } });
      window.dispatchEvent(new Event("pagehide"));
      await new Promise(resolve => setTimeout(resolve, 0));
      callbacks.onClose({ event: { reason: "collaboration_document_reset" } });
      window.dispatchEvent(new Event("pagehide"));
      await new Promise(resolve => setTimeout(resolve, 0));
      const draftKey = Object.keys(localStorage).find(key =>
        key.includes(`split-reset-${cleanFirst}.test`) && !key.endsWith(":indexeddb"))!;
      const saved = JSON.parse(localStorage.getItem(draftKey) || "null");
      expect(saved?.text).toBe("local unsaved!");
      expect([saved?.text, ...(saved?.alternatives || []).map((draft: any) => draft.text)]).toContain("remote");
      expect(values.get("sessions.collaborationDraft.session-1")?.text).toBe("local unsaved!");
    } finally {
      bindings.forEach(binding => binding.dispose());
      manager.dispose(); conflict.dispose(); clean.dispose();
    }
  });

  it("retains rejected recovery across a full manager restart and new accepted editing", async () => {
    const values = new Map(), callbacks: any[] = [];
    const openManager = () => createSessionCollaborationManager({
      zion: { state: {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value)
      } },
      clientId: "hard-reload-reset",
      runtimeConfig: { mode: "runtime", baseUrl: "http://hard-reload-reset.test" },
      createProvider(options: any) {
        options.document.getText("content").insert(0, "committed");
        callbacks.push(options);
        const awareness = new Awareness(options.document);
        queueMicrotask(options.onSynced);
        return { awareness, unsyncedChanges: 0, disconnect() {}, destroy: () => awareness.destroy() };
      }
    });
    let manager = openManager(), editor = editorHarness("committed");
    let binding = manager.bindEditor(editor);
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
      await tick();
      editor.getView().dispatch({ changes: { from: 9, insert: " rejected" } });
      callbacks[0].onClose({ event: { reason: "collaboration_document_reset" } });
      await tick();
      binding.dispose(); manager.dispose(); editor.dispose();
      await tick();
      values.clear();
      manager = openManager(); editor = editorHarness("committed rejected");
      binding = manager.bindEditor(editor);
      await tick();
      expect(editor.getValue()).toBe("committed");
      callbacks[1].onUnsyncedChanges({ number: 0 });
      await tick();
      const draftKey = Object.keys(localStorage).find(key =>
        key.includes("hard-reload-reset.test") && !key.endsWith(":indexeddb"))!;
      expect(JSON.parse(localStorage.getItem(draftKey) || "null")?.text).toBe("committed rejected");
      expect(values.get("sessions.collaborationDraft.session-1")?.text).toBe("committed rejected");
      editor.getView().dispatch({ changes: { from: 9, insert: " accepted pending" } });
      window.dispatchEvent(new Event("pagehide"));
      await tick();
      const saved = JSON.parse(localStorage.getItem(draftKey) || "null");
      expect(saved.text).toBe("committed rejected");
      expect(saved.alternatives.map((copy: any) => copy.text)).toContain("committed accepted pending");
      expect(saved.recoveryReason).toBe("collaboration_document_reset");
    } finally { binding.dispose(); manager.dispose(); editor.dispose(); }
  });

  it("shows final-mode SSE in both views before Yjs and clears only after durable commit", async () => {
    const events = eventBus();
    const shared = new Y.Doc();
    const initial = "user hi\nassistant <!-- zion-assistant:id=r --> ";
    shared.getText("content").insert(0, initial);
    const manager = createSessionCollaborationManager({
      zion: { events, state: { get() {}, set() {} } },
      clientId: "preview-client",
      runtimeConfig: { mode: "runtime", enabled: true, baseUrl: "http://runtime.test" },
      createDocument: () => shared,
      createProvider(options: any) {
        queueMicrotask(() => options.onSynced());
        return { awareness: new Awareness(options.document), destroy() {} };
      }
    });
    const first = editorHarness(initial);
    const second = editorHarness(initial);
    const bindings = [manager.bindEditor(first), manager.bindEditor(second)];
    await new Promise(resolve => setTimeout(resolve, 0));
    const payload = {
      sessionId: "session-1", runId: "r", assistantBlockId: "r",
      backend: "runtime", documentWriter: false, documentProjectionMode: "final",
      projectionSequence: 2, token: "**streamed** answer"
    };
    events.emit("chat/token", payload);
    for (const editor of [first, second]) {
      expect(editor.getValue()).toBe(initial);
      expect(editor.parent.querySelector(".zion-pending-assistant-output strong")?.textContent).toBe("streamed");
    }
    shared.getMap("runProjection").set("r", { mode: "final", lastSequence: 2, committed: false });
    events.emit("chat/runFinished", payload);
    expect(first.parent.querySelector(".zion-pending-assistant-output")).not.toBeNull();
    shared.transact(() => {
      shared.getText("content").insert(shared.getText("content").length, payload.token);
      shared.getMap("runProjection").set("r", { mode: "final", lastSequence: 3, committed: true });
    });
    for (const editor of [first, second]) {
      expect(editor.getValue()).toBe(initial + payload.token);
      expect(editor.parent.querySelector(".zion-pending-assistant-output")).toBeNull();
    }
    bindings.forEach(binding => binding.dispose());
    manager.dispose(); first.dispose(); second.dispose();
  });

  it("keeps an already visible pending target stationary during initial reveal", () => {
    const editor = editorHarness("user question");
    const scrollDOM = editor.getView().scrollDOM;
    const pending = document.createElement("span");
    pending.className = "zion-pending-assistant-output";
    pending.dataset.runId = "run-visible";
    const tail = document.createElement("span");
    tail.className = "zion-pending-assistant-tail";
    pending.appendChild(tail);
    editor.getView().dom.appendChild(pending);
    scrollDOM.scrollTop = 120;
    Object.defineProperty(scrollDOM, "scrollHeight", {
      configurable: true,
      value: 1_000
    });
    Object.defineProperty(scrollDOM, "clientHeight", {
      configurable: true,
      value: 200
    });
    Object.defineProperty(scrollDOM, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0, bottom: 200 })
    });
    Object.defineProperty(tail, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 180, bottom: 195 })
    });

    expect(revealPendingAssistantInView(editor.getView(), {
      runId: "run-visible",
      preserveVisible: true
    })).toBe(true);
    expect(scrollDOM.scrollTop).toBe(120);

    editor.dispose();
  });

  it("does not scroll on initial reveal when the pending tail reports a collapsed origin rect", () => {
    const editor = editorHarness("user question");
    const scrollDOM = editor.getView().scrollDOM;
    const pending = document.createElement("span");
    pending.className = "zion-pending-assistant-output";
    pending.dataset.runId = "run-collapsed";
    const tail = document.createElement("span");
    tail.className = "zion-pending-assistant-tail";
    pending.appendChild(tail);
    editor.getView().dom.appendChild(pending);
    scrollDOM.scrollTop = 120;
    Object.defineProperty(scrollDOM, "scrollHeight", {
      configurable: true,
      value: 1_000
    });
    Object.defineProperty(scrollDOM, "clientHeight", {
      configurable: true,
      value: 200
    });
    Object.defineProperty(scrollDOM, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 64, bottom: 264 })
    });
    Object.defineProperty(tail, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 })
    });

    expect(revealPendingAssistantInView(editor.getView(), {
      runId: "run-collapsed",
      preserveVisible: true
    })).toBe(true);
    expect(scrollDOM.scrollTop).toBe(120);

    editor.dispose();
  });

  it("does not open browser IndexedDB for Runtime-owned documents", async () => {
    const originalIndexedDb = globalThis.indexedDB;
    const indexedDb = { open: vi.fn() };
    vi.stubGlobal("indexedDB", indexedDb);
    const manager = createSessionCollaborationManager({
      zion: {
        state: {
          get() {},
          set() {}
        }
      },
      clientId: "workbench-a",
      runtimeConfig: {
        mode: "runtime",
        enabled: true,
        baseUrl: "http://127.0.0.1:8766"
      },
      createProvider(options: any) {
        queueMicrotask(() => options.onSynced());
        return {
          awareness: new Awareness(options.document),
          destroy() {}
        };
      }
    });
    const editor = editorHarness();
    const binding = manager.bindEditor(editor);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(indexedDb.open).not.toHaveBeenCalled();
    } finally {
      binding.dispose();
      manager.dispose();
      editor.dispose();
      vi.stubGlobal("indexedDB", originalIndexedDb);
    }
  });

  it("binds an editor whose Session id is assigned immediately after attach", async () => {
    const createProvider = vi.fn((options: any) => {
      queueMicrotask(() => options.onSynced());
      return {
        awareness: new Awareness(options.document),
        destroy() {}
      };
    });
    const manager = createSessionCollaborationManager({
      zion: {
        state: {
          get() {},
          set() {}
        }
      },
      clientId: "workbench-a",
      runtimeConfig: {
        mode: "runtime",
        enabled: true,
        baseUrl: "http://127.0.0.1:8766"
      },
      createProvider,
      createPersistence() {
        return {
          whenSynced: Promise.resolve(),
          destroy() {}
        };
      }
    });
    const editor = editorHarness();
    editor.sessionId = "";
    const binding = manager.bindEditor(editor);
    editor.sessionId = "session-late";
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ name: "session-late" })
    );

    binding.dispose();
    manager.dispose();
    editor.dispose();
  });

  it("does not bind editors that own their persistence", () => {
    const createProvider = vi.fn();
    const manager = createSessionCollaborationManager({
      zion: {
        state: {
          get() {},
          set() {}
        }
      },
      clientId: "workbench-a",
      runtimeConfig: {
        mode: "runtime",
        enabled: true,
        baseUrl: "http://127.0.0.1:8766"
      },
      createProvider
    });
    const editor = editorHarness("comment body");
    editor.sessionId = "comment:thread-1";
    editor.getView().dom.dataset.zionSessionPersistence = "skip";
    const binding = manager.bindEditor(editor);

    expect(createProvider).not.toHaveBeenCalled();
    expect(manager.isSynced("comment:thread-1")).toBe(false);

    binding.dispose();
    manager.dispose();
    editor.dispose();
  });

  it("does not claim document ownership before collaboration hydration", async () => {
    vi.useFakeTimers();
    const manager = createSessionCollaborationManager({
      zion: {
        state: {
          get() {},
          set() {}
        }
      },
      clientId: "workbench-a",
      runtimeConfig: {
        mode: "runtime",
        enabled: true,
        baseUrl: "http://127.0.0.1:8766"
      },
      createProvider(options: any) {
        return {
          awareness: new Awareness(options.document),
          destroy() {}
        };
      },
      createPersistence() {
        return {
          whenSynced: new Promise(() => {}),
          destroy() {}
        };
      }
    });
    const editor = editorHarness("");
    const binding = manager.bindEditor(editor);
    try {
      expect(editor.getView().dom.dataset.zionCollaborationBound)
        .toBeUndefined();

      editor.setValue("snapshot fallback");
      await vi.advanceTimersByTimeAsync(5_001);

      expect(editor.getValue()).toBe("snapshot fallback");
      expect(editor.getView().dom.dataset.zionCollaborationBound)
        .toBeUndefined();
    } finally {
      binding.dispose();
      manager.dispose();
      editor.dispose();
      vi.useRealTimers();
    }
  });

  it("renders pending output before the collaboration provider is synced", () => {
    const events = eventBus();
    const neverSynced = new Promise(() => {});
    const manager = createSessionCollaborationManager({
      zion: {
        events,
        state: {
          get() {},
          set() {}
        }
      },
      clientId: "workbench-a",
      runtimeConfig: {
        mode: "runtime",
        enabled: true,
        baseUrl: "http://127.0.0.1:8766"
      },
      createProvider(options: any) {
        return {
          awareness: new Awareness(options.document),
          destroy() {}
        };
      },
      createPersistence() {
        return {
          whenSynced: neverSynced,
          destroy() {}
        };
      }
    });
    const editor = editorHarness("user current question");
    const binding = manager.bindEditor(editor);

    events.emit("chat/token", {
      sessionId: "session-1",
      runId: "run-pending",
      assistantBlockId: "run-pending",
      backend: "runtime",
      token: "## visible before sync\n\n**bold**"
    });

    expect(
      editor.parent.querySelector(".zion-pending-markdown-heading")?.textContent
    ).toBe("visible before sync");
    expect(
      editor.parent.querySelector(".zion-pending-assistant-markdown strong")
        ?.textContent
    ).toBe("bold");
    expect(editor.getValue()).toBe("user current question");

    binding.dispose();
    manager.dispose();
    editor.dispose();
  });

  it("shows only the assistant header during preparation without writing the shared document", () => {
    const events = eventBus();
    const manager = createSessionCollaborationManager({
      zion: { events, state: { get() {}, set() {} } },
      clientId: "workbench-a",
      runtimeConfig: { mode: "runtime", enabled: true, baseUrl: "http://127.0.0.1:8766" },
      createProvider(options: any) {
        return { awareness: new Awareness(options.document), destroy() {} };
      }
    });
    const editor = editorHarness("user question");
    const binding = manager.bindEditor(editor);
    try {
      events.emit("chat/preparing", {
        sessionId: "session-1", submissionId: "pending-1",
        status: "assistant preparing", answerAnchorPos: 13
      });
      const header = editor.parent.querySelector(".zion-submitted-assistant");
      expect(header?.textContent).toBe("assistant");
      expect(editor.parent.querySelector('[role="status"]')).toBeNull();
      expect(editor.getValue()).toBe("user question");
      events.emit("chat/preparing", {
        sessionId: "session-1", submissionId: "pending-1",
        assistantBlockId: "run-1", status: "waiting"
      });
      expect(editor.parent.querySelectorAll(".zion-submitted-assistant")).toHaveLength(1);
      expect(editor.parent.querySelector(".zion-submitted-assistant")).toBe(header);
      expect(editor.parent.querySelector('[role="status"]')).toBeNull();
      events.emit("chat/prepared", { sessionId: "session-2", submissionId: "pending-1" });
      expect(editor.parent.querySelector(".zion-submitted-assistant")).toBe(header);
      events.emit("chat/prepared", { sessionId: "session-1", submissionId: "pending-1" });
      expect(editor.parent.querySelector(".zion-submitted-assistant")).toBeNull();
      expect(editor.getValue()).toBe("user question");
    } finally {
      binding.dispose();
      manager.dispose();
      editor.dispose();
    }
  });

  it("places pending output at the document end when the runtime omits its anchor", () => {
    const events = eventBus();
    const neverSynced = new Promise(() => {});
    const manager = createSessionCollaborationManager({
      zion: {
        events,
        state: {
          get() {},
          set() {}
        }
      },
      clientId: "workbench-a",
      runtimeConfig: {
        mode: "runtime",
        enabled: true,
        baseUrl: "http://127.0.0.1:8766"
      },
      createProvider(options: any) {
        return {
          awareness: new Awareness(options.document),
          destroy() {}
        };
      },
      createPersistence() {
        return {
          whenSynced: neverSynced,
          destroy() {}
        };
      }
    });
    const initial = [
      "assistant <!-- zion-assistant:id=run-pending --> old",
      "user current question",
      "assistant <!-- zion-assistant:id=run-pending --> "
    ].join("\n");
    const editor = editorHarness(initial);
    const binding = manager.bindEditor(editor);

    events.emit("chat/token", {
      sessionId: "session-1",
      runId: "run-pending",
      assistantBlockId: "run-pending",
      backend: "runtime",
      token: "streamed"
    });

    const decorations = editor.getView().state
      .field(pendingAssistantField)
      .decorations;
    expect(decorations.iter().from).toBe(initial.length);

    binding.dispose();
    manager.dispose();
    editor.dispose();
  });

  it("binds CodeMirror to a shared Y.Text after provider hydration", async () => {
    let sharedDocument: Y.Doc | null = null;
    let providerOptions: any = null;
    const providerDestroy = vi.fn();
    const persistenceDestroy = vi.fn();
    const zion = {
      state: {
        values: new Map<string, unknown>([
          ["sessions.doc.session-1", "hello"]
        ]),
        get(key: string) {
          return this.values.get(key);
        },
        set(key: string, value: unknown) {
          this.values.set(key, value);
        }
      }
    };
    const manager = createSessionCollaborationManager({
      zion,
      clientId: "workbench-a",
      runtimeConfig: {
        mode: "runtime",
        enabled: true,
        baseUrl: "http://127.0.0.1:8766"
      },
      createDocument() {
        sharedDocument = new Y.Doc();
        return sharedDocument;
      },
      createProvider(options: any) {
        providerOptions = options;
        options.document.getText("content").insert(0, "hello");
        const awareness = new Awareness(options.document);
        queueMicrotask(() => options.onSynced());
        return {
          awareness,
          destroy: providerDestroy
        };
      },
      createPersistence() {
        return {
          whenSynced: Promise.resolve(),
          destroy: persistenceDestroy
        };
      }
    });
    const editor = editorHarness();
    const binding = manager.bindEditor(editor);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sharedDocument?.getText("content").toString()).toBe("hello");
    expect(zion.state.get("sessions.collaboration.session-1"))
      .toMatchObject({ connected: true, synced: true });

    editor.getView().dispatch({
      changes: { from: 5, insert: " world" }
    });
    expect(sharedDocument?.getText("content").toString()).toBe("hello world");

    sharedDocument?.getText("content").insert(11, "!");
    expect(editor.getValue()).toBe("hello world!");
    const anchor = manager.createAnchor("session-1", 5, {
      before: "hello",
      after: " world!"
    });
    const relative = Y.decodeRelativePosition(
      Uint8Array.from(atob(anchor.encoded), (char) => char.charCodeAt(0))
    );
    expect(
      Y.createAbsolutePositionFromRelativePosition(relative, sharedDocument!)
        ?.index
    ).toBe(5);

    providerOptions?.onStatus({ status: "disconnected" });
    expect(zion.state.get("sessions.collaboration.session-1"))
      .toMatchObject({ connected: false, synced: false });

    binding.dispose();
    manager.dispose();
    editor.dispose();
    expect(providerDestroy).toHaveBeenCalledTimes(1);
    expect(persistenceDestroy).toHaveBeenCalledTimes(1);
  });

  it("keeps an authoritative empty shared document empty after hydration", async () => {
    let sharedDocument: Y.Doc | null = null;
    const values = new Map<string, unknown>([
      ["sessions.doc.session-1", "stale local snapshot"]
    ]);
    const manager = createSessionCollaborationManager({
      zion: {
        state: {
          get(key: string) {
            return values.get(key);
          },
          set(key: string, value: unknown) {
            values.set(key, value);
          }
        }
      },
      clientId: "workbench-a",
      runtimeConfig: {
        mode: "runtime",
        enabled: true,
        baseUrl: "http://127.0.0.1:8766"
      },
      createDocument() {
        sharedDocument = new Y.Doc();
        return sharedDocument;
      },
      createProvider(options: any) {
        queueMicrotask(() => options.onSynced());
        return {
          awareness: new Awareness(options.document),
          destroy() {}
        };
      }
    });
    const editor = editorHarness("stale local snapshot");
    const binding = manager.bindEditor(editor);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sharedDocument?.getText("content").toString()).toBe("");
    expect(editor.getValue()).toBe("");
    expect(values.get("sessions.doc.session-1")).toBe("");

    binding.dispose();
    manager.dispose();
    editor.dispose();
  });

  it.each([
    { baseline: "", remote: "", insert: "new question", expected: "new question", late: false },
    { baseline: "hello", remote: "remote hello", insert: "!", expected: "remote hello!", late: true },
    { baseline: "stale", remote: "", insert: "!", expected: "!", late: false }
  ])("replays only new input when syncing $baseline (late=$late)", async ({ baseline, remote, insert, expected, late }) => {
    let sync: () => void = () => {};
    let shared: Y.Doc;
    const manager = createSessionCollaborationManager({
      zion: { state: { get() {}, set() {} } },
      runtimeConfig: { mode: "runtime", baseUrl: "http://127.0.0.1:8766" },
      syncTimeoutMs: 1,
      createProvider(options: any) {
        shared = options.document;
        sync = options.onSynced;
        return { awareness: new Awareness(shared), destroy() {} };
      }
    });
    const editor = editorHarness(baseline);
    const binding = manager.bindEditor(editor);
    expect(editor.getView().state.facet(EditorView.editable)).toBe(true);
    editor.getView().dispatch({ changes: { from: baseline.length, insert } });
    if (late) await new Promise(resolve => setTimeout(resolve, 5));
    if (remote) shared!.getText("content").insert(0, remote);
    sync();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(shared!.getText("content").toString()).toBe(expected);
    expect(editor.getValue()).toBe(expected);
    expect(editor.getView().dom.dataset.zionCollaborationBound).toBe("true");
    binding.dispose();
    manager.dispose();
    editor.dispose();
  });

  it("preserves an overlapping local edit as a draft without replacing the server document", async () => {
    let sync: () => void = () => {};
    let shared: Y.Doc;
    const values = new Map();
    const manager = createSessionCollaborationManager({
      zion: { state: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value) } },
      runtimeConfig: { mode: "runtime", baseUrl: "http://127.0.0.1:8766" },
      createProvider(options: any) {
        shared = options.document;
        sync = options.onSynced;
        return { awareness: new Awareness(shared), destroy() {} };
      }
    });
    const editor = editorHarness("hello");
    const binding = manager.bindEditor(editor);
    editor.getView().dispatch({ changes: { from: 0, to: 5, insert: "local" } });
    shared!.getText("content").insert(0, "remote");
    sync();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(editor.getValue()).toBe("local");
    expect(shared!.getText("content").toString()).toBe("remote");
    expect(values.get("sessions.collaborationDraft.session-1").text).toBe("local");
    binding.dispose();
    manager.dispose();
    editor.dispose();
  });
  it("does not replay the same pre-sync split-view edit twice", async () => {
    let sync: () => void = () => {};
    let shared: Y.Doc;
    const manager = createSessionCollaborationManager({
      zion: { state: { get() {}, set() {} } },
      runtimeConfig: { mode: "runtime", baseUrl: "http://127.0.0.1:8766" },
      createProvider(options: any) {
        shared = options.document;
        sync = options.onSynced;
        return { awareness: new Awareness(shared), destroy() {} };
      }
    });
    const a = editorHarness("");
    const b = editorHarness("");
    const ba = manager.bindEditor(a);
    const bb = manager.bindEditor(b);
    a.getView().dispatch({ changes: { from: 0, insert: "question" } });
    b.getView().dispatch({ changes: { from: 0, insert: "question" }, annotations: Transaction.userEvent.of("zion.sessionSync") });
    sync();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(shared!.getText("content").toString()).toBe("question");
    expect(a.getValue()).toBe("question");
    expect(b.getValue()).toBe("question");
    ba.dispose(); bb.dispose(); manager.dispose(); a.dispose(); b.dispose();
  });
  it("blocks a session flush while one split view retains an overlapping draft", async () => {
    let sync: () => void = () => {};
    let shared: Y.Doc;
    const values = new Map();
    const manager = createSessionCollaborationManager({
      zion: { state: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value) } },
      runtimeConfig: { mode: "runtime", baseUrl: "http://127.0.0.1:8766" },
      createProvider(options: any) {
        shared = options.document;
        sync = options.onSynced;
        return { awareness: new Awareness(shared), destroy() {} };
      }
    });
    const a = editorHarness("hello");
    const b = editorHarness("hello");
    const ba = manager.bindEditor(a);
    const bb = manager.bindEditor(b);
    b.getView().dispatch({ changes: { from: 0, to: 5, insert: "local" } });
    shared!.getText("content").insert(0, "remote");
    sync();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(a.getValue()).toBe("remote");
    expect(b.getValue()).toBe("local");
    expect(manager.isSynced("session-1")).toBe(false);
    expect(await manager.flush({ sessionId: "session-1", timeoutMs: 1 })).toBe(false);
    bb.dispose();
    expect(await manager.flush({ sessionId: "session-1", timeoutMs: 1 })).toBe(true);
    ba.dispose(); manager.dispose(); a.dispose(); b.dispose();
  });

  it("retains offline edits until acknowledgement and does not save remote projections as drafts", async () => {
    localStorage.clear();
    let options: any;
    let provider: any;
    const manager = createSessionCollaborationManager({
      zion: { state: { get() {}, set() {} } },
      clientId: "draft-ack",
      runtimeConfig: { mode: "runtime", baseUrl: "http://127.0.0.1:8766" },
      createProvider(value: any) {
        options = value;
        value.document.getText("content").insert(0, "hello");
        queueMicrotask(value.onSynced);
        provider = { awareness: new Awareness(value.document), unsyncedChanges: 0, destroy() {} };
        return provider;
      }
    });
    const editor = editorHarness("hello");
    const binding = manager.bindEditor(editor);
    await new Promise(resolve => setTimeout(resolve, 0));
    options.onStatus({ status: "disconnected" });
    provider.unsyncedChanges = 1;
    editor.getView().dispatch({ changes: { from: 5, insert: "!" } });
    const keys = () => Object.keys(localStorage).filter(key => key.startsWith("zion.collaboration.draft:"));
    // Recovery captures the document once per batch instead of writing on each edit.
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(keys()).toHaveLength(1);
    options.onUnsyncedChanges({ number: 0 });
    await Promise.resolve();
    expect(keys()).toHaveLength(1);
    options.onSynced();
    provider.unsyncedChanges = 0;
    options.onUnsyncedChanges({ number: 0 });
    await vi.waitFor(() => expect(keys()).toHaveLength(0));
    options.document.getText("content").insert(0, "remote ");
    expect(keys()).toHaveLength(0);
    binding.dispose(); manager.dispose(); editor.dispose();
  });

  it("renders durable assistant output once without mutating the Yjs document from token events", async () => {
    let sharedDocument: Y.Doc | null = null;
    const events = eventBus();
    const initial = "user hi\nassistant <!-- zion-assistant:id=run-1 --> ";
    const zion = {
      events,
      state: {
        values: new Map<string, unknown>([
          ["sessions.doc.session-1", initial]
        ]),
        get(key: string) {
          return this.values.get(key);
        },
        set(key: string, value: unknown) {
          this.values.set(key, value);
        }
      }
    };
    const manager = createSessionCollaborationManager({
      zion,
      clientId: "workbench-a",
      runtimeConfig: {
        mode: "runtime",
        enabled: true,
        baseUrl: "http://127.0.0.1:8766"
      },
      createDocument() {
        sharedDocument = new Y.Doc();
        return sharedDocument;
      },
      createProvider(options: any) {
        options.document.getText("content").insert(0, initial);
        const awareness = new Awareness(options.document);
        queueMicrotask(() => options.onSynced());
        return {
          awareness,
          destroy() {}
        };
      },
      createPersistence() {
        return {
          whenSynced: Promise.resolve(),
          destroy() {}
        };
      }
    });
    const editor = editorHarness(initial);
    const binding = manager.bindEditor(editor);
    await new Promise((resolve) => setTimeout(resolve, 0));

    events.emit("chat/token", {
      sessionId: "session-1",
      runId: "run-1",
      assistantBlockId: "run-1",
      backend: "runtime",
      documentWriter: false,
      projectionSequence: 7,
      token: "streamed"
    });

    expect(editor.getValue()).toBe(initial);
    expect(sharedDocument?.getText("content").toString()).toBe(initial);
    expect(
      editor.parent.querySelector(".zion-pending-assistant-output")?.textContent
    ).toBeUndefined();

    sharedDocument?.getText("content").insert(
      sharedDocument.getText("content").length,
      "streamed"
    );
    sharedDocument?.getMap("runProjection").set("run-1", {
      lastSequence: 7
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(editor.getValue()).toBe(`${initial}streamed`);
    expect(
      editor.parent.querySelector(".zion-pending-assistant-output")
    ).toBeNull();
    expect(
      Number(zion.state.get("chat.followSuppressUntil.session-1"))
    ).toBeGreaterThan(0);
    expect(
      Number((editor.getView().scrollDOM as any).__zionProgrammaticScrollUntil)
    ).toBeGreaterThan(0);

    (editor.getView().scrollDOM as any).__zionProgrammaticScrollUntil = 0;
    zion.state.set("chat.followSuppressUntil.session-1", 0);
    sharedDocument?.getText("content").insert(
      sharedDocument.getText("content").length,
      " more"
    );
    sharedDocument?.getMap("runProjection").set("run-1", {
      lastSequence: 8
    });
    events.emit("chat/token", {
      sessionId: "session-1",
      runId: "run-1",
      assistantBlockId: "run-1",
      backend: "runtime",
      documentWriter: false,
      projectionSequence: 8,
      token: " more"
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(editor.getValue()).toBe(`${initial}streamed more`);
    expect(
      editor.parent.querySelector(".zion-pending-assistant-output")
    ).toBeNull();
    expect(
      Number((editor.getView().scrollDOM as any).__zionProgrammaticScrollUntil)
    ).toBeGreaterThan(0);

    binding.dispose();
    manager.dispose();
    editor.dispose();
  });

  it("does not render duplicate tokens when durable projection is enabled", async () => {
    let sharedDocument: Y.Doc | null = null;
    const events = eventBus();
    const manager = createSessionCollaborationManager({
      zion: {
        events,
        state: {
          get() {},
          set() {}
        }
      },
      clientId: "workbench-a",
      runtimeConfig: {
        mode: "runtime",
        enabled: true,
        baseUrl: "http://127.0.0.1:8766"
      },
      createDocument() {
        sharedDocument = new Y.Doc();
        return sharedDocument;
      },
      createProvider(options: any) {
        queueMicrotask(() => options.onSynced());
        return {
          awareness: new Awareness(options.document),
          destroy() {}
        };
      }
    });
    const editor = editorHarness(
      "user hi\nassistant <!-- zion-assistant:id=run-1 --> "
    );
    const binding = manager.bindEditor(editor);
    await new Promise((resolve) => setTimeout(resolve, 0));

    events.emit("chat/token", {
      sessionId: "session-1",
      runId: "run-1",
      assistantBlockId: "run-1",
      backend: "runtime",
      documentWriter: false,
      projectionSequence: 7,
      token: "streamed text"
    });
    expect(
      editor.parent.querySelector(".zion-pending-assistant-output")?.textContent
    ).toBeUndefined();

    sharedDocument?.getMap("runProjection").set("run-1", {
      lastSequence: 7
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      editor.parent.querySelector(".zion-pending-assistant-output")
    ).toBeNull();

    binding.dispose();
    manager.dispose();
    editor.dispose();
  });

  it("hydrates projected card payloads from the shared document", async () => {
    const values = new Map<string, unknown>();
    const executeCommand = vi.fn();
    const manager = createSessionCollaborationManager({
      zion: {
        commands: { executeCommand },
        state: {
          get(key: string) {
            return values.get(key);
          },
          set(key: string, value: unknown) {
            values.set(key, value);
          }
        }
      },
      clientId: "workbench-a",
      runtimeConfig: {
        mode: "runtime",
        enabled: true,
        baseUrl: "http://127.0.0.1:8766"
      },
      createProvider(options: any) {
        options.document.getText("content").insert(0, [
          "user inspect",
          "assistant <!-- zion-assistant:id=run-1 --> ",
          "调用 read <!-- zion-tool:id=tool:run-1:call-1 -->"
        ].join("\n"));
        options.document.getMap("cards").set("tool:run-1:call-1", {
          id: "tool:run-1:call-1",
          kind: "tool",
          runId: "run-1",
          toolCallId: "call-1",
          name: "read",
          args: { path: "package.json" },
          result: "contents",
          ok: true,
          assistantBlockId: "run-1"
        });
        queueMicrotask(() => options.onSynced());
        return {
          awareness: new Awareness(options.document),
          destroy() {}
        };
      }
    });
    const editor = editorHarness("");
    const binding = manager.bindEditor(editor);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(values.get("sessions.annotations.session-1")).toMatchObject({
      tools: [
        expect.objectContaining({
          id: "tool:run-1:call-1",
          result: "contents",
          ok: true
        })
      ]
    });
    expect(executeCommand).toHaveBeenCalledWith(
      "zion.chatCards.restoreSession",
      expect.objectContaining({
        sessionId: "session-1"
      })
    );

    binding.dispose();
    manager.dispose();
    editor.dispose();
  });

  it("streams the owner output into Yjs with stable block Markdown", async () => {
    let sharedDocument: Y.Doc | null = null;
    const events = eventBus();
    const initial =
      "user hi\nassistant <!-- zion-assistant:id=run-owner --> ";
    const values = new Map<string, unknown>([
      ["chat.followLatest.session-1", true],
      ["sessions.doc.session-1", initial]
    ]);
    const manager = createSessionCollaborationManager({
      zion: {
        events,
        state: {
          get(key: string) {
            return values.get(key);
          },
          set(key: string, value: unknown) {
            values.set(key, value);
          }
        }
      },
      clientId: "workbench-owner",
      runtimeConfig: {
        mode: "runtime",
        enabled: true,
        baseUrl: "http://127.0.0.1:8766"
      },
      createDocument() {
        sharedDocument = new Y.Doc();
        return sharedDocument;
      },
      createProvider(options: any) {
        options.document.getText("content").insert(0, initial);
        queueMicrotask(() => options.onSynced());
        return {
          awareness: new Awareness(options.document),
          destroy() {}
        };
      },
      createPersistence() {
        return {
          whenSynced: Promise.resolve(),
          destroy() {}
        };
      }
    });
    const editor = editorHarness(initial);
    const binding = manager.bindEditor(editor);
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (const token of ["#", "# Heading"]) {
      events.emit("chat/token", {
        sessionId: "session-1",
        runId: "run-owner",
        assistantBlockId: "run-owner",
        backend: "runtime",
        documentWriter: true,
        token
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    const expected = `${initial}\n## Heading`;
    expect(sharedDocument?.getText("content").toString()).toBe(expected);
    expect(editor.getValue()).toBe(expected);
    expect(
      editor.parent.querySelector(".zion-pending-assistant-output")
    ).toBeNull();
    expect(
      Number(values.get("chat.followSuppressUntil.session-1"))
    ).toBeGreaterThan(0);
    expect(
      Number((editor.getView().scrollDOM as any).__zionProgrammaticScrollUntil)
    ).toBeGreaterThan(0);

    binding.dispose();
    manager.dispose();
    editor.dispose();
  });

  it("shares one provider while split views keep independent follow state", async () => {
    let sharedDocument: Y.Doc | null = null;
    const events = eventBus();
    const initial = "user hi\nassistant <!-- zion-assistant:id=run-1 --> ";
    const values = new Map<string, unknown>([
      ["chat.followLatest.session-1", true],
      ["sessions.doc.session-1", initial]
    ]);
    const createProvider = vi.fn((options: any) => {
      options.document.getText("content").insert(0, initial);
      queueMicrotask(() => options.onSynced());
      return {
        awareness: new Awareness(options.document),
        destroy() {}
      };
    });
    const manager = createSessionCollaborationManager({
      zion: {
        events,
        state: {
          get(key: string) {
            return values.get(key);
          },
          set(key: string, value: unknown) {
            values.set(key, value);
          }
        }
      },
      clientId: "workbench-a",
      runtimeConfig: {
        mode: "runtime",
        enabled: true,
        baseUrl: "http://127.0.0.1:8766"
      },
      createDocument() {
        sharedDocument = new Y.Doc();
        return sharedDocument;
      },
      createProvider,
      createPersistence() {
        return {
          whenSynced: Promise.resolve(),
          destroy() {}
        };
      }
    });
    const first = editorHarness(initial);
    const second = editorHarness(initial);
    const firstBinding = manager.bindEditor(first);
    const secondBinding = manager.bindEditor(second);
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (const editor of [first, second]) {
      Object.defineProperty(editor.getView().scrollDOM, "scrollHeight", {
        configurable: true,
        value: 800
      });
      Object.defineProperty(editor.getView().scrollDOM, "clientHeight", {
        configurable: true,
        value: 200
      });
    }
    events.emit("chat/token", {
      sessionId: "session-1",
      runId: "run-1",
      assistantBlockId: "run-1",
      backend: "runtime",
      token: "split "
    });
    for (const editor of [first, second]) {
      Object.defineProperty(editor.getView().scrollDOM, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ top: 0, bottom: 200 })
      });
      const pendingTail = editor.parent.querySelector(
        ".zion-pending-assistant-tail"
      );
      Object.defineProperty(pendingTail, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          top: 350 - editor.getView().scrollDOM.scrollTop,
          bottom: 500 - editor.getView().scrollDOM.scrollTop
        })
      });
    }
    for (const token of ["stream ", "output"]) {
      events.emit("chat/token", {
        sessionId: "session-1",
        runId: "run-1",
        assistantBlockId: "run-1",
        backend: "runtime",
        token
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(sharedDocument?.getText("content").toString()).toBe(initial);
    for (const editor of [first, second]) {
      expect(
        editor.parent.querySelector(".zion-pending-assistant-output")?.textContent
      ).toBe("split stream output");
      expect(editor.getView().scrollDOM.scrollTop).toBe(324);
    }

    events.emit("chat/token", {
      sessionId: "session-1",
      runId: "run-1",
      assistantBlockId: "run-1",
      backend: "runtime",
      token: " stable"
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const editor of [first, second]) {
      expect(editor.getView().scrollDOM.scrollTop).toBe(324);
    }

    setConversationViewportFollowing(first.getView(), false, {
      sessionId: "session-1",
      state: {
        get(key: string) {
          return values.get(key);
        },
        set(key: string, value: unknown) {
          values.set(key, value);
        }
      }
    });
    for (const editor of [first, second]) {
      editor.getView().scrollDOM.scrollTop = 0;
    }
    events.emit("chat/token", {
      sessionId: "session-1",
      runId: "run-1",
      assistantBlockId: "run-1",
      backend: "runtime",
      token: " detached"
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.getView().scrollDOM.scrollTop).toBe(0);
    expect(second.getView().scrollDOM.scrollTop).toBe(324);

    firstBinding.dispose();
    secondBinding.dispose();
    manager.dispose();
    first.dispose();
    second.dispose();
  });
});
