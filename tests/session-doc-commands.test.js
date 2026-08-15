import { describe, expect, it } from "vitest";
import {
  appendAssistantTokenToDoc,
  ensureAssistantBlockInDoc,
  registerSessionDocCommands
} from "../extensions/dev.session-manager/commands/doc-apis.js";
import { findAssistantBlockEndInText } from "../extensions/dev.session-manager/features/assistant-block.js";

function createCommands() {
  const handlers = new Map();
  return {
    registerCommand(id, fn) {
      handlers.set(id, fn);
      return { dispose() { handlers.delete(id); } };
    },
    executeCommand(id, arg) {
      return handlers.get(id)?.(arg);
    }
  };
}

describe("session doc commands", () => {
  it("appends assistant tokens into the active assistant block", () => {
    expect(appendAssistantTokenToDoc("user hi", "hello")).toBe("user hi\nassistant hello");
    expect(appendAssistantTokenToDoc("user hi\nassistant hello", " world")).toBe("user hi\nassistant hello world");
  });

  it("ensures and appends to the requested assistant block id", () => {
    let doc = "user old\nassistant <!-- zion-assistant:id=run-old --> old";
    doc = ensureAssistantBlockInDoc(doc, "run-new");
    doc = appendAssistantTokenToDoc(doc, "new", "run-new");

    expect(doc).toBe([
      "user old",
      "assistant <!-- zion-assistant:id=run-old --> old",
      "assistant <!-- zion-assistant:id=run-new --> new"
    ].join("\n"));
    expect(appendAssistantTokenToDoc(doc, "bad", "missing-run")).toBe(doc);
  });

  it("serializes background token and marker writes per session", async () => {
    const docs = new Map([["s1", "user hi\nassistant "]]);
    const metas = new Map([["s1", { id: "s1", title: "s1" }]]);
    const commands = createCommands();
    const zion = {
      commands,
      state: { get: () => null, set: () => {} },
      window: { activeEditor: null }
    };

    registerSessionDocCommands({
      zion,
      loadDoc: (id) => docs.get(id) || "",
      loadMeta: (id) => ({ ...(metas.get(id) || { id }) }),
      saveDoc: (id, text) => docs.set(id, text),
      saveMeta: (id, meta) => metas.set(id, meta),
      now: () => 1,
      hashString: (text) => `hash:${text}`,
      upsertIndexEntry: () => {},
      getIndex: () => [],
      refreshSessionsSidebarViewIfOpen: () => {}
    });

    const p1 = commands.executeCommand("zion.sessions.appendAssistantToken", { id: "s1", token: "before" });
    const p2 = commands.executeCommand("zion.sessions.transformDoc", {
      id: "s1",
      transform: (doc) => {
        const pos = findAssistantBlockEndInText(doc);
        return `${doc.slice(0, pos)}\n调用 read\n${doc.slice(pos)}`;
      }
    });
    const p3 = commands.executeCommand("zion.sessions.appendAssistantToken", { id: "s1", token: " after" });

    await Promise.all([p1, p2, p3]);

    expect(docs.get("s1")).toBe("user hi\nassistant before\n调用 read\n after");
  });

  it("does not reset visible panel editors when saving docs", async () => {
    const docs = new Map([["s1", "user hi\nassistant "]]);
    const metas = new Map([["s1", { id: "s1", title: "s1" }]]);
    const commands = createCommands();
    const setValues = [];
    const zion = {
      commands,
      state: { get: (key) => key === "sessions.currentId" ? "s1" : null, set: () => {} },
      panels: { list: () => [{ id: "panel-a", activeTabId: "s1", tabs: [{ id: "s1" }] }] },
      window: { activeEditor: { setValue: (...args) => setValues.push(args) } }
    };

    registerSessionDocCommands({
      zion,
      loadDoc: (id) => docs.get(id) || "",
      loadMeta: (id) => ({ ...(metas.get(id) || { id }) }),
      saveDoc: (id, text) => docs.set(id, text),
      saveMeta: (id, meta) => metas.set(id, meta),
      now: () => 1,
      hashString: (text) => `hash:${text}`,
      upsertIndexEntry: () => {},
      getIndex: () => [],
      refreshSessionsSidebarViewIfOpen: () => {}
    });

    await commands.executeCommand("zion.sessions.setDoc", { id: "s1", text: "user hi\nassistant updated\n调用 read\n" });

    expect(docs.get("s1")).toContain("updated");
    expect(setValues).toEqual([]);
  });

  it("updates session-bound editor slots when saving docs", async () => {
    const docs = new Map([["s1", "user hi"]]);
    const metas = new Map([["s1", { id: "s1", title: "s1" }]]);
    const commands = createCommands();
    const setValues = [];
    const slotEditor = { setValue: (...args) => setValues.push(args) };
    const zion = {
      commands,
      state: { get: () => null, set: () => {} },
      panels: {
        list: () => [{ id: "panel-a", activeTabId: "s2", tabs: [{ id: "s1" }, { id: "s2" }] }],
        listEditors: () => [{ panelId: "panel-a", sessionId: "s1", editorId: "editor-a", active: false }],
        getEditorBySession: (panelId, sessionId) => panelId === "panel-a" && sessionId === "s1" ? slotEditor : null
      },
      window: { activeEditor: null }
    };

    registerSessionDocCommands({
      zion,
      loadDoc: (id) => docs.get(id) || "",
      loadMeta: (id) => ({ ...(metas.get(id) || { id }) }),
      saveDoc: (id, text) => docs.set(id, text),
      saveMeta: (id, meta) => metas.set(id, meta),
      now: () => 1,
      hashString: (text) => `hash:${text}`,
      upsertIndexEntry: () => {},
      getIndex: () => [],
      refreshSessionsSidebarViewIfOpen: () => {}
    });

    await commands.executeCommand("zion.sessions.setDoc", { id: "s1", text: "user hi\nassistant updated" });

    expect(docs.get("s1")).toContain("updated");
    expect(setValues).toEqual([["user hi\nassistant updated", { source: "session-load" }]]);
  });

  it("does not update a stale active editor fallback for another session", async () => {
    const docs = new Map([["s1", "user hi"]]);
    const metas = new Map([["s1", { id: "s1", title: "s1" }]]);
    const commands = createCommands();
    const setValues = [];
    const zion = {
      commands,
      state: { get: (key) => key === "sessions.currentId" ? "s1" : null, set: () => {} },
      panels: { list: () => [] },
      window: {
        activeEditor: {
          getView: () => ({ dom: { getAttribute: (name) => name === "data-session-id" ? "s2" : null } }),
          setValue: (...args) => setValues.push(args)
        }
      }
    };

    registerSessionDocCommands({
      zion,
      loadDoc: (id) => docs.get(id) || "",
      loadMeta: (id) => ({ ...(metas.get(id) || { id }) }),
      saveDoc: (id, text) => docs.set(id, text),
      saveMeta: (id, meta) => metas.set(id, meta),
      now: () => 1,
      hashString: (text) => `hash:${text}`,
      upsertIndexEntry: () => {},
      getIndex: () => [],
      refreshSessionsSidebarViewIfOpen: () => {}
    });

    await commands.executeCommand("zion.sessions.setDoc", { id: "s1", text: "updated" });

    expect(docs.get("s1")).toBe("updated");
    expect(setValues).toEqual([]);
  });
});
