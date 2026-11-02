import {
  readWorkbenchRuntimeConfig
} from "../../src/runtime/workbench-runtime-config.ts";

export const TASK_PANEL_RUNTIME_SOURCE = "runtimeTodoWrite";
export const TASK_PANEL_RUNTIME_SYNC_STATE_KEY = "todo.runtimeSync";

function cleanString(value) {
  return String(value || "").trim();
}

function safeIdPart(value) {
  return cleanString(value).replace(/[^a-zA-Z0-9_.:-]+/g, "-") || "unknown";
}

function statusValue(value) {
  const status = cleanString(value);
  return ["pending", "in_progress", "completed"].includes(status)
    ? status
    : "pending";
}

function todoSignature(todos) {
  return JSON.stringify((Array.isArray(todos) ? todos : []).map((todo) => [
    cleanString(todo?.content),
    cleanString(todo?.activeForm)
  ]));
}

function normalizeRuntimeTodos(todos, ownerId) {
  return (Array.isArray(todos) ? todos : [])
    .filter((todo) => todo && (typeof todo.content === "string" || typeof todo.activeForm === "string"))
    .map((todo, index) => ({
      id: cleanString(todo.id) || `runtime-todo-${safeIdPart(ownerId)}-${index}`,
      content: cleanString(todo.content),
      status: statusValue(todo.status),
      activeForm: cleanString(todo.activeForm)
    }))
    .filter((todo) => todo.content || todo.activeForm);
}

export function normalizeRuntimeTodoList(value = {}) {
  const ownerId = cleanString(value.ownerId || value.sessionId || value.runId);
  const todos = normalizeRuntimeTodos(value.todos, ownerId);
  return {
    ownerId,
    taskId: cleanString(value.taskId),
    sessionId: cleanString(value.sessionId || ownerId),
    runId: cleanString(value.runId),
    updatedAt: Math.max(0, Number(value.updatedAt) || 0),
    todos,
    todoSignature: todoSignature(todos)
  };
}

export function runtimeTodoTaskId(todoList) {
  const list = normalizeRuntimeTodoList(todoList);
  return list.taskId || `runtime-todo-${safeIdPart(list.ownerId)}`;
}

export function taskFromRuntimeTodoList(todoList, existingTask = null) {
  const list = normalizeRuntimeTodoList(todoList);
  if (!list.ownerId || !list.todos.length) return null;
  const taskId = list.taskId || cleanString(existingTask?.id) || runtimeTodoTaskId(list);
  const updatedAt = list.updatedAt || Date.now();
  return {
    ...(existingTask && typeof existingTask === "object" ? existingTask : {}),
    id: taskId,
    name: cleanString(existingTask?.name) || `Runtime ${list.ownerId}`,
    todos: list.todos,
    sessionId: list.sessionId || list.ownerId,
    todoSignature: list.todoSignature,
    source: TASK_PANEL_RUNTIME_SOURCE,
    runtimeTodoOwnerId: list.ownerId,
    runtimeRunId: list.runId || cleanString(existingTask?.runtimeRunId),
    updatedAt,
    createdAt: Number(existingTask?.createdAt || updatedAt)
  };
}

function matchesRuntimeTodoList(task, list) {
  if (!task || !list?.ownerId) return false;
  if (cleanString(task.runtimeTodoOwnerId) === list.ownerId) return true;
  const taskId = runtimeTodoTaskId(list);
  if (cleanString(task.id) === taskId) return true;
  if (
    [TASK_PANEL_RUNTIME_SOURCE, "todoWrite"].includes(cleanString(task.source))
    && cleanString(task.sessionId) === (list.sessionId || list.ownerId)
  ) {
    return true;
  }
  return false;
}

function shouldReplaceTask(existingTask, runtimeTask) {
  if (!existingTask) return true;
  if (cleanString(existingTask.source) === "manual") return false;
  const existingUpdatedAt = Number(existingTask.updatedAt || 0);
  const runtimeUpdatedAt = Number(runtimeTask.updatedAt || 0);
  return runtimeUpdatedAt >= existingUpdatedAt
    || cleanString(existingTask.source) === TASK_PANEL_RUNTIME_SOURCE;
}

