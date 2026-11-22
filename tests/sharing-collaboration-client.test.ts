import { EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionCollaborationManager } from "../extensions/dev.session-manager/collaboration-client.js";
import { registerSharedWorkbenchDocument } from "../src/runtime/workbench-space";
import { setAccountSession } from "../packages/account-ui/src/client";
afterEach(() => setAccountSession(null));
describe("original collaboration editor for account shares", () => {
  for (const role of ["viewer", "editor"] as const) it(`binds ${role} to the physical document with a qualified local editor`, async () => {
    setAccountSession({ user: { id: "receiver", name: "Receiver" }, space: { id: "mine" }, scopes: [] } as any);
    const doc = registerSharedWorkbenchDocument({ originSpaceId: "owner", documentId: `shared-${role}`, role, title: "Original", providerName: "Alice" });
    const parent = document.createElement("div"); document.body.appendChild(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc: "user shared" }) });
    const ydoc = new Y.Doc(); ydoc.getText("content").insert(0, "user shared");
    let providerOptions: any, awareness: Awareness;
    const emit = vi.fn();
    const manager = createSessionCollaborationManager({
      zion: { events: { emit, on: () => ({ dispose() {} }) }, state: { get() {}, set() {} } },
      clientId: "client", runtimeConfig: { mode: "runtime", enabled: true, baseUrl: "http://runtime.test" },
      createDocument: () => ydoc,
      createProvider(options: any) {
        providerOptions = options; queueMicrotask(() => {
          options.onAuthenticated({ scope: role === "viewer" ? "readonly" : "read-write" });
          options.onSynced();
        });
        awareness = new Awareness(options.document);
        return { awareness, destroy() { awareness.destroy(); } };
      }
    });
    const editor = { sessionId: doc.localId, getView: () => view, getValue: () => view.state.doc.toString(),
      setValue(text: string) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: Transaction.addToHistory.of(false) }); },
      addVisualExtension(extension: any) { view.dispatch({ effects: StateEffect.appendConfig.of(extension) }); } };
    const binding = manager.bindEditor(editor);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(providerOptions.name).toBe(doc.documentId);
    const url = new URL(providerOptions.url);
    expect(url.searchParams.get("space")).toBe("mine");
    expect(url.searchParams.get("content_space")).toBe("owner");
    expect(url.searchParams.get("content_document")).toBe(doc.documentId);
    expect(view.state.facet(EditorState.readOnly)).toBe(role === "viewer");
    expect(awareness!.getLocalState()?.user).toEqual({ id: "receiver", name: "Receiver" });
    emit.mockClear();
    providerOptions.onAwarenessChange({ states: [{ clientId: 1 }, { clientId: 2 }] });
    providerOptions.onAwarenessChange({ states: [{ clientId: 2, cursor: { x: 8 } }, { clientId: 1 }] });
    expect(emit).toHaveBeenCalledTimes(1);
    providerOptions.onAwarenessChange({ states: [{ clientId: 1 }] });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("collaboration/presenceChanged", { sessionId: doc.localId });
    if (role === "editor") {
      providerOptions.onAuthenticated({ scope: "readonly" });
      providerOptions.onSynced();
      expect(view.state.facet(EditorState.readOnly)).toBe(true);
      providerOptions.onAuthenticated({ scope: "read-write" });
      expect(view.state.facet(EditorState.readOnly)).toBe(false);
      providerOptions.onStatus({ status: "disconnected" });
      providerOptions.onStatus({ status: "connected" });
      providerOptions.onSynced();
      expect(view.state.facet(EditorState.readOnly)).toBe(true);
      providerOptions.onAuthenticated({ scope: "read-write" });
      providerOptions.onAuthenticationFailed({ reason: "share revoked" });
      providerOptions.onSynced();
      expect(view.state.facet(EditorState.readOnly)).toBe(true);
    } else expect(ydoc.getText("content").toString()).toBe("user shared");
    binding.dispose(); manager.dispose(); view.destroy(); parent.remove();
  });
});
