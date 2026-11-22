import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
import { Prec } from "@codemirror/state";
import { Decoration, ViewPlugin, WidgetType, keymap } from "@codemirror/view";
import { EditorCore } from "../../src/editor/EditorCore.ts";
import {
  finalizeProgrammaticSession,
  projectRunEventToSession
} from "../dev.langchain-chat/programmatic-session.js";
import {
  buildProgrammaticTaskBody,
  programmaticCompletionState,
  programmaticEventLogEntry
} from "./programmatic-task-core.js";
import {
  AGENTS_ACTIVE_STORAGE_KEY,
  AGENTS_TASKS_STORAGE_KEY,
  DEFAULT_AGENTS,
  OUTPUT_CONTRACT
} from "./agents-runtime-shared.js";
import {
  agentsSnapshotFromStorage,
  applyAgentsSnapshotToStorage,
  hasRuntimeActiveAgentTasks,
  loadAgentsSnapshotFromRuntime,
  shouldApplyRuntimeAgentsSnapshot,
  syncAgentsSnapshotToRuntime
} from "./agents-runtime-state.js";

const VIEW_ID = "dev.agents.panel";
const STORAGE_KEY = AGENTS_TASKS_STORAGE_KEY;
const ACTIVE_KEY = AGENTS_ACTIVE_STORAGE_KEY;
const CHANGED_EVENT = "agents/changed";
const TASK_BODY_EVENT = "zion:agent-task-body";
const I18N_NS = "dev.agents";

const I18N_MESSAGES = {
  "zh-CN": {
    "title": "智能体",
    "description": "锚定式智能体任务和委派的 AI 工作项",
    "toolbar.task": "任务",
    "toolbar.createTask": "创建智能体任务",
    "cmd.openPanel": "打开智能体",
    "cmd.createFromSelection": "为选区创建智能体任务",
    "cmd.createScratch": "新建临时智能体会话",
    "task.created": "已创建智能体任务",
    "task.scratchCreated": "已创建临时智能体会话",
    "task.noPrompt": "没有找到可委派的 user 提示或选区。",
    "task.defaultPrompt": "请基于选中的上下文，先整理 Context Brief，再给出可执行方案。",
    "task.scratchTitle": "临时探索",
    "task.scratchPrompt": "这是一个独立的临时 sub-agent 对话，不绑定当前主编辑器。请在这里输入要探索的问题。",
    "task.scratchContext": "独立临时对话",
    "task.run": "运行",
    "task.stop": "停止",
    "task.delete": "删除",
    "task.focusSource": "返回来源",
    "task.promote": "提升为会话",
    "task.queue": "任务队列",
    "task.detail": "任务详情",
    "task.context": "锚定上下文",
    "task.editor": "任务会话",
    "task.more": "详情",
    "task.count": "{count} 个任务",
    "task.runningCount": "{count} 个运行中",
    "task.status.idle": "未运行",
    "task.status.running": "运行中",
    "task.status.done": "已完成",
    "task.status.error": "出错",
    "task.status.aborted": "已停止",
    "task.empty.title": "还没有智能体任务",
    "task.empty.description": "选中文本后点击工具条里的任务，或在右键菜单中创建一个可委派任务。",
    "task.policy": "执行策略",
    "task.transcript": "运行日志",
    "task.result": "结构化结果",
    "task.noTranscript": "还没有运行日志。",
    "task.noResult": "运行完成后会提取 Context Brief、结果、证据和下一步。",
    "task.anchor.open": "打开智能体任务",
    "task.anchor.count": "{count} 个智能体任务",
    "task.promotedTitle": "智能体任务：{title}",
    "policy.none": "无",
    "policy.yes": "是",
    "policy.no": "否",
    "output.contextBrief": "Context Brief",
    "output.workResult": "Work Result",
    "output.evidence": "Evidence",
    "output.nextActions": "Next Actions",
    "policy.isolation": "隔离",
    "policy.permissions": "权限",
    "policy.tools": "工具",
    "policy.background": "后台",
    "policy.output": "输出",
    "agent.researcher": "研究员",
    "agent.planner": "规划员",
    "agent.implementer": "实现者",
    "agent.reviewer": "评审员",
    "best.title": "子智能体最佳实践",
    "best.context": "隔离上下文：任务只接收必要背景，主会话只收摘要。",
    "best.permissions": "权限约束：按 agent 类型限制工具、写入能力和确认策略。",
    "best.lifecycle": "生命周期：可后台运行、可停止、可恢复，并保留 transcript。",
    "best.outputs": "输出契约：先给 Context Brief，再给结果、证据和下一步。",
    "overview.subtitle": "由大模型通过 agentsManage 工具自主创建，也可以从选区创建。",
    "overview.empty": "等待模型委派智能体任务"
  },
  "en-US": {
    "title": "Agents",
    "description": "Anchored sub-agent tasks and delegated AI work items",
    "toolbar.task": "Task",
    "toolbar.createTask": "Create Agent Task",
    "cmd.openPanel": "Open Agents",
    "cmd.createFromSelection": "Create Agent Task From Selection",
    "cmd.createScratch": "New Temporary Agent Session",
    "task.created": "Agent Task created",
    "task.scratchCreated": "Temporary Agent session created",
    "task.noPrompt": "No delegatable user prompt or selection found.",
    "task.defaultPrompt": "Use the selected context. Start with a Context Brief, then provide an actionable plan.",
    "task.scratchTitle": "Temporary Exploration",
    "task.scratchPrompt": "This is an independent temporary sub-agent conversation, not bound to the current main editor. Type what you want to explore here.",
    "task.scratchContext": "Independent temporary conversation",
    "task.run": "Run",
    "task.stop": "Stop",
    "task.delete": "Delete",
    "task.focusSource": "Focus source",
    "task.promote": "Promote",
    "task.queue": "Queue",
    "task.detail": "Task Detail",
    "task.context": "Anchored Context",
    "task.editor": "Task Session",
    "task.more": "Details",
    "task.count": "{count} tasks",
    "task.runningCount": "{count} running",
    "task.status.idle": "Idle",
    "task.status.running": "Running",
    "task.status.done": "Done",
    "task.status.error": "Error",
    "task.status.aborted": "Stopped",
    "task.empty.title": "No Agent Tasks yet",
    "task.empty.description": "Select text and click Task in the toolbar, or create a delegated task from the context menu.",
    "task.policy": "Execution Policy",
    "task.transcript": "Run Log",
    "task.result": "Structured Result",
    "task.noTranscript": "No run log yet.",
    "task.noResult": "Context Brief, result, evidence, and next steps will be extracted after a run.",
    "task.anchor.open": "Open Agent Task",
    "task.anchor.count": "{count} Agent Tasks",
    "task.promotedTitle": "Agent Task: {title}",
    "policy.none": "none",
    "policy.yes": "yes",
    "policy.no": "no",
    "output.contextBrief": "Context Brief",
    "output.workResult": "Work Result",
    "output.evidence": "Evidence",
    "output.nextActions": "Next Actions",
    "policy.isolation": "Isolation",
    "policy.permissions": "Permissions",
    "policy.tools": "Tools",
    "policy.background": "Background",
    "policy.output": "Output",
    "agent.researcher": "Researcher",
    "agent.planner": "Planner",
    "agent.implementer": "Implementer",
    "agent.reviewer": "Reviewer",
    "best.title": "Sub-agent Best Practices",
    "best.context": "Isolate context: tasks receive only required background and return summaries.",
    "best.permissions": "Constrain capabilities: scope tools, write access, and confirmation policy by agent type.",
    "best.lifecycle": "Track lifecycle: backgroundable, stoppable, resumable, with transcript history.",
    "best.outputs": "Use output contracts: Context Brief, result, evidence, and next steps.",
    "overview.subtitle": "Created by the model through agentsManage, or manually from a selection.",
    "overview.empty": "Waiting for delegated Agent Tasks"
  }
};

const AUTO_TITLE_MAX_LENGTH = 36;

let lastTaskEditorHandle = null;
let pendingFocusTaskId = "";
const activeRuns = new Map();
let agentsRuntimeSyncTimer = 0;
let agentsRuntimeRestoreTimer = 0;
const AGENTS_RUNTIME_RESTORE_INTERVAL_MS = 1800;

function t(key, fallback, values) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return interpolate(fallback || key, values);
}

function interpolate(text, values) {
  if (!values || typeof values !== "object") return String(text || "");
  return String(text || "").replace(/\{([^}]+)\}/g, (_, key) => String(values[key] ?? ""));
}

function now() {
  return Date.now();
}

