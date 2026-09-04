import {
  readWorkbenchRuntimeConfig
} from "../../src/runtime/workbench-runtime-config.ts";
import {
  buildAvailableSkillsContextXml,
  insertAfterLeadingSystem,
  normalizeSkillsSnapshot,
  SKILLS_RUNTIME_KV_KEY
} from "./skills-runtime-shared.js";

export {
  buildAvailableSkillsContextXml,
  insertAfterLeadingSystem,
  normalizeSkillsSnapshot,
  SKILLS_RUNTIME_KV_KEY
};

export const SKILLS_SNAPSHOT_STORAGE_KEY = "zion.skills.snapshot.v1";
const SKILLS_SNAPSHOT_FINGERPRINT_STATE_KEY = "runtime.skillsSnapshotFingerprint";

function skillsSnapshotRuntimeFingerprint(snapshot) {
  const value = normalizeSkillsSnapshot(snapshot);
  return JSON.stringify({
    version: value.version,
    paths: value.paths,
    enabled: value.enabled,
    catalog: value.catalog,
    cacheContent: value.cacheContent,
    usageHistory: value.usageHistory,
    tokenBudget: value.tokenBudget,
    config: value.config,
    dependencyGraph: value.dependencyGraph,
    pluginMaterialized: value.pluginMaterialized
  });
}

export function selectNewestSkillsSnapshot(localSnapshot, runtimeSnapshot) {
  if (!localSnapshot) {
    return runtimeSnapshot
      ? { source: "runtime", snapshot: normalizeSkillsSnapshot(runtimeSnapshot) }
      : null;
  }
  if (!runtimeSnapshot) {
    return { source: "local", snapshot: normalizeSkillsSnapshot(localSnapshot) };
  }
  const local = normalizeSkillsSnapshot(localSnapshot);
  const runtime = normalizeSkillsSnapshot(runtimeSnapshot);
  return Number(local.savedAt || 0) > Number(runtime.savedAt || 0)
    ? { source: "local", snapshot: local }
    : { source: "runtime", snapshot: runtime };
}

export function skillsSnapshotFromState(state, defaults = {}) {
  return normalizeSkillsSnapshot({
    savedAt: Date.now(),
    paths: state?.get?.("skills.paths") || [],
    enabled: state?.get?.("skills.enabled") || [],
    catalog: state?.get?.("skills.catalog") || [],
    cacheContent: state?.get?.("skills.cacheContent") || {},
    usageHistory: state?.get?.("skills.usageHistory") || {},
    tokenBudget: state?.get?.("skills.tokenBudget") || defaults.tokenBudget || 30000,
    config: state?.get?.("skills.config") || defaults.config || {},
    dependencyGraph: state?.get?.("skills.dependencyGraph") || {},
    pluginMaterialized: state?.get?.("skills.pluginMaterialized") || [],
    pluginLastSync: state?.get?.("skills.pluginLastSync") || 0,
    lastScan: state?.get?.("skills.lastScan") || 0
  });
}

export function applySkillsSnapshotToState(state, snapshot) {
  const value = normalizeSkillsSnapshot(snapshot);
  if (!state?.set) return value;
  state.set("skills.paths", value.paths);
  state.set("skills.enabled", value.enabled);
  state.set("skills.catalog", value.catalog);
  state.set("skills.cacheContent", value.cacheContent);
  state.set("skills.usageHistory", value.usageHistory);
  state.set("skills.tokenBudget", value.tokenBudget);
  state.set("skills.config", value.config);
  state.set("skills.dependencyGraph", value.dependencyGraph);
  state.set("skills.pluginMaterialized", value.pluginMaterialized);
  state.set("skills.pluginLastSync", value.pluginLastSync);
  state.set("skills.lastScan", value.lastScan);
  state.set(SKILLS_SNAPSHOT_FINGERPRINT_STATE_KEY, skillsSnapshotRuntimeFingerprint(value));
  return value;
}

function runtimeConfigForSkills(state, storage) {
  const config = readWorkbenchRuntimeConfig({ state, storage });
  const backend = String(state?.get?.("runtime.connection")?.backend || "").trim();
  if (config.mode === "browser" || (config.mode !== "runtime" && backend !== "runtime")) {
    return null;
  }
  return config;
}

export async function loadSkillsSnapshotFromRuntime({
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForSkills(state, storage);
  if (!config) return null;
  const response = await fetchImpl(
    `${config.baseUrl}/v1/workbench-state/kv/${encodeURIComponent(SKILLS_RUNTIME_KV_KEY)}`,
    { headers: { accept: "application/json" } }
  );
  if (response.status === 404) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `Runtime skills load failed: ${response.status}`);
  }
  return normalizeSkillsSnapshot(body?.value);
}

export async function syncSkillsSnapshotToRuntime({
  snapshot,
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const config = runtimeConfigForSkills(state, storage);
  if (!config) {
    return { synced: false, reason: "runtime-unavailable" };
  }
  const value = normalizeSkillsSnapshot(
    snapshot || skillsSnapshotFromState(state)
  );
  const fingerprint = skillsSnapshotRuntimeFingerprint(value);
  if (state?.get?.(SKILLS_SNAPSHOT_FINGERPRINT_STATE_KEY) === fingerprint) {
    state?.set?.("runtime.skillsSync", {
      status: "synced",
      skipped: true,
      syncedAt: Date.now(),
      enabled: value.enabled.length,
      total: value.catalog.length
    });
    return { synced: true, skipped: true, snapshot: value };
  }
  const response = await fetchImpl(
    `${config.baseUrl}/v1/workbench-state/kv/${encodeURIComponent(SKILLS_RUNTIME_KV_KEY)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value })
    }
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.error || `Runtime skills sync failed: ${response.status}`);
  }
  state?.set?.(SKILLS_SNAPSHOT_FINGERPRINT_STATE_KEY, fingerprint);
  state?.set?.("runtime.skillsSync", {
    status: "synced",
    syncedAt: Date.now(),
    enabled: value.enabled.length,
    total: value.catalog.length
  });
  return { synced: true, snapshot: value, result: body };
}

export async function persistSkillsSnapshot({
  snapshot,
  state = globalThis.window?.zion?.state,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const value = normalizeSkillsSnapshot(
    snapshot || skillsSnapshotFromState(state)
  );
  let localError = null;
  try {
    storage?.setItem?.(SKILLS_SNAPSHOT_STORAGE_KEY, JSON.stringify(value));
  } catch (error) {
    localError = error;
  }

  let runtimeResult;
  try {
    runtimeResult = await syncSkillsSnapshotToRuntime({
      snapshot: value,
      state,
      storage,
      fetchImpl
    });
  } catch (error) {
    state?.set?.("runtime.skillsSync", {
      status: "error",
      syncedAt: Date.now(),
      localSaved: !localError,
      error: error?.message || String(error)
    });
    if (localError) throw localError;
    throw error;
  }

  if (localError) {
    state?.set?.("runtime.skillsSync", {
      status: runtimeResult?.synced ? "synced-runtime-only" : "local-error",
      syncedAt: Date.now(),
      localSaved: false,
      enabled: value.enabled.length,
      total: value.catalog.length,
      error: localError?.message || String(localError)
    });
  }
  return {
    localSaved: !localError,
    runtimeSynced: runtimeResult?.synced === true,
    snapshot: value,
    ...(localError ? { localError } : {})
  };
}
