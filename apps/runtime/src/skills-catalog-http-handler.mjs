import { Buffer } from "node:buffer";
import {
  mergeSkillsSourceSnapshots,
  normalizeSkillsSnapshot,
  normalizeSkillsSourceSnapshot,
  SKILLS_LOCAL_RUNTIME_NODE_ID,
  SKILLS_RUNTIME_PLUGIN_NODE_ID,
  SKILLS_RUNTIME_KV_KEY,
  SKILLS_RUNTIME_SOURCES_KV_KEY
} from "../../../extensions/dev.skills/skills-runtime-shared.js";

const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

async function readJson(request, maxRequestBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      throw Object.assign(new Error("Skills sync request exceeds the configured limit"), {
        statusCode: 413
      });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Skills sync request must be valid JSON"), {
      statusCode: 400
    });
  }
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function uniqueStrings(value) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

function nodeStatuses(availableNodes, localSourceAvailable) {
  const nodes = typeof availableNodes === "function" ? availableNodes() : [];
  return {
    ...(localSourceAvailable ? { [SKILLS_LOCAL_RUNTIME_NODE_ID]: "online" } : {}),
    [SKILLS_RUNTIME_PLUGIN_NODE_ID]: "online",
    ...Object.fromEntries((Array.isArray(nodes) ? nodes : [])
    .map((node) => [String(node?.nodeId || ""), String(node?.status || "offline")])
    .filter(([nodeId]) => nodeId))
  };
}

function withSourceStatuses(snapshot, availableNodes, localSourceAvailable) {
  const sourceStatusByNode = nodeStatuses(
    availableNodes,
    localSourceAvailable
  );
  return {
    ...snapshot,
    catalog: snapshot.catalog.map((skill) => ({
      ...skill,
      sourceStatus: sourceStatusByNode[skill.sourceNodeId] || "offline"
    })),
    sources: snapshot.sources.map((source) => ({
      ...source,
      status: sourceStatusByNode[source.nodeId] || "offline"
    }))
  };
}

async function storedSources(store) {
  const value = objectValue(
    (await store.readKV(SKILLS_RUNTIME_SOURCES_KV_KEY))?.value
  );
  const sourceValues = Array.isArray(value.sources)
    ? value.sources
    : (() => {
        const snapshot = objectValue(value.snapshot);
        return Array.isArray(snapshot.sources) ? snapshot.sources : [];
      })();
  if (!Array.isArray(value.sources)) {
    const snapshot = objectValue(
      (await store.readKV(SKILLS_RUNTIME_KV_KEY))?.value
    );
    return (Array.isArray(snapshot.sources) ? snapshot.sources : [])
      .map(normalizeSkillsSourceSnapshot)
      .filter((source) => source.nodeId);
  }
  return sourceValues
    .map(normalizeSkillsSourceSnapshot)
    .filter((source) => source.nodeId);
}

function sourceSnapshotsFromBody(body) {
  const snapshot = objectValue(body.snapshot || body);
  const explicit = Array.isArray(snapshot.sources) ? snapshot.sources : [];
  if (explicit.length) {
    return explicit
      .map(normalizeSkillsSourceSnapshot)
      .filter((source) => source.nodeId);
  }
  const byNode = new Map();
  for (const skill of Array.isArray(snapshot.catalog) ? snapshot.catalog : []) {
    const nodeId = String(skill?.sourceNodeId || skill?.source_node_id || "").trim();
    if (!nodeId) continue;
    const source = byNode.get(nodeId) || {
      nodeId,
      nodeLabel: String(skill?.sourceNodeLabel || skill?.source_node_label || nodeId),
      syncedAt: Number(skill?.syncedAt || snapshot.savedAt) || Date.now(),
      paths: [],
      catalog: []
    };
    source.catalog.push(skill);
    if (skill?.sourcePath || skill?.path) {
      source.paths.push(String(skill.sourcePath || skill.path));
    }
    byNode.set(nodeId, source);
  }
  return [...byNode.values()].map(normalizeSkillsSourceSnapshot);
}

