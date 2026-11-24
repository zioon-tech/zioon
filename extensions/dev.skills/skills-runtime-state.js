import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
import {
  readWorkbenchRuntimeConfig
} from "../../src/runtime/workbench-runtime-config.ts";
import {
  buildAvailableSkillsContextXml,
  insertAfterLeadingSystem,
  isSyncableSkillFile,
  mergeSkillsSourceSnapshots,
  normalizeSkillsSnapshot,
  normalizeSkillsSourceSnapshot,
  reconcileSkillsSourceSnapshots,
  SKILLS_LOCAL_RUNTIME_NODE_ID
} from "./skills-runtime-shared.js";

export {
  buildAvailableSkillsContextXml,
  insertAfterLeadingSystem,
  isSyncableSkillFile,
  mergeSkillsSourceSnapshots,
  normalizeSkillsSnapshot,
  normalizeSkillsSourceSnapshot,
  reconcileSkillsSourceSnapshots,
  SKILLS_LOCAL_RUNTIME_NODE_ID
};

export const SKILLS_SNAPSHOT_STORAGE_KEY = "zion.skills.snapshot.v1";
const SKILLS_SOURCE_FINGERPRINT_STATE_KEY = "runtime.skillsSourceFingerprint";
const SKILLS_ENABLED_FINGERPRINT_STATE_KEY = "runtime.skillsEnabledFingerprint";
const runtimeClients = new WeakMap();
const applyingSnapshots = new WeakSet();

function skillsSnapshotSourceFingerprint(snapshot) {
  const value = normalizeSkillsSnapshot(snapshot);
  const sources = value.sources.length
    ? value.sources.map((source) => ({
        nodeId: source.nodeId,
        syncedAt: source.syncedAt,
        paths: source.paths,
        catalog: source.catalog.map((skill) => ({
          id: skill.id,
          contentHash: skill.contentHash,
          runtimeFile: skill.runtimeFile
        }))
      }))
    : value.catalog
      .filter((skill) =>
        skill.transient !== true && String(skill.sourceNodeId || "").trim()
      )
      .map((skill) => ({
        id: skill.id,
        sourceNodeId: skill.sourceNodeId,
        sourcePath: skill.sourcePath,
        contentHash: skill.contentHash,
        runtimeFile: skill.runtimeFile
      }));
  return JSON.stringify({
    version: value.version,
    paths: value.paths,
    pathSources: value.pathSources,
    sources
  });
}

function skillsSnapshotEnabledFingerprint(snapshot) {
  return JSON.stringify({
    enabled: normalizeSkillsSnapshot(snapshot).enabled
  });
}

function setRuntimeSnapshotFingerprints(state, snapshot) {
  if (!state?.set) return;
  state.set(SKILLS_SOURCE_FINGERPRINT_STATE_KEY, skillsSnapshotSourceFingerprint(snapshot));
  state.set(SKILLS_ENABLED_FINGERPRINT_STATE_KEY, skillsSnapshotEnabledFingerprint(snapshot));
}

export function selectNewestSkillsSnapshot(localSnapshot, runtimeSnapshot) {
  if (!runtimeSnapshot) {
    return localSnapshot
      ? { source: "local", snapshot: normalizeSkillsSnapshot(localSnapshot) }
      : null;
  }
  const runtime = normalizeSkillsSnapshot(runtimeSnapshot);
  if (!localSnapshot) return { source: "runtime", snapshot: runtime };
  const local = normalizeSkillsSnapshot(localSnapshot);
  const catalog = new Map(runtime.catalog.map((skill) => [skill.id, skill]));
  // A newer browser timestamp is not evidence of edited content.
  for (const skill of local.catalog) {
    if (skill.transient && skill.body) catalog.set(skill.id, skill);
  }
  return {
    source: "runtime",
    snapshot: normalizeSkillsSnapshot({
      ...local,
      savedAt: runtime.savedAt,
      enabled: runtime.enabled,
      sources: runtime.sources,
      catalog: [...catalog.values()]
    })
  };
}

