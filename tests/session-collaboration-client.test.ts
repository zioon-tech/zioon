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

  it("shows and clears preparation status without writing the shared document", () => {
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
      expect(editor.parent.querySelector('[role="status"]')?.textContent).toBe("…");
      expect(editor.parent.querySelector('[role="status"]')?.getAttribute("aria-label"))
        .toBe("assistant preparing");
      expect(editor.getValue()).toBe("user question");
      events.emit("chat/preparing", {
        sessionId: "session-1", submissionId: "pending-1",
        assistantBlockId: "run-1", status: "waiting"
      });
      expect(editor.parent.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(editor.parent.querySelector('[role="status"]')?.textContent).toBe("…");
      expect(editor.parent.querySelector('[role="status"]')?.getAttribute("aria-label"))
        .toBe("waiting");
      events.emit("chat/prepared", { sessionId: "session-2", submissionId: "pending-1" });
      expect(editor.parent.querySelector('[role="status"]')).not.toBeNull();
      events.emit("chat/prepared", { sessionId: "session-1", submissionId: "pending-1" });
      expect(editor.parent.querySelector('[role="status"]')).toBeNull();
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

  it("renders streamed assistant output without mutating the Yjs document", async () => {
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
      projectionSequence: 7,
      token: "streamed"
    });

    expect(editor.getValue()).toBe(initial);
    expect(sharedDocument?.getText("content").toString()).toBe(initial);
    expect(
      editor.parent.querySelector(".zion-pending-assistant-output")?.textContent
    ).toBe("streamed");

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

  it("clears pending output when the Runtime projection sequence is acknowledged", async () => {
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
    ).toBe("streamed text");

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