function settingsFromSnapshot(snapshot, previous = {}, {
  allowIncomingEnabled = true,
  previousHasEnabled = Object.prototype.hasOwnProperty.call(
    objectValue(previous),
    "enabled"
  )
} = {}) {
  const source = objectValue(snapshot);
  const previousValue = objectValue(previous);
  if (
    Number(source.savedAt) > 0
    && Number(previous.savedAt) > Number(source.savedAt)
  ) {
    return previousValue;
  }
  const settings = {
    ...previousValue,
    savedAt: Number(source.savedAt) || Date.now(),
    paths: Array.isArray(source.paths) ? source.paths : previous.paths,
    pathSources: Array.isArray(source.pathSources)
      ? source.pathSources
      : previous.pathSources,
    usageHistory: source.usageHistory ?? previous.usageHistory,
    tokenBudget: source.tokenBudget ?? previous.tokenBudget,
    config: source.config ?? previous.config,
    dependencyGraph: source.dependencyGraph ?? previous.dependencyGraph,
    pluginMaterialized: source.pluginMaterialized ?? previous.pluginMaterialized,
    pluginLastSync: source.pluginLastSync ?? previous.pluginLastSync,
    lastScan: source.lastScan ?? previous.lastScan
  };
  if (allowIncomingEnabled && Array.isArray(source.enabled)) {
    settings.enabled = source.enabled;
  } else if (previousHasEnabled) {
    settings.enabled = previous.enabled;
  }
  return settings;
}

function reconcileEnabledWithCatalog(previous, catalog) {
  const previousIds = new Set(
    (Array.isArray(previous.catalog) ? previous.catalog : [])
      .map((skill) => String(skill?.id || ""))
      .filter(Boolean)
  );
  const catalogIds = new Set(
    (Array.isArray(catalog) ? catalog : [])
      .map((skill) => String(skill?.id || ""))
      .filter(Boolean)
  );
  const enabled = new Set(
    uniqueStrings(previous.enabled).filter((id) => catalogIds.has(id))
  );
  for (const skill of Array.isArray(catalog) ? catalog : []) {
    if (skill?.id && !previousIds.has(skill.id)) enabled.add(skill.id);
  }
  return [...enabled];
}

export async function syncSkillsCatalog({ store, snapshot }) {
  const incomingSources = sourceSnapshotsFromBody({ snapshot });
  const previousSourceSnapshots = await storedSources(store);
  if (!incomingSources.length) {
    const storedSnapshot = (await store.readKV(SKILLS_RUNTIME_KV_KEY))?.value;
    const previous = normalizeSkillsSnapshot(storedSnapshot || {});
    const merged = mergeSkillsSourceSnapshots(
      previousSourceSnapshots,
      storedSnapshot ? previous : {}
    );
    merged.catalog = merged.catalog.map((skill) => ({
      ...skill,
      runtimeCached: !!(skill.body || skill.runtimeFile)
    }));
    await store.writeKV(SKILLS_RUNTIME_KV_KEY, merged);
    return merged;
  }
  const sourceMap = new Map(previousSourceSnapshots.map((source) => [source.nodeId, source]));
  for (const source of incomingSources) {
    const current = sourceMap.get(source.nodeId);
    if (!current || source.syncedAt >= current.syncedAt) {
      sourceMap.set(source.nodeId, source);
    }
  }

  const storedSnapshot = (await store.readKV(SKILLS_RUNTIME_KV_KEY))?.value;
  const previousHasEnabled = Object.prototype.hasOwnProperty.call(
    objectValue(storedSnapshot),
    "enabled"
  );
  const previous = normalizeSkillsSnapshot(storedSnapshot || {});
  const settings = settingsFromSnapshot(
    snapshot,
    storedSnapshot ? previous : {},
    {
      allowIncomingEnabled: !storedSnapshot,
      previousHasEnabled
    }
  );
  const merged = mergeSkillsSourceSnapshots([...sourceMap.values()], settings);
  if (storedSnapshot && previousHasEnabled) {
    // /sync is a source-catalog write. Once Runtime has shared state, enabled
    // Skills can only change through PATCH /v1/skills/snapshot.
    merged.enabled = reconcileEnabledWithCatalog(previous, merged.catalog);
  }
  merged.catalog = merged.catalog.map((skill) => ({
    ...skill,
    runtimeCached: !!(skill.body || skill.runtimeFile)
  }));
  await store.writeKV(SKILLS_RUNTIME_SOURCES_KV_KEY, {
    version: 1,
    sources: [...sourceMap.values()]
  });
  await store.writeKV(SKILLS_RUNTIME_KV_KEY, merged);
  return merged;
}

