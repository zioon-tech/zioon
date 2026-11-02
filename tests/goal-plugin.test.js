import { expect, it, vi } from "vitest";
import { activate } from "../extensions/dev.goal/main.js";
import { completeGoalTrigger, goalCommandHighlight, stageGoal } from "../extensions/dev.goal/editor.js";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { parseMessages } from "../src/chat/doc";
import * as Y from "yjs";
import { prepareRunInYText } from "../extensions/dev.session-manager/session-document-projector.js";

function makeEditor(doc = "", sessionId = "session") {
  const root = document.createElement("div"); root.className = "zion-panel"; document.body.appendChild(root);
  const header = document.createElement("div"); header.className = "zion-editor-header";
  const path = document.createElement("div"); path.className = "zion-editor-session-path"; header.append(path);
  const parent = document.createElement("div"); root.append(header, parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [history()] }) });
  return { sessionId, panelId: `panel-${sessionId}`, root, getView: () => view,
    addVisualExtension: (extension) => view.dispatch({ effects: StateEffect.appendConfig.of(extension) }),
    destroy() { view.destroy(); root.remove(); } };
}

it("stages a new user turn after unfinished code without changing selected history; undo restores the document", () => {
  const original = "user 原始问题\nassistant 历史回答\n```js\nuser 代码里的文本";
  const editor = makeEditor(original);
  try {
    editor.getView().dispatch({ selection: { anchor: 5, head: 9 } });
    stageGoal(editor, "保留所有约束");
    const doc = editor.getView().state.doc.toString();
    expect(doc.startsWith(original)).toBe(true);
    expect(parseMessages(doc).at(-1)).toEqual({ role: "user", content: "/goal 保留所有约束" });
    expect(undo(editor.getView())).toBe(true);
    expect(editor.getView().state.doc.toString()).toBe(original);
  } finally { editor.destroy(); }
});

it("refuses to stage while collaboration has made the editor read only", () => {
  const editor = makeEditor("user 草稿");
  try {
    editor.addVisualExtension(EditorView.editable.of(false));
    expect(() => stageGoal(editor)).toThrow("同步");
    expect(editor.getView().state.doc.toString()).toBe("user 草稿");
  } finally { editor.destroy(); }
});

it("completes /goal in place and highlights only executable Goal commands", () => {
  const editor = makeEditor("/goal");
  try {
    editor.getView().dispatch({ selection: { anchor: 5 } });
    completeGoalTrigger(editor);
    expect(editor.getView().state.doc.toString()).toBe("/goal ");
    expect(editor.getView().state.selection.main.head).toBe(6);
    editor.getView().dispatch({ changes: { from: 0, to: 6, insert:
      "user /goal 完成任务\nassistant /goal 只是回答\nuser ```txt\n/goal 代码内容\n```\nuser /goal-resume" } });
    const highlighting = goalCommandHighlight(editor);
    expect([...editor.root.querySelectorAll(".zion-goal-command")].map((node) => node.textContent))
      .toEqual(["/goal", "/goal-resume"]);
    highlighting.dispose();
    expect(editor.root.querySelector(".zion-goal-command")).toBeNull();
  } finally { editor.destroy(); }
});

it("projects a continuation as a fresh message, preserves drafts and is idempotent", () => {
  for (const draft of ["user 尚未发送的草稿", "user ", "assistant 历史\n~~~js\n草稿"]) {
    const document = new Y.Doc(); const ytext = document.getText("content"); ytext.insert(0, draft);
    const input = { runId: "resumed", userContent: "继续当前目标", forceNewUser: true };
    expect(prepareRunInYText(ytext, input)).toBe(true);
    expect(ytext.toString().startsWith(draft)).toBe(true);
    const messages = parseMessages(ytext.toString());
    expect(messages.find((message) => message.content === "继续当前目标")).toMatchObject({ role: "user" });
    const once = ytext.toString();
    expect(prepareRunInYText(ytext, input)).toBe(false);
    expect(ytext.toString()).toBe(once);
    document.destroy();
  }
});

