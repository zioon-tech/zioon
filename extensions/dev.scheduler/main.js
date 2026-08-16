import { LocalSchedulerEngine } from "./engine.js";
import { ACTIVE_RUN_STATUSES, buildSchedulerTask, SchedulerController, validateSchedulerTask } from "./controller.js";
import { describeSchedule, normalizeSchedule } from "./schedule.js";
import { SchedulerServiceClient } from "./service-api.js";
import {
  archiveDateForTimestamp,
  buildScheduledSessionContent,
  ensureScheduledSessionDateFolder,
  ensureScheduledSessionFolder,
  migrateScheduledSessions,
  scheduledSessionTagForDate,
  sessionTagForLocale,
  withSessionTag
} from "./session-archive.js";
import { registerSchedulerTool } from "./scheduler-tools.js";
import { LocalSchedulerStore } from "./store.js";

const VIEW_ID = "scheduler.tasks";
const STATUS_ID = "dev.scheduler.status";
const MAX_CONCURRENT_SERVICE_RUNS = 3;

function currentLocale() {
  return String(
    window.zion?.i18n?.getLocale?.()
    || window.zion?.state?.get?.("ui.locale")
    || "zh-CN"
  );
}

function id(prefix) {
  try {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === "function") return `${prefix}_${randomUUID.call(globalThis.crypto)}`;
  } catch {}
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatDate(value) {
  if (!value) return "—";
  try { return new Date(Number(value)).toLocaleString(); } catch { return "—"; }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function localDateTimeValue(timestamp) {
  const date = new Date(Number(timestamp) || Date.now() + 60 * 60_000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function runStatusLabel(status, run = null) {
  if (status === "success") return "成功";
  if (status === "running") return "运行中";
  if (status === "failed") return "失败";
  if (status === "aborted") return "已中止";
  if (status === "pending") {
    const queuedAt = Number(run?.createdAt || run?.scheduledFor || run?.startedAt || 0);
    return queuedAt > 0 && Date.now() - queuedAt > 5000 ? "等待执行" : "正在启动";
  }
  if (status === "claimed") return "已领取";
  return status || "未知";
}

function taskState(task, engine, activeRun = null) {
  if (engine?.isRunning?.(task.id)) return "running";
  if (task.executionMode === "service-backed" && ACTIVE_RUN_STATUSES.has(activeRun?.status)) {
    return activeRun.status;
  }
  return task.enabled ? "enabled" : "paused";
}

function isCommandTask(task) {
  return (task?.taskType || "agent") === "command";
}

function taskTypeLabel(task) {
  return isCommandTask(task) ? "命令" : "Agent";
}

function compactCommand(command) {
  const value = String(command || "").replace(/\s+/g, " ").trim();
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function taskListMeta(task, next) {
  const type = taskTypeLabel(task);
  const command = isCommandTask(task) ? ` · ${compactCommand(task.command) || "未设置命令"}` : "";
  return `${type} · ${describeSchedule(task.schedule)}${command} · ${next}`;
}

export async function projectRunEventToSession(zion, sessionId, event) {
  if (!sessionId || !event) return;
  const payload = {
    runId: event.runId,
    assistantBlockId: event.runId,
    sessionId,
    panelId: null,
    requestSource: "scheduled-task"
  };
  if (event.type === "run.started") {
    await zion.commands.executeCommand("zion.sessions.ensureAssistantBlock", {
      id: sessionId,
      assistantBlockId: event.runId
    });
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: true,
      aborted: false,
      awaiting: false,
      error: false
    });
    zion.events.emit("chat/runStarted", payload);
    return;
  }
  if (event.type === "message.delta") {
    await zion.commands.executeCommand("zion.sessions.appendAssistantToken", {
      id: sessionId,
      token: String(event.data?.delta || ""),
      runId: event.runId,
      assistantBlockId: event.runId
    });
    zion.events.emit("chat/token", { ...payload, token: String(event.data?.delta || "") });
    return;
  }
  if (event.type === "tool.requested") {
    zion.events.emit("chat/toolCall", {
      ...payload,
      toolCall: {
        id: event.data?.callId,
        name: event.data?.name,
        args: event.data?.args || {}
      }
    });
    return;
  }
  if (event.type === "tool.completed" || event.type === "tool.denied") {
    zion.events.emit("chat/toolResult", {
      ...payload,
      toolCallId: event.data?.callId,
      result: event.data?.result || event.data?.error || event.data?.reason || "",
      ok: event.type === "tool.completed" && !event.data?.error
    });
    return;
  }
  if (event.type === "run.completed") {
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: false,
      aborted: false,
      awaiting: true,
      error: false
    });
    zion.events.emit("chat/runFinished", payload);
    return;
  }
  if (event.type === "run.failed") {
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: false,
      aborted: false,
      awaiting: false,
      error: true
    });
    zion.events.emit("chat/runError", { ...payload, error: event.data?.error || "Scheduled run failed" });
    zion.events.emit("chat/runFinished", payload);
    return;
  }
  if (event.type === "run.aborted") {
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: false,
      aborted: true,
      awaiting: false,
      error: false
    });
    zion.events.emit("chat/aborted", { ...payload, reason: event.data?.reason || "user" });
    zion.events.emit("chat/runFinished", payload);
  }
}

export async function finalizeScheduledSession(zion, sessionId, run) {
  if (!sessionId) return;
  await zion.commands.executeCommand("zion.sessions.transformDoc", {
    id: sessionId,
    transform: (doc) => {
      const text = String(doc || "");
      if (/\nuser\s*$/.test(text)) return text;
      return `${text}${text.endsWith("\n") ? "" : "\n"}user `;
    }
  });
  await zion.commands.executeCommand("zion.sessions.patchMeta", {
    id: sessionId,
    patch: {
      scheduledRunStatus: run.status,
      scheduledRunCompletedAt: run.completedAt,
      scheduledRunError: run.error || null
    }
  });
  zion.commands.executeCommand("zion.sessions.bumpUpdatedAt", sessionId);
}

