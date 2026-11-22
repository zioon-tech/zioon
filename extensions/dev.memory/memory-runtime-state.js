import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
import {
  readWorkbenchRuntimeConfig
} from "../../src/runtime/workbench-runtime-config.ts";
import {
  DEFAULT_MEMORY_ROOT,
  MEMORY_ACTIVE_STORAGE_KEY,
  MEMORY_ITEMS_STORAGE_KEY,
  MEMORY_RUNTIME_KV_KEY,
  MEMORY_SETTINGS_STORAGE_KEY,
  buildMemoryContextFromSnapshot,
  insertAfterLeadingSystem,
  normalizeMemorySnapshot
} from "./memory-runtime-shared.js";

export {
  DEFAULT_MEMORY_ROOT,
  MEMORY_ACTIVE_STORAGE_KEY,
  MEMORY_ITEMS_STORAGE_KEY,
  MEMORY_RUNTIME_KV_KEY,
  MEMORY_SETTINGS_STORAGE_KEY,
  buildMemoryContextFromSnapshot,
  insertAfterLeadingSystem,
  normalizeMemorySnapshot
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

export function memorySnapshotFromStorage({
  storage = localStorage
} = {}) {
  const items = readJson(storage, MEMORY_ITEMS_STORAGE_KEY, []);
  const settings = readJson(storage, MEMORY_SETTINGS_STORAGE_KEY, {});
  const activeId = (() => {
    try { return storage?.getItem?.(MEMORY_ACTIVE_STORAGE_KEY) || ""; } catch { return ""; }
  })();
  return normalizeMemorySnapshot({
    savedAt: Date.now(),
    activeId,
    settings: {
      memoryRootPath: DEFAULT_MEMORY_ROOT,
      ...settings
    },
    items
  });
}

export function applyMemorySnapshotToStorage(snapshot, {
  storage = localStorage,
  state = globalThis.window?.zion?.state
} = {}) {
  const value = normalizeMemorySnapshot(snapshot);
  writeJson(storage, MEMORY_ITEMS_STORAGE_KEY, value.items);
  writeJson(storage, MEMORY_SETTINGS_STORAGE_KEY, value.settings);
  try { storage?.setItem?.(MEMORY_ACTIVE_STORAGE_KEY, value.activeId); } catch {}
  state?.set?.("memory.items", value.items);
  state?.set?.("memory.activeId", value.activeId);
  state?.set?.("memory.runtimeSnapshot", value);
  return value;
}

function runtimeConfigForMemory(state, storage) {
  const config = readWorkbenchRuntimeConfig({ state, storage });
  const backend = String(state?.get?.("runtime.connection")?.backend || "").trim();
  if (config.mode === "browser" || (config.mode !== "runtime" && backend !== "runtime")) {
    return null;
  }
  return config;
}

export async function loadMemorySnapshotFromRuntime({
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForMemory(state, storage);
  if (!config) return null;
  const response = await fetchImpl(
    `${config.baseUrl}/v1/workbench-state/kv/${encodeURIComponent(MEMORY_RUNTIME_KV_KEY)}`,
    { headers: { accept: "application/json" } }
  );
  if (response.status === 404) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Runtime memory load failed: ${response.status}`);
  }
  return normalizeMemorySnapshot(body?.value);
}

export async function syncMemorySnapshotToRuntime({
  snapshot,
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForMemory(state, storage);
  if (!config) return { synced: false, reason: "runtime-unavailable" };
  const value = normalizeMemorySnapshot(snapshot || memorySnapshotFromStorage({ storage }));
  const response = await fetchImpl(
    `${config.baseUrl}/v1/workbench-state/kv/${encodeURIComponent(MEMORY_RUNTIME_KV_KEY)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value })
    }
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.error || `Runtime memory sync failed: ${response.status}`);
  }
  state?.set?.("runtime.memorySync", {
    status: "synced",
    syncedAt: Date.now(),
    count: value.items.length
  });
  return { synced: true, snapshot: value, result: body };
}

export function shouldApplyRuntimeMemorySnapshot(localSnapshot, runtimeSnapshot) {
  const local = normalizeMemorySnapshot(localSnapshot || {});
  const remote = normalizeMemorySnapshot(runtimeSnapshot || {});
  const remoteChangedAt = Number(remote.lastChangedAt || remote.savedAt || 0);
  const localChangedAt = Number(local.lastChangedAt || local.savedAt || 0);
  if (!remote.items.length) {
    return !!local.items.length && remoteChangedAt > localChangedAt;
  }
  if (!local.items.length) return true;
  return remoteChangedAt > localChangedAt;
}