function uid(prefix = "agent") {
  return `${prefix}_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readTasks() {
  try {
    const current = window.zion?.state?.get?.("agents.tasks");
    if (Array.isArray(current)) return current.filter(Boolean);
  } catch {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeTasks(list, opts = {}) {
  const next = Array.isArray(list) ? list : [];
  try {
    window.zion?.state?.set?.("agents.tasks", next);
  } catch {}
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
  scheduleRuntimeAgentsSync();
  if (hasRuntimeActiveAgentTasks({ tasks: next })) {
    scheduleRuntimeAgentsRestore(AGENTS_RUNTIME_RESTORE_INTERVAL_MS);
  }
  if (!opts.silent) emitChanged();
}

function emitChanged() {
  try { window.zion?.events?.emit?.(CHANGED_EVENT, {}); } catch {}
  try { window.dispatchEvent(new CustomEvent("zion:agents-changed")); } catch {}
}

function syncCurrentAgentsSnapshotToRuntime() {
  const snapshot = agentsSnapshotFromStorage();
  return syncAgentsSnapshotToRuntime({ snapshot });
}

function scheduleRuntimeAgentsSync() {
  try {
    if (agentsRuntimeSyncTimer) window.clearTimeout(agentsRuntimeSyncTimer);
    agentsRuntimeSyncTimer = window.setTimeout(() => {
      agentsRuntimeSyncTimer = 0;
      void syncCurrentAgentsSnapshotToRuntime().catch(() => {});
    }, 250);
  } catch {}
}

function isRuntimeBackendActive() {
  try {
    if (String(window.zion?.state?.get?.("runtime.connection")?.backend || "") === "runtime") {
      return true;
    }
  } catch {}
  try {
    return String(localStorage.getItem("zion.runtime.mode") || "").trim() === "runtime";
  } catch {
    return false;
  }
}

async function refreshAgentsSnapshotFromRuntime() {
  try {
    const runtimeSnapshot = await loadAgentsSnapshotFromRuntime();
    if (!runtimeSnapshot) return { loaded: false, applied: false, snapshot: null };
    const localSnapshot = agentsSnapshotFromStorage();
    const applied = shouldApplyRuntimeAgentsSnapshot(localSnapshot, runtimeSnapshot);
    if (applied) {
      applyAgentsSnapshotToStorage(runtimeSnapshot);
      for (const task of runtimeSnapshot.tasks || []) {
        if (String(task?.body || "").trim()) {
          publishTaskBody(task.id, task.body);
        }
      }
      emitChanged();
    }
    return { loaded: true, applied, snapshot: runtimeSnapshot };
  } catch {
    return { loaded: false, applied: false, snapshot: null };
  }
}

function scheduleRuntimeAgentsRestore(delay = AGENTS_RUNTIME_RESTORE_INTERVAL_MS) {
  try {
    if (agentsRuntimeRestoreTimer) window.clearTimeout(agentsRuntimeRestoreTimer);
    if (!isRuntimeBackendActive()) return;
    agentsRuntimeRestoreTimer = window.setTimeout(() => {
      agentsRuntimeRestoreTimer = 0;
      void refreshAgentsSnapshotFromRuntime()
        .then((result) => {
          const snapshot = result.snapshot || agentsSnapshotFromStorage();
          if (hasRuntimeActiveAgentTasks(snapshot)) {
            scheduleRuntimeAgentsRestore(AGENTS_RUNTIME_RESTORE_INTERVAL_MS);
          }
        })
        .catch(() => {});
    }, Math.max(0, Number(delay) || 0));
  } catch {}
}

function publishTaskBody(taskId, body) {
  try {
    window.dispatchEvent(new CustomEvent(TASK_BODY_EVENT, {
      detail: { taskId, body }
    }));
  } catch {}
}

function patchTask(id, patch, opts = {}) {
  const list = readTasks();
  const idx = list.findIndex((item) => item?.id === id);
  if (idx < 0) return null;
  const next = { ...list[idx], ...patch, updatedAt: now() };
  list[idx] = next;
  writeTasks(list, opts);
  return next;
}

function deleteTask(id) {
  const list = readTasks().filter((item) => item?.id !== id);
  writeTasks(list);
  const active = getActiveTaskId();
  if (active === id) setActiveTask(list[0]?.id || "");
}

function getActiveTaskId() {
  try { return String(window.zion?.state?.get?.(ACTIVE_KEY) || localStorage.getItem(ACTIVE_KEY) || ""); } catch {}
  return "";
}

function setActiveTask(id) {
  const value = String(id || "");
  try { localStorage.setItem(ACTIVE_KEY, value); } catch {}
  try { window.zion?.state?.set?.(ACTIVE_KEY, value); } catch {}
  scheduleRuntimeAgentsSync();
  emitChanged();
}

function getTaskSessionId(task) {
  if (task?.taskSessionId) return String(task.taskSessionId);
  return task?.id ? `agent-task:${task.id}` : `agent-task:${uid("session")}`;
}

function getCurrentSessionId(editor) {
  try {
    const panelId = editor?.panelId || window.zion?.panels?.getActivePanelId?.();
    if (panelId) {
      const panel = window.zion?.panels?.list?.().find((item) => item.id === panelId);
      if (panel?.activeTabId) return String(panel.activeTabId);
    }
  } catch {}
  try { return window.zion?.state?.get?.("sessions.currentId") || "global"; } catch {}
  return "global";
}

function getLineRange(view, from, to) {
  try {
    const start = view.state.doc.lineAt(Math.max(0, from));
    const end = view.state.doc.lineAt(Math.max(0, to));
    return { lineFrom: start.number - 1, lineTo: end.number - 1 };
  } catch {
    return { lineFrom: 0, lineTo: 0 };
  }
}

function getAgentLabel(agent) {
  if (!agent) return "Agent";
  return t(agent.labelKey, agent.id || "Agent");
}

function getAgentDefinition(id) {
  return DEFAULT_AGENTS.find((item) => item.id === id) || DEFAULT_AGENTS[0];
}

function buildExecutionPlan(task) {
  const agent = getAgentDefinition(task?.agentId);
  return {
    runner: "local-chat-runner",
    isolation: task?.isolation || agent.isolation || "context",
    background: task?.background ?? agent.background ?? false,
    permissionMode: task?.permissionMode || agent.permissionMode || "default",
    tools: Array.isArray(task?.tools) ? task.tools : (agent.tools || []),
    disallowedTools: Array.isArray(task?.disallowedTools) ? task.disallowedTools : (agent.disallowedTools || []),
    modelPolicy: task?.modelPolicy || agent.modelPolicy || "inherit",
    maxTurns: Number(task?.maxTurns || agent.maxTurns || 8),
    outputContract: agent.outputContract || OUTPUT_CONTRACT
  };
}

function createRunEvent(type, data = {}) {
  return {
    id: uid("evt"),
    type,
    ts: now(),
    ...data
  };
}

function appendTaskEvent(taskId, type, data = {}, opts = {}) {
  const task = readTasks().find((item) => item?.id === taskId);
  if (!task) return null;
  const events = Array.isArray(task.events) ? task.events.slice(-80) : [];
  events.push(createRunEvent(type, data));
  return patchTask(taskId, { events }, opts);
}

function mergeTaskEvents(taskId, incoming) {
  const current = readTasks().find((item) => item?.id === taskId);
  const merged = new Map();
  for (const event of [
    ...(Array.isArray(current?.events) ? current.events : []),
    ...(Array.isArray(incoming) ? incoming : [])
  ]) {
    if (!event) continue;
    const key = String(event.id || `${event.type}:${event.ts}:${event.message || ""}`);
    merged.set(key, event);
  }
  return Array.from(merged.values())
    .sort((left, right) => Number(left?.ts || 0) - Number(right?.ts || 0))
    .slice(-80);
}

function parseContractSections(text) {
  const raw = String(text || "");
  const result = {};
  for (let i = 0; i < OUTPUT_CONTRACT.length; i += 1) {
    const current = OUTPUT_CONTRACT[i];
    const next = OUTPUT_CONTRACT[i + 1];
    const startRe = new RegExp(`(?:^|\\n)\\s{0,3}#{0,3}\\s*${escapeRegExp(current.heading)}\\s*:?[\\t ]*\\n`, "i");
    const start = startRe.exec(raw);
    if (!start) continue;
    const startIndex = start.index + start[0].length;
    let endIndex = raw.length;
    if (next) {
      const rest = raw.slice(startIndex);
      const nextRe = new RegExp(`\\n\\s{0,3}#{0,3}\\s*${escapeRegExp(next.heading)}\\s*:?[\\t ]*\\n`, "i");
      const nextMatch = nextRe.exec(rest);
      if (nextMatch) endIndex = startIndex + nextMatch.index;
    }
    result[current.id] = raw.slice(startIndex, endIndex).trim();
  }
  if (!Object.keys(result).length && raw.trim()) {
    result.workResult = raw.trim();
  }
  return result;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getTasksForSession(sessionId) {
  const sid = String(sessionId || "global");
  return readTasks()
    .filter((item) => String(item?.sessionId || "global") === sid)
    .sort(compareTasksStable);
}

function taskOrder(item) {
  if (typeof item?.from === "number") return item.from;
  if (typeof item?.lineFrom === "number") return item.lineFrom * 1000000;
  return Number.MAX_SAFE_INTEGER;
}