function parseList(value) {
  return String(value || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function taskFromForm(form, existing = null) {
  const data = new window.FormData(form);
  const taskType = String(data.get("taskType") || "agent");
  const command = String(data.get("command") || "").trim();
  let allowedCommandPrefixes = parseList(data.get("allowedCommandPrefixes"));
  if (
    taskType === "command"
    && command
    && (
      allowedCommandPrefixes.length === 0
      || (existing?.taskType === "command" && allowedCommandPrefixes.length === 1 && allowedCommandPrefixes[0] === String(existing?.command || "").trim())
    )
  ) {
    allowedCommandPrefixes = [command];
  }
  return buildSchedulerTask({
    id: existing?.id,
    taskType,
    executionMode: String(data.get("executionMode") || "local-only"),
    title: String(data.get("title") || "").trim(),
    prompt: String(data.get("prompt") || "").trim(),
    sessionTag: taskType === "command"
      ? ""
      : (existing?.sessionTag || sessionTagForLocale(currentLocale())),
    command,
    cwd: String(data.get("cwd") || "").trim(),
    note: String(data.get("note") || "").trim(),
    schedule: {
      kind: String(data.get("kind") || "daily"),
      intervalMinutes: Number(data.get("intervalMinutes") || 60),
      time: String(data.get("time") || "09:00"),
      timestamp: new Date(String(data.get("timestamp") || "")).getTime()
    },
    capability: {
      preset: String(data.get("preset") || "read-only"),
      allowedTools: data.getAll("allowedTools").map(String),
      fileRoots: parseList(data.get("fileRoots")),
      allowedCommandPrefixes,
      allowedTerminalSessionIds: parseList(data.get("allowedTerminalSessionIds")),
      allowedRecipients: parseList(data.get("allowedRecipients")),
      maxMailPerRun: Number(data.get("maxMailPerRun") || 0),
      maxToolCalls: Number(data.get("maxToolCalls") || 50)
    },
    timeoutSeconds: Number(data.get("timeoutSeconds") || 300),
    enabled: existing?.enabled ?? true
  }, existing);
}

function createTaskEditor({ task, onSave, onCancel, onToggle, onDelete }) {
  const form = document.createElement("form");
  form.className = "scheduler-editor";
  const schedule = normalizeSchedule(task?.schedule || { kind: "daily", time: "09:00" });
  const capability = task?.capability || { preset: "read-only", allowedTools: [] };
  const taskType = task?.taskType || "agent";
  const legacyToolName = { write: "fsWrite", edit: "fsEdit", Bash: "terminalExecute" };
  const checked = (name) => capability.allowedTools?.includes(name) || capability.allowedTools?.includes(legacyToolName[name])
    ? "checked"
    : "";
  form.innerHTML = `
    <header class="scheduler-header">
      <button type="button" class="scheduler-icon-button" data-action="cancel" title="返回" aria-label="返回"><span class="codicon codicon-arrow-left" aria-hidden="true"></span></button>
      <strong class="scheduler-header-title">${task ? "编辑任务" : "新建任务"}</strong>
    </header>
    <div class="scheduler-editor-body">
      <label>名称<input name="title" required maxlength="80" value="${escapeHtml(task?.title || "")}" placeholder="例如：每日项目摘要"></label>
      <div class="scheduler-grid">
        <label>任务类型
          <select name="taskType">
            <option value="agent" ${taskType !== "command" ? "selected" : ""}>Agent 任务</option>
            <option value="command" ${taskType === "command" ? "selected" : ""}>命令任务</option>
          </select>
        </label>
        <label>执行模式
          <select name="executionMode">
            <option value="local-only" ${task?.executionMode !== "service-backed" ? "selected" : ""}>Local-only</option>
            <option value="service-backed" ${task?.executionMode === "service-backed" ? "selected" : ""}>Service-backed</option>
          </select>
        </label>
      </div>
      <label data-field="prompt">任务提示词<textarea name="prompt" rows="7" maxlength="12000" placeholder="描述 Agent 要完成的任务">${escapeHtml(task?.prompt || "")}</textarea></label>
      <label data-field="command">命令<textarea name="command" rows="4" maxlength="4000" placeholder="例如：bash /Users/bytedance/.zion-next/scripts/parking_monitor.sh">${escapeHtml(task?.command || "")}</textarea></label>
      <div class="scheduler-grid" data-field="command-meta">
        <label>工作目录<input name="cwd" value="${escapeHtml(task?.cwd || "")}" placeholder="可选，例如 /Users/bytedance/Downloads/zion-next"></label>
        <label>备注<input name="note" value="${escapeHtml(task?.note || "")}" placeholder="可选，说明这个任务做什么"></label>
      </div>
      <div class="scheduler-grid">
        <label>运行方式
          <select name="kind">
            <option value="daily" ${schedule.kind === "daily" ? "selected" : ""}>每天</option>
            <option value="weekdays" ${schedule.kind === "weekdays" ? "selected" : ""}>工作日</option>
            <option value="interval" ${schedule.kind === "interval" ? "selected" : ""}>固定间隔</option>
            <option value="once" ${schedule.kind === "once" ? "selected" : ""}>单次运行</option>
          </select>
        </label>
        <label data-field="time">时间<input name="time" type="time" value="${escapeHtml(schedule.time || "09:00")}"></label>
        <label data-field="interval">间隔（分钟）<input name="intervalMinutes" type="number" min="1" max="10080" value="${Number(schedule.intervalMinutes || 60)}"></label>
        <label data-field="once">运行时间<input name="timestamp" type="datetime-local" value="${localDateTimeValue(schedule.timestamp)}"></label>
      </div>
      <details class="scheduler-advanced" ${capability.preset !== "read-only" ? "open" : ""}>
        <summary>高级设置 <span data-policy-title></span></summary>
        <div class="scheduler-advanced-body">
          <div class="scheduler-grid">
            <label>超时（秒）<input name="timeoutSeconds" type="number" min="10" max="3600" value="${Number(task?.timeoutSeconds || 300)}"></label>
            <label>最大工具调用数<input name="maxToolCalls" type="number" min="1" max="500" value="${Number(capability.maxToolCalls || 50)}"></label>
          </div>
          <label>权限配置
            <select name="preset">
              <option value="read-only" ${capability.preset === "read-only" ? "selected" : ""}>只读</option>
              <option value="workspace-write" ${capability.preset === "workspace-write" ? "selected" : ""}>工作区写入</option>
              <option value="trusted-automation" ${capability.preset === "trusted-automation" ? "selected" : ""}>受信自动化</option>
            </select>
          </label>
          <fieldset class="scheduler-capabilities" data-field="capabilities">
            <legend>允许的变更工具</legend>
            <label><input type="checkbox" name="allowedTools" value="write" ${checked("write")}>写文件</label>
            <label><input type="checkbox" name="allowedTools" value="edit" ${checked("edit")}>编辑文件</label>
            <label data-trusted><input type="checkbox" name="allowedTools" value="Bash" ${checked("Bash")}>终端命令</label>
            <label data-trusted><input type="checkbox" name="allowedTools" value="sendMail" ${checked("sendMail")}>发送邮件</label>
            <label data-trusted><input type="checkbox" name="allowedTools" value="todoWrite" ${checked("todoWrite")}>更新任务清单</label>
          </fieldset>
          <label data-field="file-roots">允许写入的目录<textarea name="fileRoots" rows="2" placeholder="/path/to/workspace">${escapeHtml((capability.fileRoots || []).join("\n"))}</textarea></label>
          <label data-field="terminal-policy">允许的命令前缀（可选；留空允许 Bash 沙箱内的命令）<textarea name="allowedCommandPrefixes" rows="2" placeholder="例如：npm test&#10;python3 /path/to/script.py">${escapeHtml((capability.allowedCommandPrefixes || []).join("\n"))}</textarea></label>
          <label data-field="terminal-policy">允许的终端 Session ID<input name="allowedTerminalSessionIds" value="${escapeHtml((capability.allowedTerminalSessionIds || []).join(", "))}" placeholder="可留空，表示任意已有终端"></label>
          <div class="scheduler-grid" data-field="mail-policy">
            <label>允许的邮件收件人<textarea name="allowedRecipients" rows="2" placeholder="team@example.com">${escapeHtml((capability.allowedRecipients || []).join("\n"))}</textarea></label>
            <label>每次最多发送<input name="maxMailPerRun" type="number" min="0" max="100" value="${Number(capability.maxMailPerRun || 0)}"></label>
          </div>
          <p class="scheduler-policy-note" data-policy-description></p>
          ${task ? `<div class="scheduler-advanced-actions"><button type="button" data-action="toggle">${task.enabled ? "暂停任务" : "恢复任务"}</button><button type="button" class="danger" data-action="delete">删除任务</button></div>` : ""}
        </div>
      </details>
      <div class="scheduler-form-error" role="alert"></div>
    </div>
    <footer class="scheduler-editor-footer"><button type="submit" class="primary">保存</button></footer>
  `;

  const updateFields = () => {
    const kind = form.elements.kind.value;
    const preset = form.elements.preset.value;
    const executionMode = form.elements.executionMode.value;
    const currentTaskType = form.elements.taskType.value;
    const promptField = form.querySelector('[data-field="prompt"]');
    const commandField = form.querySelector('[data-field="command"]');
    const commandMeta = form.querySelector('[data-field="command-meta"]');
    promptField.hidden = currentTaskType !== "agent";
    commandField.hidden = currentTaskType !== "command";
    commandMeta.hidden = currentTaskType !== "command";
    form.elements.prompt.required = currentTaskType === "agent";
    form.elements.command.required = currentTaskType === "command";
    if (currentTaskType === "command") {
      form.elements.preset.value = "trusted-automation";
      const terminalTool = form.querySelector('input[name="allowedTools"][value="Bash"]');
      if (terminalTool) terminalTool.checked = true;
    }
    form.querySelector('[data-field="time"]').hidden = kind === "interval" || kind === "once";
    form.querySelector('[data-field="interval"]').hidden = kind !== "interval";
    form.querySelector('[data-field="once"]').hidden = kind !== "once";
    form.querySelector('[data-field="capabilities"]').hidden = preset === "read-only";
    form.querySelector('[data-field="file-roots"]').hidden = preset === "read-only";
    form.querySelectorAll("[data-trusted]").forEach((element) => { element.hidden = preset !== "trusted-automation"; });
    form.querySelectorAll('[data-field="terminal-policy"], [data-field="mail-policy"]').forEach((element) => {
      element.hidden = preset !== "trusted-automation";
    });
    form.querySelector("[data-policy-title]").textContent = `${currentTaskType === "command" ? "命令" : "Agent"} · ${executionMode === "service-backed" ? "Service-backed" : "Local-only"} · ${form.elements.preset.selectedOptions[0].textContent}`;
    form.querySelector("[data-policy-description]").textContent = currentTaskType === "command"
      ? "按计划直接执行命令，并在运行记录中保存 stdout/stderr；需要 zion-local-tools 可用。"
      : executionMode === "service-backed"
          ? "命令前缀留空时，Bash 可执行本地工具沙箱允许的命令；填写前缀会进一步限制。触发和待执行队列由 zion-local-tools 持久化；需要至少一个 Zion 页面在线领取并执行。"
          : "命令前缀留空时，Bash 可执行本地工具沙箱允许的命令；填写前缀会进一步限制。浏览器需保持打开；错过的触发不会补跑。";
  };
  form.elements.kind.addEventListener("change", updateFields);
  form.elements.taskType.addEventListener("change", updateFields);
  form.elements.executionMode.addEventListener("change", updateFields);
  form.elements.preset.addEventListener("change", updateFields);
  updateFields();
  form.querySelector('[data-action="cancel"]').addEventListener("click", onCancel);
  form.querySelector('[data-action="toggle"]')?.addEventListener("click", () => onToggle?.(task));
  form.querySelector('[data-action="delete"]')?.addEventListener("click", () => onDelete?.(task));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const candidate = taskFromForm(form, task);
    const error = validateSchedulerTask(candidate);
    form.querySelector(".scheduler-form-error").textContent = error;
    if (!error) onSave(candidate);
  });
  return form;
}