it("registers goal slash commands after plugin readiness and sends explicit goal controls to Runtime", async () => {
  const previousZion = window.zion;
  const previousFetch = globalThis.fetch;
  const commands = new Map(), listeners = new Map();
  const values = new Map([
    ["runtime.mode", "runtime"], ["runtime.baseUrl", "http://runtime.test"], ["sessions.currentId", "session"]
  ]);
  const editor = makeEditor("user 草稿");
  const executeCommand = vi.fn(async () => {});
  const fetchImpl = vi.fn(async () => new globalThis.Response(JSON.stringify({ result: null }), { status: 200 }));
  const ctx = { subscriptions: [] };
  window.zion = {
    window: { activeEditor: editor },
    state: {
      get: (key) => values.get(key), set: (key, value) => values.set(key, value),
      onDidChange(key, listener) { listeners.set(key, listener); return { dispose() { listeners.delete(key); } }; }
    },
    commands: {
      registerCommand(id, execute) { commands.set(id, execute); return { dispose() { commands.delete(id); } }; },
      executeCommand
    },
    events: { on: () => ({ dispose() {} }) }
  };
  globalThis.fetch = fetchImpl;
  try {
    await activate(ctx);
    const registerCommand = vi.fn(() => ({ dispose() {} }));
    window.zion.slash = { registerCommand };
    listeners.get("workbench.pluginsReady")();
    expect(registerCommand).toHaveBeenCalledTimes(5);
    expect(registerCommand.mock.calls.map(([command]) => command.trigger)).toContain("goal-resume");
    await commands.get("goal.start")({ objective: "保留完整目标与用户更正", tokenBudget: 5000 });
    expect(editor.getView().state.doc.toString()).toBe("user 草稿\nuser /goal 保留完整目标与用户更正");
    expect(executeCommand).toHaveBeenCalledWith("chat.run", { editor, panelId: editor.panelId, sessionId: "session", metadata: {
      goal: { action: "start", objective: "保留完整目标与用户更正", tokenBudget: 5000, criteria: undefined }
    }});
    await commands.get("goal.pause")();
    expect(fetchImpl.mock.calls.some(([url, init]) => url === "http://runtime.test/v1/plugins/dev.goal/commands"
      && JSON.parse(init.body).action === "pause" && JSON.parse(init.body).sessionId === "session")).toBe(true);
    const beforeResume = editor.getView().state.doc.toString();
    await commands.get("goal.resume")();
    expect(editor.getView().state.doc.toString()).toBe(beforeResume);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.some(([, init]) => JSON.parse(init.body).action === "resume")).toBe(true);
  } finally {
    for (const subscription of ctx.subscriptions.reverse()) subscription.dispose?.();
    window.zion = previousZion;
    globalThis.fetch = previousFetch;
    editor.destroy();
  }
});

it("binds toolbar controls to their editor and discards an old Session response after a tab switch", async () => {
  const previousZion = window.zion, previousFetch = globalThis.fetch;
  const first = makeEditor("user 草稿一", "one"), second = makeEditor("user 草稿二", "two");
  const ctx = { subscriptions: [] }, commands = new Map();
  let resolveOld;
  const old = new Promise((resolve) => { resolveOld = resolve; });
  const values = new Map([["runtime.mode", "runtime"], ["runtime.baseUrl", "http://runtime.test"]]);
  const fetchImpl = vi.fn(async (_, init) => {
    const args = JSON.parse(init.body);
    if (args.sessionId === "one" && args.action === "status") return old;
    return new Response(JSON.stringify({ result: { objective: `目标 ${args.sessionId}`, status: "active", tokenUsage: 0 } }));
  });
  globalThis.fetch = fetchImpl;
  window.zion = {
    window: { activeEditor: second },
    state: { get: (key) => values.get(key), onDidChange: () => ({ dispose() {} }) },
    commands: { registerCommand(id, fn) { commands.set(id, fn); return { dispose() {} }; }, executeCommand: vi.fn() },
    editor: { registerDecorator(decorator) {
      const handles = [decorator.apply(first), decorator.apply(second)];
      return { dispose() { handles.forEach((handle) => handle.dispose()); } };
    }},
    events: { on: () => ({ dispose() {} }) }
  };
  try {
    await activate(ctx);
    await vi.waitFor(() => expect(second.root.textContent).toContain("目标 two"));
    first.sessionId = "three";
    resolveOld(new Response(JSON.stringify({ result: { objective: "过期目标 one", status: "active" } })));
    await old; await Promise.resolve();
    expect(first.root.textContent).not.toContain("过期目标 one");
    // Active global editor is now first, but the second panel's action must stay scoped.
    window.zion.window.activeEditor = first;
    second.root.querySelector(".zion-goal-chrome button:nth-of-type(2)").click();
    await vi.waitFor(() => expect(fetchImpl.mock.calls.some(([, init]) => {
      const args = JSON.parse(init.body); return args.action === "pause" && args.sessionId === "two";
    })).toBe(true));
    expect(second.getView().state.doc.toString()).toBe("user 草稿二");
    for (const subscription of ctx.subscriptions.reverse()) subscription.dispose?.();
    expect(second.root.querySelector(".zion-goal-chrome")).toBeNull();
  } finally {
    for (const subscription of ctx.subscriptions.reverse()) subscription.dispose?.();
    globalThis.fetch = previousFetch; window.zion = previousZion;
    first.destroy(); second.destroy();
  }
});