function compareTasksStable(a, b) {
  const byOrder = taskOrder(a) - taskOrder(b);
  if (byOrder) return byOrder;
  const byCreated = Number(a?.createdAt || 0) - Number(b?.createdAt || 0);
  if (byCreated) return byCreated;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function locateTaskAnchor(view, task) {
  const doc = view?.state?.doc;
  if (!doc || !task) return null;
  const from = Number(task.from);
  const to = Number(task.to);
  const quote = String(task.anchorText || task.quote || "");
  try {
    if (Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to <= doc.length && from <= to) {
      if (!quote || doc.sliceString(from, to) === quote) return { from, to };
    }
    if (quote) {
      const text = doc.toString();
      const idx = text.indexOf(quote);
      if (idx >= 0) return { from: idx, to: idx + quote.length };
    }
  } catch {}
  return null;
}

function createTaskFromSelection(ctx = {}) {
  const view = ctx.view || window.zion?.window?.activeEditor?.getView?.();
  if (!view) return null;
  const selection = view.state.selection?.main;
  const from = typeof ctx.from === "number" ? ctx.from : selection?.from;
  const to = typeof ctx.to === "number" ? ctx.to : selection?.to;
  if (typeof from !== "number" || typeof to !== "number" || from === to) return null;
  const anchorText = String(ctx.selectionText ?? view.state.sliceDoc(from, to)).trim();
  if (!anchorText) return null;
  const editor = window.zion?.window?.activeEditor;
  const sessionId = getCurrentSessionId(editor);
  const lines = getLineRange(view, from, to);
  const agent = getAgentDefinition("planner");
  const title = compactText(anchorText, 64);
  const prompt = t("task.defaultPrompt", "Use the selected context. Start with a Context Brief, then provide an actionable plan.");
  const task = {
    id: uid("task"),
    sessionId,
    panelId: editor?.panelId || window.zion?.panels?.getActivePanelId?.() || "",
    agentId: agent.id,
    title,
    prompt,
    body: `user ${prompt}`,
    anchorText,
    quote: anchorText,
    from,
    to,
    lineFrom: lines.lineFrom,
    lineTo: lines.lineTo,
    status: "idle",
    isolation: agent.isolation,
    background: agent.background,
    permissionMode: agent.permissionMode,
    tools: agent.tools,
    disallowedTools: agent.disallowedTools,
    modelPolicy: agent.modelPolicy,
    maxTurns: agent.maxTurns,
    events: [],
    result: null,
    runCount: 0,
    createdAt: now(),
    updatedAt: now()
  };
  const list = readTasks();
  list.push(task);
  writeTasks(list);
  setActiveTask(task.id);
  openAgentsPanel();
  try {
    window.zion?.notification?.show?.(t("task.created", "Agent Task created"), { type: "success", duration: 1400 });
  } catch {}
  return task;
}

function extractPromptContext(editor, promptOverride = "") {
  const view = editor?.getView?.() || window.zion?.window?.activeEditor?.getView?.();
  const doc = view?.state?.doc;
  const override = String(promptOverride || "").trim();
  if (!view || !doc) {
    return override ? { text: override, from: null, to: null, lineFrom: 0, lineTo: 0 } : null;
  }
  const selection = view.state.selection?.main;
  if (selection && selection.from !== selection.to) {
    const text = view.state.sliceDoc(selection.from, selection.to).trim();
    if (text) {
      const lines = getLineRange(view, selection.from, selection.to);
      return { text, from: selection.from, to: selection.to, lineFrom: lines.lineFrom, lineTo: lines.lineTo };
    }
  }
  if (override) {
    const line = doc.lineAt(selection?.from ?? doc.length);
    return { text: override, from: line.from, to: line.to, lineFrom: line.number - 1, lineTo: line.number - 1 };
  }
  const cursor = selection?.from ?? doc.length;
  const text = doc.toString();
  const before = text.slice(0, cursor);
  const roleRe = /(^|\n)\s*(system|user|assistant|tool)\s+/g;
  let match = null;
  let current = null;
  while ((match = roleRe.exec(before))) {
    current = match;
  }
  if (!current || String(current[2]).toLowerCase() !== "user") return null;
  const roleStart = current.index + current[1].length;
  const contentStart = roleStart + current[0].slice(current[1].length).length;
  roleRe.lastIndex = contentStart;
  const next = roleRe.exec(text);
  const contentEnd = next ? next.index + next[1].length : text.length;
  const raw = text.slice(contentStart, contentEnd).trim();
  if (!raw) return null;
  const startLine = doc.lineAt(roleStart);
  const endLine = doc.lineAt(Math.max(roleStart, contentEnd));
  return {
    text: raw,
    from: roleStart,
    to: contentEnd,
    lineFrom: startLine.number - 1,
    lineTo: endLine.number - 1
  };
}

function createTaskFromPrompt(opts = {}) {
  const editor = opts.editor || window.zion?.window?.activeEditor;
  const context = extractPromptContext(editor, opts.prompt || opts.selectionText || "");
  if (!context?.text) {
    try {
      window.zion?.notification?.show?.(t("task.noPrompt", "No delegatable user prompt or selection found."), { type: "warning", duration: 1800 });
    } catch {}
    return null;
  }
  const agent = getAgentDefinition(opts.agentId || inferAgentId(context.text));
  const sessionId = opts.sessionId || getCurrentSessionId(editor);
  const prompt = String(opts.instruction || t("task.defaultPrompt", "Use the selected context. Start with a Context Brief, then provide an actionable plan."));
  const task = {
    id: uid("task"),
    sessionId,
    panelId: opts.panelId || editor?.panelId || window.zion?.panels?.getActivePanelId?.() || "",
    agentId: agent.id,
    title: compactText(opts.title || context.text, 72),
    prompt,
    body: `user ${prompt}`,
    anchorText: context.text,
    quote: context.text,
    from: typeof context.from === "number" ? context.from : undefined,
    to: typeof context.to === "number" ? context.to : undefined,
    lineFrom: context.lineFrom || 0,
    lineTo: context.lineTo || context.lineFrom || 0,
    status: "idle",
    isolation: agent.isolation,
    background: agent.background,
    permissionMode: agent.permissionMode,
    tools: agent.tools,
    disallowedTools: agent.disallowedTools,
    modelPolicy: agent.modelPolicy,
    maxTurns: agent.maxTurns,
    events: [createRunEvent("task.created", { message: "created from prompt" })],
    result: null,
    runCount: 0,
    createdAt: now(),
    updatedAt: now()
  };
  const list = readTasks();
  list.push(task);
  writeTasks(list);
  setActiveTask(task.id);
  openAgentsPanel();
  try {
    window.zion?.notification?.show?.(t("task.created", "Agent Task created"), { type: "success", duration: 1400 });
  } catch {}
  return task;
}

function isScratchTask(task) {
  return !!task?.scratch;
}

function createScratchTask() {
  const agent = getAgentDefinition("researcher");
  const task = {
    id: uid("task"),
    sessionId: `scratch:${uid("session")}`,
    panelId: "",
    agentId: agent.id,
    title: t("task.scratchTitle", "Temporary Exploration"),
    prompt: t("task.scratchPrompt", "This is an independent temporary sub-agent conversation, not bound to the current main editor. Type what you want to explore here."),
    body: "user ",
    anchorText: "",
    quote: t("task.scratchContext", "Independent temporary conversation"),
    status: "idle",
    scratch: true,
    titleAuto: true,
    isolation: "context",
    background: agent.background,
    permissionMode: agent.permissionMode,
    tools: agent.tools,
    disallowedTools: agent.disallowedTools,
    modelPolicy: agent.modelPolicy,
    maxTurns: agent.maxTurns,
    events: [createRunEvent("task.created", { message: "created as scratch sub-agent session" })],
    result: null,
    runCount: 0,
    createdAt: now(),
    updatedAt: now()
  };
  const list = readTasks();
  list.push(task);
  writeTasks(list);
  setActiveTask(task.id);
  pendingFocusTaskId = task.id;
  openAgentsPanel();
  try {
    window.zion?.notification?.show?.(t("task.scratchCreated", "Temporary Agent session created"), { type: "success", duration: 1400 });
  } catch {}
  return task;
}

function inferAgentId(text) {
  const value = String(text || "").toLowerCase();
  if (/review|code review|审查|评审/.test(value)) return "reviewer";
  if (/implement|实现|修复|开发|改代码/.test(value)) return "implementer";
  if (/research|调研|进展|资料|竞品|趋势|infra|基础设施/.test(value)) return "researcher";
  return "planner";
}

function openAgentsPanel() {
  try { window.zion?.auxiliaryBar?.setWidth?.(Math.max(380, window.zion?.state?.get?.("ui.auxiliaryBar.width") || 0)); } catch {}
  try { window.zion?.auxiliaryBar?.activateView?.(VIEW_ID); } catch {}
}

function revealTask(taskId, opts = {}) {
  const task = typeof taskId === "object" ? taskId : readTasks().find((item) => item?.id === taskId) || null;
  if (!task) return false;
  setActiveTask(task.id);
  openAgentsPanel();
  const editor = opts.editor || window.zion?.window?.activeEditor;
  const view = editor?.getView?.();
  const anchor = locateTaskAnchor(view, task);
  if (view && anchor) {
    try {
      view.dispatch({ selection: { anchor: anchor.from, head: anchor.to }, scrollIntoView: true });
      if (opts.focus !== false) view.focus?.();
    } catch {}
  }
  return true;
}

class AgentMarkerWidget extends WidgetType {
  constructor(taskId, count) {
    super();
    this.taskId = taskId;
    this.count = count;
  }
  eq(other) {
    return other?.taskId === this.taskId && other?.count === this.count;
  }
  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zion-agent-anchor";
    button.title = this.count > 1
      ? t("task.anchor.count", "{count} Agent Tasks", { count: this.count })
      : t("task.anchor.open", "Open Agent Task");
    button.textContent = this.count > 1 ? String(this.count) : "T";
    button.onclick = (event) => {
      try { event.preventDefault(); event.stopPropagation(); } catch {}
      revealTask(this.taskId, { focus: false });
    };
    return button;
  }
  ignoreEvent() {
    return false;
  }
}

function buildTaskDecorations(view, editor) {
  const sessionId = getCurrentSessionId(editor);
  const tasks = getTasksForSession(sessionId);
  if (!tasks.length) return Decoration.none;
  const ranges = [];
  for (const task of tasks) {
    const anchor = locateTaskAnchor(view, task);
    if (!anchor) continue;
    if (anchor.to > anchor.from) ranges.push(Decoration.mark({ class: "zion-agent-range" }).range(anchor.from, anchor.to));
    ranges.push(Decoration.widget({ widget: new AgentMarkerWidget(task.id, 1), side: 1 }).range(anchor.to));
  }
  return Decoration.set(ranges, true);
}