export function skillsSnapshotFromState(state, defaults = {}) {
  return normalizeSkillsSnapshot({
    savedAt: Date.now(),
    paths: state?.get?.("skills.paths") || [],
    pathSources: state?.get?.("skills.pathSources") || [],
    enabled: state?.get?.("skills.enabled") || [],
    catalog: state?.get?.("skills.catalog") || [],
    sources: state?.get?.("skills.sources") || [],
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
  applyingSnapshots.add(state);
  try {
    for (const [key, next] of Object.entries(value)) {
      if (key === "version" || key === "savedAt" || key === "cacheContent") continue;
      if (JSON.stringify(state.get?.(`skills.${key}`)) !== JSON.stringify(next)) {
        state.set(`skills.${key}`, next);
      }
    }
  } finally {
    applyingSnapshots.delete(state);
  }
  return value;
}

export function isApplyingSkillsSnapshot(state) {
  return applyingSnapshots.has(state);
}

function runtimeConfigForSkills(state, storage) {
  const config = readWorkbenchRuntimeConfig({ state, storage });
  const backend = String(state?.get?.("runtime.connection")?.backend || "").trim();
  if (config.mode === "browser" || (config.mode !== "runtime" && backend !== "runtime")) {
    return null;
  }
  return config;
}

function runtimeClient(state, storage) {
  const config = runtimeConfigForSkills(state, storage);
  if (!state || !config) {
    if (state) disposeSkillsRuntimeState(state);
    return null;
  }
  let client = runtimeClients.get(state);
  if (!client || client.baseUrl !== config.baseUrl) {
    disposeSkillsRuntimeState(state);
    client = {
      baseUrl: config.baseUrl, baseline: null, enabled: new Map(),
      sources: new Map(), transient: new Map(),
      tail: Promise.resolve(), read: null, disposed: false
    };
    runtimeClients.set(state, client);
    state.set(SKILLS_SOURCE_FINGERPRINT_STATE_KEY, null);
    state.set(SKILLS_ENABLED_FINGERPRINT_STATE_KEY, null);
  }
  return client;
}

export function disposeSkillsRuntimeState(state) {
  const client = runtimeClients.get(state);
  if (client) {
    client.disposed = true;
    client.controller?.abort();
    runtimeClients.delete(state);
  }
}

function enqueue(client, operation) {
  const result = client.tail.then(() => {
    if (client.disposed) return null;
    return operation();
  });
  client.tail = result.catch(() => {});
  return result;
}

function sourceFingerprint(source) {
  return skillsSnapshotSourceFingerprint({ sources: [source] });
}

function sameContent(left, right) {
  return left?.contentHash === right?.contentHash
    && (left?.body || "") === (right?.body || "");
}

function projectedSnapshot(client, local) {
  const runtime = client.baseline;
  const selected = selectNewestSkillsSnapshot({ ...local, catalog: [] }, runtime).snapshot;
  if (client.sources.size) {
    const sources = new Map(runtime.sources.map((source) => [source.nodeId, source]));
    for (const [id, entry] of client.sources) sources.set(id, entry.value);
    const merged = mergeSkillsSourceSnapshots([...sources.values()], selected);
    selected.sources = merged.sources;
    selected.catalog = merged.catalog;
  }
  const catalog = new Map(selected.catalog.map((skill) => [skill.id, skill]));
  for (const [id, skill] of client.transient) {
    if (!sameContent(skill, catalog.get(id))) catalog.set(id, { ...skill, transient: true });
  }
  selected.catalog = [...catalog.values()];
  const enabled = new Set(runtime.enabled);
  const runtimeIds = new Set(runtime.catalog.map((skill) => skill.id));
  // Scan defaults are an observed view, not selection operations.
  for (const { value, initialEnabled } of client.sources.values()) {
    for (const skill of value.catalog) {
      if (!runtimeIds.has(skill.id) && initialEnabled.has(skill.id)) enabled.add(skill.id);
    }
  }
  for (const [id, entry] of client.enabled) {
    if (entry.value) enabled.add(id);
    else enabled.delete(id);
  }
  selected.enabled = [...enabled];
  return selected;
}

function markPending(client, state) {
  if (!client.enabled.size && !client.sources.size && !client.transient.size) return;
  state.set("runtime.skillsSync", {
    ...state.get("runtime.skillsSync"),
    status: "pending",
    pendingEnabled: [...client.enabled.keys()],
    pendingSources: [...client.sources.keys()],
    pending: [...client.transient.keys()]
  });
}

// Called synchronously for local changes, before idle persistence or a read can
// replace the view. No selection delta may be inferred from unverified storage.
export function captureSkillsSnapshotEdits({
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  snapshot = skillsSnapshotFromState(state),
  sources = true,
  scannedSources = []
} = {}) {
  const client = runtimeClient(state, storage);
  if (!client || isApplyingSkillsSnapshot(state)) return;
  const value = normalizeSkillsSnapshot(snapshot);
  const enabled = new Set(value.enabled);
  for (const source of scannedSources) {
    const scanned = normalizeSkillsSourceSnapshot(source);
    client.sources.set(scanned.nodeId, { value: scanned, initialEnabled: enabled });
  }
  if (!client.baseline) {
    markPending(client, state);
    return;
  }
  const projected = projectedSnapshot(client, value);
  const expected = new Set(projected.enabled);
  const catalogIds = new Set(value.catalog.map((skill) => skill.id));
  for (const id of new Set([
    ...client.baseline.catalog.map((skill) => skill.id), ...client.enabled.keys(),
    ...[...client.sources.values()].flatMap((entry) => entry.value.catalog.map((skill) => skill.id))
  ])) {
    if (catalogIds.has(id) && enabled.has(id) !== expected.has(id)) {
      client.enabled.set(id, { value: enabled.has(id) });
    }
  }
  if (!sources) {
    markPending(client, state);
    return;
  }
  const expectedSources = new Map(projected.sources.map((source) => [source.nodeId, source]));
  for (const source of value.sources) {
    if (sourceFingerprint(source) !== sourceFingerprint(expectedSources.get(source.nodeId) || {})) {
      client.sources.set(source.nodeId, { value: source, initialEnabled: enabled });
    }
  }
  const expectedCatalog = new Map(projectedSnapshot(client, value).catalog.map((skill) => [skill.id, skill]));
  const previousCatalog = new Map(projected.catalog.map((skill) => [skill.id, skill]));
  for (const skill of value.catalog) {
    const previous = expectedCatalog.get(skill.id);
    if (skill.body && (skill.transient || (
      previous && !sameContent(skill, previous)
      && !sameContent(skill, previousCatalog.get(skill.id))
    ))) {
      client.transient.set(skill.id, { ...skill, transient: true });
    }
  }
  markPending(client, state);
}

async function requestSnapshot(client, fetchImpl, path, payload, method = "GET") {
  const controller = new AbortController();
  client.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(`${client.baseUrl}${path}`, {
      method,
      headers: { accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}),
        ...(method === "GET" && client.etag && client.baseline ? { "if-none-match": client.etag } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: controller.signal
    });
    if (response.status === 304 && method === "GET" && client.baseline) return client.baseline;
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok === false || !body?.snapshot) {
      throw new Error(body?.error || `Runtime skills ${method} failed: ${response.status}`);
    }
    client.etag = method === "GET" ? response.headers?.get?.("etag") || "" : "";
    return normalizeSkillsSnapshot(body.snapshot);
  } finally {
    clearTimeout(timeout);
    client.controller = null;
  }
}