async function goalWorkbench(editor, respond, { withAuxiliary = false } = {}) {
  const previousZion = window.zion, previousFetch = globalThis.fetch;
  const ctx = { subscriptions: [] }, events = new Map(), commands = new Map();
  const values = new Map([["runtime.mode", "runtime"], ["runtime.baseUrl", "http://runtime.test"]]);
  const activeTabs = [{ id: editor.panelId, activeTabId: editor.sessionId }];
  const auxiliaryRoot = document.createElement("div");
  let auxiliaryView = null, auxiliaryMount = null;
  if (withAuxiliary) document.body.append(auxiliaryRoot);
  const auxiliaryBar = withAuxiliary ? {
    registerView(view) {
      auxiliaryView = view;
      return { dispose() { auxiliaryMount?.dispose?.(); auxiliaryRoot.replaceChildren(); } };
    },
    activateView(id) {
      values.set("ui.auxiliaryBar.visible", true);
      values.set("ui.auxiliaryBar.activeViewId", id);
      if (!auxiliaryMount) auxiliaryMount = auxiliaryView.component.render(auxiliaryRoot);
      void auxiliaryView.onActivate?.();
    },
    show() { values.set("ui.auxiliaryBar.visible", true); },
    hide() { values.set("ui.auxiliaryBar.visible", false); },
    setWidth: vi.fn()
  } : undefined;
  const fetch = vi.fn(async (_, init) => new Response(JSON.stringify({ result: await respond(JSON.parse(init.body)) })));
  globalThis.fetch = fetch;
  window.zion = {
    window: { activeEditor: editor }, panels: { list: () => activeTabs }, auxiliaryBar,
    state: { get: (key) => values.get(key), onDidChange: () => ({ dispose() {} }) },
    commands: { registerCommand(id, fn) { commands.set(id, fn); return { dispose() {} }; }, executeCommand: vi.fn() },
    editor: { registerDecorator(decorator) { return decorator.apply(editor); } },
    events: { on(id, listener) { events.set(id, listener); return { dispose() {} }; } }
  };
  await activate(ctx);
  return { fetch, commands, activeTabs, auxiliaryRoot, get auxiliaryView() { return auxiliaryView; },
    emit: (id, payload) => events.get(id)?.(payload),
    dispose() {
      for (const subscription of ctx.subscriptions.reverse()) subscription.dispose?.();
      auxiliaryRoot.remove();
      globalThis.fetch = previousFetch; window.zion = previousZion;
    }
  };
}

it("opens Goal details in the registered Auxiliary Bar and exposes a useful header tooltip", async () => {
  const editor = makeEditor("user 正在运行");
  const goal = { id: "g", status: "active", objective: "完成跨模块迁移", nextAction: "运行集成验证", runIds: [] };
  const app = await goalWorkbench(editor, () => goal, { withAuxiliary: true });
  try {
    await vi.waitFor(() => expect(editor.root.querySelector(".zion-goal-trigger")).not.toBeNull());
    expect(app.auxiliaryView).toMatchObject({
      id: "dev.goal.inspector", pluginId: "dev.goal", title: "持续目标", location: "auxiliarybar"
    });
    const trigger = editor.root.querySelector(".zion-goal-trigger");
    expect(trigger.dataset.tooltip).toContain("进行中 · 点击在辅助栏查看");
    expect(trigger.dataset.tooltip).toContain("下一步：运行集成验证");
    trigger.click();
    await vi.waitFor(() => expect(app.auxiliaryRoot.querySelector(".zion-goal-inspector")?.hidden).toBe(false));
    expect(editor.root.querySelector(".zion-goal-inspector")).toBeNull();
    await vi.waitFor(() => expect(editor.root.querySelector(".zion-goal-trigger").disabled).toBe(false));
    const openedTrigger = editor.root.querySelector(".zion-goal-trigger");
    expect(openedTrigger.getAttribute("aria-expanded")).toBe("true");
    openedTrigger.click();
    await vi.waitFor(() => expect(window.zion.state.get("ui.auxiliaryBar.visible")).toBe(false));
  } finally { app.dispose(); editor.destroy(); }
});