function installAgentAnchors(editor) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.decorations = buildTaskDecorations(view, editor);
        this.onChanged = () => {
          this.decorations = buildTaskDecorations(this.view, editor);
          try { this.view.dispatch({}); } catch {}
        };
        try { window.addEventListener("zion:agents-changed", this.onChanged); } catch {}
      }
      update(update) {
        if (update.docChanged || update.viewportChanged) this.decorations = buildTaskDecorations(update.view, editor);
      }
      destroy() {
        try { window.removeEventListener("zion:agents-changed", this.onChanged); } catch {}
      }
    },
    { decorations: (value) => value.decorations }
  );
}

function renderAgentsPanel(container) {
  
const root = document.createElement("div");
  root.className = "zion-agents-panel";
  container.appendChild(root);
  const disposables = [];
  let disposed = false;
  let renderTimer = 0;
  let taskEditorHandle = null;

  const scheduleRender = () => {
    if (disposed) return;
    if (renderTimer) window.cancelAnimationFrame(renderTimer);
    renderTimer = window.requestAnimationFrame(render);
  };

  try { disposables.push(window.zion?.state?.onDidChange?.(ACTIVE_KEY, scheduleRender)); } catch {}
  try { disposables.push(window.zion?.events?.on?.(CHANGED_EVENT, scheduleRender)); } catch {}
  try { disposables.push(window.zion?.events?.on?.("i18n/changed", scheduleRender)); } catch {}
  try {
    const onChanged = () => scheduleRender();
    window.addEventListener("zion:agents-changed", onChanged);
    disposables.push({ dispose: () => window.removeEventListener("zion:agents-changed", onChanged) });
  } catch {}

  render();

  return {
    dispose() {
      disposed = true;
      if (renderTimer) window.cancelAnimationFrame(renderTimer);
      try { taskEditorHandle?.dispose?.(); } catch {}
      for (const d of disposables.splice(0)) {
        try { d?.dispose?.(); } catch {}
      }
      try { root.remove(); } catch {}
    }
  };

  function render() {
    const activeId = getActiveTaskId();
    const tasks = readTasks();
    const active = tasks.find((item) => item.id === activeId) || tasks[0] || null;
    if (active && active.id !== activeId) setActiveTask(active.id);
    try { taskEditorHandle?.dispose?.(); } catch {}
    taskEditorHandle = null;

    const shell = document.createElement("div");
    shell.className = "zion-agents-shell";
    shell.appendChild(renderOverview(tasks));
    const body = document.createElement("div");
    body.className = "zion-agents-body";
    body.appendChild(renderTaskList(tasks, active?.id || ""));
    body.appendChild(renderTaskDetail(active));
    shell.appendChild(body);
    root.replaceChildren(shell);
  }

  function renderOverview(tasks) {
    const box = document.createElement("div");
    box.className = "zion-agents-header";
    const running = tasks.filter((item) => item?.status === "running").length;
    const meta = document.createElement("div");
    meta.className = "zion-agents-stats";
    meta.innerHTML = tasks.length
      ? `<span>${escapeHtml(t("task.count", "{count} tasks").replace("{count}", String(tasks.length)))}</span><span>${escapeHtml(t("task.runningCount", "{count} running").replace("{count}", String(running)))}</span>`
      : `<span>${escapeHtml(t("overview.empty", "Waiting for delegated Agent Tasks"))}</span>`;
    box.appendChild(meta);
    return box;
  }

  function renderTaskList(tasks, activeId) {
    const list = document.createElement("div");
    list.className = "zion-agents-list";
    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "zion-agents-empty";
      empty.innerHTML = `<b>${escapeHtml(t("task.empty.title", "No Agent Tasks yet"))}</b><span>${escapeHtml(t("task.empty.description", ""))}</span>`;
      list.appendChild(empty);
      return list;
    }
    const sorted = tasks.slice().sort(compareTasksStable);
    for (const task of sorted) {
      const agent = getAgentDefinition(task.agentId);
      const row = document.createElement("button");
      row.type = "button";
      row.className = `zion-agents-row is-${statusClass(task.status)}${task.id === activeId ? " is-active" : ""}`;
      row.onclick = () => setActiveTask(task.id);
      const lineLabel = isScratchTask(task) ? t("task.scratchContext", "Independent temporary conversation") : `L${Number(task.lineFrom || 0) + 1}`;
      const metaLabel = [lineLabel, formatTime(task.updatedAt || task.createdAt)].filter(Boolean).join(" · ");
      const rowIcon = window.zionIcons?.htmlFromCodicon?.("agent", "zion-agents-row-icon")
        || `<span class="zion-agents-row-icon codicon codicon-hubot" aria-hidden="true"></span>`;
      row.innerHTML = [
        rowIcon,
        `<span class="zion-agents-row-main">`,
        `<span class="zion-agents-row-title">${escapeHtml(task.title || task.anchorText || task.id)}</span>`,
        `</span>`,
        `<span class="zion-agents-row-meta">${statusDot(task.status)}${escapeHtml(getAgentLabel(agent))} · ${escapeHtml(metaLabel)}</span>`
      ].join("");
      list.appendChild(row);
    }
    return list;
  }

  function renderTaskDetail(task) {
    const detail = document.createElement("div");
    detail.className = "zion-agents-detail";
    if (!task) {
      detail.appendChild(sectionHeader(t("task.detail", "Task Detail"), ""));
      return detail;
    }
    const agent = getAgentDefinition(task.agentId);
    const plan = buildExecutionPlan(task);
    const editorFrame = document.createElement("div");
    editorFrame.className = "zion-agents-editor-frame";
    const editorHeader = document.createElement("div");
    editorHeader.className = "zion-agents-editor-header";
    editorFrame.appendChild(editorHeader);
    const scratch = isScratchTask(task);

    const quoteButton = document.createElement("button");
    quoteButton.type = "button";
    quoteButton.className = `zion-agents-quote${scratch ? " is-scratch" : ""}`;
    quoteButton.title = scratch ? t("task.scratchContext", "Independent temporary conversation") : t("task.focusSource", "Focus source");
    quoteButton.innerHTML = `<span class="zion-agents-quote-label">${escapeHtml(getAgentLabel(agent))} · ${escapeHtml(statusLabel(task.status))}</span><span class="zion-agents-quote-text">${escapeHtml(compactText(scratch ? t("task.scratchContext", "Independent temporary conversation") : (task.anchorText || task.quote || task.title || task.id), 120))}</span>`;
    if (scratch) quoteButton.disabled = true;
    else quoteButton.onclick = () => revealTask(task.id);
    editorHeader.appendChild(quoteButton);

    const actions = document.createElement("div");
    actions.className = "zion-agents-actions";
    editorHeader.appendChild(actions);
    actions.appendChild(iconAction(task.status === "running" ? "stop" : "play", () => {
      if (task.status === "running") stopTask(task);
      else runTask(task, taskEditorHandle);
    }, task.status === "running" ? "danger" : "primary", task.status === "running" ? t("task.stop", "Stop") : t("task.run", "Run")));
    actions.appendChild(iconAction(
      "external",
      () => {
        if (task.linkedSessionId) {
          void window.zion?.commands?.executeCommand?.(
            "zion.sessions.switch",
            task.linkedSessionId
          );
          return;
        }
        void promoteTask(task, taskEditorHandle);
      },
      "",
      task.linkedSessionId ? "打开完整运行会话" : t("task.promote", "Promote")
    ));
    actions.appendChild(iconAction("trash", () => deleteTask(task.id), "danger", t("task.delete", "Delete")));

    const policy = renderExecutionPolicy(task);
    const result = renderStructuredResult(task);
    const log = renderTranscript(task);
    if (task.error) {
      const errorBanner = document.createElement("div");
      errorBanner.className = "zion-agents-error";
      errorBanner.setAttribute("role", "alert");
      errorBanner.textContent = task.error;
      editorFrame.appendChild(errorBanner);
    }
    const editorHost = document.createElement("div");
    editorHost.className = "zion-agents-editor-host";
    editorFrame.appendChild(editorHost);
    detail.appendChild(editorFrame);
    const more = document.createElement("details");
    more.className = "zion-agents-more";
    more.open = task.status === "running" || task.status === "error";
    const moreSummary = document.createElement("summary");
    moreSummary.textContent = t("task.more", "Details");
    more.appendChild(moreSummary);
    const moreContent = document.createElement("div");
    moreContent.className = "zion-agents-more-content";
    if (result) moreContent.appendChild(result);
    moreContent.appendChild(policy);
    if (!scratch) moreContent.appendChild(contextBlock(task));
    if (log) moreContent.appendChild(log);
    more.appendChild(moreContent);
    detail.appendChild(more);
    taskEditorHandle = createTaskEditor(editorHost, task);
    lastTaskEditorHandle = taskEditorHandle;
    if (pendingFocusTaskId === task.id) {
      pendingFocusTaskId = "";
      requestAnimationFrame(() => {
        try {
          const view = taskEditorHandle?.view;
          const pos = view?.state?.doc?.length;
          if (Number.isFinite(pos)) view.dispatch({ selection: { anchor: pos } });
          taskEditorHandle?.proxy?.focus?.();
          view?.focus?.();
        } catch {}
      });
    }
    return detail;
  }
}

function sectionHeader(title, meta = "") {
  const head = document.createElement("div");
  head.className = "zion-agents-section-head";
  const label = document.createElement("span");
  label.textContent = title;
  head.appendChild(label);
  if (meta) {
    const badge = document.createElement("span");
    badge.className = "zion-agents-section-meta";
    badge.textContent = meta;
    head.appendChild(badge);
  }
  return head;
}

function statusDot(status) {
  return `<span class="zion-agents-session-dot is-${statusClass(status)}" title="${escapeHtml(statusLabel(status))}"></span>`;
}