export function createSkillsCatalogHttpHandler({
  store,
  availableNodes = () => [],
  localSourceAvailable = false,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES
} = {}) {
  if (!store?.readKV || !store?.writeKV) {
    throw new Error("Skills catalog HTTP handler requires a state store");
  }

  return async function handleSkillsCatalog(request, response, url) {
    if (!url.pathname.startsWith("/v1/skills")) return false;
    try {
      if (request.method === "GET" && url.pathname === "/v1/skills/snapshot") {
        const snapshot = normalizeSkillsSnapshot(
          (await store.readKV(SKILLS_RUNTIME_KV_KEY))?.value || {}
        );
        json(response, 200, {
          snapshot: withSourceStatuses(
            snapshot,
            availableNodes,
            localSourceAvailable
          )
        });
        return true;
      }
      if (request.method === "POST" && url.pathname === "/v1/skills/sync") {
        const body = await readJson(request, maxRequestBytes);
        const snapshot = await syncSkillsCatalog({
          store,
          snapshot: body.snapshot || body
        });
        json(response, 200, {
          ok: true,
          snapshot: withSourceStatuses(
            snapshot,
            availableNodes,
            localSourceAvailable
          )
        });
        return true;
      }
      if (request.method === "PATCH" && url.pathname === "/v1/skills/snapshot") {
        const body = await readJson(request, maxRequestBytes);
        const hasUpdates = Object.prototype.hasOwnProperty.call(body || {}, "updates");
        if (hasUpdates && (
          Object.prototype.hasOwnProperty.call(body, "enabled")
          || !Array.isArray(body.updates)
          || body.updates.some((update) =>
            typeof update?.id !== "string" || !update.id.trim()
            || typeof update.enabled !== "boolean"
          )
        )) {
          json(response, 400, { error: "Use updates: [{ id, enabled: boolean }] or enabled: [], not both" });
          return true;
        }
        // Read and commit synchronously after parsing the body so concurrent
        // clients merge desired values against the latest committed selection.
        const current = normalizeSkillsSnapshot(
          (await store.readKV(SKILLS_RUNTIME_KV_KEY))?.value || {}
        );
        const enabled = new Set(current.enabled);
        const knownIds = new Set(current.catalog.map((skill) => skill.id));
        for (const update of hasUpdates ? body.updates : []) {
          const id = update.id.trim();
          if (!update.enabled) enabled.delete(id);
          else if (knownIds.has(id)) enabled.add(id);
        }
        const next = normalizeSkillsSnapshot({
          ...current,
          enabled: hasUpdates ? [...enabled] : Array.isArray(body?.enabled)
            ? body.enabled
            : current.enabled,
          savedAt: Date.now()
        });
        await store.writeKV(SKILLS_RUNTIME_KV_KEY, next);
        json(response, 200, {
          ok: true,
          snapshot: withSourceStatuses(
            next,
            availableNodes,
            localSourceAvailable
          )
        });
        return true;
      }
      json(response, 404, { error: "Skills catalog endpoint not found" });
    } catch (error) {
      json(response, Number(error?.statusCode) || 500, {
        error: error?.message || String(error)
      });
    }
    return true;
  };
}