it("keeps empty sessions free of Goal chrome and offers a new goal after cancellation", async () => {
  const editor = makeEditor("user 草稿");
  let goal = null;
  const app = await goalWorkbench(editor, () => goal);
  try {
    await vi.waitFor(() => expect(app.fetch).toHaveBeenCalled());
    expect(editor.root.querySelector(".zion-goal-chrome").hidden).toBe(true);
    expect(editor.getView().dom.querySelector(".cm-panels")).toBeNull();
    goal = { id: "g", status: "cancelled", objective: "原目标", cycles: 4, tokenUsage: 294365 };
    app.emit("chat/runFinished");
    await vi.waitFor(() => expect(editor.root.querySelector(".zion-goal-chrome").textContent).toContain("新目标"));
    expect(editor.root.querySelector(".zion-goal-chrome").textContent).not.toContain("294");
    editor.root.querySelector(".zion-goal-chrome button:last-child").click();
    await vi.waitFor(() => expect(editor.getView().state.doc.toString()).toBe("user 草稿\nuser /goal "));
    expect(undo(editor.getView())).toBe(true);
    expect(editor.getView().state.doc.toString()).toBe("user 草稿");
  } finally { app.dispose(); editor.destroy(); }
});

it("inspects persisted results without changing drafts, selection or undo; Escape returns focus", async () => {
  const editor = makeEditor("user 保留未发送的草稿");
  const goal = { id: "g", status: "paused", objective: "完成完整目标", createdAt: 1, cycles: 1, runIds: ["run-a"] };
  const app = await goalWorkbench(editor, (args) => args.view === "records"
    ? { goalId: "g", records: [{ id: "run-a", status: "completed", createdAt: 1, preview: "已保存产物" }] }
    : args.view === "run" ? { goalId: "g", id: "run-a", output: "持久化的实际输出", offset: 0, nextOffset: null } : goal);
  try {
    const view = editor.getView(); view.dispatch({ selection: { anchor: 5, head: 9 } }); view.focus();
    await vi.waitFor(() => expect(editor.root.querySelector(".zion-goal-trigger")).not.toBeNull());
    const trigger = editor.root.querySelector(".zion-goal-trigger"); trigger.focus(); trigger.click();
    await vi.waitFor(() => expect(editor.root.querySelector(".zion-goal-inspector").hidden).toBe(false));
    const drawer = editor.root.querySelector(".zion-goal-inspector");
    await vi.waitFor(() => expect([...drawer.querySelectorAll("button")].find((button) => button.textContent === "查看 1 轮记录").disabled).toBe(false));
    [...drawer.querySelectorAll("button")].find((button) => button.textContent === "查看 1 轮记录").click();
    await vi.waitFor(() => expect(drawer.querySelector(".zion-goal-record")).not.toBeNull());
    await vi.waitFor(() => expect(drawer.querySelector(".zion-goal-record").disabled).toBe(false));
    drawer.querySelector(".zion-goal-record").click();
    await vi.waitFor(() => expect(drawer.querySelector("pre")?.textContent).toBe("持久化的实际输出"));
    expect(view.state.doc.toString()).toBe("user 保留未发送的草稿");
    expect(view.state.selection.main).toMatchObject({ anchor: 5, head: 9 });
    expect(undo(view)).toBe(false);
    drawer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(drawer.hidden).toBe(true);
    // The refreshed trigger is the focus return target even after polling replaced it.
    expect(document.activeElement.classList.contains("zion-goal-trigger")).toBe(true);
  } finally { app.dispose(); editor.destroy(); }
});

