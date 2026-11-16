import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { EditorCore } from "../src/editor/EditorCore";
import { attachEditor, detachEditor, setActiveEditorPanel } from "../src/ext/registry";
import { captureDocumentInput } from "../src/chat/document-input";
import { appendConversationDraft } from "../src/chat/conversation-draft.js";
import { beginConversationViewportFollow, setConversationViewportFollowing } from "../src/chat/conversation-viewport.js";
import { createSessionDocumentProjector } from "../extensions/dev.session-manager/session-document-projector.js";
import { createSessionCollaborationManager } from "../extensions/dev.session-manager/collaboration-client.js";
import { pendingAssistantField } from "../extensions/dev.session-manager/editor/pending-assistant-plugin.js";
import { projectRunEventToSession } from "../extensions/dev.langchain-chat/programmatic-session.js";
import { createChatAnnotationsApi } from "../src/chat/annotations";
import { installToolCallCards } from "../extensions/dev.tools/tool-calls.js";
import { installThinkingCards } from "../extensions/dev.thinking/thinking-cards.js";
import { roles } from "../extensions/dev.roles/roles.js";

vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
});

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function liveHarness(initial = "user hi\nassistant <!-- zion-assistant:id=r --> ", native = false, projection?: any) {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, initial);
  if (projection) doc.getMap("runProjection").set("r", projection);
  const listeners = new Map<string, Set<(payload: any) => void>>();
  const values = new Map();
  const zion = native ? window.zion : {
    state: { get: (key: string) => values.get(key), set: (key: string, value: any) => values.set(key, value) },
    events: {
      on(topic: string, listener: (payload: any) => void) {
        if (!listeners.has(topic)) listeners.set(topic, new Set());
        listeners.get(topic)!.add(listener);
        return { dispose: () => listeners.get(topic)!.delete(listener) };
      },
      emit(topic: string, payload: any) { for (const listener of listeners.get(topic) || []) listener(payload); }
    }
  };
  const editors: any[] = [];
  const panels = [0, 1].map(i => ({ id: `live-panel-${i}`, activeTabId: "live-session" }));
  if (native) {
    const previousPanels = window.zion.panels;
    window.zion.panels = {
      getActivePanelId: () => panels[0].id, list: () => panels,
      getEditor: (id: string) => editors[panels.findIndex(panel => panel.id === id)]
    } as any;
    window.zion.state.set("chat.thinkingVisible", true);
    window.zion.state.set("sessions.annotations.live-session", {});
    const annotations = createChatAnnotationsApi({
      state: zion.state, events: zion.events, commands: zion.commands,
      getActivePanelId: () => panels[0].id
    });
    cleanups.push(() => { annotations.dispose(); window.zion.panels = previousPanels; });
  }
  const manager = createSessionCollaborationManager({
    zion, clientId: "live-ui",
    runtimeConfig: { mode: "runtime", baseUrl: "http://runtime.test" },
    createDocument: () => doc,
    createProvider(options: any) {
      const awareness = new Awareness(options.document);
      queueMicrotask(() => options.onSynced());
      return { awareness, destroy: () => awareness.destroy() };
    }
  });
  cleanups.push(() => manager.dispose());
  const views = [0, 1].map(i => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const core = native ? new EditorCore(parent, initial, panels[i].id) : null;
    core?.setSessionId("live-session");
    const view = core?.view || new EditorView({ state: EditorState.create({ doc: initial }), parent });
    const editor = core ? attachEditor(core, panels[i].id) : {
      sessionId: "live-session", getView: () => view,
      getValue: () => view.state.doc.toString(),
      setValue: (text: string) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
      addVisualExtension: (extension: any) => view.dispatch({ effects: StateEffect.appendConfig.of(extension) })
    };
    editors.push(editor);
    core?.addExternalExtension(roles());
    core?.addExternalExtension(installToolCallCards());
    core?.addExternalExtension(installThinkingCards());
    const binding = manager.bindEditor(editor);
    cleanups.push(() => { binding.dispose(); if (core) detachEditor(panels[i].id); view.destroy(); parent.remove(); });
    return view;
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  let sequence = 0;
  const projector = createSessionDocumentProjector();
  const send = async (type: string, data = {}, eventSequence = ++sequence, project = true) => {
    const event = { type, data, sequence: eventSequence, runId: "r" };
    await projectRunEventToSession(zion, "live-session", event, {
      backend: "runtime", documentWriter: false, documentProjectionMode: native ? "live" : "final",
      answerAnchorPos: initial.length, editorView: views[0]
    });
    if (native && project) {
      doc.transact(() => projector.projectEvents({ document: doc, runId: "r", events: [event] }));
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return event;
  };
  return { views, doc, send, zion, projector };
}

describe("live conversation UI", () => {
  it.each([
    ["sse-first", "message.delta", { delta: "answer" }],
    ["sse-first", "reasoning.delta", { turn: 1, delta: "checking" }],
    ["document-first", "message.delta", { delta: "answer" }],
    ["sse-first", "run.completed", { output: "answer without tokens" }]
  ])("hands the submitted assistant to native content atomically (%s, %s)", async (order, type, data) => {
    const initial = "user question\nuser later";
    const { views, doc, send, zion, projector } = await liveHarness(initial, true);
    const preparing = {
      sessionId: "live-session", submissionId: "preparing-r",
      answerAnchorPos: 13, editorView: views[0]
    };
    zion.events.emit("chat/preparing", preparing);
    for (const view of views) {
      expect(view.dom.querySelector(".zion-submitted-assistant")?.textContent).toBe("assistant");
      expect(view.dom.querySelector('[role="status"]')).toBeNull();
      expect(view.state.doc.toString()).toBe(initial);
    }
    const counts: number[][] = views.map(() => []);
    views.forEach((view, index) => view.dispatch({
      effects: StateEffect.appendConfig.of(EditorView.updateListener.of(update => {
        counts[index].push(update.view.dom.querySelectorAll(".cm-role-token-assistant").length);
      }))
    }));
    await send("run.started", {}, 1, false);
    const event = { runId: "r", type, data, sequence: 2 };
    const project = () => doc.transact(() => {
      projector.prepareRun({
        document: doc, runId: "r", mode: "live",
        documentAnchor: { fallback: { offset: 13, before: "user question", after: "\nuser later" } }
      });
      projector.projectEvents({ document: doc, runId: "r", events: [event] });
    });
    if (order === "document-first") {
      project();
      await Promise.resolve();
    }
    zion.events.emit("chat/preparing", { ...preparing, assistantBlockId: "r" });
    zion.events.emit("chat/prepared", { ...preparing, waitForDocument: true });
    await send(type as string, data, 2, false);
    await new Promise(resolve => setTimeout(resolve, 0));
    if (order === "sse-first") {
      for (const view of views) {
        expect(view.dom.querySelector(".zion-submitted-assistant")?.textContent).toBe("assistant");
        expect(view.state.doc.toString()).toBe(initial);
      }
      project();
    }
    for (const view of views) {
      expect(view.dom.querySelector(".zion-submitted-assistant")).toBeNull();
      expect(view.dom.querySelectorAll(".cm-role-token-assistant")).toHaveLength(1);
      expect(view.state.doc.toString()).toContain("\nuser later");
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    for (const count of counts) {
      expect(count.length).toBeGreaterThan(0);
      expect(count.every(value => value === 1), JSON.stringify(count)).toBe(true);
    }
    for (const view of views) expect(view.state.field(pendingAssistantField).entries.size).toBe(0);
  });

  it.each(["chat/aborted", "chat/runError", "detached"])("clears the waiting submitted header on %s", async topic => {
    const { views, doc, zion } = await liveHarness("user question", true);
    zion.events.emit("chat/preparing", {
      sessionId: "live-session", submissionId: "preparing-r",
      assistantBlockId: "r", answerAnchorPos: 13, editorView: views[0]
    });
    zion.events.emit("chat/prepared", {
      sessionId: "live-session", submissionId: "preparing-r", waitForDocument: true
    });
    if (topic === "detached") doc.getMap("runProjection").set("r", { mode: "live", detached: true });
    else zion.events.emit(topic, { sessionId: "live-session", runId: "r", backend: "runtime" });
    for (const view of views) {
      expect(view.dom.querySelector(".zion-submitted-assistant")).toBeNull();
      expect(view.state.field(pendingAssistantField).entries.size).toBe(0);
      expect(view.state.doc.toString()).toBe("user question");
    }
  });

  it("uses the same native Markdown and card DOM before and after completion in both editors", async () => {
    const source = "user question\nuser later draft";
    const { views, doc, send, projector } = await liveHarness(source, true);
    doc.transact(() => projector.prepareRun({
      document: doc, runId: "r", mode: "live",
      documentAnchor: { fallback: { offset: 13, before: "user question", after: "\nuser later draft" } }
    }));
    await send("run.started");
    await send("reasoning.delta", { turn: 1, delta: "检查文件" });
    for (const view of views) {
      expect(view.dom.querySelector(".zion-pending-assistant-output")).toBeNull();
      const card = view.dom.querySelector(".zion-thinking-inline") as HTMLElement;
      expect(card, view.state.doc.toString()).not.toBeNull();
      card.click();
    }
    await send("reasoning.completed", { turn: 1, content: "检查文件" });
    await send("tool.requested", { callId: "one", name: "lookup", arguments: { path: "package.json" } });
    for (const view of views) {
      const card = view.dom.querySelector(".zion-tool-call-inline") as HTMLElement;
      expect(card, JSON.stringify({
        text: view.state.doc.toString(), projection: doc.getMap("runProjection").get("r"),
        annotations: window.zion.state.get("sessions.annotations.live-session")
      })).not.toBeNull();
      card.click();
    }
    await send("tool.completed", { callId: "one", name: "lookup", result: "found", ok: true });
    await send("tool.requested", { callId: "two", name: "lookup", arguments: { path: "README.md" } });
    await send("tool.completed", { callId: "two", name: "lookup", result: "readme", ok: true });
    await send("reasoning.delta", { turn: 2, delta: "汇总结果" });
    await send("reasoning.completed", { turn: 2, content: "汇总结果" });
    for (const view of views) {
      const rows = [...view.dom.querySelectorAll(".zion-inline-widget-row")];
      expect(rows).toHaveLength(4);
      for (let i = 0; i < rows.length - 1; i += 1) {
        expect(rows[i].nextElementSibling).toBe(rows[i + 1]);
      }
    }
    const output = "# 结果\n\n**说明**与 `code`\n\n- 第一项\n- 第二项\n\n```txt\nexample\n```\n\n| 字段 | 值 |\n| --- | --- |\n| 名称 | 文件 |\n";
    for (const delta of [output.slice(0, 8), output.slice(8, 52), output.slice(52)]) {
      await send("message.delta", { delta });
    }
    for (const view of views) {
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("later") + 2 } });
      expect(view.state.doc.toString()).toContain("user later draft");
      expect(view.state.doc.toString()).toContain("第一项\n- 第二项\n\n```txt");
      expect(view.dom.querySelector(".cm-md-strong")?.textContent).toBe("说明");
      expect(view.dom.querySelector(".cm-md-list-line")).not.toBeNull();
      expect(view.dom.querySelector(".cm-md-codeblock")).not.toBeNull();
      expect(view.dom.querySelector(".cm-md-table")?.textContent).toContain("名称");
      expect(view.dom.querySelector(".zion-thinking-card-body")?.textContent).toContain("检查文件");
      expect(view.dom.querySelector(".zion-tool-call-card")?.textContent).toContain("found");
    }
    const before = views.map(view => ({
      text: view.state.doc.toString(),
      html: view.contentDOM.innerHTML,
      cursor: view.state.selection.main.head,
      thinking: view.dom.querySelector(".zion-thinking-card"),
      tool: view.dom.querySelector(".zion-tool-call-card"),
      table: view.dom.querySelector(".cm-md-table")
    }));
    await send("run.completed", { output });
    for (const [index, view] of views.entries()) {
      expect(view.state.doc.toString()).toBe(before[index].text);
      expect(view.contentDOM.innerHTML).toBe(before[index].html);
      expect(view.state.selection.main.head).toBe(before[index].cursor);
      expect(view.dom.querySelector(".zion-thinking-card")).toBe(before[index].thinking);
      expect(view.dom.querySelector(".zion-tool-call-card")).toBe(before[index].tool);
      expect(view.dom.querySelector(".cm-md-table")).toBe(before[index].table);
      expect(view.dom.querySelector(".zion-pending-assistant-output")).toBeNull();
    }
  });

  it("streams fragmented fences at a middle anchor without absorbing later text or moving its caret", async () => {
    const source = "user question\nuser later draft";
    const { views, doc, send, projector } = await liveHarness(source, true);
    doc.transact(() => projector.prepareRun({
      document: doc, runId: "r", mode: "live",
      documentAnchor: { fallback: { offset: 13, before: "user question", after: "\nuser later draft" } }
    }));
    const view = views[0];
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf("later") + 3 } });
    let output = "";
    for (const delta of ["`", "`", "`txt\n", "assistant example\n", "user example\n", "`", "`", "`", "\n完成"]) {
      output += delta;
      await send("message.delta", { delta });
      expect(captureDocumentInput({
        getValue: () => view.state.doc.toString(),
        getCursor: () => ({ line: view.state.doc.lines - 1, ch: 0 })
      }).messages.at(-1)).toEqual({ role: "user", content: "later draft" });
      expect(view.state.doc.sliceString(view.state.selection.main.head - 3, view.state.selection.main.head)).toBe("lat");
      expect(doc.getMap("runProjection").get("r")?.detached).not.toBe(true);
    }
    await send("run.completed", { output });
    expect(view.state.doc.toString()).toContain(output + "\nuser later draft");
  });

  it.each(["改写", "删除"])("preserves %s of a streaming answer in both editors", async action => {
    const { views, doc, send, projector } = await liveHarness("user question", true);
    doc.transact(() => projector.prepareRun({
      document: doc, runId: "r", mode: "live",
      documentAnchor: { fallback: { offset: 13, before: "user question", after: "" } }
    }));
    await send("message.delta", { delta: "initial answer" });
    const view = views[1];
    const start = view.state.doc.toString().indexOf(action === "改写" ? "initial answer" : "assistant ");
    view.dispatch({ changes: { from: start, to: view.state.doc.length, insert: action === "改写" ? "我的修改" : "" } });
    const edited = view.state.doc.toString();
    await send("message.delta", { delta: " later tokens" });
    await send("run.completed", { output: "initial answer later tokens" });
    for (const item of views) {
      expect(item.state.doc.toString()).toBe(edited);
      expect(item.dom.querySelector(".zion-pending-assistant-output")).toBeNull();
    }
    expect(doc.getMap("runProjection").get("r")).toMatchObject({ detached: true });
  });

  it("opens completed history with one next-message row and preserves later drafts", async () => {
    const { views, doc } = await liveHarness("user hi\nassistant saved answer");
    for (const view of views) expect(view.state.doc.toString()).toBe("user hi\nassistant saved answer\nuser ");
    expect(doc.getText("content").toString()).toBe("user hi\nassistant saved answer\nuser ");
    views[0].dispatch({ changes: { from: views[0].state.doc.length, insert: "draft" } });
    appendConversationDraft(views[0]);
    expect(views[0].state.doc.toString()).toBe("user hi\nassistant saved answer\nuser draft");
  });

  it("adds and focuses the next input only after completion, retaining native answer nodes", async () => {
    const { views, doc, send, zion, projector } = await liveHarness("user question", true);
    const view = views[0];
    const editor = {
      getValue: () => view.state.doc.toString(),
      getView: () => view,
      getCursor: () => ({ line: 0, ch: 0 })
    };
    const input = captureDocumentInput(editor);
    const anchor = {
      encoded: Buffer.from(Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(doc.getText("content"), input.insertionOffset, -1)
      )).toString("base64")
    };
    zion.events.emit("chat/preparing", {
      sessionId: "live-session", submissionId: "preparing-r",
      answerAnchorPos: input.insertionOffset
    });
    expect(view.dom.querySelector(".zion-submitted-assistant")?.textContent).toBe("assistant");
    expect(view.state.doc.toString()).toBe("user question");
    doc.transact(() => projector.prepareRun({
      document: doc, runId: "r", mode: "live", documentAnchor: anchor, appendUserPrompt: true
    }));
    zion.events.emit("chat/prepared", { sessionId: "live-session", submissionId: "preparing-r" });
    await send("run.started");
    await send("message.delta", { delta: "**answer**" });
    view.dispatch({ selection: { anchor: 8 } });
    await send("message.delta", { delta: " continues" });
    expect(view.state.doc.toString()).not.toMatch(/\nuser $/);
    const nodes = views.map(item => item.dom.querySelector(".cm-md-strong"));
    const before = view.state.doc.toString();
    await send("run.completed", { output: "**answer** continues" });
    for (const [i, item] of views.entries()) {
      expect(item.state.doc.toString()).toBe(before + "\nuser ");
      expect(item.dom.querySelector(".cm-md-strong")).toBe(nodes[i]);
    }
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(view.hasFocus).toBe(true);
    await send("run.completed", { output: "**answer** continues" }, 20);
    view.dispatch(view.state.replaceSelection("follow up"));
    for (const item of views) {
      expect(item.dom.querySelector(".zion-pending-assistant-output")).toBeNull();
      expect(item.state.doc.toString()).toBe(before + "\nuser follow up");
    }
    // Editing an earlier message changes only the prefix for a new trigger.
    view.dispatch({ selection: { anchor: 0, head: 4 }, changes: { from: 5, to: 13, insert: "revised question" } });
    const next = captureDocumentInput(editor);
    expect(next.messages).toEqual([{ role: "user", content: "revised question" }]);
    expect(input.messages).toEqual([{ role: "user", content: "question" }]);
  });

  it("reopens a streaming snapshot without creating a user row", async () => {
    const initial = "user hi\nassistant <!-- zion-assistant:id=r --> still generating";
    const { views, doc } = await liveHarness(initial, false, { mode: "live", status: "running" });
    for (const view of views) expect(view.state.doc.toString()).toBe(initial);
    expect(doc.getText("content").toString()).toBe(initial);
  });

  it("inserts a middle input at completion while preserving later text, its caret and answer rendering", async () => {
    const source = "user question\nuser later draft";
    const { views, doc, send, projector } = await liveHarness(source, true);
    doc.transact(() => projector.prepareRun({
      document: doc, runId: "r", mode: "live", appendUserPrompt: true,
      documentAnchor: { fallback: { offset: 13, before: "user question", after: "\nuser later draft" } }
    }));
    await send("run.started");
    await send("message.delta", { delta: "**answer**" });
    expect(doc.getText("content").toString()).not.toContain("\nuser \n");
    const nodes = views.map(view => view.dom.querySelector(".cm-md-strong"));
    views[1].dispatch({ selection: { anchor: views[1].state.doc.toString().indexOf("later") + 2 } });
    await send("run.completed", { output: "**answer**" });
    for (const [index, view] of views.entries()) {
      expect(view.state.doc.toString()).toBe("user question\nassistant <!-- zion-assistant:id=r --> **answer**\nuser \nuser later draft");
      expect(view.dom.querySelector(".cm-md-strong")).toBe(nodes[index]);
    }
    expect(views[1].state.doc.sliceString(views[1].state.selection.main.head - 2, views[1].state.selection.main.head)).toBe("la");
    const inputOffset = views[0].state.doc.toString().indexOf("\nuser \n") + 6;
    expect(views[0].state.selection.main.head).toBe(inputOffset);
    expect(views[0].hasFocus).toBe(true);
    expect(views[1].hasFocus).toBe(false);
    views[0].dispatch(views[0].state.replaceSelection("follow up here"));
    const next = captureDocumentInput({
      getView: () => views[0], getValue: () => views[0].state.doc.toString(),
      getCursor: () => ({ line: 2, ch: 0 })
    });
    expect(next.messages.at(-1)).toEqual({ role: "user", content: "follow up here" });
    expect(next.messages.some(message => message.content === "later draft")).toBe(false);
    expect(views[1].state.doc.toString()).toContain("user follow up here\nuser later draft");
  });

  it.each([
    ["thinking", false], ["tool", false], ["thinking", true], ["tool", true]
  ])("ignores delayed %s card scrolling after completion or replacement (next run=%s)", async (kind, nextRun) => {
    const { views, doc, send, projector, zion } = await liveHarness("user question", true);
    doc.transact(() => projector.prepareRun({
      document: doc, runId: "r", mode: "live",
      documentAnchor: { fallback: { offset: 13, before: "user question", after: "" } }
    }));
    await send("run.started");
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.set(++id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (key: number) => callbacks.delete(key));
    cleanups.push(() => vi.unstubAllGlobals());
    if (kind === "thinking") await send("reasoning.delta", { turn: 1, delta: "thinking" });
    else await send("tool.requested", { callId: "one", name: "lookup", arguments: {} });
    for (const view of views) {
      const card = view.dom.querySelector(`.zion-${kind === "tool" ? "tool-call" : "thinking"}-inline`)!;
      expect(card).not.toBeNull();
      vi.spyOn(card, "getBoundingClientRect").mockReturnValue({ top: 600, bottom: 700 } as DOMRect);
      vi.spyOn(view.scrollDOM, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 300 } as DOMRect);
      view.scrollDOM.scrollTop = 2_000;
    }
    zion.state.set("chat.runs.live-session", { runId: nextRun ? "next" : "r", streaming: nextRun });
    const flush = () => {
      const queued = [...callbacks.values()];
      callbacks.clear();
      queued.forEach(callback => callback(performance.now()));
    };
    flush();
    for (const view of views) expect(view.scrollDOM.scrollTop).toBe(2_000);
  });

  it("follows delayed final document text once, without scrolling a detached pane or later edits", async () => {
    const { views, doc, send, projector, zion } = await liveHarness("user question", true);
    doc.transact(() => projector.prepareRun({
      document: doc, runId: "r", mode: "live", appendUserPrompt: true,
      documentAnchor: { fallback: { offset: 13, before: "user question", after: "" } }
    }));
    for (const view of views) {
      beginConversationViewportFollow(view, { sessionId: "live-session", state: zion.state, cycleId: "r" });
      setConversationViewportFollowing(view, false, { sessionId: "live-session", state: zion.state });
    }
    await send("run.started");
    await send("message.delta", { delta: "first" });
    const spies = views.map(view => vi.spyOn(view, "dispatch"));
    cleanups.push(() => spies.forEach(spy => spy.mockRestore()));
    const final = await send("run.completed", { output: "first final" }, 100, false);
    await new Promise(resolve => setTimeout(resolve, 30));
    spies.forEach(spy => spy.mockClear());
    doc.transact(() => projector.projectEvents({ document: doc, runId: "r", events: [final] }));
    await new Promise(resolve => setTimeout(resolve, 30));
    const scrolls = spy => spy.mock.calls.flatMap(args => args).filter(spec =>
      spec.effects && (Array.isArray(spec.effects) ? spec.effects : [spec.effects]).some(effect =>
        effect.value?.range && effect.value?.y === "nearest"));
    expect(scrolls(spies[0])).toHaveLength(1);
    expect(scrolls(spies[1])).toHaveLength(0);
    expect(scrolls(spies[0])[0].effects.value.range.head).toBe(views[0].state.doc.length);
    expect(views[0].state.selection.main.head).toBe(views[0].state.doc.length);
    expect(views[0].hasFocus).toBe(true);
    expect(views[0].state.doc.toString()).toContain("first final\nuser ");
    spies.forEach(spy => spy.mockClear());
    views[0].dispatch({ changes: { from: views[0].state.doc.length, insert: "draft" } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(scrolls(spies[0])).toHaveLength(0);
  });

  it.each([
    ["middle", "tokens"], ["middle", "terminal-only"], ["tail", "terminal-only"], ["reused", "tokens"], ["fence", "tokens"]
  ])("reveals the next input with nearest scrolling when the document finishes before SSE (%s, %s)", async (position, delivery) => {
    const suffix = position === "tail" ? "" : position === "reused" ? "\nuser \nassistant later" : "\nuser later";
    const source = "user question" + suffix;
    const { views, doc, send, projector } = await liveHarness(source, true);
    doc.transact(() => projector.prepareRun({
      document: doc, runId: "r", mode: "live", appendUserPrompt: true,
      documentAnchor: { fallback: { offset: 13, before: "user question", after: suffix } }
    }));
    await send("run.started");
    const output = position === "fence" ? "```txt\nuser example\nassistant example\n```" : "answer";
    if (delivery === "tokens") await send("message.delta", { delta: output });
    const spy = vi.spyOn(views[0], "dispatch");
    cleanups.push(() => spy.mockRestore());
    doc.transact(() => projector.projectEvents({
      document: doc, runId: "r",
      events: [{ runId: "r", sequence: 100, type: "run.completed", data: { output } }]
    }));
    await new Promise(resolve => setTimeout(resolve, 30));
    const scrolls = () => spy.mock.calls.flatMap(args => args).flatMap(spec =>
      spec.effects ? (Array.isArray(spec.effects) ? spec.effects : [spec.effects]) : []
    ).filter(effect => effect.value?.range && effect.value?.y === "nearest");
    expect(scrolls()).toHaveLength(1);
    const text = views[0].state.doc.toString();
    const inputEnd = position === "tail" ? text.length : text.indexOf("\nuser \n") + 6;
    expect(scrolls()[0].value.range.head).toBe(inputEnd);
    expect(scrolls()[0].value.yMargin).toBe(24);
    expect(views[0].state.selection.main.head).toBe(inputEnd);
    expect(views[0].hasFocus).toBe(true);
    views[0].dispatch({ selection: { anchor: 7 } });
    spy.mockClear();
    await send("run.completed", { output }, 100, false);
    await send("message.delta", { delta: "late replay" }, 99, false);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(scrolls()).toHaveLength(0);
    expect(views[0].state.doc.toString()).toBe(text);
    expect(views[0].state.selection.main.head).toBe(7);
  });

  it.each(["tail", "middle", "reused"])("reveals a submitted input once when final Yjs arrives before run.started (%s)", async position => {
    const suffix = position === "tail" ? "" : position === "reused" ? "\nuser \nassistant later" : "\nuser later";
    const source = "user question" + suffix;
    const { views, doc, zion, projector } = await liveHarness(source, true);
    const context = {
      backend: "runtime", documentWriter: false, documentProjectionMode: "live",
      editorView: views[0], followCycleId: "preparing-r"
    };
    zion.events.emit("chat/preparing", {
      sessionId: "live-session", submissionId: "preparing-r",
      editorView: views[0], followCycleId: "preparing-r", answerAnchorPos: 13
    });
    doc.transact(() => {
      projector.prepareRun({
        document: doc, runId: "r", mode: "live", appendUserPrompt: true,
        documentAnchor: { fallback: { offset: 13, before: "user question", after: suffix } }
      });
      projector.projectEvents({
        document: doc, runId: "r",
        events: [{ runId: "r", sequence: 100, type: "run.completed", data: { output: "answer" } }]
      });
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    zion.events.emit("chat/preparing", {
      sessionId: "live-session", submissionId: "preparing-r", assistantBlockId: "r",
      editorView: views[0], followCycleId: "preparing-r", answerAnchorPos: 13
    });
    for (const view of views) view.dispatch({ selection: { anchor: 7 } });
    const spies = views.map(view => vi.spyOn(view, "dispatch"));
    cleanups.push(() => spies.forEach(spy => spy.mockRestore()));
    const scrolls = spy => spy.mock.calls.flatMap(args => args).flatMap(spec =>
      spec.effects ? (Array.isArray(spec.effects) ? spec.effects : [spec.effects]) : []
    ).filter(effect => effect.value?.range && effect.value?.y === "nearest");
    const started = { runId: "r", sequence: 1, type: "run.started", data: {} };
    await projectRunEventToSession(zion, "live-session", started, context);
    await new Promise(resolve => setTimeout(resolve, 30));
    const text = views[0].state.doc.toString();
    const inputEnd = position === "tail" ? text.length : text.indexOf("\nuser \n") + 6;
    expect(scrolls(spies[0])).toHaveLength(1);
    expect(scrolls(spies[1])).toHaveLength(0);
    expect(views[0].state.selection.main.head).toBe(inputEnd);
    expect(views[0].hasFocus).toBe(true);
    expect(views[1].state.selection.main.head).toBe(7);
    views[0].dispatch({ selection: { anchor: 7 } });
    spies.forEach(spy => spy.mockClear());
    await projectRunEventToSession(zion, "live-session", started, context);
    await projectRunEventToSession(zion, "live-session", {
      runId: "r", sequence: 100, type: "run.completed", data: { output: "answer" }
    }, context);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(scrolls(spies[0])).toHaveLength(0);
    expect(views[0].state.selection.main.head).toBe(7);
  });

  it.each(["history", "other-cycle", "other-view", "replaced", "detached"])("does not refocus an already projected run for %s", async reason => {
    const { views, doc, zion, projector } = await liveHarness("user question", true);
    if (reason !== "history") zion.events.emit("chat/preparing", {
      sessionId: "live-session", submissionId: "preparing-r", editorView: views[0],
      followCycleId: "preparing-r", answerAnchorPos: 13
    });
    doc.transact(() => {
      projector.prepareRun({
        document: doc, runId: "r", mode: "live", appendUserPrompt: true,
        documentAnchor: { fallback: { offset: 13, before: "user question", after: "" } }
      });
      projector.projectEvents({
        document: doc, runId: "r",
        events: [{ runId: "r", sequence: 100, type: "run.completed", data: { output: "answer" } }]
      });
      if (reason === "detached") doc.getMap("runProjection").set("r", {
        ...doc.getMap("runProjection").get("r"), detached: true
      });
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    for (const view of views) view.dispatch({ selection: { anchor: 7 } });
    if (reason === "replaced") zion.state.set("chat.runs.live-session", { runId: "new-run" });
    zion.events.emit("chat/runStarted", {
      sessionId: "live-session", runId: "r",
      backend: "runtime", documentWriter: false, documentProjectionMode: "live",
      editorView: views[reason === "other-view" ? 1 : 0],
      followCycleId: reason === "other-cycle" ? "old-cycle" : "preparing-r"
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    for (const view of views) expect(view.state.selection.main.head).toBe(7);
    zion.state.set("chat.runs.live-session", null);
  });

  it("renders reasoning and tools before completion, preserving expansion, order and both views", async () => {
    const { views, doc, send } = await liveHarness();
    const initial = doc.getText("content").toString();
    await send("run.started");
    await send("reasoning.started", { turn: 1 });
    for (const view of views) {
      const button = view.dom.querySelector(".zion-thinking-inline button") as HTMLButtonElement;
      expect(button).not.toBeNull();
      button.click();
      expect(button.getAttribute("aria-expanded")).toBe("true");
    }
    await send("reasoning.delta", { turn: 1, delta: "先检查" });
    const thinking = views[0].dom.querySelector(".zion-thinking-card")!;
    await send("reasoning.delta", { turn: 1, delta: "文件。" }, 4);
    await send("reasoning.delta", { turn: 1, delta: "文件。" }, 4);
    expect(views[0].dom.querySelector(".zion-thinking-card")).toBe(thinking);
    for (const view of views) expect(view.dom.querySelector(".zion-thinking-card-body")?.textContent).toBe("先检查文件。");
    await send("reasoning.completed", { turn: 1 });
    await send("message.delta", { delta: "**准备**读取。" });
    await send("tool.requested", { callId: "one", name: "lookup", arguments: { query: "package.json" } });
    for (const view of views) {
      expect(view.dom.querySelector(".zion-tool-call-status")?.getAttribute("data-status")).toBe("pending");
      (view.dom.querySelector(".zion-tool-call-inline button") as HTMLButtonElement).click();
      expect(view.dom.querySelector(".zion-tool-call-card")?.textContent).toContain("package.json");
    }
    await send("tool.completed", { callId: "one", result: "found", ok: true });
    await send("tool.requested", { callId: "two", name: "lookup", args: { query: "missing.txt" } });
    await send("tool.completed", { callId: "two", result: "not found", ok: false });
    await send("reasoning.started", { turn: 2 });
    await send("reasoning.delta", { turn: 2, delta: "汇总结果。" });
    await send("reasoning.completed", { turn: 2 });
    await send("message.delta", { delta: "**完成**。" });
    for (const view of views) {
      expect(view.state.doc.toString()).toBe(initial);
      const output = view.dom.querySelector(".zion-pending-assistant-output")!;
      expect([...output.querySelectorAll("[data-kind]")].map(node => node.getAttribute("data-kind")))
        .toEqual(["reasoning", "answer", "tool", "tool", "reasoning", "answer"]);
      expect([...output.querySelectorAll(".zion-tool-call-inline .zion-tool-call-status")].map(node => node.getAttribute("data-status")))
        .toEqual(["ok", "error"]);
      expect(output.querySelector(".zion-tool-call-inline button")?.getAttribute("aria-expanded")).toBe("true");
      expect(output.querySelector(".zion-tool-call-card")?.textContent).toContain("found");
      expect([...output.querySelectorAll("strong")].map(node => node.textContent)).toEqual(["准备", "完成"]);
    }
    await send("run.completed");
    expect(views[0].dom.querySelector(".zion-pending-assistant-output")).not.toBeNull();
    doc.transact(() => {
      doc.getText("content").insert(doc.getText("content").length, "已保存的完整回答");
      doc.getMap("runProjection").set("r", { mode: "final", lastSequence: 100, committed: true });
    });
    await send("message.delta", { delta: "迟到的重放" }, 50);
    for (const view of views) {
      expect(view.dom.querySelector(".zion-pending-assistant-output")).toBeNull();
      expect(view.state.doc.toString()).toBe(initial + "已保存的完整回答");
    }
  });

  it.each(["run.aborted", "run.failed"])("retains partial cards on %s until projection acknowledges", async type => {
    const { views, doc, send } = await liveHarness("user question");
    await send("tool.requested", { callId: "one", name: "lookup", args: {} });
    const before = views[0].state.field(pendingAssistantField).entries.get("r")!.fallbackOffset;
    views[0].dispatch({ changes: { from: 0, insert: "edited " } });
    await send("reasoning.delta", { turn: 1, delta: "waiting" });
    expect(views[0].state.field(pendingAssistantField).entries.get("r")!.fallbackOffset).toBe(before + 7);
    await send(type, { error: "failure" });
    await send("message.delta", { delta: "late output" });
    for (const view of views) {
      expect(view.dom.querySelector(".zion-pending-assistant-output")?.textContent).not.toContain("late output");
      expect(view.dom.querySelector(".zion-pending-activity-status")?.textContent).toBe(type === "run.aborted" ? "已停止" : "运行失败");
      expect(view.dom.querySelector(".zion-tool-call-inline .zion-tool-call-status")?.getAttribute("data-status")).toBe("stopped");
    }
    doc.getMap("runProjection").set("r", { mode: "final", detached: true });
    for (const view of views) expect(view.dom.querySelector(".zion-pending-assistant-output")).toBeNull();
  });
});

describe("conversation submit keyboard UI", () => {
  it("sends the cursor prefix or exact selection on Cmd+Enter without jumping to the end", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const text = "user context\nuser selected\nuser later";
    const core = new EditorCore(parent, text);
    const editor = attachEditor(core);
    setActiveEditorPanel(editor.panelId);
    cleanups.push(() => { detachEditor(editor.panelId); core.view.destroy(); parent.remove(); });
    const source = fs.readFileSync("extensions/dev.langchain-chat/main.js", "utf8");
    const begin = source.indexOf("  const doRun = async");
    const end = source.indexOf("  // 注册命令", begin);
    const submit = source.split("\n").find(line => line.includes('registerCommand("chat.submit"'))!.trim().replace(/,$/, "");
    const selectionCommand = source.split("\n").find(line => line.includes('registerCommand("chat.runSelection"'))!.trim().replace(/,$/, "");
    const binding = source.split("\n").find(line => line.includes('keybindings.register({ command: "chat.submit"'))!.trim().replace(/,$/, "");
    const snapshots: any[] = [];
    const notify = vi.spyOn(window.zion.notification, "show").mockImplementation(() => {});
    cleanups.push(() => notify.mockRestore());
    const install = new Function("deps", `
      const { accountCan, getEd, getSessionId, getRunState, interactivePreparations,
        beginConversationViewportFollow, runtime, pendingRecoveryRuns,
        recoverInteractiveRuntimeRun, performRun, captureDocumentInput,
        captureInteractiveRuntimeAccount } = deps;
      ${source.slice(begin, end)}
      return [${submit}, ${selectionCommand}, ${binding}];
    `);
    const disposables = install({
      accountCan: () => true, getEd: () => editor, getSessionId: () => "shortcut-ui", getRunState: () => ({}),
      interactivePreparations: new Map(), beginConversationViewportFollow() {},
      runtime: { beginRun() {}, setController() {}, clearController() {}, isRunActive: () => false },
      pendingRecoveryRuns: new Map(), recoverInteractiveRuntimeRun() {},
      performRun: async (_opts: any, preparation: any) => {
        preparation.accept("accepted-ui");
        snapshots.push(preparation.inputSnapshot);
      },
      captureDocumentInput, captureInteractiveRuntimeAccount: () => null
    });
    cleanups.push(() => disposables.forEach((disposable: any) => disposable.dispose()));
    const press = async () => {
      core.view.focus();
      const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", metaKey: true, bubbles: true, cancelable: true });
      core.view.contentDOM.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 0));
    };
    const from = text.indexOf("user selected");
    const to = text.indexOf("\nuser later");
    core.view.dispatch({ selection: { anchor: to } });
    await press();
    expect(snapshots, JSON.stringify(notify.mock.calls)).toHaveLength(1);
    expect(snapshots[0].scope).toBe("prefix");
    expect(snapshots[0].messages).toEqual([{ role: "user", content: "context" }, { role: "user", content: "selected" }]);
    expect(core.view.state.doc.toString()).toBe(text);
    expect(core.view.state.selection.main.head).toBe(to);
    core.view.dispatch({ selection: { anchor: from, head: to } });
    await press();
    expect(snapshots[1].scope).toBe("selection");
    expect(snapshots[1].messages).toEqual([{ role: "user", content: "selected" }]);
    core.view.dispatch({ selection: { anchor: from, head: to } });
    await window.zion.commands.executeCommand("chat.runSelection");
    expect(snapshots[2].scope).toBe("selection");
    expect(snapshots[2].messages).toEqual([{ role: "user", content: "selected" }]);
    core.view.dispatch({ selection: { anchor: core.view.state.doc.length } });
    await press();
    expect(snapshots[3].messages.at(-1)).toEqual({ role: "user", content: "later" });
    expect(core.view.state.doc.toString()).toBe(text);
    expect(core.view.state.selection.main.head).toBe(core.view.state.doc.length);
    core.view.dispatch({ changes: { from: core.view.state.doc.length, insert: "\nuser " }, selection: { anchor: text.length + 6 } });
    await press();
    expect(snapshots).toHaveLength(4);
    expect(notify).toHaveBeenCalledWith("请在当前位置输入消息后发送。", { type: "error" });
    core.view.dispatch({ changes: { from: 0, to: core.view.state.doc.length, insert: "" } });
    await press();
    expect(snapshots).toHaveLength(4);
    expect(notify).toHaveBeenCalledWith("没有可发送的内容。", { type: "error" });
    const manifest = JSON.parse(fs.readFileSync("extensions/dev.langchain-chat/manifest.json", "utf8"));
    expect(manifest.zion.contributes.keybindings.find((item: any) => item.key === "Mod-Enter").command).toBe("chat.submit");
  });
});
