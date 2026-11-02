import { activeWorkflowSessionId, runtimePluginCommand } from "../../src/runtime/runtime-plugin-commands.ts";
import { stageGoal, completeGoalTrigger, goalCommandHighlight } from "./editor.js";
import { createGoalInspector, inspectorStyles } from "./inspector.js";
import { currentAccountSession } from "../../packages/account-ui/src/client";

const AUXILIARY_VIEW_ID = "dev.goal.inspector";

export async function activate(ctx) {
  const zion = window.zion, panels = new Set();
  let disposed = false, slashRegistered = false;
  const sessionFor = (editor) => String(editor ? editor.sessionId || "" : activeWorkflowSessionId(zion));
  const notify = (error) => zion.notification?.show?.(error.message, { type: "error", duration: 6000 });
  const command = (args) => runtimePluginCommand("dev.goal", args);
  const refreshAll = async () => { await Promise.all([...panels].map((panel) => panel.refresh())); };
  const start = async (args = {}, editor = zion.window?.activeEditor) => {
    const sessionId = sessionFor(editor), account = currentAccountSession();
    if (!sessionId) throw new Error("请先打开会话编辑器");
    // Do not insert a second activation into the document when a goal already exists.
    const current = await command({ action: "status", sessionId });
    if (disposed || sessionId !== sessionFor(editor) || account !== currentAccountSession()) return;
    if (current && !["completed", "cancelled"].includes(current.status)) {
      for (const panel of panels) if (panel.editor === editor) panel.showDetails();
      throw new Error("当前已有持续目标，请继续或取消后再开始新目标");
    }
    const objective = String(args.objective || "").trim();
    stageGoal(editor, objective);
    if (objective) await zion.commands.executeCommand("chat.run", {
      editor, panelId: editor.panelId, sessionId: sessionFor(editor),
      metadata: { goal: { action: "start", objective, tokenBudget: args.tokenBudget, criteria: args.criteria } }
    });
    await refreshAll();
  };
  const control = async (action, args = {}, editor = zion.window?.activeEditor) => {
    const result = await command({ ...args, action, sessionId: sessionFor(editor) });
    await refreshAll(); return result;
  };
  const activePanel = () => [...panels].find((panel) => panel.editor === zion.window?.activeEditor);
  let auxiliary = null;
  if (zion.auxiliaryBar?.registerView) {
    const host = document.createElement("div");
    host.className = "zion-goal-auxiliary-host";
    auxiliary = {
      host,
      isActive: () => zion.state?.get?.("ui.auxiliaryBar.visible") === true
        && String(zion.state?.get?.("ui.auxiliaryBar.activeViewId") || "") === AUXILIARY_VIEW_ID,
      open() {
        zion.auxiliaryBar.setWidth?.(Math.max(360, zion.state?.get?.("ui.auxiliaryBar.width") || 0));
        zion.auxiliaryBar.activateView(AUXILIARY_VIEW_ID);
        zion.auxiliaryBar.show();
      },
      close() { zion.auxiliaryBar.hide(); }
    };
    const auxiliaryView = zion.auxiliaryBar.registerView({
      id: AUXILIARY_VIEW_ID, pluginId: "dev.goal", title: "持续目标", icon: "$(target)",
      location: "auxiliarybar", order: 18, keepWhenActive: true,
      component: {
        render(container) {
          container.append(host);
          return { dispose() { if (host.parentNode === container) host.remove(); } };
        }
      },
      onActivate() {
        activePanel()?.showDetails({ activate: false, focus: false });
        void refreshAll();
      }
    });
    if (auxiliaryView) ctx.subscriptions.push(auxiliaryView);
  }
  const style = zion.styles?.register?.("dev.goal.inspector", inspectorStyles);
  if (style) ctx.subscriptions.push(style);
  else {
    const node = document.createElement("style"); node.textContent = inspectorStyles; document.head.append(node);
    ctx.subscriptions.push({ dispose() { node.remove(); } });
  }
  const decorator = zion.editor?.registerDecorator?.({ id: "dev.goal.panel", apply(editor) {
    const highlighting = goalCommandHighlight(editor);
    const panel = createGoalInspector(editor, {
      zion, sessionFor, command, start, notify, auxiliary, disposed: () => disposed
    });
    panels.add(panel);
    return { dispose() { panels.delete(panel); panel.dispose(); highlighting.dispose(); } };
  }});
  if (decorator) ctx.subscriptions.push(decorator);
  const actions = { start, status: async (_args = {}, editor = zion.window?.activeEditor) => {
    await refreshAll();
    for (const panel of panels) if (panel.editor === editor) panel.showDetails();
    return control("status", {}, editor);
  }, pause: (args = {}, editor) => control("pause", args, editor),
    resume: (args = {}, editor) => control("resume", args, editor),
    cancel: (args = {}, editor) => control("cancel", args, editor) };
  for (const [action, execute] of Object.entries(actions)) ctx.subscriptions.push(zion.commands.registerCommand(`goal.${action}`, execute));
  const registerSlash = () => {
    if (slashRegistered || !zion.slash?.registerCommand) return;
    slashRegistered = true;
    for (const [action, execute] of Object.entries(actions)) ctx.subscriptions.push(zion.slash.registerCommand({
      id: `goal.slash.${action}`, trigger: action === "start" ? "goal" : `goal-${action}`,
      title: { start: "开始目标", status: "目标状态", pause: "暂停目标", resume: "继续目标", cancel: "取消目标" }[action],
      description: action === "start" ? "补全 /goal，填写目标后使用发送快捷键开始" : "在当前会话中持续推进目标",
      category: "AI", icon: "$(target)", retainTrigger: action === "start",
      execute: action === "start" ? (_args, editor = zion.window?.activeEditor) => completeGoalTrigger(editor) : execute
    }));
  };
  registerSlash();
  const ready = zion.state?.onDidChange?.("workbench.pluginsReady", registerSlash);
  if (ready) ctx.subscriptions.push(ready);
  for (const event of ["runtime/sessionRunEvent", "chat/runFinished", "chat/aborted", "sessions/changed", "panel/tabActivated", "panel/focusChanged"]) {
    const subscription = zion.events?.on?.(event, () => {
      if (auxiliary?.isActive() && ["panel/tabActivated", "panel/focusChanged"].includes(event)) {
        activePanel()?.showDetails({ activate: false, focus: false });
      }
      void refreshAll();
    });
    if (subscription) ctx.subscriptions.push(subscription);
  }
  const auxiliaryChanged = zion.events?.on?.("ui/auxiliaryBarActiveViewChanged", ({ id } = {}) => {
    if (id === AUXILIARY_VIEW_ID) activePanel()?.showDetails({ activate: false, focus: false });
  });
  if (auxiliaryChanged) ctx.subscriptions.push(auxiliaryChanged);
  const changed = zion.state?.onDidChange?.("sessions.currentId", () => { void refreshAll(); });
  if (changed) ctx.subscriptions.push(changed);
  const auxiliaryVisible = zion.state?.onDidChange?.("ui.auxiliaryBar.visible", () => { void refreshAll(); });
  if (auxiliaryVisible) ctx.subscriptions.push(auxiliaryVisible);
  const onFocus = () => { void refreshAll(); };
  const onAccount = () => { for (const panel of panels) panel.clear(); void refreshAll(); };
  window.addEventListener("focus", onFocus);
  window.addEventListener("zion-account-changed", onAccount);
  const timer = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    for (const panel of panels) if (panel.active || sessionFor(panel.editor) !== panel.sessionId) void panel.refresh();
  }, 4000);
  ctx.subscriptions.push({ dispose() {
    disposed = true; clearInterval(timer); window.removeEventListener("focus", onFocus);
    window.removeEventListener("zion-account-changed", onAccount);
  }});
  return {};
}
