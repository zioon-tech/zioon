export const SKILLS_RUNTIME_PLUGIN_ID = "dev.skills";
export const SKILLS_RUNTIME_STATE_NAMESPACE = "skills";
export const SKILLS_RUNTIME_SNAPSHOT_KEY = "snapshot";
export const SKILLS_RUNTIME_KV_KEY =
  `runtime.plugins.${SKILLS_RUNTIME_PLUGIN_ID}.${SKILLS_RUNTIME_STATE_NAMESPACE}.${SKILLS_RUNTIME_SNAPSHOT_KEY}`;
export const SKILLS_RUNTIME_SOURCES_KEY = "sources";
export const SKILLS_RUNTIME_SOURCES_KV_KEY =
  `runtime.plugins.${SKILLS_RUNTIME_PLUGIN_ID}.${SKILLS_RUNTIME_STATE_NAMESPACE}.${SKILLS_RUNTIME_SOURCES_KEY}`;
export const SKILLS_LOCAL_RUNTIME_NODE_ID = "runtime:local";
export const SKILLS_RUNTIME_PLUGIN_NODE_ID = "runtime:plugins";
const MAX_SKILL_BODY_CHARS = 512 * 1024;
const SYNCABLE_SKILL_TEXT_FILE_RE =
  /\.(md|mdx|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|xml|html|css|csv)$/i;
const PRIVATE_KEY_FILE_RE = /\.(?:key|pem|p12|pfx)$/i;
const SECRET_PATH_RE =
  /(^|\/)(?:\.env(?:\..*)?|\.git|node_modules|__MACOSX|\.ssh|\.aws|\.azure|id_rsa|id_ed25519|credentials?|secrets?|api[-_.]?keys?|tokens?)(?:\/|(?:\.[^/]*)?$)/i;

function uniqueStrings(value) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function isSyncableSkillFile(value) {
  const path = String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path || path.split("/").some((part) => part === "..")) return false;
  return SYNCABLE_SKILL_TEXT_FILE_RE.test(path)
    && !PRIVATE_KEY_FILE_RE.test(path)
    && !SECRET_PATH_RE.test(path);
}