it("hides retained editor controls on tab changes and clears them on account changes", async () => {
  const editor = makeEditor("user 草稿", "one");
  let goal = { id: "g", status: "active", objective: "仅属于会话一" };
  const app = await goalWorkbench(editor, () => goal);
  try {
    await vi.waitFor(() => expect(editor.root.querySelector(".zion-goal-chrome").hidden).toBe(false));
    app.activeTabs[0].activeTabId = "other";
    app.emit("panel/tabActivated");
    expect(editor.root.querySelector(".zion-goal-chrome").hidden).toBe(true);
    app.activeTabs[0].activeTabId = "one";
    app.emit("panel/tabActivated");
    await vi.waitFor(() => expect(editor.root.querySelector(".zion-goal-chrome").hidden).toBe(false));
    goal = null;
    window.dispatchEvent(new Event("zion-account-changed"));
    expect(editor.root.querySelector(".zion-goal-chrome").hidden).toBe(true);
    expect(editor.root.textContent).not.toContain("仅属于会话一");
  } finally { app.dispose(); editor.destroy(); }
});

it("preserves edits during status refresh and saves through the scoped command without rewriting chat", async () => {
  const editor = makeEditor("user 原聊天");
  let goal = { id: "g", status: "paused", objective: "旧目标", runIds: [] };
  const app = await goalWorkbench(editor, (args) => {
    if (args.action === "amend") goal = { ...goal, objective: args.objective };
    return goal;
  });
  try {
    await app.commands.get("goal.status")();
    const drawer = editor.root.querySelector(".zion-goal-inspector");
    [...drawer.querySelectorAll("button")].find((node) => node.textContent === "调整目标").click();
    await vi.waitFor(() => expect(drawer.querySelector("textarea")).not.toBeNull());
    await vi.waitFor(() => expect([...drawer.querySelectorAll("button")].find((node) => node.textContent === "保存目标").disabled).toBe(false));
    const input = drawer.querySelector("textarea"); input.value = "保留原约束的新目标"; input.focus();
    app.emit("runtime/sessionRunEvent");
    await Promise.resolve(); await Promise.resolve();
    expect(drawer.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("保留原约束的新目标");
    const save = [...drawer.querySelectorAll("button")].find((node) => node.textContent === "保存目标");
    save.focus(); save.click();
    await vi.waitFor(() => expect(app.fetch.mock.calls.some(([, init]) => {
      const args = JSON.parse(init.body);
      return args.action === "amend" && args.sessionId === "session" && args.objective === "保留原约束的新目标";
    })).toBe(true));
    expect(editor.getView().state.doc.toString()).toBe("user 原聊天");
    await expect(app.commands.get("goal.start")({ objective: "重复目标" })).rejects.toThrow("已有持续目标");
    expect(editor.getView().state.doc.toString()).toBe("user 原聊天");
  } finally { app.dispose(); editor.destroy(); }
});

it("keeps the pause control stable during status refresh and shows pending feedback until Runtime stops", async () => {
  const editor = makeEditor("user 正在运行");
  let goal = { id: "g", status: "active", objective: "长任务", activeRunId: "run-a", runIds: ["run-a"] };
  let releasePause;
  const pauseResult = new Promise((resolve) => { releasePause = resolve; });
  const app = await goalWorkbench(editor, async (args) => {
    if (args.action === "pause") {
      await pauseResult;
      goal = { ...goal, status: "paused", reason: "user-pause", activeRunId: null };
    }
    return goal;
  });
  try {
    await vi.waitFor(() => expect(editor.root.querySelector(".zion-goal-chrome button:last-child")?.textContent).toBe("暂停"));
    const pause = editor.root.querySelector(".zion-goal-chrome button:last-child");
    pause.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    app.emit("runtime/sessionRunEvent");
    await vi.waitFor(() => expect(app.fetch.mock.calls.filter(([, init]) => JSON.parse(init.body).action === "status").length).toBeGreaterThan(1));
    expect(editor.root.querySelector(".zion-goal-chrome button:last-child")).toBe(pause);
    pause.click();
    expect(pause.textContent).toBe("正在暂停…");
    expect(pause.disabled).toBe(true);
    expect(app.fetch.mock.calls.some(([, init]) => JSON.parse(init.body).action === "pause")).toBe(true);
    releasePause();
    await vi.waitFor(() => expect(editor.root.querySelector(".zion-goal-chrome button:last-child")?.textContent).toBe("继续"));
  } finally { app.dispose(); editor.destroy(); }
});