function acknowledgeSnapshot(client, state, snapshot, sentSources = [], sentEnabled = []) {
  if (client.disposed) return;
  if (!client.baseline) {
    for (const skill of state.get("skills.catalog") || []) {
      if (skill.transient && skill.body) client.transient.set(skill.id, skill);
    }
  }
  for (const [id, entry] of sentSources) {
    if (client.sources.get(id) === entry) client.sources.delete(id);
  }
  for (const [id, entry] of sentEnabled) {
    if (client.enabled.get(id) === entry) client.enabled.delete(id);
  }
  for (const skill of snapshot.catalog) {
    if (sameContent(client.transient.get(skill.id), skill)) client.transient.delete(skill.id);
  }
  client.baseline = snapshot;
  setRuntimeSnapshotFingerprints(state, snapshot);
  applySkillsSnapshotToState(state, projectedSnapshot(client, skillsSnapshotFromState(state)));
  const pending = [...client.transient.keys()];
  state.set("runtime.skillsSync", {
    status: client.enabled.size || client.sources.size || pending.length ? "pending" : "synced",
    syncedAt: Date.now(),
    enabled: snapshot.enabled.length,
    total: snapshot.catalog.length,
    hashes: Object.fromEntries(snapshot.catalog.map((skill) => [skill.id, skill.contentHash || ""])),
    pending,
    pendingEnabled: [...client.enabled.keys()],
    pendingSources: [...client.sources.keys()]
  });
}