function createEmptyState(text, compact = false) {
  const empty = document.createElement("div");
  empty.className = `scheduler-empty${compact ? " scheduler-empty-compact" : ""}`;
  empty.textContent = text;
  return empty;
}

function createTaskRow() {
  const row = document.createElement("article");
  row.className = "scheduler-task-row";
  row.innerHTML = `
    <button type="button" class="scheduler-row-main" data-action="edit">
      <span class="scheduler-status-dot" aria-hidden="true"></span>
      <span class="scheduler-row-copy"><strong></strong><small></small></span>
    </button>
    <button type="button" class="scheduler-row-action" data-action="run"><span class="codicon codicon-play" aria-hidden="true"></span></button>
  `;
  return row;
}

function syncTaskRow(row, task, engine, activeRun = null) {
  const state = taskState(task, engine, activeRun);
  const next = task.enabled ? `下次 ${formatDate(task.nextRun)}` : "已暂停";
  const statusText = ACTIVE_RUN_STATUSES.has(state) ? runStatusLabel(state, activeRun) : next;
  row.dataset.state = state;
  row.dataset.taskId = task.id;
  const edit = row.querySelector('[data-action="edit"]');
  const run = row.querySelector('[data-action="run"]');
  const dot = row.querySelector(".scheduler-status-dot");
  const title = row.querySelector(".scheduler-row-copy strong");
  const meta = row.querySelector(".scheduler-row-copy small");
  if (edit) edit.title = `编辑 ${task.title}`;
  if (dot) dot.dataset.status = state;
  if (title) title.textContent = task.title;
  if (meta) meta.textContent = taskListMeta(task, statusText);
  if (run) {
    const isBusy = ACTIVE_RUN_STATUSES.has(state);
    const busyLabel = `任务${runStatusLabel(state, activeRun)}`;
    run.disabled = isBusy;
    run.title = isBusy ? busyLabel : "立即运行";
    run.setAttribute("aria-label", isBusy ? busyLabel : "立即运行");
  }
}