function contextBlock(task) {
  const box = document.createElement("details");
  box.className = "zion-agents-card";
  const summary = document.createElement("summary");
  summary.textContent = t("task.context", "Anchored Context");
  box.appendChild(summary);
  const quote = document.createElement("blockquote");
  quote.className = "zion-agents-context";
  quote.textContent = task.anchorText || task.quote || "";
  box.appendChild(quote);
  return box;
}

function renderExecutionPolicy(task) {
  const plan = buildExecutionPlan(task);
  const card = document.createElement("details");
  card.className = "zion-agents-card";
  const summary = document.createElement("summary");
  summary.textContent = `${t("task.policy", "Execution Policy")} · ${plan.runner}`;
  card.appendChild(summary);
  const chips = document.createElement("div");
  chips.className = "zion-agents-policy";
  chips.appendChild(policyChip(t("policy.isolation", "Isolation"), plan.isolation));
  chips.appendChild(policyChip(t("policy.permissions", "Permissions"), plan.permissionMode));
  chips.appendChild(policyChip(t("policy.tools", "Tools"), (plan.tools || []).join(", ") || t("policy.none", "none")));
  chips.appendChild(policyChip(t("policy.background", "Background"), plan.background ? t("policy.yes", "yes") : t("policy.no", "no")));
  chips.appendChild(policyChip(t("policy.output", "Output"), (plan.outputContract || []).map((item) => item.heading).join(" / ")));
  card.appendChild(chips);
  return card;
}

function policyChip(label, value) {
  const chip = document.createElement("span");
  chip.className = "zion-agents-policy-chip";
  chip.innerHTML = `<b>${escapeHtml(label)}</b><span>${escapeHtml(value)}</span>`;
  return chip;
}

function renderStructuredResult(task) {
  const result = task?.result || {};
  if (!Object.keys(result).length) return null;
  const box = document.createElement("details");
  box.className = "zion-agents-card zion-agents-result";
  box.open = true;
  const summary = document.createElement("summary");
  summary.textContent = t("task.result", "Structured Result");
  box.appendChild(summary);
  for (const item of OUTPUT_CONTRACT) {
    const value = String(result[item.id] || "").trim();
    if (!value) continue;
    const section = document.createElement("section");
    section.className = "zion-agents-result-section";
    const h = document.createElement("b");
    h.textContent = t(`output.${item.id}`, item.label);
    const p = document.createElement("div");
    p.textContent = value;
    section.appendChild(h);
    section.appendChild(p);
    box.appendChild(section);
  }
  return box;
}

function renderTranscript(task) {
  const events = Array.isArray(task?.events) ? task.events : [];
  if (!events.length) return null;
  const box = document.createElement("details");
  box.className = "zion-agents-card zion-agents-transcript";
  box.open = task?.status === "running" || task?.status === "error";
  const summary = document.createElement("summary");
  summary.textContent = `${t("task.transcript", "Run Log")} (${events.length})`;
  box.appendChild(summary);
  for (const event of events.slice(-12)) {
    const row = document.createElement("div");
    row.className = `zion-agents-event is-${String(event.type || "event").replace(/[^a-z0-9_-]/gi, "-")}`;
    const time = formatTime(event.ts);
    row.textContent = [time, event.type, event.message || event.status || event.runner || ""].filter(Boolean).join(" · ");
    box.appendChild(row);
  }
  return box;
}

function iconAction(iconName, onClick, tone = "", title = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `zion-agents-action${tone ? ` ${tone}` : ""}`;
  button.innerHTML = iconSvg(iconName);
  button.title = title || iconName;
  button.setAttribute("aria-label", title || iconName);
  button.onclick = () => {
    try { onClick?.(); } catch (err) { console.error("[agents] action failed", err); }
  };
  return button;
}

function iconSvg(name) {
  const map = {
    play: "play",
    stop: "debug-stop",
    external: "link-external",
    trash: "trash"
  };
  const codicon = map[name] || "play";
  try {
    const html = window.zionIcons?.htmlFromCodicon?.(codicon);
    if (html) return html;
  } catch {}
  return `<span class="codicon codicon-${codicon}" aria-hidden="true"></span>`;
}

function createTaskEditor(container, task) {
  const panelId = `agents:${task.id}`;
  const sessionId = getTaskSessionId(task);
  const core = new EditorCore(container, String(task.body || `user ${task.prompt || ""}`), panelId);
  core.setSessionId(sessionId);
  if (isScratchTask(task)) {
    try {
      const pos = core.view?.state?.doc?.length;
      if (Number.isFinite(pos)) core.view.dispatch({ selection: { anchor: pos } });
    } catch {}
  }
  try { core.setLineNumbersEnabled(false); } catch {}
  try { core.setFoldingEnabled(false); } catch {}
  const proxy = window.zion?.editor?.attachEditor?.(core, panelId) || null;
  try { proxy?.setSessionId?.(sessionId); } catch {}
  try { core.addExternalExtension(Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => { runTask(task, handle); return true; } }]))); } catch {}
  let saveTimer = 0;
  const onTaskBody = (event) => {
    if (String(event?.detail?.taskId || "") !== task.id) return;
    const body = String(event?.detail?.body || "");
    if (core.view.state.doc.toString() === body) return;
    const selection = core.view.state.selection.main;
    const nextAnchor = Math.min(body.length, selection.anchor);
    core.view.dispatch({
      changes: { from: 0, to: core.view.state.doc.length, insert: body },
      selection: { anchor: nextAnchor }
    });
  };
  window.addEventListener(TASK_BODY_EVENT, onTaskBody);
  try {
    core.addExternalExtension(EditorViewUpdateListener((text) => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => patchTask(task.id, { body: text, taskSessionId: sessionId }, { silent: true }), 220);
    }));
  } catch {}
  const handle = {
    core,
    proxy,
    view: core.view,
    panelId,
    sessionId,
    dispose() {
      if (saveTimer) clearTimeout(saveTimer);
      window.removeEventListener(TASK_BODY_EVENT, onTaskBody);
      try { patchTask(task.id, { body: core.view.state.doc.toString(), taskSessionId: sessionId }, { silent: true }); } catch {}
      try { window.zion?.editor?.detachEditor?.(panelId); } catch {}
      try { core.destroy?.(); } catch {}
    }
  };
  return handle;
}

function EditorViewUpdateListener(onChange) {
  return ViewPlugin.fromClass(class {
    update(update) {
      if (update.docChanged) onChange(update.view.state.doc.toString());
    }
  });
}

function buildTaskContextMessages(task) {
  const agent = getAgentDefinition(task.agentId);
  const plan = buildExecutionPlan(task);
  const contractText = (plan.outputContract || OUTPUT_CONTRACT)
    .map((item, index) => `${index + 1}. ${item.heading}: ${item.label}`)
    .join("\n");
  const system = [
    "你正在 Zion Agents 中执行一个独立的 sub-agent / Task。",
    "这个任务应模拟最佳实践：上下文隔离、权限约束、可恢复 transcript、明确输出契约。",
    "当前实现运行在浏览器内的独立任务会话中；如果需要真实文件写入或 worktree 执行，请在输出中明确建议 runner 计划。",
    "",
    `Agent: ${getAgentLabel(agent)} (${agent.id})`,
    `Runner: ${plan.runner}`,
    `Isolation: ${plan.isolation}`,
    `Background capable: ${plan.background ? "yes" : "no"}`,
    `Model policy: ${plan.modelPolicy}`,
    `Permission mode: ${plan.permissionMode}`,
    `Allowed capability hints: ${(plan.tools || []).join(", ")}`,
    `Disallowed capability hints: ${(plan.disallowedTools || []).join(", ") || "none"}`,
    `Max turns: ${plan.maxTurns}`,
    "",
    "Agent prompt:",
    agent.prompt,
    "",
    "Output contract:",
    contractText,
    "",
    "必须使用上述英文标题作为 Markdown 小节标题，方便 Zion 自动解析结构化结果。",
    "",
    `Source session: ${task.sessionId || "global"}`,
    `Task id: ${task.id}`,
    `Anchor lines: L${Number(task.lineFrom || 0) + 1}-L${Number(task.lineTo || task.lineFrom || 0) + 1}`,
    "",
    "Anchored context:",
    task.anchorText || task.quote || "（无）"
  ].join("\n");
  return [{ role: "system", content: system }];
}

function parseAutoTitlePayload(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const withoutFence = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const tryParse = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      const title = parsed && typeof parsed === "object" ? (parsed.title ?? parsed.name) : "";
      return typeof title === "string" ? title : "";
    } catch {
      return "";
    }
  };
  const direct = tryParse(withoutFence);
  if (direct) return direct;
  const match = withoutFence.match(/\{[\s\S]*?\}/);
  return match ? tryParse(match[0]) : "";
}

function looksLikeAnswerTitle(title) {
  const value = String(title || "").trim();
  if (!value) return true;
  if (Array.from(value).length > AUTO_TITLE_MAX_LENGTH) return true;
  if (/[。！？!?]\s*.+/.test(value)) return true;
  return /^(当然|可以|好的|首先|其次|以下|这里|这是|这个问题|答案|建议|Sure|Certainly|Here|You can|To )/i.test(value);
}