export function loadSkillsSnapshotFromRuntime({
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const client = runtimeClient(state, storage);
  if (!client) return Promise.resolve(null);
  if (client.read) return client.read;
  client.read = enqueue(client, async () => {
    try {
      const snapshot = await requestSnapshot(client, fetchImpl, "/v1/skills/snapshot");
      acknowledgeSnapshot(client, state, snapshot);
      return client.disposed ? null : snapshot;
    } catch (error) {
      if (client.disposed) return null;
      throw error;
    }
  }).finally(() => { client.read = null; });
  return client.read;
}

export async function syncSkillsSnapshotToRuntime({
  snapshot,
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const client = runtimeClient(state, storage);
  if (!client) return { synced: false, reason: "runtime-unavailable" };
  if (!client.baseline) {
    state.set("runtime.skillsSync", { status: "pending", reason: "runtime-unacknowledged" });
    return { synced: false, reason: "runtime-unacknowledged" };
  }
  captureSkillsSnapshotEdits({ state, storage, snapshot: snapshot || skillsSnapshotFromState(state) });
  return await enqueue(client, async () => {
    let patched = false;
    let wrote = false;
    for (;;) {
      let sourceError = null;
      const sources = [...client.sources].filter(([, entry]) =>
        !entry.value.catalog.some((skill) => skill.transient)
      );
      if (sources.length) {
        try {
          const canonical = await requestSnapshot(client, fetchImpl, "/v1/skills/sync", {
            snapshot: { sources: sources.map(([, entry]) => entry.value) }
          }, "POST");
          acknowledgeSnapshot(client, state, canonical, sources);
          wrote = true;
        } catch (error) {
          sourceError = error;
        }
      }
      const knownIds = new Set(client.baseline.catalog.map((skill) => skill.id));
      const pendingSourceIds = new Set([...client.sources.values()]
        .flatMap((entry) => entry.value.catalog.map((skill) => skill.id)));
      // An unknown-ID PATCH cannot acknowledge intent while its source is pending.
      const enabled = [...client.enabled].filter(([id]) =>
        knownIds.has(id) || !pendingSourceIds.has(id)
      );
      if (enabled.length && !client.disposed) {
        const canonical = await requestSnapshot(client, fetchImpl, "/v1/skills/snapshot", {
          updates: enabled.map(([id, entry]) => ({ id, enabled: entry.value }))
        }, "PATCH");
        acknowledgeSnapshot(client, state, canonical, [], enabled);
        patched = wrote = true;
      }
      if (sourceError) throw sourceError;
      if (client.disposed) return { synced: false, reason: "runtime-changed" };
      if (!sources.length && !enabled.length) break;
    }
    return {
      synced: !client.enabled.size && !client.sources.size && !client.transient.size,
      patched,
      skipped: !wrote,
      snapshot: skillsSnapshotFromState(state)
    };
  }).catch((error) => {
    if (client.disposed) return { synced: false, reason: "runtime-changed" };
    throw error;
  });
}

export async function persistSkillsSnapshot({
  snapshot,
  state = globalThis.window?.zion?.state,
  storage = localStorage,
  fetchImpl = globalThis.fetch
} = {}) {
  const value = normalizeSkillsSnapshot(
    snapshot || skillsSnapshotFromState(state)
  );
  let localError = null;
  try {
    storage?.setItem?.(
      SKILLS_SNAPSHOT_STORAGE_KEY,
      JSON.stringify(normalizeSkillsSnapshot(value, { includeContent: false }))
    );
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
      ...state?.get?.("runtime.skillsSync"),
      status: "error",
      syncedAt: Date.now(),
      localSaved: !localError,
      error: error?.message || String(error)
    });
    if (localError) throw localError;
    throw error;
  }

  if (localError) {
    const canonical = runtimeResult?.snapshot || value;
    state?.set?.("runtime.skillsSync", {
      ...state?.get?.("runtime.skillsSync"),
      status: runtimeResult?.synced ? "synced-runtime-only" : "local-error",
      syncedAt: Date.now(),
      localSaved: false,
      enabled: canonical.enabled.length,
      total: canonical.catalog.length,
      error: localError?.message || String(localError)
    });
  }
  return {
    localSaved: !localError,
    runtimeSynced: runtimeResult?.synced === true,
    snapshot: runtimeResult?.snapshot || value,
    ...(localError ? { localError } : {})
  };
}

export function startSkillsSnapshotRefresh({
  refresh,
  isActive = () => false,
  document = globalThis.document,
  window = globalThis.window
}) {
  let disposed = false;
  let timer;
  let running = null;
  let failures = 0;
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed && !document.hidden) {
      timer = setTimeout(tick, Math.min(30_000, (isActive() ? 3_000 : 5_000) * 2 ** failures));
    }
  };
  const tick = () => {
    clearTimeout(timer);
    if (disposed || document.hidden) return Promise.resolve();
    if (running) return running;
    running = Promise.resolve().then(refresh)
      .then(() => { failures = 0; }, () => { failures = Math.min(failures + 1, 3); })
      .finally(() => { running = null; schedule(); });
    return running;
  };
  const visibility = () => {
    clearTimeout(timer);
    if (!document.hidden) void tick();
  };
  window.addEventListener("focus", tick);
  window.addEventListener("online", tick);
  document.addEventListener("visibilitychange", visibility);
  schedule();
  return {
    refresh: tick,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", tick);
      window.removeEventListener("online", tick);
      document.removeEventListener("visibilitychange", visibility);
    }
  };
}