function syncTaskList(list, tasks, engine, activeRuns) {
  if (!tasks.length) {
    list.replaceChildren(createEmptyState("还没有定时任务"));
    return;
  }

  list.querySelectorAll(".scheduler-empty").forEach((node) => node.remove());
  const existing = new Map([...list.querySelectorAll(".scheduler-task-row")].map((row) => [row.dataset.taskId, row]));
  let nextNode = list.firstElementChild;
  for (const task of tasks) {
    let row = existing.get(task.id);
    if (!row) row = createTaskRow();
    existing.delete(task.id);
    syncTaskRow(row, task, engine, activeRuns.get(task.id));
    if (row !== nextNode) list.insertBefore(row, nextNode);
    nextNode = row.nextElementSibling;
  }
  for (const row of existing.values()) row.remove();
}

function createRunRow() {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "scheduler-run-row";
  row.innerHTML = `
    <span class="scheduler-status-dot" aria-hidden="true"></span>
    <span class="scheduler-row-copy"><strong></strong><small></small></span>
    <span class="scheduler-run-status"></span>
  `;
  return row;
}

function syncRunRow(row, run) {
  row.dataset.runId = run.id;
  const status = run.status || "unknown";
  const dot = row.querySelector(".scheduler-status-dot");
  const title = row.querySelector(".scheduler-row-copy strong");
  const time = row.querySelector(".scheduler-row-copy small");
  const label = row.querySelector(".scheduler-run-status");
  if (dot) dot.dataset.status = status;
  if (title) title.textContent = run.taskTitle;
  if (time) time.textContent = formatDate(run.startedAt);
  if (label) {
    label.dataset.status = status;
    label.textContent = runStatusLabel(status, run);
  }
}

function syncRunList(list, runs) {
  if (!runs.length) {
    list.replaceChildren(createEmptyState("暂无运行记录", true));
    return;
  }

  list.querySelectorAll(".scheduler-empty").forEach((node) => node.remove());
  const existing = new Map([...list.querySelectorAll(".scheduler-run-row")].map((row) => [row.dataset.runId, row]));
  let nextNode = list.firstElementChild;
  for (const run of runs) {
    let row = existing.get(run.id);
    if (!row) row = createRunRow();
    existing.delete(run.id);
    syncRunRow(row, run);
    if (row !== nextNode) list.insertBefore(row, nextNode);
    nextNode = row.nextElementSibling;
  }
  for (const row of existing.values()) row.remove();
}

function createSchedulerListRoot() {
  const root = document.createElement("div");
  root.className = "scheduler-panel";
  root.innerHTML = `
    <header class="scheduler-header">
      <strong class="scheduler-header-title">定时任务</strong>
      <span class="scheduler-header-note">Agent / 命令</span>
      <button type="button" class="scheduler-icon-button" data-action="new" title="新建任务" aria-label="新建任务"><span class="codicon codicon-add" aria-hidden="true"></span></button>
    </header>
    <div class="scheduler-panel-body">
      <div class="scheduler-task-list"></div>
      <section class="scheduler-history">
        <div class="scheduler-list-label"><span>最近运行</span><button type="button" class="scheduler-text-button" data-action="clear-runs" hidden>清空</button></div>
        <div class="scheduler-run-list"></div>
      </section>
    </div>
  `;
  return root;
}

function syncSchedulerListRoot(root, store, engine) {
  const tasks = store.listTasks();
  const allRuns = store.listRuns();
  const activeRuns = new Map();
  for (const run of allRuns) {
    if (ACTIVE_RUN_STATUSES.has(run.status) && !activeRuns.has(run.taskId)) {
      activeRuns.set(run.taskId, run);
    }
  }
  const runs = allRuns.slice(0, 20);
  syncTaskList(root.querySelector(".scheduler-task-list"), tasks, engine, activeRuns);
  syncRunList(root.querySelector(".scheduler-run-list"), runs);
  const clearRuns = root.querySelector('[data-action="clear-runs"]');
  if (clearRuns) clearRuns.hidden = !runs.length;
}