function cleanAutoTaskTitle(raw) {
  let title = parseAutoTitlePayload(raw);
  if (!title) title = String(raw || "").split("\n").find((line) => String(line || "").trim().length > 0) || "";
  title = title.replace(/^\s*(title|session title)\s*[:：]\s*/i, "");
  title = title.replace(/^\s*(name|session name)\s*[:：]\s*/i, "");
  title = title.replace(/^\s*标题\s*[:：]\s*/i, "");
  title = title.replace(/^\s*会话名\s*[:：]\s*/i, "");
  title = title.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/^[\-–—:：#*]+/, "").replace(/[\-–—:：#*]+$/, "").trim();
  if (looksLikeAnswerTitle(title)) return "";
  return title;
}

async function maybeGenerateScratchTaskTitle(task, transcript) {
  if (!isScratchTask(task) || task.titleAuto !== true) return false;
  const runStream = window.zion?.llm?.runStream;
  if (typeof runStream !== "function") return false;
  const text = String(transcript || task.body || "").trim();
  if (text.length < 12) return false;
  const excerpt = text.length > 6000 ? text.slice(0, 6000) : text;
  const messages = [
    {
      role: "system",
      content: [
        "你是会话标题生成器，不是聊天助手。",
        "任务：只根据用户提供的临时 sub-agent 对话内容生成一个会话名。",
        "禁止：不要回答会话里的问题，不要给建议，不要解释，不要复述内容，不要输出 Markdown。",
        "标题要求：2-18 个中文字符或 2-8 个英文单词；短、具体、像文件/会话标题；不要引号；不要句号。",
        "如果内容是在提问，也要概括主题，而不是回答问题。",
        "必须只输出一行严格 JSON，格式为：{\"title\":\"会话名\"}"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        "为下面的临时 sub-agent 对话生成会话名。",
        "再次强调：不要回答会话内容，只返回 JSON。",
        "",
        "<conversation>",
        excerpt,
        "</conversation>"
      ].join("\n")
    }
  ];
  let out = "";
  let error = null;
  await runStream({
    messages,
    tools: null,
    onToken: (token) => { out += String(token || ""); },
    onEnd: () => {},
    onError: (err) => { error = err || new Error("LLM error"); },
    runId: `agentTaskTitle-${task.id}-${Date.now()}`,
    sessionId: `agent-title:${task.id}`,
    requestSource: "agent-task-title",
    silentReasoning: true
  });
  if (error) return false;
  const title = cleanAutoTaskTitle(out);
  if (!title) return false;
  const latest = readTasks().find((item) => item?.id === task.id);
  if (!latest || !isScratchTask(latest) || latest.titleAuto !== true) return false;
  patchTask(task.id, { title, titleAuto: false }, { silent: true });
  return true;
}

async function runProgrammaticTask(task) {
  if (!task || activeRuns.has(task.id)) return null;
  if (!window.zion?.chat?.execute) throw new Error("Chat runtime is unavailable");
  const prompt = String(task.prompt || task.anchorText || "").trim();
  const runId = uid("run");
  const startedAt = now();
  let linkedSessionId = "";
  let sessionError = "";
  try {
    linkedSessionId = String(
      await window.zion?.commands?.executeCommand?.("zion.sessions.new", {
        title: task.title || `Agent Task: ${task.id}`,
        content: `user ${prompt}\n`,
        open: false,
        meta: {
          source: "agent-task",
          agentTaskId: task.id,
          agentId: task.agentId || "",
          projectAutomation: task.automation || null
        }
      }) || ""
    );
  } catch (error) {
    sessionError = error?.message || String(error);
  }
  const sessionId = linkedSessionId || `agent-task:${task.id}`;
  let traceEvents = mergeTaskEvents(task.id, [
    createRunEvent("runner.start", {
      runId,
      runner: "programmatic",
      message: task.executionPolicy?.preset || "read-only"
    }),
    ...(sessionError ? [createRunEvent("runner.session", {
      runId,
      message: `Session unavailable: ${sessionError}`
    })] : [])
  ]);
  patchTask(task.id, {
    status: "running",
    startedAt,
    activeRunId: runId,
    taskSessionId: sessionId,
    linkedSessionId,
    body: buildProgrammaticTaskBody(prompt, ""),
    result: null,
    error: "",
    runCount: Number(task.runCount || 0) + 1,
    events: traceEvents
  });
  let timeout = null;
  let flushTimer = null;
  let execution = null;
  let streamedOutput = "";
  const flushLiveState = (notify = false) => {
    if (flushTimer) window.clearTimeout(flushTimer);
    flushTimer = null;
    const body = buildProgrammaticTaskBody(prompt, streamedOutput);
    traceEvents = mergeTaskEvents(task.id, traceEvents);
    patchTask(task.id, {
      body,
      events: traceEvents,
      taskSessionId: sessionId,
      linkedSessionId
    }, { silent: true });
    publishTaskBody(task.id, body);
    if (notify) emitChanged();
  };
  const scheduleLiveFlush = () => {
    if (flushTimer) return;
    flushTimer = window.setTimeout(() => flushLiveState(false), 200);
  };
  const recordProgrammaticEvent = (event) => {
    const entry = programmaticEventLogEntry(event);
    if (!entry) return;
    traceEvents = mergeTaskEvents(task.id, [...traceEvents, entry]);
  };
  const projectEvent = async (event) => {
    if (!linkedSessionId) return;
    await projectRunEventToSession(
      window.zion,
      linkedSessionId,
      event,
      {
        requestSource: "agent-task",
        defaultError: "自动推进失败"
      }
    );
  };
  try {
    const source = task.automation?.projectKey
      ? { pluginId: "dev.identity", kind: "project", id: task.automation.projectKey }
      : { pluginId: "dev.agents", kind: "agent-task", id: task.id };
    execution = window.zion.chat.execute({
      title: task.title || `Agent Task: ${task.id}`,
      prompt,
      executionMode: "local-only",
      sessionId,
      source,
      trigger: task.automation ? "supervisor" : "user",
      metadata: {
        agentTaskId: task.id,
        agentId: task.agentId || "",
        automation: task.automation || null
      },
      policy: task.executionPolicy
    });
    activeRuns.set(task.id, {
      runId: execution.runId || runId,
      stop() {
        void execution.abort("user");
      }
    });
    const timeoutMs = Math.max(1, Number(task.timeoutMinutes || 10)) * 60_000;
    timeout = window.setTimeout(() => void execution.abort("timeout"), timeoutMs);
    const consuming = (async () => {
      if (!execution.events?.[Symbol.asyncIterator]) return;
      for await (const event of execution.events) {
        if (event.type === "message.delta") {
          streamedOutput += String(event.data?.delta || "");
        }
        recordProgrammaticEvent(event);
        await projectEvent(event);
        if (event.type === "message.delta") scheduleLiveFlush();
        else flushLiveState(true);
      }
    })();
    const completion = await execution.completion;
    await consuming;
    streamedOutput = String(completion?.output ?? streamedOutput);
    flushLiveState(false);
    const terminal = programmaticCompletionState(completion);
    const completedAt = now();
    const body = buildProgrammaticTaskBody(prompt, streamedOutput);
    patchTask(task.id, {
      status: terminal.status,
      completedAt,
      activeRunId: "",
      body,
      events: mergeTaskEvents(task.id, traceEvents),
      result: {
        workResult: streamedOutput,
        status: completion?.status || "failed",
        usage: completion?.usage || null
      },
      error: terminal.error
    });
    publishTaskBody(task.id, body);
    if (linkedSessionId) {
      await finalizeProgrammaticSession(window.zion, linkedSessionId, {
        agentTaskId: task.id,
        agentTaskStatus: terminal.status,
        agentTaskCompletedAt: completedAt,
        agentTaskError: terminal.error || null
      });
    }
    return completion;
  } catch (error) {
    const errorMessage = error?.message || String(error);
    const failedEvent = {
      schemaVersion: 1,
      eventId: uid("evt"),
      runId: execution?.runId || runId,
      sequence: 0,
      type: "run.failed",
      ts: now(),
      data: { error: errorMessage }
    };
    recordProgrammaticEvent(failedEvent);
    try { await projectEvent(failedEvent); } catch {}
    flushLiveState(false);
    const completedAt = now();
    const body = buildProgrammaticTaskBody(prompt, streamedOutput);
    patchTask(task.id, {
      status: "error",
      completedAt,
      activeRunId: "",
      body,
      events: mergeTaskEvents(task.id, traceEvents),
      result: {
        workResult: streamedOutput,
        status: "failed",
        usage: null
      },
      error: errorMessage
    });
    publishTaskBody(task.id, body);
    if (linkedSessionId) {
      try {
        await finalizeProgrammaticSession(window.zion, linkedSessionId, {
          agentTaskId: task.id,
          agentTaskStatus: "error",
          agentTaskCompletedAt: completedAt,
          agentTaskError: errorMessage
        });
      } catch {}
    }
    return {
      runId: execution?.runId || runId,
      status: "failed",
      error: errorMessage,
      output: streamedOutput
    };
  } finally {
    if (timeout) window.clearTimeout(timeout);
    if (flushTimer) window.clearTimeout(flushTimer);
    activeRuns.delete(task.id);
    emitChanged();
  }
}

async function runTask(task, handle) {
  if (!task) return;
  if (task.executionPolicy) return runProgrammaticTask(task);
  if (!handle?.view || !handle?.proxy) return;
  if (activeRuns.has(task.id)) return;
  const sessionId = getTaskSessionId(task);
  const runId = uid("run");
  const plan = buildExecutionPlan(task);
  const startedBody = handle.view.state.doc.toString();
  const eventDisposables = [];
  const record = (type, data = {}) => appendTaskEvent(task.id, type, { runId, ...data }, { silent: true });
  const watch = (eventName, type) => {
    try {
      const d = window.zion?.events?.on?.(eventName, (payload) => {
        if (String(payload?.sessionId || "") !== sessionId) return;
        record(type, { message: eventName, status: payload?.status || "" });
      });
      if (d) eventDisposables.push(d);
    } catch {}
  };
  watch("chat/runStarted", "chat.start");
  watch("chat/runFinished", "chat.finish");
  watch("chat/runError", "chat.error");
  watch("chat/aborted", "chat.abort");
  activeRuns.set(task.id, {
    runId,
    stop() {
      try { window.zion?.commands?.executeCommand?.("chat.stop", sessionId); } catch {}
    }
  });
  patchTask(task.id, {
    status: "running",
    startedAt: now(),
    activeRunId: runId,
    taskSessionId: sessionId,
    body: startedBody,
    runner: plan,
    result: null,
    events: [createRunEvent("runner.start", { runId, runner: plan.runner, message: `${plan.isolation} / ${plan.permissionMode}` })],
    runCount: Number(task.runCount || 0) + 1
  }, { silent: true });
  try {
    record("runner.context", {
      message: `${String(task.anchorText || task.quote || "").length} chars anchored; tools=${(plan.tools || []).join(",") || "none"}`
    });
    await window.zion?.commands?.executeCommand?.("chat.run", {
      editor: handle.proxy,
      sessionId,
      panelId: handle.panelId,
      skipSessionPersistence: true,
      usageSessionId: task.sessionId,
      requestSource: "agents",
      contextMessages: buildTaskContextMessages(task)
    });
    const body = handle.view.state.doc.toString();
    const result = parseContractSections(body);
    record("runner.complete", { message: Object.keys(result).length ? "structured result extracted" : "completed" });
    patchTask(task.id, {
      status: "done",
      completedAt: now(),
      activeRunId: "",
      body,
      result
    }, { silent: true });
    try { await maybeGenerateScratchTaskTitle(task, body); } catch {}
  } catch (err) {
    record("runner.error", { message: err?.message || String(err || "unknown") });
    patchTask(task.id, {
      status: "error",
      activeRunId: "",
      error: err?.message || String(err || "unknown"),
      body: handle.view.state.doc.toString()
    }, { silent: true });
  } finally {
    activeRuns.delete(task.id);
    for (const d of eventDisposables.splice(0)) {
      try { d?.dispose?.(); } catch {}
    }
  }
  emitChanged();
}

function stopTask(task) {
  const active = activeRuns.get(task?.id);
  if (active) {
    try { active.stop(); } catch {}
  } else {
    try { window.zion?.commands?.executeCommand?.("chat.stop", getTaskSessionId(task)); } catch {}
  }
  appendTaskEvent(task.id, "runner.stop", { runId: active?.runId || task?.activeRunId || "", message: "stop requested" }, { silent: true });
  patchTask(task.id, { status: "aborted", activeRunId: "" });
}

async function promoteTask(task, handle) {
  if (!task) return null;
  const body = handle?.view?.state?.doc?.toString?.() || task.body || "";
  const plan = buildExecutionPlan(task);
  const result = task.result || parseContractSections(body);
  const content = [
    `# Agent Task: ${task.title || task.id}`,
    "",
    `Agent: ${task.agentId || "agent"}`,
    `Source session: ${task.sessionId || "global"}`,
    `Runner: ${plan.runner}`,
    `Isolation: ${plan.isolation}`,
    `Permission mode: ${plan.permissionMode}`,
    `Tools: ${(plan.tools || []).join(", ") || "none"}`,
    "",
    "## Structured Result",
    "",
    ...OUTPUT_CONTRACT.flatMap((item) => {
      const value = String(result?.[item.id] || "").trim();
      return value ? [`### ${item.heading}`, "", value, ""] : [];
    }),
    "",
    "## Anchored Context",
    "",
    task.anchorText || task.quote || "",
    "",
    "## Run Events",
    "",
    ...(Array.isArray(task.events) ? task.events.map((event) => `- ${new Date(event.ts || Date.now()).toISOString()} ${event.type}: ${event.message || event.status || event.runner || ""}`) : []),
    "",
    "## Transcript",
    "",
    body
  ].join("\n");
  try {
    const id = await window.zion?.commands?.executeCommand?.("zion.sessions.new", {
      title: t("task.promotedTitle", "Agent Task: {title}", { title: compactText(task.title || task.id, 42) }),
      content,
      panelId: task.panelId || window.zion?.panels?.getActivePanelId?.() || null,
      focus: true
    });
    if (id) patchTask(task.id, { promotedSessionId: id });
    return id || null;
  } catch {
    return null;
  }
}

function statusLabel(status) {
  const key = `task.status.${status || "idle"}`;
  return t(key, status || "idle");
}

function statusClass(status) {
  const value = String(status || "idle").toLowerCase();
  if (["running", "done", "error", "aborted"].includes(value)) return value;
  return "idle";
}

function formatTime(value) {
  const n = Number(value || 0);
  if (!n) return "";
  const d = new Date(n);
  const nowMs = Date.now();
  if (nowMs - n < 86400000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString();
}

function compactText(text, max = 80) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (raw.length <= max) return raw;
  return `${raw.slice(0, Math.max(0, max - 1))}…`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function installAgentApi() {
  const api = {
    listTasks: () => readTasks(),
    getTask: (id) => readTasks().find((item) => item?.id === id) || null,
    getTasksForSession,
    getExecutionPlan: buildExecutionPlan,
    isRunning: (id) => activeRuns.has(id),
    refreshRuntimeSnapshot: refreshAgentsSnapshotFromRuntime,
    runTask: (id, handle = lastTaskEditorHandle) => {
      const task = readTasks().find((item) => item?.id === id);
      return task ? runTask(task, handle) : null;
    },
    runTaskHeadless,
    stopTask: (id) => {
      const task = readTasks().find((item) => item?.id === id);
      return task ? stopTask(task) : null;
    },
    createTask: (task) => {
      const agent = getAgentDefinition(task?.agentId || "planner");
      const next = {
        ...task,
        id: task?.id || uid("task"),
        agentId: task?.agentId || agent.id,
        isolation: task?.isolation || agent.isolation,
        background: task?.background ?? agent.background,
        permissionMode: task?.permissionMode || agent.permissionMode,
        tools: task?.tools || agent.tools,
        disallowedTools: task?.disallowedTools || agent.disallowedTools,
        modelPolicy: task?.modelPolicy || agent.modelPolicy,
        maxTurns: task?.maxTurns || agent.maxTurns,
        events: Array.isArray(task?.events) ? task.events : [],
        createdAt: task?.createdAt || now(),
        updatedAt: now()
      };
      const list = readTasks();
      list.push(next);
      writeTasks(list);
      return next;
    },
    updateTask: (id, patch) => patchTask(id, patch),
    deleteTask,
    revealTask,
    openPanel: openAgentsPanel,
    listAgents: () => DEFAULT_AGENTS.slice(),
    getAgent: getAgentDefinition
  };
  window.zion.agents = api;
  try { window.zion?.state?.set?.("agents.tasks", readTasks()); } catch {}
  return { dispose() { try { if (window.zion.agents === api) delete window.zion.agents; } catch {} } };
}


function registerAgentTool(disposables) {
  const tool = {
    type: "function",
    function: {
      name: "agentsManage",
      description: [
        "管理 Zion Agent Tasks / sub-agents。",
        "当用户要求用 subagent、agent、task、委派、并行调研、后台调研、代码评审或实现子任务时使用。",
        "优先 create_task 或 create_research_task；只有用户明确要求立即执行时才 run_task。"
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list_agents", "list_tasks", "get_task", "create_task", "create_research_task", "reveal_task", "run_task", "stop_task", "delete_task", "open_panel"],
            description: "要执行的 Agent Task 操作"
          },
          task_id: { type: "string", description: "已有 Agent Task ID，get/reveal/run/stop/delete 时使用" },
          agent_id: { type: "string", enum: ["researcher", "planner", "implementer", "reviewer"], description: "创建任务时指定 sub-agent 类型" },
          prompt: { type: "string", description: "要委派给 sub-agent 的任务说明；创建任务时建议必填" },
          title: { type: "string", description: "任务标题，可选" },
          instruction: { type: "string", description: "给 sub-agent 的执行指令，可选" },
          session_id: { type: "string", description: "源会话 ID；不传则使用当前聊天会话" },
          run: { type: "boolean", description: "创建后是否立即后台运行；默认 false" }
        },
        required: ["action"],
        additionalProperties: false
      }
    }
  };

  const existingTools = window.zion?.state?.get("chat.tools") || [];
  const toolNames = new Set(existingTools.map((item) => item?.function?.name).filter(Boolean));
  if (!toolNames.has("agentsManage")) {
    window.zion?.state?.set("chat.tools", [...existingTools, tool]);
  }

  const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };
  handlers.agentsManage = async (args = {}, toolCtx = {}) => {
    const action = String(args?.action || "").trim();
    const taskId = String(args?.task_id || "").trim();
    const sourceSessionId = String(args?.session_id || toolCtx?.sessionId || "").trim();
    const summarizeTask = (task) => task ? ({
      id: task.id,
      title: task.title,
      agentId: task.agentId,
      status: task.status,
      sessionId: task.sessionId,
      lineFrom: task.lineFrom,
      lineTo: task.lineTo,
      runner: task.runner || buildExecutionPlan(task),
      result: task.result || null,
      updatedAt: task.updatedAt
    }) : null;

    if (action === "list_agents") {
      return JSON.stringify(DEFAULT_AGENTS.map((agent) => ({
        id: agent.id,
        label: getAgentLabel(agent),
        isolation: agent.isolation,
        background: agent.background,
        permissionMode: agent.permissionMode,
        tools: agent.tools,
        disallowedTools: agent.disallowedTools,
        outputContract: (agent.outputContract || OUTPUT_CONTRACT).map((item) => item.heading)
      })), null, 2);
    }

    if (action === "list_tasks") {
      const tasks = sourceSessionId ? getTasksForSession(sourceSessionId) : readTasks();
      return JSON.stringify({ tasks: tasks.map(summarizeTask) }, null, 2);
    }

    if (action === "get_task") {
      if (!taskId) return "Missing task_id";
      return JSON.stringify(summarizeTask(readTasks().find((item) => item?.id === taskId)), null, 2);
    }

    if (action === "create_task" || action === "create_research_task") {
      const prompt = String(args?.prompt || "").trim();
      if (!prompt) return "Missing prompt";
      const agentId = action === "create_research_task" ? "researcher" : (args?.agent_id || inferAgentId(prompt));
      const task = createTaskFromPrompt({
        prompt,
        title: args?.title || prompt,
        instruction: args?.instruction || "",
        agentId,
        sessionId: sourceSessionId || undefined
      });
      if (!task) return "Failed to create Agent Task";
      if (args?.run === true) {
        const runResult = await runTaskHeadless(task.id);
        return JSON.stringify({ created: summarizeTask(readTasks().find((item) => item?.id === task.id) || task), run: runResult }, null, 2);
      }
      return JSON.stringify({ created: summarizeTask(task), next: "Task created. Use agentsManage action=run_task to run it, or inspect @context > Agents." }, null, 2);
    }

    if (action === "reveal_task") {
      if (!taskId) return "Missing task_id";
      return JSON.stringify({ revealed: revealTask(taskId, { focus: false }) }, null, 2);
    }

    if (action === "run_task") {
      if (!taskId) return "Missing task_id";
      return JSON.stringify(await runTaskHeadless(taskId), null, 2);
    }

    if (action === "stop_task") {
      if (!taskId) return "Missing task_id";
      const task = readTasks().find((item) => item?.id === taskId);
      if (!task) return `Task not found: ${taskId}`;
      stopTask(task);
      return JSON.stringify({ stopped: taskId }, null, 2);
    }

    if (action === "delete_task") {
      if (!taskId) return "Missing task_id";
      deleteTask(taskId);
      return JSON.stringify({ deleted: taskId }, null, 2);
    }

    if (action === "open_panel") {
      openAgentsPanel();
      return JSON.stringify({ opened: true }, null, 2);
    }

    return `Unknown action: ${action}`;
  };
  window.zion?.state?.set("chat.toolHandlers", handlers);

  try {
    const names = (window.zion?.state?.get("chat.tools") || []).map((item) => item?.function?.name).filter(Boolean);
    window.zion?.state?.set("chat.toolsKnownNames", names);
    const enabled = window.zion?.state?.get("chat.enabledTools");
    if (!Array.isArray(enabled) || enabled.length === 0) {
      window.zion?.state?.set("chat.enabledTools", names);
    } else if (!enabled.includes("agentsManage")) {
      window.zion?.state?.set("chat.enabledTools", [...enabled, "agentsManage"]);
    }
  } catch {}

  disposables.push({
    dispose() {
      try {
        const tools = (window.zion?.state?.get("chat.tools") || []).filter((item) => item?.function?.name !== "agentsManage");
        window.zion?.state?.set("chat.tools", tools);
        const current = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };
        if (current.agentsManage === handlers.agentsManage) {
          delete current.agentsManage;
          window.zion?.state?.set("chat.toolHandlers", current);
        }
      } catch {}
    }
  });
}

