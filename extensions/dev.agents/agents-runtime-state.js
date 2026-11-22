import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
import {
  readWorkbenchRuntimeConfig
} from "../../src/runtime/workbench-runtime-config.ts";
import {
  AGENTS_ACTIVE_STORAGE_KEY,
  AGENTS_RUNTIME_KV_KEY,
  AGENTS_TASKS_STORAGE_KEY,
  normalizeAgentsSnapshot
} from "./agents-runtime-shared.js";

export {
  AGENTS_ACTIVE_STORAGE_KEY,
  AGENTS_RUNTIME_KV_KEY,
  AGENTS_TASKS_STORAGE_KEY,
  normalizeAgentsSnapshot
};

function readJson(storage, key, fallback) {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem?.(key, JSON.stringify(value));
  } catch {}
}

function stateTasks(state) {
  try {
    const tasks = state?.get?.("agents.tasks");
    return Array.isArray(tasks) ? tasks : null;
  } catch {
    return null;
  }
}

export function agentsSnapshotFromStorage({
  storage = localStorage,
  state = globalThis.window?.zion?.state
} = {}) {
  const tasks = stateTasks(state) || readJson(storage, AGENTS_TASKS_STORAGE_KEY, []);
  const activeTaskId = (() => {
    try {
      return String(state?.get?.(AGENTS_ACTIVE_STORAGE_KEY) || storage?.getItem?.(AGENTS_ACTIVE_STORAGE_KEY) || "");
    } catch {
      return "";
    }
  })();
  return normalizeAgentsSnapshot({
    savedAt: Date.now(),
    activeTaskId,
    tasks
  });
}

export function applyAgentsSnapshotToStorage(snapshot, {
  storage = localStorage,
  state = globalThis.window?.zion?.state
} = {}) {
  const value = normalizeAgentsSnapshot(snapshot);
  writeJson(storage, AGENTS_TASKS_STORAGE_KEY, value.tasks);
  try { storage?.setItem?.(AGENTS_ACTIVE_STORAGE_KEY, value.activeTaskId); } catch {}
  state?.set?.("agents.tasks", value.tasks);
  state?.set?.(AGENTS_ACTIVE_STORAGE_KEY, value.activeTaskId);
  state?.set?.("agents.runtimeSnapshot", value);
  return value;
}

function runtimeConfigForAgents(state, storage) {
  const config = readWorkbenchRuntimeConfig({ state, storage });
  const backend = String(state?.get?.("runtime.connection")?.backend || "").trim();
  if (config.mode === "browser" || (config.mode !== "runtime" && backend !== "runtime")) {
    return null;
  }
  return config;
}

export async function loadAgentsSnapshotFromRuntime({
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForAgents(state, storage);
  if (!config) return null;
  const response = await fetchImpl(
    `${config.baseUrl}/v1/workbench-state/kv/${encodeURIComponent(AGENTS_RUNTIME_KV_KEY)}`,
    { headers: { accept: "application/json" } }
  );
  if (response.status === 404) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Runtime agents load failed: ${response.status}`);
  }
  return normalizeAgentsSnapshot(body?.value);
}

export async function syncAgentsSnapshotToRuntime({
  snapshot,
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForAgents(state, storage);
  if (!config) return { synced: false, reason: "runtime-unavailable" };
  const value = normalizeAgentsSnapshot(snapshot || agentsSnapshotFromStorage({ storage, state }));
  const response = await fetchImpl(
    `${config.baseUrl}/v1/workbench-state/kv/${encodeURIComponent(AGENTS_RUNTIME_KV_KEY)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value })
    }
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.error || `Runtime agents sync failed: ${response.status}`);
  }
  state?.set?.("runtime.agentsSync", {
    status: "synced",
    syncedAt: Date.now(),
    count: value.tasks.length
  });
  return { synced: true, snapshot: value, result: body };
}

export function shouldApplyRuntimeAgentsSnapshot(localSnapshot, runtimeSnapshot) {
  const local = normalizeAgentsSnapshot(localSnapshot || {});
  const remote = normalizeAgentsSnapshot(runtimeSnapshot || {});
  const remoteChangedAt = Number(remote.lastChangedAt || remote.savedAt || 0);
  const localChangedAt = Number(local.lastChangedAt || local.savedAt || 0);
  if (!remote.tasks.length) {
    return !!local.tasks.length && remoteChangedAt > localChangedAt;
  }
  if (!local.tasks.length) return true;
  return remoteChangedAt > localChangedAt;
}

export function hasRuntimeActiveAgentTasks(snapshot) {
  return normalizeAgentsSnapshot(snapshot || {}).tasks.some((task) =>
    String(task.status || "") === "running"
    && String(task.activeRunId || "").trim()
  );
}