function createPanel({
  store,
  engine,
  refreshAll,
  refreshRuns,
  loadRunDetails,
  saveTask,
  toggleTask,
  deleteTask,
  runTask,
  cancelRun
}) {
  return {
    render(container) {
      container.classList.add("scheduler-panel-host");
      let mode = "list";
      let editing = null;
      let selectedRun = null;
      let disposed = false;

      const requestRender = () => {
        if (disposed) return;
        if (mode === "edit") return;
        render();
      };

      const handleListClick = (event) => {
        const target = event.target?.closest?.("[data-action], .scheduler-run-row");
        if (!target || !container.contains(target)) return;
        const action = target.dataset.action || "";
        if (action === "new") {
          mode = "edit";
          editing = null;
          render();
          return;
        }
        if (action === "clear-runs") {
          store.clearRuns();
          refreshAll();
          return;
        }
        const taskRow = target.closest?.(".scheduler-task-row");
        if (action === "edit" && taskRow) {
          editing = store.getTask(taskRow.dataset.taskId);
          mode = "edit";
          render();
          return;
        }
        if (action === "run" && taskRow) {
          event.preventDefault();
          event.stopPropagation();
          const task = store.getTask(taskRow.dataset.taskId);
          if (!task) return;
          target.disabled = true;
          target.title = "任务运行中";
          target.setAttribute("aria-label", "任务运行中");
          taskRow.dataset.state = "running";
          taskRow.querySelector(".scheduler-status-dot")?.setAttribute("data-status", "running");
          void Promise.resolve(runTask(task))
            .then((result) => {
              if (result?.queued) {
                window.zion?.notification?.show?.("任务正在启动", { type: "info", duration: 1600 });
              }
              return result;
            })
            .catch((error) => {
              window.zion?.notification?.show?.(error?.message || String(error), { type: "error" });
            })
            .finally(requestRender);
          return;
        }
        const runRow = target.closest?.(".scheduler-run-row");
        if (runRow) {
          selectedRun = runRow.dataset.runId;
          mode = "run";
          render();
          if (store.getRun(selectedRun)?.isSummary === true) {
            void Promise.resolve(loadRunDetails?.(selectedRun))
              .then(render)
              .catch((error) => {
                window.zion?.notification?.show?.(error?.message || String(error), { type: "error" });
              });
          }
        }
      };

      const render = () => {
        if (mode === "edit") {
          container.replaceChildren();
          container.appendChild(createTaskEditor({
            task: editing,
            onCancel: () => { mode = "list"; editing = null; render(); },
            onSave: async (task) => {
              try {
                await saveTask(task);
                mode = "list";
                editing = null;
                refreshAll();
              } catch (error) {
                window.zion?.notification?.show?.(error?.message || String(error), { type: "error" });
              }
            },
            onToggle: async (task) => {
              try {
                await toggleTask(task);
                mode = "list";
                editing = null;
                render();
              } catch (error) {
                window.zion?.notification?.show?.(error?.message || String(error), { type: "error" });
              }
            },
            onDelete: async (task) => {
              if (!globalThis.confirm?.(`删除任务“${task?.title || task?.id}”？`)) return;
              try {
                await deleteTask(task);
                mode = "list";
                editing = null;
                render();
              } catch (error) {
                window.zion?.notification?.show?.(error?.message || String(error), { type: "error" });
              }
            }
          }));
          return;
        }
        if (mode === "run" && selectedRun) {
          const run = store.getRun(selectedRun);
          if (!run) { mode = "list"; render(); return; }
          const status = run.status || "unknown";
          const loadingDetails = run.isSummary === true;
          const detailTask = store.getTask(run.taskId);
          const canCancel = ACTIVE_RUN_STATUSES.has(status)
            && (
              run.executionMode === "service-backed"
              || detailTask?.executionMode === "service-backed"
              || status !== "running"
            );
          const detail = document.createElement("div");
          detail.className = "scheduler-run-detail";
          detail.innerHTML = `
            <header class="scheduler-header">
              <button type="button" class="scheduler-icon-button scheduler-back" title="返回" aria-label="返回"><span class="codicon codicon-arrow-left" aria-hidden="true"></span></button>
              <strong class="scheduler-header-title">运行记录</strong>
                ${canCancel ? '<button type="button" class="scheduler-text-button danger" data-action="cancel-run">取消运行</button>' : ""}
              ${run.sessionId ? '<button type="button" class="scheduler-text-button" data-action="open-session">打开会话</button>' : ""}
            </header>
            <div class="scheduler-detail-body">
              <div class="scheduler-detail-title">
                <span class="scheduler-status-dot" data-status="${escapeHtml(status)}"></span>
                <span class="scheduler-row-copy"><strong>${escapeHtml(run.taskTitle)}</strong><small>${formatDate(run.startedAt)} · ${escapeHtml(runStatusLabel(status, run))}</small></span>
              </div>
              ${run.error ? `<div class="scheduler-error">${escapeHtml(run.error)}</div>` : ""}
              ${run.command ? `<section class="scheduler-detail-section"><div class="scheduler-list-label"><span>命令</span></div><pre>${escapeHtml(run.cwd ? `cd ${run.cwd}\n${run.command}` : run.command)}</pre></section>` : ""}
              <section class="scheduler-detail-section"><div class="scheduler-list-label"><span>输出</span></div><pre>${escapeHtml(loadingDetails ? "正在加载…" : run.output || "暂无输出")}</pre></section>
              <section class="scheduler-detail-section"><div class="scheduler-list-label"><span>事件</span></div><div class="scheduler-events">${(run.events || []).map((event) => `
                <div><time>${new Date(event.ts).toLocaleTimeString()}</time><strong>${escapeHtml(event.type)}</strong><code>${escapeHtml(JSON.stringify(event.data || {}))}</code></div>
              `).join("") || `<div class="scheduler-empty scheduler-empty-compact">${loadingDetails ? "正在加载…" : "暂无事件"}</div>`}</div></section>
            </div>
          `;
          detail.querySelector(".scheduler-back").addEventListener("click", () => { mode = "list"; selectedRun = null; render(); });
          detail.querySelector('[data-action="open-session"]')?.addEventListener("click", () => {
            window.zion.commands.executeCommand("zion.sessions.switch", run.sessionId);
          });
          detail.querySelector('[data-action="cancel-run"]')?.addEventListener("click", async (event) => {
            if (typeof globalThis.confirm === "function" && !globalThis.confirm(`取消运行“${run.taskTitle || run.id}”？`)) return;
            const button = event.currentTarget;
            button.disabled = true;
            try {
              await cancelRun(run.id, "user");
              window.zion?.notification?.show?.("运行已取消", { type: "info", duration: 1600 });
              render();
            } catch (error) {
              button.disabled = false;
              window.zion?.notification?.show?.(error?.message || String(error), { type: "error" });
            }
          });
          container.replaceChildren();
          container.appendChild(detail);
          return;
        }

        let root = container.firstElementChild?.classList?.contains("scheduler-panel")
          ? container.firstElementChild
          : null;
        if (!root) {
          root = createSchedulerListRoot();
          root.addEventListener("click", handleListClick);
          container.replaceChildren(root);
        }
        syncSchedulerListRoot(root, store, engine);
    };

      render();
      const refreshRunHistory = () => Promise.resolve(refreshRuns?.()).catch(() => {});
      void refreshRunHistory();
      const runHistoryTimer = window.setInterval(() => void refreshRunHistory(), 30_000);
      const disposable = window.zion.events.on("scheduler/changed", requestRender);
      const createDisposable = window.zion.events.on("scheduler/createRequested", () => {
        mode = "edit";
        editing = null;
        render();
      });
      return {
        dispose: () => {
          disposed = true;
          window.clearInterval(runHistoryTimer);
          disposable.dispose();
          createDisposable.dispose();
          container.classList.remove("scheduler-panel-host");
          container.replaceChildren();
        }
      };
    }
  };
}