export function mergeRuntimeTodoListsIntoTasks(tasks, todoLists) {
  const next = Array.isArray(tasks) ? tasks.slice() : [];
  for (const raw of Array.isArray(todoLists) ? todoLists : []) {
    const list = normalizeRuntimeTodoList(raw);
    if (!list.ownerId || !list.todos.length) continue;
    const index = next.findIndex((task) => matchesRuntimeTodoList(task, list));
    const runtimeTask = taskFromRuntimeTodoList(list, index >= 0 ? next[index] : null);
    if (!runtimeTask) continue;
    if (index >= 0) {
      if (shouldReplaceTask(next[index], runtimeTask)) {
        next[index] = runtimeTask;
      }
    } else {
      next.unshift(runtimeTask);
    }
  }
  return next;
}

function runtimeConfigForTaskPanel(state, storage) {
  const config = readWorkbenchRuntimeConfig({ state, storage });
  const backend = cleanString(state?.get?.("runtime.connection")?.backend);
  if (config.mode === "browser" || (config.mode !== "runtime" && backend !== "runtime")) {
    return null;
  }
  return config;
}

export async function loadRuntimeTodoLists({
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch,
  limit = 200,
  updatedAfter = 0
} = {}) {
  const config = runtimeConfigForTaskPanel(state, storage);
  if (!config) return [];
  const url = new URL(`${config.baseUrl}/v1/todo-lists`);
  url.searchParams.set("limit", String(limit));
  if (Number(updatedAfter) > 0) {
    url.searchParams.set("updatedAfter", String(Math.floor(Number(updatedAfter))));
  }
  const response = await fetchImpl(url.href, {
    headers: { accept: "application/json" }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Runtime todo list load failed: ${response.status}`);
  }
  return (Array.isArray(body?.todoLists) ? body.todoLists : [])
    .map((item) => normalizeRuntimeTodoList(item))
    .filter((item) => item.ownerId && item.todos.length);
}

export async function loadRuntimeTodoList(ownerId, {
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForTaskPanel(state, storage);
  if (!config) return null;
  const id = cleanString(ownerId);
  if (!id) return null;
  const response = await fetchImpl(
    `${config.baseUrl}/v1/todo-lists/${encodeURIComponent(id)}`,
    { headers: { accept: "application/json" } }
  );
  if (response.status === 404) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Runtime todo list load failed: ${response.status}`);
  }
  return normalizeRuntimeTodoList(body?.todoList);
}

export function applyRuntimeTodoListsToState(todoLists, {
  state = globalThis.window?.zion?.state
} = {}) {
  const currentTasks = Array.isArray(state?.get?.("todo.tasks"))
    ? state.get("todo.tasks")
    : [];
  const nextTasks = mergeRuntimeTodoListsIntoTasks(currentTasks, todoLists);
  state?.set?.("todo.tasks", nextTasks);
  const activeTaskId = cleanString(state?.get?.("todo.activeTaskId"));
  if (!activeTaskId || !nextTasks.some((task) => cleanString(task.id) === activeTaskId)) {
    const currentSessionId = cleanString(state?.get?.("sessions.currentId"));
    const sessionTask = currentSessionId
      ? nextTasks.find((task) => cleanString(task.sessionId) === currentSessionId)
      : null;
    const fallbackTask = sessionTask || nextTasks[0] || null;
    if (fallbackTask?.id) state?.set?.("todo.activeTaskId", fallbackTask.id);
  }
  state?.set?.(TASK_PANEL_RUNTIME_SYNC_STATE_KEY, {
    status: "synced",
    syncedAt: Date.now(),
    count: nextTasks.filter((task) => cleanString(task.source) === TASK_PANEL_RUNTIME_SOURCE).length
  });
  return nextTasks;
}