function normalizeSkillPathSources(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .map((entry) => typeof entry === "string"
      ? { path: entry }
      : objectValue(entry))
    .map((entry) => ({
      path: String(entry.path || "").trim().replace(/\/+$/, ""),
      nodeId: String(entry.nodeId || entry.node_id || "").trim(),
      nodeLabel: String(entry.nodeLabel || entry.node_label || "").trim()
    }))
    .filter((entry) => {
      if (!entry.path) return false;
      const key = `${entry.nodeId}\0${entry.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeSkill(skill, defaults = {}) {
  const entry = objectValue(skill);
  const id = String(entry.id || "").trim();
  if (!id) return null;
  const body = typeof entry.body === "string"
    ? entry.body.slice(0, MAX_SKILL_BODY_CHARS)
    : "";
  return {
    id,
    name: String(entry.name || id),
    description: String(entry.description || ""),
    category: String(entry.category || ""),
    tags: uniqueStrings(entry.tags),
    difficulty: String(entry.difficulty || ""),
    allowedTools: uniqueStrings(entry.allowedTools),
    dependencies: uniqueStrings(entry.dependencies),
    path: String(entry.path || entry.sourcePath || ""),
    file: String(entry.file || entry.sourceFile || ""),
    source: String(entry.source || "user"),
    pluginId: String(entry.pluginId || ""),
    sourceNodeId: String(
      entry.sourceNodeId || entry.source_node_id || defaults.sourceNodeId || ""
    ),
    sourceNodeLabel: String(
      entry.sourceNodeLabel || entry.source_node_label || defaults.sourceNodeLabel || ""
    ),
    sourcePath: String(entry.sourcePath || entry.path || ""),
    sourceFile: String(entry.sourceFile || entry.file || ""),
    contentHash: String(entry.contentHash || entry.content_hash || ""),
    syncedAt: Number(entry.syncedAt || defaults.syncedAt) || 0,
    runtimeNodeId: String(entry.runtimeNodeId || entry.runtime_node_id || ""),
    runtimePath: String(entry.runtimePath || entry.runtime_path || ""),
    runtimeFile: String(entry.runtimeFile || entry.runtime_file || ""),
    runtimeCached: entry.runtimeCached === true || entry.runtime_cached === true,
    files: uniqueStrings(entry.files),
    ...(body ? { body } : {}),
    ...(entry.transient === true ? { transient: true } : {}),
    ...(Array.isArray(entry.sourceVariants) ? {
      sourceVariants: entry.sourceVariants.map((variant) => ({
        nodeId: String(variant?.nodeId || ""),
        nodeLabel: String(variant?.nodeLabel || ""),
        contentHash: String(variant?.contentHash || ""),
        syncedAt: Number(variant?.syncedAt) || 0
      }))
    } : {})
  };
}

function normalizeMaterializedSkills(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => objectValue(entry))
    .filter((entry) => String(entry.id || "").trim())
    .map((entry) => ({
      id: String(entry.id),
      pluginId: String(entry.pluginId || ""),
      pluginPath: String(entry.pluginPath || ""),
      skillName: String(entry.skillName || ""),
      relativePath: String(entry.relativePath || ""),
      sourceFile: String(entry.sourceFile || ""),
      path: String(entry.path || ""),
      file: String(entry.file || ""),
      files: uniqueStrings(entry.files)
    }));
}

export function normalizeSkillsSourceSnapshot(value = {}) {
  const source = objectValue(value);
  const sourceNodeId = String(source.nodeId || source.sourceNodeId || "").trim();
  const sourceNodeLabel = String(
    source.nodeLabel || source.sourceNodeLabel || sourceNodeId
  ).trim();
  const syncedAt = Number(source.syncedAt || source.savedAt) || Date.now();
  const catalog = (Array.isArray(source.catalog) ? source.catalog : source.skills)
    || [];
  return {
    nodeId: sourceNodeId,
    nodeLabel: sourceNodeLabel,
    syncedAt,
    paths: uniqueStrings(source.paths),
    catalog: catalog
      .map((skill) => normalizeSkill(skill, {
        sourceNodeId,
        sourceNodeLabel,
        syncedAt
      }))
      .filter(Boolean)
  };
}

export function reconcileSkillsSourceSnapshots({
  previousSources = [],
  scannedSources = [],
  configuredSources = [],
  successfulPaths = [],
  pluginCatalogReady = false,
  now = Date.now()
} = {}) {
  const previousByNode = new Map(
    previousSources
      .map(normalizeSkillsSourceSnapshot)
      .filter((source) => source.nodeId)
      .map((source) => [source.nodeId, source])
  );
  const scannedByNode = new Map(
    scannedSources
      .map(normalizeSkillsSourceSnapshot)
      .filter((source) => source.nodeId)
      .map((source) => [source.nodeId, source])
  );
  const configured = normalizeSkillPathSources(configuredSources)
    .filter((entry) => entry.nodeId);
  const succeeded = new Set(uniqueStrings(successfulPaths));
  const sourceNodeIds = new Set([
    ...previousByNode.keys(),
    ...scannedByNode.keys()
  ]);
  const result = [];

  for (const nodeId of sourceNodeIds) {
    const previous = previousByNode.get(nodeId);
    const scanned = scannedByNode.get(nodeId);
    const configuredForNode = configured.filter((entry) =>
      entry.nodeId === nodeId
    );
    const preserved = (previous?.catalog || []).filter((skill) => {
      if (skill.source === "plugin") return !pluginCatalogReady;
      const owners = configuredForNode.filter(({ path }) =>
        skill.sourcePath === path || skill.sourcePath.startsWith(`${path}/`)
      );
      return owners.length > 0 && !owners.some(({ path }) =>
        succeeded.has(`${nodeId}\0${path}`)
      );
    });
    const catalog = [...preserved, ...(scanned?.catalog || [])];
    const pluginCatalogChanged = pluginCatalogReady && (
      (previous?.catalog || []).some((skill) => skill.source === "plugin")
      || (scanned?.catalog || []).some((skill) => skill.source === "plugin")
    );
    const changed = !!scanned
      || pluginCatalogChanged
      || catalog.length !== (previous?.catalog.length || 0);
    result.push(normalizeSkillsSourceSnapshot({
      nodeId,
      nodeLabel: scanned?.nodeLabel || previous?.nodeLabel || nodeId,
      syncedAt: changed ? now : previous?.syncedAt,
      paths: configuredForNode.map((entry) => entry.path),
      catalog
    }));
  }

  return result;
}

export function mergeSkillsSourceSnapshots(sourceSnapshots, settings = {}) {
  const sources = (Array.isArray(sourceSnapshots) ? sourceSnapshots : [])
    .map(normalizeSkillsSourceSnapshot)
    .filter((source) => source.nodeId);
  const variantsById = new Map();
  for (const source of sources) {
    for (const skill of source.catalog) {
      const variants = variantsById.get(skill.id) || [];
      variants.push(skill);
      variantsById.set(skill.id, variants);
    }
  }
  const catalog = [];
  for (const variants of variantsById.values()) {
    variants.sort((left, right) =>
      Number(right.syncedAt || 0) - Number(left.syncedAt || 0)
      || Number(right.runtimeCached === true) - Number(left.runtimeCached === true)
      || String(left.sourceNodeId).localeCompare(String(right.sourceNodeId))
    );
    const winner = variants[0];
    catalog.push({
      ...winner,
      sourceVariants: variants.map((variant) => ({
        nodeId: variant.sourceNodeId,
        nodeLabel: variant.sourceNodeLabel,
        contentHash: variant.contentHash,
        syncedAt: variant.syncedAt
      }))
    });
  }
  catalog.sort((left, right) =>
    String(left.name || left.id).localeCompare(String(right.name || right.id))
  );
  const latestSourceAt = sources.reduce(
    (latest, source) => Math.max(latest, source.syncedAt),
    0
  );
  const hasEnabled = Object.prototype.hasOwnProperty.call(
    objectValue(settings),
    "enabled"
  );
  const enabled = uniqueStrings(settings.enabled);
  return {
    version: 2,
    savedAt: Math.max(Number(settings.savedAt) || 0, latestSourceAt)
      || Date.now(),
    paths: uniqueStrings(settings.paths || sources.flatMap((source) => source.paths)),
    pathSources: normalizeSkillPathSources(
      settings.pathSources
      || sources.flatMap((source) => source.paths.map((path) => ({
        path,
        nodeId: source.nodeId,
        nodeLabel: source.nodeLabel
      })))
    ),
    enabled: hasEnabled ? enabled : catalog.map((skill) => skill.id),
    catalog,
    sources,
    cacheContent: {},
    usageHistory: objectValue(settings.usageHistory),
    tokenBudget: Number(settings.tokenBudget) || 30000,
    config: objectValue(settings.config),
    dependencyGraph: objectValue(settings.dependencyGraph),
    pluginMaterialized: normalizeMaterializedSkills(settings.pluginMaterialized),
    pluginLastSync: Number(settings.pluginLastSync) || 0,
    lastScan: Number(settings.lastScan) || latestSourceAt || 0
  };
}

export function normalizeSkillsSnapshot(value = {}, {
  includeContent = true
} = {}) {
  const source = objectValue(value);
  const catalog = Array.isArray(source.catalog) ? source.catalog : [];
  const sources = (Array.isArray(source.sources) ? source.sources : [])
    .map(normalizeSkillsSourceSnapshot)
    .filter((entry) => entry.nodeId);
  const normalized = {
    version: 2,
    savedAt: Number(source.savedAt) || Date.now(),
    paths: uniqueStrings(source.paths),
    pathSources: normalizeSkillPathSources(source.pathSources || source.paths),
    enabled: uniqueStrings(source.enabled),
    catalog: catalog
      .map((skill) => normalizeSkill(skill))
      .filter(Boolean),
    sources,
    cacheContent: {},
    usageHistory: objectValue(source.usageHistory),
    tokenBudget: Number(source.tokenBudget) || 30000,
    config: objectValue(source.config),
    dependencyGraph: objectValue(source.dependencyGraph),
    pluginMaterialized: normalizeMaterializedSkills(source.pluginMaterialized),
    pluginLastSync: Number(source.pluginLastSync) || 0,
    lastScan: Number(source.lastScan) || 0
  };
  if (includeContent) return normalized;
  const strip = (skill) => {
    const { body: _body, ...metadata } = skill;
    return metadata;
  };
  return {
    ...normalized,
    catalog: normalized.catalog.map(strip),
    sources: normalized.sources.map((entry) => ({
      ...entry,
      catalog: entry.catalog.map(strip)
    }))
  };
}

function escapeXML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildAvailableSkillsContextXml(snapshot, {
  sourceStatusByNode = {},
  detailTool = "skillsList"
} = {}) {
  const normalized = normalizeSkillsSnapshot(snapshot);
  const enabledSet = new Set(normalized.enabled);
  const enabledSkills = normalized.catalog.filter((skill) =>
    enabledSet.has(skill.id)
  );
  const skillXMLs = enabledSkills
    .map((skill) => {
      const name = escapeXML(skill.name || skill.id);
      const desc = skill.description
        ? `<description>${escapeXML(skill.description)}</description>`
        : "";
      const cached = skill.runtimeCached || skill.body;
      const location = skill.runtimeFile
        || (!cached
          ? skill.file || (skill.path ? `${skill.path}/SKILL.md` : "")
          : "");
      const locationNodeId = skill.runtimeFile
        ? skill.runtimeNodeId
        : skill.sourceNodeId;
      const locationXml = location
        ? `<location${locationNodeId ? ` node_id="${escapeXML(locationNodeId)}"` : ""}>${escapeXML(location)}</location>`
        : "";
      const sourceStatus = String(
        sourceStatusByNode?.[skill.sourceNodeId] || ""
      );
      const sourceXml = skill.sourceNodeId
        ? `<source node_id="${escapeXML(skill.sourceNodeId)}"${sourceStatus ? ` status="${escapeXML(sourceStatus)}"` : ""}>${escapeXML(skill.sourceFile || skill.sourcePath)}</source>`
        : "";
      const cachedXml = cached
        ? "<runtime_cached>true</runtime_cached>"
        : "";
      const transientBody = skill.transient && skill.body
        ? `<instructions>${escapeXML(skill.body)}</instructions>`
        : "";
      return `  <skill>\n    <name>${name}</name>\n    ${desc}\n    ${locationXml}\n    ${sourceXml}\n    ${cachedXml}\n    ${transientBody}\n  </skill>`;
    })
    .join("\n");

  const hasCached = enabledSkills.some((skill) => skill.runtimeCached || skill.body);
  const hasOfflineSource = enabledSkills.some((skill) =>
    skill.sourceNodeId && sourceStatusByNode?.[skill.sourceNodeId] === "offline"
  );
  const guidance = [
    hasCached
      ? `For Runtime-cached skills, call ${detailTool} with name and include_body=true. Do not use Read or node_id for their source metadata.`
      : "",
    "Use the Read tool only for a non-cached skill that shows a location and node_id.",
    hasOfflineSource
      ? "A source Node is offline. Cached instructions remain usable for reasoning, but do not assume that source-local files, commands, credentials, login state, or environment variables are available."
      : ""
  ].filter(Boolean).join(" ");
  return `<available_skills>\n${skillXMLs}\n</available_skills>\n\n${guidance}`;
}

export function insertAfterLeadingSystem(messages, injectedMessage) {
  const list = Array.isArray(messages) ? messages : [];
  let insertAt = 0;
  while (insertAt < list.length && list[insertAt]?.role === "system") insertAt += 1;
  return [
    ...list.slice(0, insertAt),
    injectedMessage,
    ...list.slice(insertAt)
  ];
}