async function runTaskHeadless(taskId) {
  const task = readTasks().find((item) => item?.id === taskId);
  if (!task) return { ok: false, error: `Task not found: ${taskId}` };
  let handle = null;
  let host = null;
  try {
    if (task.executionPolicy) {
      await runTask(task, null);
      let next = readTasks().find((item) => item?.id === taskId);
      if (next?.status === "running" && !activeRuns.has(taskId)) {
        next = patchTask(taskId, {
          status: "error",
          activeRunId: "",
          completedAt: now(),
          error: next.error || "自动推进异常结束"
        });
      }
      return {
        ok: next?.status === "done",
        task: next ? {
          id: next.id,
          status: next.status,
          result: next.result || null,
          error: next.error || ""
        } : null
      };
    }
    if (lastTaskEditorHandle?.sessionId === getTaskSessionId(task)) {
      handle = lastTaskEditorHandle;
    } else {
      host = document.createElement("div");
      host.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:420px;height:360px;opacity:0;pointer-events:none;";
      document.body.appendChild(host);
      handle = createTaskEditor(host, task);
    }
    await runTask(task, handle);
    const next = readTasks().find((item) => item?.id === taskId);
    return { ok: next?.status === "done", task: next ? { id: next.id, status: next.status, result: next.result || null, error: next.error || "" } : null };
  } finally {
    if (host) {
      try { handle?.dispose?.(); } catch {}
      try { host.remove(); } catch {}
    }
  }
}