export async function activate(ctx) {
  const store = new LocalSchedulerStore();
  const service = new SchedulerServiceClient();
  const workerId = (() => {
    const key = "zion.scheduler.workerId";
    try {
      const existing = localStorage.getItem(key);
      if (existing) return existing;
      const created = id("worker");
      localStorage.setItem(key, created);
      return created;
    } catch {
      return id("worker");
    }
  })();
  let statusDisposable = null;
  let leaderRelease = null;
  let leaderAbort = null;
  let servicePollTimer = null;
  let serviceClaiming = false;
  const activeServiceRuns = new Set();
  let serviceOnline = false;
  let isLeader = false;
  let disposed = false;
  let archiveFolderPromise = null;
  let archivePathQueue = Promise.resolve();
  let migrationPromise = null;
  let migrationDisposable = null;

  const resolveArchiveFolder = () => {
    if (!archiveFolderPromise) {
      archiveFolderPromise = ensureScheduledSessionFolder({
        zion: window.zion,
        store,
        locale: currentLocale()
      }).finally(() => {
        archiveFolderPromise = null;
      });
    }
    return archiveFolderPromise;
  };
  const resolveArchiveDateFolder = (archiveDate) => {
    const pending = archivePathQueue
      .catch(() => {})
      .then(() => ensureScheduledSessionDateFolder({
        zion: window.zion,
        store,
        locale: currentLocale(),
        archiveDate,
        ensureFolder: resolveArchiveFolder
      }));
    archivePathQueue = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const requestSessionMigration = (force = false) => {
    if (disposed) return Promise.resolve(false);
    if (!migrationPromise) {
      migrationPromise = migrateScheduledSessions({
        zion: window.zion,
        store,
        locale: currentLocale(),
        force,
        moveOutsideArchive: force,
        ensureFolder: resolveArchiveFolder,
        ensureDateFolder: ({ archiveDate }) => resolveArchiveDateFolder(archiveDate)
      }).finally(() => {
        migrationPromise = null;
      });
    }
    return migrationPromise;
  };

  const emitChanged = () => {
    if (!disposed) window.zion?.events?.emit?.("scheduler/changed");
  };
  const updateStatus = () => {
    if (disposed) return;
    const enabled = store.listTasks().filter((task) => task.enabled).length;
    const running = (engine ? Array.from(engine.runningTasks || []).length : 0) + activeServiceRuns.size;
    statusDisposable?.dispose?.();
    statusDisposable = window.zion.statusBar.registerItem({
      id: STATUS_ID,
      text: `$(clock) ${enabled}${running ? ` · ${running} 运行中` : ""}`,
      tooltip: `${isLeader ? "当前标签页负责本地调度" : "其他标签页负责本地调度"}；zion-local-tools ${serviceOnline ? "已连接" : "未连接"}`,
      priority: 36,
      onClick: () => window.zion.commands.executeCommand("scheduler.openPanel")
    });
  };

  const runCommandTask = async (task, remoteContext = null) => {
    const startedAt = Date.now();
    const run = {
      id: remoteContext?.runId || id("localrun"),
      chatRunId: null,
      sessionId: null,
      taskId: task.id,
      taskTitle: task.title,
      taskType: "command",
      command: task.command || "",
      cwd: task.cwd || "",
      executionMode: task.executionMode || "local-only",
      capability: task.capability || { preset: "trusted-automation" },
      status: "running",
      startedAt,
      completedAt: null,
      output: "",
      error: null,
      events: []
    };
    store.saveRun(run);
    emitChanged();

    const appendEvent = async (type, data = {}) => {
      const event = { runId: run.id, ts: Date.now(), type, data };
      store.appendRunEvent(run.id, event);
      emitChanged();
      if (remoteContext) {
        try { await service.appendEvent(remoteContext.runId, workerId, event); } catch {}
      }
    };

    try {
      await appendEvent("command.started", { command: task.command, cwd: task.cwd || "" });
      const result = await service.executeCommand({
        command: task.command,
        cwd: task.cwd || "",
        timeoutSeconds: task.timeoutSeconds || 300
      });
      serviceOnline = true;
      const stdout = String(result?.stdout || "");
      const stderr = String(result?.stderr || "");
      const exitCode = Number(result?.exit_code);
      const output = [
        stdout,
        stderr ? `[stderr]\n${stderr}` : ""
      ].filter(Boolean).join(stdout && stderr ? "\n" : "");
      const status = result?.ok && exitCode === 0 ? "success" : "failed";
      await appendEvent("command.completed", {
        exitCode: Number.isFinite(exitCode) ? exitCode : null,
        durationMs: result?.duration_ms || null
      });
      store.saveRun({
        ...store.getRun(run.id),
        status,
        completedAt: Date.now(),
        output,
        error: status === "failed" ? (result?.error || stderr || `命令退出码 ${exitCode}`) : null,
        exitCode: Number.isFinite(exitCode) ? exitCode : null
      });
      const savedTask = store.getTask(task.id);
      if (savedTask) {
        store.saveTask({
          ...savedTask,
          lastRun: { id: run.id, status, startedAt, completedAt: Date.now() },
          updatedAt: Date.now()
        });
      }
      if (remoteContext) {
        try {
          await service.complete(remoteContext.runId, workerId, {
            status,
            sessionId: null,
            chatRunId: null,
            output,
            error: status === "failed" ? (result?.error || stderr || `命令退出码 ${exitCode}`) : null,
            usage: null
          });
        } catch (error) {
          console.warn("[scheduler] failed to report remote command completion", error);
        }
      }
      return { status, output, exitCode: Number.isFinite(exitCode) ? exitCode : null, result };
    } catch (error) {
      serviceOnline = false;
      await appendEvent("command.failed", { error: error?.message || String(error) });
      store.saveRun({
        ...store.getRun(run.id),
        status: "failed",
        completedAt: Date.now(),
        error: error?.message || String(error)
      });
      const savedTask = store.getTask(task.id);
      if (savedTask) {
        store.saveTask({
          ...savedTask,
          lastRun: { id: run.id, status: "failed", startedAt, completedAt: Date.now() },
          updatedAt: Date.now()
        });
      }
      if (remoteContext) {
        try {
          await service.complete(remoteContext.runId, workerId, {
            status: "failed",
            sessionId: null,
            chatRunId: null,
            output: "",
            error: error?.message || String(error),
            usage: null
          });
        } catch {}
      }
      return null;
    } finally {
      emitChanged();
      updateStatus();
    }
  };

  const runTask = async (task, remoteContext = null) => {
    if (isCommandTask(task)) return runCommandTask(task, remoteContext);
    if (!window.zion?.chat?.execute) throw new Error("Chat runtime 尚未就绪");
    const taggedTask = withSessionTag(task, currentLocale());
    if (taggedTask.sessionTag !== task.sessionTag) store.saveTask(taggedTask);
    task = taggedTask;
    const startedAt = Date.now();
    const archiveTimestamp = Number(remoteContext?.scheduledFor || startedAt);
    const archiveDate = archiveDateForTimestamp(
      archiveTimestamp,
      task.schedule?.timeZone
    );
    const run = {
      id: remoteContext?.runId || id("localrun"),
      chatRunId: null,
      sessionId: null,
      taskId: task.id,
      taskTitle: task.title,
      executionMode: task.executionMode || "local-only",
      capability: task.capability || { preset: "read-only" },
      status: "running",
      startedAt,
      completedAt: null,
      output: "",
      error: null,
      events: []
    };
    store.saveRun(run);
    emitChanged();

    let timeout = null;
    try {
      const folderId = await resolveArchiveDateFolder(archiveDate);
      if (!folderId) throw new Error("无法准备定时任务日期文件夹");
      const datedTag = scheduledSessionTagForDate(task.sessionTag, archiveDate);
      const sessionId = await window.zion.commands.executeCommand("zion.sessions.new", {
          title: `定时任务 · ${task.title} · ${new Date(startedAt).toLocaleString()}`,
          content: buildScheduledSessionContent(task.prompt, datedTag),
          parentId: folderId,
          open: false,
          meta: {
            source: "scheduled-task",
            scheduledTaskId: task.id,
            scheduledRunId: run.id,
            scheduledRunStatus: "running"
          }
      });
      if (!sessionId) throw new Error("无法创建定时任务会话");
      run.sessionId = sessionId;
      store.saveRun(run);
      const handle = window.zion.chat.execute({
        prompt: task.prompt,
        executionMode: task.executionMode || "local-only",
        sessionId,
        policy: task.capability || { preset: "read-only" }
      });
      run.chatRunId = handle.runId;
      store.saveRun(run);
      timeout = window.setTimeout(() => void handle.abort("timeout"), Number(task.timeoutSeconds || 300) * 1000);
      let pendingEvents = [];
      let eventFlushTimer = null;
      const flushEvents = () => {
        if (eventFlushTimer) window.clearTimeout(eventFlushTimer);
        eventFlushTimer = null;
        if (!pendingEvents.length) return;
        const current = store.getRun(run.id);
        store.saveRun({ ...current, events: [...(current?.events || []), ...pendingEvents] });
        pendingEvents = [];
        emitChanged();
      };
      const consuming = (async () => {
        for await (const event of handle.events) {
          await projectRunEventToSession(window.zion, sessionId, event);
          if (remoteContext && event.type !== "message.delta") {
            try { await service.appendEvent(remoteContext.runId, workerId, event); } catch {}
          }
          pendingEvents.push(event);
          if (!eventFlushTimer) eventFlushTimer = window.setTimeout(flushEvents, 200);
        }
        flushEvents();
      })();
      const result = await handle.completion;
      await consuming;
      if (timeout) window.clearTimeout(timeout);
      const status = result.status === "completed" ? "success" : result.status;
      store.saveRun({
        ...store.getRun(run.id),
        status,
        completedAt: Date.now(),
        output: result.output || "",
        error: result.error || (result.reason === "timeout" ? "运行超时" : null),
        usage: result.usage || null
      });
      await finalizeScheduledSession(window.zion, sessionId, store.getRun(run.id));
      const savedTask = store.getTask(task.id);
      if (savedTask) {
        store.saveTask({
          ...savedTask,
          lastRun: { id: run.id, status, startedAt, completedAt: Date.now() },
          updatedAt: Date.now()
        });
      }
      if (remoteContext) {
          try {
            await service.complete(remoteContext.runId, workerId, {
              status,
              sessionId,
              chatRunId: handle.runId,
              output: result.output || "",
              error: result.error || null,
              usage: result.usage || null
            });
          } catch (error) {
            console.warn("[scheduler] failed to report remote completion", error);
          }
      }
      return result;
    } catch (error) {
      if (timeout) window.clearTimeout(timeout);
      store.saveRun({ ...store.getRun(run.id), status: "failed", completedAt: Date.now(), error: error?.message || String(error) });
      if (run.sessionId) {
        await projectRunEventToSession(window.zion, run.sessionId, {
          runId: run.chatRunId || run.id,
          type: "run.failed",
          data: { error: error?.message || String(error) }
        });
        await finalizeScheduledSession(window.zion, run.sessionId, store.getRun(run.id));
      }
      const savedTask = store.getTask(task.id);
      if (savedTask) {
        store.saveTask({
          ...savedTask,
          lastRun: { id: run.id, status: "failed", startedAt, completedAt: Date.now() },
          updatedAt: Date.now()
        });
      }
      if (remoteContext) {
        try {
          await service.complete(remoteContext.runId, workerId, {
            status: "failed",
            sessionId: run.sessionId,
            chatRunId: run.chatRunId,
            output: "",
            error: error?.message || String(error),
            usage: null
          });
        } catch {}
      }
      return null;
    } finally {
      emitChanged();
      updateStatus();
    }
  };

    const engine = new LocalSchedulerEngine({
      store,
      runTask,
      onChange: () => { emitChanged(); updateStatus(); }
    });
    const controller = new SchedulerController({
      store,
      service,
      onChange: () => { emitChanged(); updateStatus(); },
      onServiceStatus: (online) => { serviceOnline = online; }
    });
    controller.setEngine(engine);

    const saveTask = (task) => controller.saveTask(
      isCommandTask(task) ? task : withSessionTag(task, currentLocale())
    );
    const toggleTask = (task) => controller.setEnabled(task.id, !task.enabled);
    const deleteTask = (task) => controller.deleteTask(task?.id);
    const refreshServiceTasks = () => controller.refreshServiceTasks();
    const refreshServiceRuns = () => controller.refreshServiceRuns();
    const loadRunDetails = (runId) => controller.getRunDetails(runId);
    const cancelRun = (runId, reason = "user") => controller.cancelRun(runId, reason);
    const requestRun = async (task) => {
      const result = await controller.runNow(task.id);
      if (task.executionMode === "service-backed") void pollService();
      return result;
    };
    void requestSessionMigration();
    migrationDisposable = window.zion?.state?.onDidChange?.(
      "sessions.catalog",
      () => { void requestSessionMigration(); }
    ) || null;

    const pollService = async () => {
      if (
        disposed
        || !isLeader
        || serviceClaiming
        || activeServiceRuns.size >= MAX_CONCURRENT_SERVICE_RUNS
        || !window.zion?.chat?.execute
      ) return;
      serviceClaiming = true;
      let claimedRun = null;
      try {
          const availableTools = (window.zion?.state?.get?.("chat.tools") || [])
            .map((tool) => String(tool?.function?.name || tool?.name || ""))
            .filter(Boolean);
          if (service?.executeCommand) {
            if (!availableTools.includes("Bash")) availableTools.push("Bash");
            if (!availableTools.includes("terminalExecute")) availableTools.push("terminalExecute");
          }
          const remoteRun = await service.claim(workerId, availableTools);
        serviceOnline = true;
        if (remoteRun) {
          claimedRun = remoteRun;
          const snapshot = remoteRun.task || {};
          const existing = store.listTasks().find((task) =>
            task.remoteTaskId === remoteRun.taskId || task.id === snapshot.clientTaskId
          );
          const task = {
            ...(existing || snapshot),
            id: existing?.id || snapshot.clientTaskId || `service_${remoteRun.taskId}`,
            executionMode: "service-backed",
            capability: snapshot.capability || { preset: "read-only" }
          };
          activeServiceRuns.add(remoteRun.id);
          updateStatus();
          void (async () => {
            await runTask(task, {
              runId: remoteRun.id,
              scheduledFor: remoteRun.scheduledFor
            });
            await refreshServiceTasks();
          })().finally(() => {
            activeServiceRuns.delete(remoteRun.id);
            updateStatus();
            void pollService();
          });
        }
      } catch {
        serviceOnline = false;
      } finally {
        serviceClaiming = false;
        updateStatus();
      }
      if (claimedRun && activeServiceRuns.size < MAX_CONCURRENT_SERVICE_RUNS) void pollService();
    };

  const startLeader = () => {
    if (navigator?.locks?.request) {
      leaderAbort = new AbortController();
      void navigator.locks.request("zion.scheduler.local.leader", { signal: leaderAbort.signal }, async () => {
        isLeader = true;
        engine.start();
        updateStatus();
        await new Promise((resolve) => { leaderRelease = resolve; });
        engine.stop();
        isLeader = false;
      }).catch((error) => {
        if (error?.name !== "AbortError") console.warn("[scheduler] leader lock failed", error);
      });
    } else {
      isLeader = true;
      engine.start();
    }
  };
  startLeader();
    const onSchedulerStorage = (event) => {
      if (!event.key || event.key.startsWith("zion.scheduler.local.")) {
        emitChanged();
        updateStatus();
      }
    };
    window.addEventListener("storage", onSchedulerStorage);
    void refreshServiceTasks();
    servicePollTimer = window.setInterval(() => void pollService(), 3000);
    void pollService();

    const panel = createPanel({
      store,
      engine,
      refreshAll: () => { emitChanged(); updateStatus(); },
      refreshRuns: refreshServiceRuns,
      loadRunDetails,
      saveTask,
      toggleTask,
      deleteTask,
      runTask: requestRun,
      cancelRun
    });
  const viewDisposable = window.zion.auxiliaryBar.registerView({
    id: VIEW_ID,
    pluginId: "dev.scheduler",
    title: "定时任务",
    icon: "$(clock)",
    location: "auxiliarybar",
    order: 35,
    headerActions: [{
      id: "scheduler.new",
      title: "新建定时任务",
      ariaLabel: "新建定时任务",
      icon: "$(add)",
      onClick: () => window.zion.events.emit("scheduler/createRequested")
    }],
    component: panel
  });
  const activityDisposable = window.zion.activityBar?.registerItem?.({
    id: "scheduler.activity",
    pluginId: "dev.scheduler",
    icon: "$(clock)",
    tooltip: "定时任务",
    auxiliaryBarViewId: VIEW_ID,
    order: 35
  });

  const open = window.zion.commands.registerCommand("scheduler.openPanel", () => {
    window.zion.auxiliaryBar.activateView(VIEW_ID);
    window.zion.auxiliaryBar.show();
  });
  const create = window.zion.commands.registerCommand("scheduler.create", () => {
    window.zion.auxiliaryBar.activateView(VIEW_ID);
    window.zion.auxiliaryBar.show();
    window.zion.events.emit("scheduler/createRequested");
  });
  const runNow = window.zion.commands.registerCommand("scheduler.runNow", (taskId) => {
    const task = store.getTask(String(taskId || ""));
    return task ? requestRun(task) : null;
  });
  const cancel = window.zion.commands.registerCommand("scheduler.cancelRun", (runId, reason = "user") =>
    cancelRun(String(runId || ""), reason)
  );
  const repairSessionArchive = window.zion.commands.registerCommand(
    "scheduler.repairSessionArchive",
    () => requestSessionMigration(true)
  );
  const schedulerTool = registerSchedulerTool({
    controller,
    openPanel: () => window.zion.commands.executeCommand("scheduler.openPanel"),
    getSessionTag: () => sessionTagForLocale(currentLocale())
  });

  updateStatus();
  ctx.subscriptions.push(viewDisposable, activityDisposable, open, create, runNow, cancel, repairSessionArchive, schedulerTool, {
    dispose() {
        disposed = true;
      leaderRelease?.();
      leaderAbort?.abort?.();
      if (servicePollTimer) window.clearInterval(servicePollTimer);
      window.removeEventListener("storage", onSchedulerStorage);
      migrationDisposable?.dispose?.();
      engine.stop();
      statusDisposable?.dispose?.();
    }
  });
}