export async function activate(ctx) {
  const disposables = [];
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) disposables.push(disp);
  } catch {}
  disposables.push(installAgentApi());
  void refreshAgentsSnapshotFromRuntime()
    .then((result) => {
      if (!result.loaded) scheduleRuntimeAgentsSync();
      const snapshot = result.snapshot || agentsSnapshotFromStorage();
      if (hasRuntimeActiveAgentTasks(snapshot)) {
        scheduleRuntimeAgentsRestore(AGENTS_RUNTIME_RESTORE_INTERVAL_MS);
      }
    })
    .catch(() => {});
  disposables.push(window.zion.commands.registerCommand("agents.openPanel", openAgentsPanel));
  disposables.push(window.zion.commands.registerCommand("agents.createTaskFromSelection", () => {
    const editor = window.zion?.window?.activeEditor;
    const view = editor?.getView?.();
    const sel = view?.state?.selection?.main;
    if (!view || !sel) return null;
    return createTaskFromSelection({ view, from: sel.from, to: sel.to, selectionText: view.state.sliceDoc(sel.from, sel.to) });
  }));
  disposables.push(window.zion.commands.registerCommand("agents.createScratch", createScratchTask));
  disposables.push(window.zion.commands.registerCommand("agents.revealTask", revealTask));
  try {
    const onScratchShortcut = (event) => {
      try {
        const key = String(event?.key || "").toLowerCase();
        if (event?.repeat) return;
        if (key !== "i" || !event?.metaKey || !event?.shiftKey || event?.ctrlKey || event?.altKey) return;
        const target = event?.target;
        const tag = String(target?.tagName || "").toLowerCase();
        const inPlainInput = tag === "input" || tag === "textarea" || tag === "select";
        if (inPlainInput) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        createScratchTask();
      } catch {}
    };
    window.addEventListener("keydown", onScratchShortcut, true);
    disposables.push({ dispose: () => window.removeEventListener("keydown", onScratchShortcut, true) });
  } catch {}
  registerAgentTool(disposables);
  try {
    const view = window.zion.auxiliaryBar?.registerView?.({
      id: VIEW_ID,
      pluginId: "dev.agents",
      title: t("title", "Agents"),
      titleKey: "dev.agents.title",
      icon: "$(agent)",
      order: 5,
      keepWhenActive: true,
      component: { render: renderAgentsPanel }
    });
    if (view) disposables.push(view);
  } catch {}
  try {
    const selectionItem = window.zion.editor?.selectionToolbar?.registerItem?.({
      id: "agents.create",
      order: 19,
      title: t("toolbar.createTask", "Create Agent Task"),
      titleKey: "dev.agents.toolbar.createTask",
      label: t("toolbar.task", "Task"),
      labelKey: "dev.agents.toolbar.task",
      codicon: "agent",
      when: (toolbarCtx) => !!String(toolbarCtx?.selectionText || "").trim(),
      run: createTaskFromSelection
    });
    if (selectionItem) disposables.push(selectionItem);
  } catch {}
  try {
    const menu = window.zion.menus?.register?.("editor/context", {
      command: "agents.createTaskFromSelection",
      title: t("toolbar.createTask", "Create Agent Task"),
      titleKey: "dev.agents.toolbar.createTask",
      when: "editorFocus",
      order: 19
    });
    if (menu) disposables.push(menu);
  } catch {}
  try {
    const decorator = window.zion.editor?.registerDecorator?.({
      id: "dev.agents.anchors",
      apply(editor) {
        if (String(editor?.panelId || "").startsWith("agents:")) return { dispose() {} };
        try { editor.addVisualExtension(installAgentAnchors(editor)); } catch {}
        return { dispose() {} };
      }
    });
    if (decorator) disposables.push(decorator);
  } catch {}
  try {
    const runtimeDisp = window.zion.state?.onDidChange?.(
      "runtime.connection",
      () => {
        void refreshAgentsSnapshotFromRuntime()
          .then((result) => {
            if (!result.loaded) scheduleRuntimeAgentsSync();
            const snapshot = result.snapshot || agentsSnapshotFromStorage();
            if (hasRuntimeActiveAgentTasks(snapshot)) {
              scheduleRuntimeAgentsRestore(0);
            }
          })
          .catch(() => {});
      }
    );
    if (runtimeDisp) disposables.push(runtimeDisp);
  } catch {}
  const disposable = {
    dispose() {
      try {
        if (agentsRuntimeSyncTimer) window.clearTimeout(agentsRuntimeSyncTimer);
        if (agentsRuntimeRestoreTimer) window.clearTimeout(agentsRuntimeRestoreTimer);
      } catch {}
      agentsRuntimeSyncTimer = 0;
      agentsRuntimeRestoreTimer = 0;
      for (const d of disposables.splice(0)) {
        try { d?.dispose?.(); } catch {}
      }
    }
  };
  try { ctx?.subscriptions?.push?.(disposable); } catch {}
  return disposable;
}
