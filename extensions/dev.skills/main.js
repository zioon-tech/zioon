import { materializePluginSkills } from "./plugin-skills.js";
import {
  runtimeDeviceServiceBaseUrl
} from "../../src/runtime/workbench-runtime-config.ts";
import { createPluginLocations } from "../../src/plugin/data-locations.ts";
import { normalizeDataLocation } from "../../packages/plugin-sdk/src/data-location.mjs";
import {
  applySkillsSnapshotToState,
  buildAvailableSkillsContextXml,
  captureSkillsSnapshotEdits,
  disposeSkillsRuntimeState,
  insertAfterLeadingSystem as insertAfterLeadingSystemMessage,
  isApplyingSkillsSnapshot,
  isSyncableSkillFile,
  loadSkillsSnapshotFromRuntime,
  mergeSkillsSourceSnapshots,
  normalizeSkillsSnapshot,
  normalizeSkillsSourceSnapshot,
  persistSkillsSnapshot,
  reconcileSkillsSourceSnapshots,
  SKILLS_LOCAL_RUNTIME_NODE_ID,
  SKILLS_SNAPSHOT_STORAGE_KEY,
  skillsSnapshotFromState,
  startSkillsSnapshotRefresh,
} from "./skills-runtime-state.js";

const DEFAULT_CONFIG = {
  maxActiveSkills: 3,
  tokenBudget: 30000,
  metadataScanTokens: 100,
  safetyMargin: 5000,
  enableUsageTracking: true,
  enableDependencyResolution: true,
  scoring: {
    keywordMatchWeight: 2,
    tagMatchWeight: 3,
    categoryMatchWeight: 4,
    historyBoostWeight: 0.5,
    exactNameBoost: 5
  }
};

const I18N_NS = "dev.skills";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.skills": "技能",
    "cmd.openPanel": "打开技能面板",
    "cmd.scanNow": "立即扫描技能",
    "cmd.clearCache": "清除使用历史",
    "cmd.showStats": "显示技能统计",
    "cmd.openPanel.description": "管理技能目录、扫描 SKILL.md、启用或禁用技能",
    "cmd.scanNow.description": "扫描已配置目录中的 SKILL.md 文件",
    "cmd.clearCache.description": "清除使用历史统计",
    "cmd.showStats.description": "显示使用统计和性能指标",
    "status.skills": "技能：{enabled}/{total}",
    "status.tooltip": "管理技能",
    "settings.title": "Skills 配置",
    "settings.description": "管理技能目录、重新扫描技能索引，并批量启用或清理缓存。",
    "settings.enabled": "已启用 {enabled}/{total} 个 skills",
    "settings.paths": "Skills 目录",
    "settings.add": "添加",
    "settings.scan": "立即扫描",
    "settings.enableAll": "全部启用",
    "settings.clear": "清除缓存"
  },
  "en-US": {
    "category.skills": "Skills",
    "cmd.openPanel": "Open Skills Panel",
    "cmd.scanNow": "Scan Skills Now",
    "cmd.clearCache": "Clear Usage History",
    "cmd.showStats": "Show Skills Statistics",
    "cmd.openPanel.description": "Manage skill directories, scan SKILL.md, enable or disable skills",
    "cmd.scanNow.description": "Scan configured directories for SKILL.md files",
    "cmd.clearCache.description": "Clear usage history statistics",
    "cmd.showStats.description": "Display usage statistics and performance metrics",
    "status.skills": "Skills: {enabled}/{total}",
    "status.tooltip": "Manage Skills",
    "settings.title": "Skills",
    "settings.description": "Manage skill directories, rescan skills, enable all, or clear cache.",
    "settings.enabled": "{enabled}/{total} skills enabled",
    "settings.paths": "Skills Directories",
    "settings.add": "Add",
    "settings.scan": "Scan Now",
    "settings.enableAll": "Enable All",
    "settings.clear": "Clear Cache"
  }
};

function t(key, fallback, values) {
  try {
    const translated = window.zion?.i18n?.t?.(`${I18N_NS}.${key}`, values);
    if (translated && translated !== `${I18N_NS}.${key}`) return translated;
  } catch {}
  return fallback;
}

let skillsStatusDisp = null;

function getState() {
  return window.zion && window.zion.state;
}

function safeJSONParse(text) {
  try { return JSON.parse(String(text || "")); } catch { return null; }
}

function loadSnapshot() {
  try {
    const raw = localStorage.getItem(SKILLS_SNAPSHOT_STORAGE_KEY) || "";
    const parsed = safeJSONParse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const snapshot = normalizeSkillsSnapshot(parsed);
    return snapshot;
  } catch {
    return null;
  }
}

let snapshotIdle = 0;
let skillsScanPromise = null;
let skillsDisposed = false;
const removedSkillPaths = new Set();
let writeRetryTimer = 0;
let writeRetryDelay = 5000;
let writeRetryNeeded = false;
function scheduleWriteRetry() {
  if (skillsDisposed) return;
  writeRetryNeeded = true;
  clearTimeout(writeRetryTimer);
  if (document.hidden) return;
  writeRetryTimer = setTimeout(() => {
    writeRetryTimer = 0;
    if (!document.hidden) saveSnapshotSoon();
  }, writeRetryDelay);
  writeRetryDelay = Math.min(30_000, writeRetryDelay * 2);
}

function saveSnapshotSoon() {
  const state = getState();
  if (skillsDisposed || !state || isApplyingSkillsSnapshot(state)) return;
  captureSkillsSnapshotEdits({ state, sources: !skillsScanPromise });
  if (skillsScanPromise) return;
  if (snapshotIdle) cancelIdleCallback(snapshotIdle);
  snapshotIdle = requestIdleCallback(
    () => {
      snapshotIdle = 0;
      try {
        const state = getState();
        if (!state) return;
        const snap = skillsSnapshotFromState(state, DEFAULT_CONFIG);
        void persistSkillsSnapshot({ snapshot: snap, state })
          .then(() => {
            if (state.get("runtime.skillsSync")?.reason === "runtime-unacknowledged") {
              scheduleWriteRetry();
              return;
            }
            writeRetryNeeded = false;
            writeRetryDelay = 5000;
            clearTimeout(writeRetryTimer);
          })
          .catch((error) => {
            console.warn("[skills] snapshot persistence failed", error);
            scheduleWriteRetry();
          });
      } catch (error) {
        console.warn("[skills] snapshot creation failed", error);
      }
    },
    { timeout: 250 }
  );
}

function restoreFromSnapshotIfNeeded() {
  try {
    const state = getState();
    if (!state) return;
    const snap = loadSnapshot();
    if (!snap) return;

    const paths = state.get("skills.paths") || [];
    const catalog = state.get("skills.catalog") || [];
    const lastScan = state.get("skills.lastScan") || 0;

    // Only restore when state looks like a fresh boot/defaults.
    const looksEmpty =
      (!Array.isArray(paths) || paths.length === 0) &&
      (!Array.isArray(catalog) || catalog.length === 0) &&
      (!lastScan || lastScan === 0);
    if (!looksEmpty) return snap;

    applySkillsSnapshotToState(state, snap);
    return snap;
  } catch {
    return null;
  }
}

async function restoreFromRuntimeIfAvailable() {
  const state = getState();
  if (!state) return false;
  try {
    const runtimeSnapshot = await loadSkillsSnapshotFromRuntime({ state });
    if (!runtimeSnapshot) return false;
    try {
      localStorage.setItem(
        SKILLS_SNAPSHOT_STORAGE_KEY,
        JSON.stringify(normalizeSkillsSnapshot(skillsSnapshotFromState(state), {
          includeContent: false
        }))
      );
    } catch {}
    return true;
  } catch (error) {
    state.set("runtime.skillsSync", {
      ...state.get("runtime.skillsSync"),
      status: "error",
      syncedAt: Date.now(),
      error: error?.message || String(error)
    });
    return false;
  }
}

async function restoreAndRescanRuntimeSkills() {
  const loaded = await restoreFromRuntimeIfAvailable();
  if (!loaded) return false;
  await scanAllSkills();
  updateStatusBar();
  return true;
}

function ensureDefaults() {
  const state = getState();
  if (!state) return;

  if (!state.get("skills.paths")) state.set("skills.paths", []);
  if (!state.get("skills.pathSources")) state.set("skills.pathSources", []);
  if (!state.get("skills.enabled")) state.set("skills.enabled", []);
  if (!state.get("skills.catalog")) state.set("skills.catalog", []);
  if (!state.get("skills.sources")) state.set("skills.sources", []);
  if (!state.get("skills.cacheContent")) state.set("skills.cacheContent", {});
  if (!state.get("skills.usageHistory")) state.set("skills.usageHistory", {});
  if (!state.get("skills.tokenBudget")) state.set("skills.tokenBudget", DEFAULT_CONFIG.tokenBudget);
  if (!state.get("skills.config")) state.set("skills.config", DEFAULT_CONFIG);
  if (!state.get("skills.dependencyGraph")) state.set("skills.dependencyGraph", {});
  if (!state.get("skills.pluginMaterialized")) state.set("skills.pluginMaterialized", []);
  if (!state.get("skills.pluginLastSync")) state.set("skills.pluginLastSync", 0);
  if (!state.get("skills.lastScan")) state.set("skills.lastScan", 0);
}

function getLocalToolsBase() {
  const runtimeBase = runtimeDeviceServiceBaseUrl("local-tools");
  if (runtimeBase) return runtimeBase;
  const state = getState();
  const raw = (state && state.get("localTools.baseUrl")) || "http://127.0.0.1:8765";
  return String(raw || "http://127.0.0.1:8765").replace(/\/$/, "");
}

function usesRuntimeDeviceService() {
  return !!runtimeDeviceServiceBaseUrl("local-tools");
}

let pluginSkillsRootPromise = null;
let skillsDataLocationPromise = null;
const MAX_SYNCED_SKILL_FILES = 128;
const MAX_SYNCED_SKILL_BYTES = 8 * 1024 * 1024;
const MAX_SYNCED_SKILL_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_SYNCED_SKILL_AUXILIARY_FILE_BYTES = 512 * 1024;

function localToolsUrl(base, endpoint, {
  path,
  nodeId,
  ...params
} = {}) {
  const url = new URL(`${String(base || "").replace(/\/+$/, "")}${endpoint}`,
    globalThis.location?.href || "http://localhost/");
  if (path != null) url.searchParams.set("path", String(path));
  if (nodeId && nodeId !== SKILLS_LOCAL_RUNTIME_NODE_ID) {
    url.searchParams.set("node_id", String(nodeId));
  }
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function normalizedNodeId(value) {
  return String(value || "").trim();
}

function normalizeSkillFsPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function skillPathOverlaps(path, root) {
  const target = normalizeSkillFsPath(path);
  const base = normalizeSkillFsPath(root);
  if (!target || !base) return false;
  return target === base
    || target.startsWith(`${base}/`)
    || base.startsWith(`${target}/`);
}

function sourceFromKnownSkillPaths(path, state = getState()) {
  const candidates = new Map();
  const add = (root, nodeId, nodeLabel = "") => {
    const normalizedNode = normalizedNodeId(nodeId);
    if (!normalizedNode || !skillPathOverlaps(path, root)) return;
    candidates.set(normalizedNode, {
      path: normalizeSkillFsPath(path),
      nodeId: normalizedNode,
      nodeLabel: String(nodeLabel || normalizedNode)
    });
  };
  for (const entry of Array.isArray(state?.get?.("skills.pathSources"))
    ? state.get("skills.pathSources")
    : []) {
    add(entry?.path, entry?.nodeId || entry?.node_id, entry?.nodeLabel || entry?.node_label);
  }
  for (const source of Array.isArray(state?.get?.("skills.sources"))
    ? state.get("skills.sources")
    : []) {
    const nodeId = source?.nodeId || source?.sourceNodeId;
    const nodeLabel = source?.nodeLabel || source?.sourceNodeLabel || nodeId;
    for (const root of Array.isArray(source?.paths) ? source.paths : []) {
      add(root, nodeId, nodeLabel);
    }
    for (const skill of Array.isArray(source?.catalog) ? source.catalog : []) {
      add(skill?.sourcePath || skill?.path, nodeId, nodeLabel);
      add(skill?.sourceFile || skill?.file, nodeId, nodeLabel);
    }
  }
  for (const skill of Array.isArray(state?.get?.("skills.catalog"))
    ? state.get("skills.catalog")
    : []) {
    add(
      skill?.sourcePath || skill?.path,
      skill?.sourceNodeId || skill?.source_node_id,
      skill?.sourceNodeLabel || skill?.source_node_label
    );
    add(
      skill?.sourceFile || skill?.file,
      skill?.sourceNodeId || skill?.source_node_id,
      skill?.sourceNodeLabel || skill?.source_node_label
    );
  }
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

function pathSourceFor(path, state = getState()) {
  const normalizedPath = normalizeSkillFsPath(path);
  const configured = state?.get?.("skills.pathSources");
  const match = (Array.isArray(configured) ? configured : []).find((entry) =>
    normalizeSkillFsPath(entry?.path) === normalizedPath
  );
  if (match) {
    return {
      path: normalizedPath,
      nodeId: normalizedNodeId(match.nodeId || match.node_id),
      nodeLabel: String(match.nodeLabel || match.node_label || "")
    };
  }
  return { path: normalizedPath, nodeId: "", nodeLabel: "" };
}

function rememberPathSource(state, source) {
  if (!source?.path) return;
  const current = Array.isArray(state?.get?.("skills.pathSources"))
    ? state.get("skills.pathSources")
    : [];
  const key = `${normalizedNodeId(source.nodeId)}\0${normalizeSkillFsPath(source.path)}`;
  const next = [
    ...current.filter((entry) =>
      `${normalizedNodeId(entry?.nodeId)}\0${normalizeSkillFsPath(entry?.path)}` !== key
      && normalizeSkillFsPath(entry?.path) !== normalizeSkillFsPath(source.path)
    ),
    {
      path: normalizeSkillFsPath(source.path),
      nodeId: normalizedNodeId(source.nodeId),
      nodeLabel: String(source.nodeLabel || "")
    }
  ];
  state?.set?.("skills.pathSources", next);
}

async function skillsDataLocation() {
  if (!skillsDataLocationPromise) {
    skillsDataLocationPromise = createPluginLocations("dev.skills").data
      .then(normalizeDataLocation)
      .catch((error) => {
        skillsDataLocationPromise = null;
        throw error;
      });
  }
  return await skillsDataLocationPromise;
}

async function sha256Text(value) {
  const bytes = new globalThis.TextEncoder().encode(String(value || ""));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeSkillSegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    || "skill";
}

function inferHomeDirectory(session) {
  const explicit = String(session?.home || session?.home_dir || session?.homeDirectory || "")
    .trim()
    .replace(/\/+$/, "");
  if (explicit) return explicit;
  const cwd = String(session?.cwd || session?.initial_cwd || "").trim().replace(/\\/g, "/");
  const unixMatch = cwd.match(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?:\/|$)/);
  if (unixMatch) return unixMatch[1];
  const windowsMatch = cwd.match(/^([A-Za-z]:\/Users\/[^/]+)(?:\/|$)/i);
  return windowsMatch ? windowsMatch[1] : "";
}

function localHomeSources(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  return list
    .filter((session) => String(session?.type || "local").toLowerCase() !== "ssh")
    .map((session) => ({
      home: normalizeSkillFsPath(inferHomeDirectory(session)),
      nodeId: normalizedNodeId(session?.nodeId || session?.node_id)
        || SKILLS_LOCAL_RUNTIME_NODE_ID,
      nodeLabel: String(
        session?.nodeLabel
        || session?.node_label
        || (session?.nodeId || session?.node_id ? "" : "This Runtime")
      )
    }))
    .filter((entry) => entry.home);
}

function pickLocalHomeSource(sessions) {
  const local = localHomeSources(sessions);
  const unique = new Map(local.map((entry) => [
    `${entry.nodeId}\0${entry.home}`,
    entry
  ]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function sourceFromSessionsForPath(path, sessions) {
  const normalizedPath = normalizeSkillFsPath(path);
  const matches = localHomeSources(sessions)
    .filter((entry) => skillPathOverlaps(normalizedPath, entry.home));
  if (!matches.length) return null;
  const longestHome = matches.reduce(
    (longest, entry) => Math.max(longest, entry.home.length),
    0
  );
  const candidates = new Map(matches
    .filter((entry) => entry.home.length === longestHome)
    .map((entry) => [entry.nodeId, {
      path: normalizedPath,
      nodeId: entry.nodeId,
      nodeLabel: entry.nodeLabel
    }]));
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

async function resolvePathSource(base, configured, state = getState()) {
  const path = normalizeSkillFsPath(configured?.path || configured);
  const explicit = {
    path,
    nodeId: normalizedNodeId(configured?.nodeId || configured?.node_id),
    nodeLabel: String(configured?.nodeLabel || configured?.node_label || "")
  };
  if (!path || explicit.nodeId) return explicit;
  const known = sourceFromKnownSkillPaths(path, state);
  if (known) return known;
  const stateSessionSource = sourceFromSessionsForPath(
    path,
    state?.get?.("terminal.sessions")
  );
  if (stateSessionSource) return stateSessionSource;
  try {
    const response = await fetch(`${base}/sessions`, { method: "GET" });
    const data = await response.json().catch(() => null);
    if (response.ok) {
      const source = sourceFromSessionsForPath(path, data?.sessions);
      if (source) return source;
    }
  } catch {}
  return explicit;
}

function isDeviceAccessApprovalError(error) {
  return String(error?.code || "") === "DEVICE_ACCESS_APPROVAL_REQUIRED"
    || /Device access approval required/i.test(String(error?.message || ""));
}

async function resolvePluginSkillsRoot() {
  if (pluginSkillsRootPromise) return pluginSkillsRootPromise;
  pluginSkillsRootPromise = (async () => {
    const state = getState();
    const base = getLocalToolsBase();
    const configured = String(state?.get("skills.pluginRootPath") || "").trim();
    if (configured && configured !== "~" && !configured.startsWith("~/")) {
      const source = await resolvePathSource(base, { path: configured }, state);
      return {
        root: source.path,
        nodeId: source.nodeId,
        nodeLabel: source.nodeLabel
      };
    }
    const pathSources = (Array.isArray(state?.get("skills.pathSources"))
      ? state.get("skills.pathSources")
      : [])
      .map((entry) => ({
        path: String(entry?.path || "").replace(/\/+$/, ""),
        nodeId: normalizedNodeId(entry?.nodeId || entry?.node_id),
        nodeLabel: String(entry?.nodeLabel || entry?.node_label || "")
      }))
      .filter((entry) => entry.path && entry.nodeId);
    const uniquePathNodes = new Set(pathSources.map((entry) => entry.nodeId));
    if (!configured && uniquePathNodes.size === 1) {
      const defaultRoot = pathSources.find((entry) =>
        /(?:^|\/)\.zion-next\/skills$/.test(entry.path)
      );
      if (defaultRoot) {
        return {
          root: `${defaultRoot.path}/.plugins`,
          nodeId: defaultRoot.nodeId,
          nodeLabel: defaultRoot.nodeLabel
        };
      }
    }
    let source = pickLocalHomeSource(state?.get("terminal.sessions"));
    if (!source) {
      const response = await fetch(`${base}/sessions`, { method: "GET" });
      const data = await response.json().catch(() => null);
      if (response.ok) source = pickLocalHomeSource(data?.sessions);
    }
    if (!source?.home) return null;
    const suffix = configured.startsWith("~/") ? configured.slice(2) : ".zion-next/skills/.plugins";
    return {
      root: `${source.home.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`,
      nodeId: source.nodeId,
      nodeLabel: source.nodeLabel
    };
  })();
  try {
    const result = await pluginSkillsRootPromise;
    if (!result) pluginSkillsRootPromise = null;
    return result;
  } catch (error) {
    pluginSkillsRootPromise = null;
    throw error;
  }
}

async function syncPluginSkills() {
  const state = getState();
  const manager = window.zion?.plugins;
  if (!state || !manager || typeof manager.getEnabledPlugins !== "function") {
    return {
      entries: Array.isArray(state?.get("skills.pluginMaterialized"))
        ? state.get("skills.pluginMaterialized")
        : [],
      ready: false
    };
  }
  const previous = Array.isArray(state.get("skills.pluginMaterialized"))
    ? state.get("skills.pluginMaterialized")
    : [];
  const location = await resolvePluginSkillsRoot();
  if (!location?.root || (usesRuntimeDeviceService() && !location.nodeId)) {
    return { entries: previous, ready: false };
  }
  const materialized = await materializePluginSkills({
    base: getLocalToolsBase(),
    root: location.root,
    nodeId: location.nodeId,
    previous,
    plugins: manager.getEnabledPlugins()
  });
  state.set("skills.pluginMaterialized", materialized.map((entry) => ({
    ...entry,
    sourceNodeId: location.nodeId,
    sourceNodeLabel: location.nodeLabel
  })));
  state.set("skills.pluginLastSync", Date.now());
  return {
    entries: materialized.map((entry) => ({
      ...entry,
      sourceNodeId: location.nodeId,
      sourceNodeLabel: location.nodeLabel
    })),
    nodeId: location.nodeId,
    ready: true
  };
}

function getEnabledSet() {
  const state = getState();
  const enabled = (state && state.get("skills.enabled")) || [];
  return new Set(Array.isArray(enabled) ? enabled : []);
}

function getCatalog() {
  const state = getState();
  const catalog = (state && state.get("skills.catalog")) || [];
  return Array.isArray(catalog) ? catalog : [];
}

async function listDirEntries(base, dir, nodeId = "") {
  const url = localToolsUrl(base, "/files/entries", {
    path: dir,
    nodeId,
    max_depth: 1
  });
  const res = await fetch(url, { method: "GET" });
  const j = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(j?.error || `Skill directory scan failed: ${res.status}`);
    error.statusCode = res.status;
    if (j?.code) error.code = String(j.code);
    if (j?.requestId) error.requestId = String(j.requestId);
    throw error;
  }
  const rootPath = String((j && j.path) ? j.path : dir).replace(/\/$/, "");
  const raw = (j && typeof j === "object" && "results" in j) ? j.results : j;
  const entries = [];
  const seen = new Set();
  const addEntry = (path, type) => {
    const key = path + "|" + type;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ path, type });
  };

  if (Array.isArray(raw)) {
    raw.forEach((it) => {
      const p = String(it?.path || it?.full_path || it || "").trim();
      if (!p) return;
      const isDir = p.endsWith("/");
      const type = String(it?.type || it?.kind || "").toLowerCase() || (isDir ? "dir" : "file");
      addEntry(p.replace(/\/$/, ""), isDir || type === "directory" ? "dir" : type);
    });
    entries.nodeId = normalizedNodeId(j?.node_id || nodeId)
      || SKILLS_LOCAL_RUNTIME_NODE_ID;
    entries.nodeLabel = String(
      j?.node_label
      || (entries.nodeId === SKILLS_LOCAL_RUNTIME_NODE_ID ? "This Runtime" : "")
    );
    return entries;
  }

  if (typeof raw === "string") {
    raw.split(/\r?\n/).forEach((ln) => {
      if (!/^-\s+/.test(ln)) return;
      const name = ln.replace(/^-\s+/, "").trim();
      if (!name) return;
      const isDir = /\/$/.test(name);
      const cleanName = name.replace(/\/$/, "");
      addEntry(`${rootPath}/${cleanName}`, isDir ? "dir" : "file");
    });
  }

  entries.nodeId = normalizedNodeId(j?.node_id || nodeId)
    || SKILLS_LOCAL_RUNTIME_NODE_ID;
  entries.nodeLabel = String(
    j?.node_label
    || (entries.nodeId === SKILLS_LOCAL_RUNTIME_NODE_ID ? "This Runtime" : "")
  );
  return entries;
}

async function fileExists(base, path, nodeId = "") {
  try {
    const url = localToolsUrl(base, "/files/read", {
      path,
      nodeId,
      offset: 0,
      limit: 1
    });
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return false;
    const json = await res.json().catch(() => null);
    return json !== null && !json.error;
  } catch {
    return false;
  }
}

async function readFile(base, path, {
  headOnly = false,
  maxBytes = 0,
  nodeId = ""
} = {}) {
  try {
    const url = localToolsUrl(base, "/files/read", { path, nodeId });
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return "";
    const contentLength = Number(res.headers.get("content-length")) || 0;
    if (maxBytes > 0 && contentLength > maxBytes * 2 + 4096) return "";
    const json = await res.json().catch(() => null);
    if (!json) return "";
    const text = String(json.content || "");
    if (
      maxBytes > 0
      && new globalThis.TextEncoder().encode(text).byteLength > maxBytes
    ) {
      return "";
    }
    return headOnly ? text.slice(0, 6144) : text;
  } catch {
    return "";
  }
}

async function readSkillBundle(base, skillRoot, nodeId) {
  const skillBody = await readFile(base, `${skillRoot}/SKILL.md`, {
    maxBytes: MAX_SYNCED_SKILL_DOCUMENT_BYTES,
    nodeId
  });
  if (!skillBody) return {};
  const files = { "SKILL.md": skillBody };
  let totalBytes = new globalThis.TextEncoder().encode(skillBody).byteLength;
  const queue = [{ path: skillRoot, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    const entries = await listDirEntries(base, current.path, nodeId);
    for (const entry of entries) {
      const relative = String(entry.path || "")
        .slice(String(skillRoot).length)
        .replace(/^\/+/, "");
      if (!relative || relative.split("/").some((part) => part === "..")) continue;
      if (entry.type === "dir") {
        if (!isSyncableSkillFile(`${relative}/placeholder.md`)) continue;
        if (current.depth < 6) {
          queue.push({ path: entry.path, depth: current.depth + 1 });
        }
        continue;
      }
      if (relative === "SKILL.md") continue;
      if (!isSyncableSkillFile(relative)) continue;
      if (Object.keys(files).length >= MAX_SYNCED_SKILL_FILES) {
        return files;
      }
      const content = await readFile(base, entry.path, {
        maxBytes: MAX_SYNCED_SKILL_AUXILIARY_FILE_BYTES,
        nodeId
      });
      if (!content) continue;
      const contentBytes = new globalThis.TextEncoder().encode(content).byteLength;
      if (totalBytes + contentBytes > MAX_SYNCED_SKILL_BYTES) return files;
      totalBytes += contentBytes;
      files[relative] = content;
    }
  }
  return files;
}

async function cacheSkillBundleAtRuntime(skill, files) {
  const body = String(files?.["SKILL.md"] || skill?.body || "");
  if (!body.trim()) return skill;
  const stableBundle = Object.entries(files || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => `${path}\0${content}`)
    .join("\0");
  const contentHash = await sha256Text(stableBundle || body);
  try {
    const location = await skillsDataLocation();
    const runtimePath = `${location.root}/cache/${safeSkillSegment(skill.id)}/${contentHash}`;
    for (const [relativePath, content] of Object.entries(files || {})) {
      const target = `${runtimePath}/${relativePath}`;
      const response = await fetch(localToolsUrl(
        getLocalToolsBase(),
        "/files/write",
        {
          nodeId: location.nodeId,
          plugin_data_version: 1
        }
      ), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: target,
          content,
          create_only: true
        })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error || `Runtime Skill cache failed: ${response.status}`);
      }
    }
    return {
      ...skill,
      body,
      contentHash,
      runtimeCached: true,
      runtimeNodeId: location.nodeId,
      runtimePath,
      runtimeFile: `${runtimePath}/SKILL.md`
    };
  } catch (error) {
    console.warn(`[skills] Runtime cache unavailable for ${skill.id}`, error);
    return {
      ...skill,
      body,
      contentHash,
      runtimeCached: false
    };
  }
}

function normalizeArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return String(val).split(/[,\s]+/).filter(Boolean);
}

function parseSkillFrontMatter(text) {
  try {
    const m = /^---\s*[\r\n]+([\s\S]*?)[\r\n]+---\s*/.exec(text || "");
    if (!m) return {};
    const meta = {};
    m[1].split(/\r?\n/).forEach((ln) => {
      const kv = ln.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+)\s*$/);
      if (!kv) return;
      const key = kv[1].trim();
      let val = kv[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      const arr = val.match(/^\[(.*)\]$/);
      if (arr) {
        meta[key] = arr[1].split(",").map((s) => s.trim()).filter(Boolean);
        return;
      }
      if (/^(true|false)$/i.test(val)) val = val.toLowerCase() === "true";
      else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
      meta[key] = val;
    });

    return {
      name: meta.name,
      description: meta.description,
      category: meta.category,
      difficulty: meta.difficulty,
      tags: normalizeArray(meta.tags || meta.tag),
      allowedTools: normalizeArray(meta["allowed-tools"] || meta.allowedTools),
      dependencies: normalizeArray(meta.dependencies)
    };
  } catch {
    return {};
  }
}

async function buildPluginSkillCatalog(entries, base) {
  const catalog = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry?.id || !entry?.file || !entry?.path) continue;
    const nodeId = normalizedNodeId(entry.sourceNodeId);
    const files = await readSkillBundle(base, entry.path, nodeId);
    const body = String(files["SKILL.md"] || "");
    if (!body) continue;
    const meta = parseSkillFrontMatter(body.slice(0, 6144));
    catalog.push(await cacheSkillBundleAtRuntime({
      id: entry.id,
      name: meta.name || entry.skillName || entry.id,
      description: meta.description || "",
      category: meta.category || "",
      tags: meta.tags || [],
      difficulty: meta.difficulty || "",
      allowedTools: meta.allowedTools || [],
      dependencies: meta.dependencies || [],
      path: entry.path,
      file: entry.file,
      source: "plugin",
      pluginId: entry.pluginId,
      sourceNodeId: nodeId,
      sourceNodeLabel: String(entry.sourceNodeLabel || ""),
      sourcePath: entry.path,
      sourceFile: entry.file,
      syncedAt: Date.now(),
      body
    }, files));
  }
  return catalog;
}

async function scanAllSkillsWhileLocked(state) {
  const base = getLocalToolsBase();
  const prevCatalog = getCatalog();
  let paths = state.get("skills.paths") || [];
  if (!Array.isArray(paths) || paths.length === 0) {
    try {
      const response = await fetch(`${base}/sessions`, { method: "GET" });
      const data = await response.json().catch(() => null);
      const source = response.ok
        ? pickLocalHomeSource(data?.sessions)
        : null;
      if (source?.home) {
        paths = [`${source.home}/.zion-next/skills`];
        state.set("skills.paths", paths);
        rememberPathSource(state, {
          path: paths[0],
          nodeId: source.nodeId,
          nodeLabel: source.nodeLabel
        });
      }
    } catch {}
  }
  let pluginEntries = [];
  let pluginSourceNodeId = "";
  let pluginMaterializationReady = false;
  try {
    const pluginResult = await syncPluginSkills();
    pluginSourceNodeId = pluginResult?.nodeId || "";
    pluginEntries = Array.isArray(pluginResult)
      ? pluginResult
      : Array.isArray(pluginResult?.entries)
        ? pluginResult.entries
        : [];
    pluginMaterializationReady = Array.isArray(pluginResult)
      ? true
      : pluginResult?.ready === true;
  } catch (error) {
    console.warn("[skills] plugin skill sync failed", error);
    pluginEntries = Array.isArray(state.get("skills.pluginMaterialized"))
      ? state.get("skills.pluginMaterialized")
      : [];
  }
  let pluginCatalog = [];
  let pluginCatalogReady = false;
  try {
    pluginCatalog = await buildPluginSkillCatalog(pluginEntries, base);
    pluginCatalogReady = pluginMaterializationReady;
  } catch (error) {
    console.warn("[skills] plugin catalog scan failed", error);
  }
  const scannedByNode = new Map();
  const successfulPaths = new Set();
  const scanWarnings = [];

  for (const dirValue of Array.isArray(paths) ? paths : []) {
    const rawConfigured = typeof dirValue === "string"
      ? pathSourceFor(dirValue, state)
      : {
          path: normalizeSkillFsPath(dirValue?.path || ""),
          nodeId: normalizedNodeId(dirValue?.nodeId || dirValue?.node_id),
          nodeLabel: String(dirValue?.nodeLabel || dirValue?.node_label || "")
        };
    const configured = await resolvePathSource(base, rawConfigured, state);
    const dir = configured.path;
    if (!dir) continue;
    if (configured.nodeId) {
      rememberPathSource(state, configured);
    } else if (usesRuntimeDeviceService()) {
      scanWarnings.push({
        path: dir,
        code: "source-node-unresolved",
        message: "Unable to resolve a source Node for this Skill directory"
      });
      continue;
    }
    try {
      const entries = await listDirEntries(base, dir, configured.nodeId);
      const nodeId = normalizedNodeId(entries.nodeId || configured.nodeId)
        || SKILLS_LOCAL_RUNTIME_NODE_ID;
      const nodeLabel = String(entries.nodeLabel || configured.nodeLabel || nodeId);
      rememberPathSource(state, { path: dir, nodeId, nodeLabel });
      successfulPaths.add(`${nodeId}\0${dir}`);
      const source = scannedByNode.get(nodeId) || {
        nodeId,
        nodeLabel,
        syncedAt: Date.now(),
        paths: [],
        catalog: []
      };
      source.paths.push(dir);
      for (const entry of entries) {
        if (!entry || entry.type !== "dir") continue;
        const skillDir = String(entry.path || "").replace(/\/$/, "");
        if (!skillDir) continue;
        const skillMd = `${skillDir}/SKILL.md`;
        if (!(await fileExists(base, skillMd, nodeId))) continue;
        const files = await readSkillBundle(base, skillDir, nodeId);
        const body = String(files["SKILL.md"] || "");
        if (!body) continue;
        const meta = parseSkillFrontMatter(body.slice(0, 6144));
        const id = skillDir.split("/").filter(Boolean).pop();
        if (!id) continue;
        source.catalog.push(await cacheSkillBundleAtRuntime({
          id,
          name: meta.name || id,
          description: meta.description || "",
          category: meta.category || "",
          tags: meta.tags || [],
          difficulty: meta.difficulty || "",
          allowedTools: meta.allowedTools || [],
          dependencies: meta.dependencies || [],
          path: skillDir,
          file: skillMd,
          source: "user",
          sourceNodeId: nodeId,
          sourceNodeLabel: nodeLabel,
          sourcePath: skillDir,
          sourceFile: skillMd,
          syncedAt: source.syncedAt,
          body
        }, files));
      }
      scannedByNode.set(nodeId, source);
    } catch (error) {
      if (isDeviceAccessApprovalError(error)) {
        scanWarnings.push({
          path: dir,
          nodeId: configured.nodeId,
          code: String(error?.code || "DEVICE_ACCESS_APPROVAL_REQUIRED"),
          message: error?.message || String(error)
        });
      } else {
        console.warn(`[skills] failed to scan ${dir}`, error);
      }
    }
  }

  if (pluginCatalogReady) {
    for (const skill of pluginCatalog) {
      const nodeId = normalizedNodeId(skill.sourceNodeId);
      if (!nodeId) continue;
      const source = scannedByNode.get(nodeId) || {
        nodeId,
        nodeLabel: String(skill.sourceNodeLabel || nodeId),
        syncedAt: Date.now(),
        paths: [],
        catalog: []
      };
      source.catalog.push(skill);
      scannedByNode.set(nodeId, source);
    }
  }

  const activePaths = new Set(
    (Array.isArray(paths) ? paths : [])
      .map((entry) => String(typeof entry === "string" ? entry : entry?.path || "")
        .replace(/\/+$/, ""))
      .filter(Boolean)
  );
  state.set("skills.pathSources", (
    Array.isArray(state.get("skills.pathSources"))
      ? state.get("skills.pathSources")
      : []
  ).filter((entry) =>
    activePaths.has(String(entry?.path || "").replace(/\/+$/, ""))
  ));
  const previousSources = (Array.isArray(state.get("skills.sources"))
    ? state.get("skills.sources")
    : []).map(normalizeSkillsSourceSnapshot);
  const configuredSources = (Array.isArray(paths) ? paths : [])
    .map((entry) => typeof entry === "string"
      ? pathSourceFor(entry, state)
      : {
          path: String(entry?.path || "").replace(/\/+$/, ""),
          nodeId: normalizedNodeId(entry?.nodeId || entry?.node_id),
          nodeLabel: String(entry?.nodeLabel || entry?.node_label || "")
        })
    .filter((entry) => entry.path && entry.nodeId);
  // A client's directory preferences do not delete other clients' sources.
  // Only explicit local removals or successful scans establish deletions.
  for (const source of previousSources) {
    for (const path of source.paths) {
      if (!removedSkillPaths.has(`${source.nodeId}\0${path}`)) {
        configuredSources.push({ path, nodeId: source.nodeId });
      }
    }
  }
  const nodeIds = new Set([...previousSources.map((source) => source.nodeId), ...scannedByNode.keys()]);
  const nextSources = [...nodeIds].flatMap((nodeId) => reconcileSkillsSourceSnapshots({
    previousSources: previousSources.filter((source) => source.nodeId === nodeId),
    scannedSources: scannedByNode.has(nodeId) ? [scannedByNode.get(nodeId)] : [],
    configuredSources,
    successfulPaths: [...successfulPaths],
    pluginCatalogReady: pluginCatalogReady && nodeId === pluginSourceNodeId,
    now: Date.now()
  }));
  removedSkillPaths.clear();
  const merged = mergeSkillsSourceSnapshots(nextSources, {
    ...skillsSnapshotFromState(state, DEFAULT_CONFIG),
    paths,
    pathSources: state.get("skills.pathSources") || [],
    savedAt: Date.now(),
    lastScan: Date.now()
  });
  const catalog = merged.catalog;
  const enabled = state.get("skills.enabled") || [];
  let nextEnabled;
  if (!Array.isArray(enabled) || (enabled.length === 0 && prevCatalog.length === 0)) {
    nextEnabled = catalog.map((skill) => skill.id);
  } else {
    const previousIds = new Set(prevCatalog.map((skill) => skill?.id).filter(Boolean));
    const catalogIds = new Set(catalog.map((skill) => skill.id));
    const next = new Set(enabled.filter((id) => catalogIds.has(id)));
    for (const skill of catalog) {
      if (!previousIds.has(skill.id)) next.add(skill.id);
    }
    nextEnabled = Array.from(next);
  }
  state.set("skills.sources", nextSources);
  state.set("skills.catalog", catalog);
  state.set("skills.enabled", nextEnabled);
  state.set("skills.lastScan", Date.now());
  state.set("skills.scanWarnings", scanWarnings);
  captureSkillsSnapshotEdits({
    state,
    sources: false,
    scannedSources: nextSources.filter((source) =>
      source.syncedAt !== previousSources.find((previous) => previous.nodeId === source.nodeId)?.syncedAt
    )
  });
  return catalog;
}

async function scanAllSkills() {
  if (skillsScanPromise) return await skillsScanPromise;
  const state = getState();
  if (!state) return [];
  const run = scanAllSkillsWhileLocked(state);
  skillsScanPromise = run.finally(() => {
    if (skillsScanPromise) {
      skillsScanPromise = null;
      saveSnapshotSoon();
    }
  });
  return await skillsScanPromise;
}

async function getCatalogOrScan() {
  const catalog = getCatalog();
  const state = getState();
  if (window.zion?.plugins && !state?.get("skills.pluginLastSync")) return await scanAllSkills();
  if (catalog.length > 0) return catalog;
  return await scanAllSkills();
}

function findSkillsByNames(catalog, names) {
  const wanted = (Array.isArray(names) ? names : [names])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  if (!wanted.length) return [];
  const byIdOrName = new Map();
  for (const skill of catalog || []) {
    if (!skill) continue;
    if (skill.id) byIdOrName.set(String(skill.id).toLowerCase(), skill);
    if (skill.name) byIdOrName.set(String(skill.name).toLowerCase(), skill);
  }
  return wanted.map((name) => byIdOrName.get(name.toLowerCase())).filter(Boolean);
}

function skillSummary(skill, enabledSet) {
  return {
    id: skill.id,
    name: skill.name || skill.id,
    enabled: enabledSet.has(skill.id),
    description: skill.description || "",
    category: skill.category || "",
    tags: Array.isArray(skill.tags) ? skill.tags : [],
    difficulty: skill.difficulty || "",
    allowedTools: Array.isArray(skill.allowedTools) ? skill.allowedTools : [],
    dependencies: Array.isArray(skill.dependencies) ? skill.dependencies : [],
    source: skill.source || "directory",
    pluginId: skill.pluginId || "",
    path: skill.path || "",
    file: skill.file || "",
    sourceNodeId: skill.sourceNodeId || "",
    sourceNodeLabel: skill.sourceNodeLabel || "",
    sourcePath: skill.sourcePath || skill.path || "",
    contentHash: skill.contentHash || "",
    runtimeCached: skill.runtimeCached === true,
    runtimeNodeId: skill.runtimeNodeId || "",
    runtimeFile: skill.runtimeFile || ""
  };
}

function registerSkillManagerTool() {
  try {
    const toolName = "skillManager";
    const tool = {
      type: "function",
      function: {
        name: toolName,
        description: "Manage LLM skills: list/get/scan, enable or disable skills, manage skill directories, clear cache, show stats, or open the skills panel. The default skills directory is ~/.zion-next/skills.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["list", "get", "scan", "enable", "disable", "set_enabled", "list_paths", "add_path", "remove_path", "clear_cache", "stats", "open_panel"],
              description: "Operation to perform"
            },
            name: { type: "string", description: "Skill id or name for get/enable/disable" },
            names: { type: "array", items: { type: "string" }, description: "Skill ids or names for enable/disable/set_enabled" },
            query: { type: "string", description: "Optional list filter matching id/name/description/category/tags" },
            enabled_only: { type: "boolean", description: "For list: only return enabled skills" },
            include_body: { type: "boolean", description: "For get: include SKILL.md content" },
            path: { type: "string", description: "Skill directory path for add_path/remove_path. Default location: ~/.zion-next/skills" }
          },
          required: ["action"],
          additionalProperties: false
        }
      }
    };

    const existing = window.zion?.state?.get("chat.tools") || [];
    const existNames = new Set(existing.map(t => t?.function?.name).filter(Boolean));
    const merged = existing.slice();
    if (!existNames.has(toolName)) merged.push(tool);
    window.zion?.state?.set("chat.tools", merged);

    const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };
    handlers[toolName] = async (args) => {
      try {
        const state = getState();
        if (!state) return JSON.stringify({ ok: false, error: "State unavailable" });
        const action = String(args?.action || "").trim();
        const catalog = action === "scan" ? await scanAllSkills() : await getCatalogOrScan();
        const enabledSet = getEnabledSet();
        const paths = Array.isArray(state.get("skills.paths")) ? state.get("skills.paths") : [];

        if (action === "list") {
          const q = String(args?.query || "").trim().toLowerCase();
          const enabledOnly = !!args?.enabled_only;
          let skills = catalog.map((s) => skillSummary(s, enabledSet));
          if (enabledOnly) skills = skills.filter((s) => s.enabled);
          if (q) {
            skills = skills.filter((s) => {
              const haystack = [
                s.id,
                s.name,
                s.description,
                s.category,
                ...(s.tags || [])
              ].join(" ").toLowerCase();
              return haystack.includes(q);
            });
          }
          return JSON.stringify({
            ok: true,
            total: catalog.length,
            enabled: enabledSet.size,
            lastScan: state.get("skills.lastScan") || 0,
            paths,
            skills
          }, null, 2);
        }

        if (action === "get") {
          const [skill] = findSkillsByNames(catalog, args?.name || args?.names);
          if (!skill) return JSON.stringify({ ok: false, error: "Skill not found", name: args?.name || args?.names });
          const result = skillSummary(skill, enabledSet);
          if (args?.include_body) result.body = await loadSkillBody(skill);
          return JSON.stringify({ ok: true, skill: result }, null, 2);
        }

        if (action === "scan") {
          try { updateStatusBar(); } catch {}
          return JSON.stringify({
            ok: true,
            total: catalog.length,
            enabled: getEnabledSet().size,
            lastScan: state.get("skills.lastScan") || 0,
            paths
          }, null, 2);
        }

        if (action === "enable" || action === "disable" || action === "set_enabled") {
          const targets = findSkillsByNames(catalog, action === "set_enabled" ? args?.names : (args?.names || args?.name));
          if (!targets.length) return JSON.stringify({ ok: false, error: "No matching skills found" });
          const next = action === "set_enabled" ? new Set() : new Set(Array.from(enabledSet));
          for (const skill of targets) {
            if (action === "disable") next.delete(skill.id);
            else next.add(skill.id);
          }
          state.set("skills.enabled", Array.from(next));
          try { updateStatusBar(); } catch {}
          return JSON.stringify({
            ok: true,
            action,
            changed: targets.map((s) => ({ id: s.id, name: s.name || s.id })),
            enabled: Array.from(next)
          }, null, 2);
        }

        if (action === "list_paths") {
          return JSON.stringify({ ok: true, paths }, null, 2);
        }

        if (action === "add_path" || action === "remove_path") {
          const path = String(args?.path || "").trim();
          if (!path) return JSON.stringify({ ok: false, error: "Missing path" });
          const next = action === "add_path"
            ? Array.from(new Set([...paths, path]))
            : paths.filter((p) => p !== path);
          state.set("skills.paths", next);
          return JSON.stringify({ ok: true, action, paths: next }, null, 2);
        }

        if (action === "clear_cache") {
          state.set("skills.cacheContent", {});
          state.set("skills.usageHistory", {});
          return JSON.stringify({ ok: true, cleared: ["skills.cacheContent", "skills.usageHistory"] }, null, 2);
        }

        if (action === "stats") {
          const history = state.get("skills.usageHistory") || {};
          const skills = Object.entries(history || {}).map(([id, entries]) => {
            const skill = catalog.find((s) => s.id === id);
            return {
              id,
              name: (skill && (skill.name || skill.id)) || id,
              uses: Array.isArray(entries) ? entries.length : 0
            };
          });
          return JSON.stringify({ ok: true, total: catalog.length, enabled: enabledSet.size, skills }, null, 2);
        }

        if (action === "open_panel") {
          openSkillsPanel();
          return JSON.stringify({ ok: true, opened: true }, null, 2);
        }

        return JSON.stringify({ ok: false, error: `Unknown action: ${action}` });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e?.message || String(e) });
      }
    };
    window.zion?.state?.set("chat.toolHandlers", handlers);

    try {
      const names = (window.zion?.state?.get("chat.tools") || [])
        .map(t => t?.function?.name)
        .filter(Boolean);
      window.zion?.state?.set("chat.toolsKnownNames", names);
      const enabled = window.zion?.state?.get("chat.enabledTools");
      if (!Array.isArray(enabled) || enabled.length === 0) {
        window.zion?.state?.set("chat.enabledTools", names);
      } else if (!enabled.includes(toolName)) {
        window.zion?.state?.set("chat.enabledTools", [...enabled, toolName]);
      }
    } catch {}
  } catch (e) {
    console.warn("[skills] register skillManager tool failed", e);
  }
}

function registerMessageContributor() {
  if (!window.zion || !window.zion.messages || typeof window.zion.messages.registerContributor !== "function") {
    return { dispose: () => {} };
  }

  return window.zion.messages.registerContributor({
    id: "dev.skills.standard",
    order: 25,
    stage: "pre",
    contribute: async (messages) => {
      try {
        const catalog = await getCatalogOrScan();
        const enabled = getEnabledSet();
        if (enabled.size === 0) return messages;
        const availableSkillsXML = buildAvailableSkillsContextXml({
          catalog,
          enabled: Array.from(enabled)
        }, {
          detailTool: "skillManager"
        });
        const injectedMessage = { role: "user", content: availableSkillsXML };
        return insertAfterLeadingSystemMessage(messages, injectedMessage);
      } catch {
        return messages;
      }
    }
  });
}

function updateStatusBar() {
  try {
    const catalog = getCatalog();
    const enabled = getEnabledSet();
    const text = t("status.skills", "Skills: {enabled}/{total}", { enabled: enabled.size, total: catalog.length });
    try { skillsStatusDisp?.dispose?.(); } catch {}
    skillsStatusDisp = window.zion.bottomStatusBar?.registerItem?.({
      id: "dev.skills.status",
      text,
      tooltip: t("status.tooltip", "Manage Skills"),
      priority: 69,
      onClick: () => window.zion.commands.executeCommand("skills.openPanel")
    }) || window.zion.editorHeaderMenu?.register?.({
      id: "dev.skills.status",
      title: text,
      section: "Extensions",
      order: 20,
      onClick: () => window.zion.commands.executeCommand("skills.openPanel")
    }) || window.zion.statusBar.registerItem({
      id: "dev.skills.status",
      text,
      tooltip: t("status.tooltip", "Manage Skills"),
      onClick: () => window.zion.commands.executeCommand("skills.openPanel"),
      priority: 78
    });
  } catch {}
}

function getSkillsStatusButton() {
  try {
    return document.querySelector('[data-zion-status-id="dev.skills.status"]');
  } catch {
    return null;
  }
}

function positionSkillsPanel(panel) {
  const gap = 8;
  const margin = 8;
  const fallbackBottom = 36;
  const anchor = getSkillsStatusButton();

  let right = 12;
  let bottom = fallbackBottom;
  let availableHeight = window.innerHeight - fallbackBottom - margin;

  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    right = Math.max(margin, window.innerWidth - rect.right);
    bottom = Math.max(margin, window.innerHeight - rect.top + gap);
    availableHeight = Math.max(240, rect.top - gap - margin);
  }

  const panelWidth = panel.offsetWidth || Math.min(360, window.innerWidth - margin * 2);
  right = Math.min(right, Math.max(margin, window.innerWidth - panelWidth - margin));

  Object.assign(panel.style, {
    top: "auto",
    right: `${right}px`,
    bottom: `${bottom}px`,
    maxHeight: `${Math.min(Math.floor(window.innerHeight * 0.65), availableHeight)}px`
  });
}

function createButton(text, style, onClick) {
  const btn = document.createElement("button");
  btn.textContent = text;
  Object.assign(btn.style, style || {});
  btn.onclick = onClick;
  return btn;
}

function showModal(title, content) {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.35)",
    zIndex: "100000"
  });
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  const modal = document.createElement("div");
  Object.assign(modal.style, {
    position: "fixed",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: "720px",
    maxWidth: "92vw",
    maxHeight: "72vh",
    overflow: "auto",
    background: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "10px",
    boxShadow: "0 16px 48px rgba(0,0,0,0.45)",
    padding: "14px"
  });
  modal.onclick = (e) => e.stopPropagation();

  const h = document.createElement("div");
  h.textContent = title;
  Object.assign(h.style, { fontWeight: "600", marginBottom: "10px", fontSize: "13px" });

  const pre = document.createElement("pre");
  pre.textContent = content;
  Object.assign(pre.style, {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    lineHeight: "1.55",
    margin: "0"
  });

  const close = createButton(
    "Close",
    {
      marginTop: "12px",
      padding: "6px 12px",
      background: "var(--accent)",
      color: "var(--panel)",
      border: "none",
      borderRadius: "8px",
      cursor: "pointer"
    },
    () => overlay.remove()
  );

  modal.appendChild(h);
  modal.appendChild(pre);
  modal.appendChild(close);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

async function loadSkillBody(skill) {
  const base = getLocalToolsBase();
  const runtimeFile = String(skill?.runtimeFile || "");
  if (runtimeFile) {
    const content = await readFile(base, runtimeFile, {
      headOnly: false,
      nodeId: skill?.runtimeNodeId
    });
    if (content) return content;
  }
  const file = skill && (skill.sourceFile || skill.file
    || (skill.path ? `${skill.path}/SKILL.md` : ""));
  if (file) {
    const content = await readFile(base, file, {
      headOnly: false,
      nodeId: skill?.sourceNodeId
    });
    if (content) return content;
  }
  return String(skill?.body || "");
}

function renderSkillsList(container) {
  const state = getState();
  if (!state) return;

  container.innerHTML = "";
  const catalog = getCatalog();
  const enabled = state.get("skills.enabled") || [];
  const enabledSet = new Set(Array.isArray(enabled) ? enabled : []);

  if (catalog.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = 'No skills found. Add a directory path and click "Scan Now".';
    Object.assign(empty.style, {
      fontSize: "11px",
      opacity: "0.6",
      padding: "8px 6px",
      textAlign: "center",
      fontStyle: "italic"
    });
    container.appendChild(empty);
    return;
  }

  const sorted = catalog.slice().sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  for (const skill of sorted) {
    const row = document.createElement("div");
    const isEnabled = enabledSet.has(skill.id);
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      cursor: "pointer",
      borderRadius: "4px",
      padding: "4px 6px",
      background: "transparent",
      transition: "background-color 120ms ease, color 120ms ease",
      fontFamily: "inherit",
      fontSize: "11px",
      lineHeight: "1.3"
    });
    row.onmouseenter = () => { row.style.background = "color-mix(in srgb, var(--border) 28%, transparent)"; };
    row.onmouseleave = () => { row.style.background = "transparent"; };

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = isEnabled;
    Object.assign(toggle.style, { flexShrink: "0", margin: "0 0 0 0", cursor: "pointer" });
    toggle.onchange = () => {
      const next = new Set(enabledSet);
      if (toggle.checked) next.add(skill.id);
      else next.delete(skill.id);
      state.set("skills.enabled", Array.from(next));
    };

    const title = document.createElement("div");
    title.textContent = skill.name || skill.id;
    Object.assign(title.style, {
      flex: "0 0 34%",
      minWidth: "90px",
      fontWeight: "400",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    });

    const parts = [];
    if (skill.description) parts.push(String(skill.description));
    if (skill.category) parts.push(`[${String(skill.category)}]`);
    if (skill.tags && skill.tags.length) parts.push(skill.tags.slice(0, 2).map((t) => `#${t}`).join(" "));

    const meta = document.createElement("div");
    meta.textContent = parts.join("  ");
    Object.assign(meta.style, {
      flex: "1",
      minWidth: "0",
      fontSize: "10px",
      opacity: "0.5",
      color: "var(--fg)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      textAlign: "left"
    });

    const preview = createButton(
      "Preview",
      {
        flexShrink: "0",
        padding: "2px 6px",
        borderRadius: "4px",
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--fg)",
        cursor: "pointer",
        fontSize: "10px",
        opacity: "0.55"
      },
      async (e) => {
        try { e?.preventDefault?.(); e?.stopPropagation?.(); } catch {}
        const body = await loadSkillBody(skill);
        showModal(skill.name || skill.id, body || "(empty)");
      }
    );

    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("click", (e) => {
      if (e.target === toggle || e.target === preview) return;
      const next = new Set(enabledSet);
      if (isEnabled) next.delete(skill.id);
      else next.add(skill.id);
      state.set("skills.enabled", Array.from(next));
    });

    row.appendChild(toggle);
    row.appendChild(title);
    row.appendChild(meta);
    row.appendChild(preview);
    container.appendChild(row);
  }
}

function renderPathsList(container) {
  const state = getState();
  if (!state) return;

  container.innerHTML = "";
  const paths = state.get("skills.paths") || [];
  const list = Array.isArray(paths) ? paths : [];

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "No paths configured";
    Object.assign(empty.style, { fontSize: "10px", opacity: "0.5", padding: "2px 0" });
    container.appendChild(empty);
    return;
  }

  list.forEach((p, idx) => {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "6px", alignItems: "center", marginBottom: "4px" });

    const label = document.createElement("div");
    label.textContent = String(p);
    Object.assign(label.style, {
      flex: "1",
      fontSize: "10px",
      opacity: "0.62",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontFamily: "var(--font-mono)"
    });

    const del = createButton(
      "×",
      {
        width: "26px",
        height: "22px",
        borderRadius: "4px",
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--fg)",
        cursor: "pointer",
        opacity: "0.7"
      },
      () => {
        const next = list.slice();
        next.splice(idx, 1);
        state.set("skills.paths", next);
        renderPathsList(container);
      }
    );

    row.appendChild(label);
    row.appendChild(del);
    container.appendChild(row);
  });
}

function openSkillsPanel() {
  const state = getState();
  if (!state) return;

  const existing = document.getElementById("zion-skills-panel");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "zion-skills-panel";
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "transparent",
    zIndex: "100000"
  });
  let d1 = null;
  let d2 = null;
  let d3 = null;
  const closePanel = () => {
    try { d1 && d1.dispose && d1.dispose(); } catch {}
    try { d2 && d2.dispose && d2.dispose(); } catch {}
    try { d3 && d3.dispose && d3.dispose(); } catch {}
    try { overlay.remove(); } catch {}
  };
  overlay.onclick = (e) => {
    if (e.target === overlay) closePanel();
  };

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed",
    right: "12px",
    bottom: "36px",
    width: "360px",
    maxWidth: "calc(100vw - 16px)",
    maxHeight: "65vh",
    overflow: "auto",
    background: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "0 12px 32px rgba(0,0,0,0.32)",
    padding: "8px",
    zIndex: "100001",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
  });
  panel.onclick = (e) => e.stopPropagation();
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Skills");

  const title = document.createElement("div");
  title.textContent = "Select Skills";
  Object.assign(title.style, { fontWeight: "500", fontSize: "11px", opacity: "0.8" });

  const stats = document.createElement("div");
  Object.assign(stats.style, {
    fontSize: "10px",
    opacity: "0.55",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    marginLeft: "auto"
  });
  const refreshStats = () => {
    const catalog = getCatalog();
    const enabled = getEnabledSet();
    stats.textContent = `${enabled.size}/${catalog.length}`;
  };
  refreshStats();

  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "6px"
  });
  header.appendChild(title);
  header.appendChild(stats);
  panel.appendChild(header);

  const actions = document.createElement("div");
  Object.assign(actions.style, {
    display: "flex",
    gap: "6px",
    alignItems: "center",
    flexWrap: "wrap",
    marginBottom: "8px"
  });

  const compactButtonStyle = {
    height: "24px",
    padding: "0 8px",
    borderRadius: "4px",
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--fg)",
    cursor: "pointer",
    fontSize: "11px"
  };

  actions.appendChild(
    createButton(
      "Scan",
      {
        ...compactButtonStyle,
        border: "none",
        background: "var(--accent)",
        color: "var(--panel)",
        fontWeight: "500"
      },
      async () => {
        await window.zion.commands.executeCommand("skills.scanNow");
        renderSkillsList(skillsList);
        refreshStats();
      }
    )
  );

  actions.appendChild(
    createButton(
      "All",
      compactButtonStyle,
      () => {
        const catalog = getCatalog();
        state.set("skills.enabled", catalog.map((s) => s.id));
        renderSkillsList(skillsList);
        refreshStats();
      }
    )
  );

  actions.appendChild(
    createButton(
      "None",
      compactButtonStyle,
      () => {
        state.set("skills.enabled", []);
        renderSkillsList(skillsList);
        refreshStats();
      }
    )
  );

  actions.appendChild(
    createButton(
      "Clear",
      compactButtonStyle,
      async () => {
        await window.zion.commands.executeCommand("skills.clearCache");
      }
    )
  );
  panel.appendChild(actions);

  const skillsList = document.createElement("div");
  Object.assign(skillsList.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px"
  });
  renderSkillsList(skillsList);
  panel.appendChild(skillsList);

  const pathsWrap = document.createElement("div");
  Object.assign(pathsWrap.style, {
    marginBottom: "8px",
    paddingBottom: "8px",
    borderBottom: "1px solid color-mix(in srgb, var(--border) 62%, transparent)"
  });

  const pathsDetails = document.createElement("details");
  pathsDetails.open = false;
  const pathsHeader = document.createElement("summary");
  pathsHeader.textContent = "Directories";
  Object.assign(pathsHeader.style, {
    cursor: "pointer",
    fontSize: "10px",
    opacity: "0.58",
    marginBottom: "6px",
    userSelect: "none"
  });
  pathsDetails.appendChild(pathsHeader);

  const inputRow = document.createElement("div");
  Object.assign(inputRow.style, { display: "flex", gap: "6px", marginBottom: "6px" });
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "/absolute/path/to/skills";
  Object.assign(input.style, {
    flex: "1",
    height: "24px",
    borderRadius: "4px",
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--fg)",
    padding: "0 10px",
    outline: "none",
    fontSize: "11px",
    fontFamily: "inherit"
  });
  const addBtn = createButton(
    "Add",
    {
      height: "24px",
      padding: "0 8px",
      borderRadius: "4px",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--fg)",
      cursor: "pointer",
      fontSize: "11px"
    },
    () => {
      const p = String(input.value || "").trim();
      if (!p) return;
      const paths = state.get("skills.paths") || [];
      const next = Array.isArray(paths) ? paths.slice() : [];
      if (!next.includes(p)) next.push(p);
      state.set("skills.paths", next);
      input.value = "";
      renderPathsList(pathsList);
    }
  );
  inputRow.appendChild(input);
  inputRow.appendChild(addBtn);
  pathsDetails.appendChild(inputRow);

  const pathsList = document.createElement("div");
  renderPathsList(pathsList);
  pathsDetails.appendChild(pathsList);
  pathsWrap.appendChild(pathsDetails);
  panel.insertBefore(pathsWrap, actions);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  positionSkillsPanel(panel);

  d1 = window.zion.state.onDidChange("skills.catalog", () => {
    renderSkillsList(skillsList);
    refreshStats();
  });
  d2 = window.zion.state.onDidChange("skills.enabled", () => {
    renderSkillsList(skillsList);
    refreshStats();
  });
  const onResize = () => positionSkillsPanel(panel);
  window.addEventListener("resize", onResize);
  d3 = { dispose: () => window.removeEventListener("resize", onResize) };
  return { dispose: closePanel };
}

function registerCommands() {
  const cmds = [];
  try {
    cmds.push(window.zion.commands.registerCommand("skills.openPanel", () => openSkillsPanel()));
    cmds.push(
      window.zion.commands.registerCommand("skills.scanNow", async () => {
        await scanAllSkills();
        updateStatusBar();
      })
    );
    cmds.push(
      window.zion.commands.registerCommand("skills.clearCache", () => {
        const state = getState();
        if (!state) return;
        state.set("skills.cacheContent", {});
        state.set("skills.usageHistory", {});
      })
    );
    cmds.push(
      window.zion.commands.registerCommand("skills.showStats", () => {
        try {
          const state = getState();
          if (!state) return;
          const history = state.get("skills.usageHistory") || {};
          const catalog = getCatalog();
          const lines = Object.entries(history || {}).map(([id, entries]) => {
            const skill = catalog.find((s) => s.id === id);
            const name = (skill && (skill.name || skill.id)) || id;
            const total = Array.isArray(entries) ? entries.length : 0;
            return `${name}: ${total}`;
          });
          alert(`Skills Statistics:\n\n${lines.length ? lines.join("\n") : "No usage data."}`);
        } catch {}
      })
    );
  } catch {}
  return cmds;
}

function registerStateListeners() {
  const disposers = [];
  try {
    disposers.push(window.zion.state.onDidChange("skills.enabled", () => updateStatusBar()));
    disposers.push(window.zion.state.onDidChange("skills.catalog", () => updateStatusBar()));
    disposers.push(window.zion.events.on("i18n/changed", () => updateStatusBar()));
    disposers.push({ dispose: () => { try { skillsStatusDisp?.dispose?.(); skillsStatusDisp = null; } catch {} } });
    const keysToPersist = [
      "skills.paths",
      "skills.pathSources",
      "skills.enabled",
      "skills.catalog",
      "skills.sources",
      "skills.cacheContent",
      "skills.usageHistory",
      "skills.tokenBudget",
      "skills.config",
      "skills.dependencyGraph",
      "skills.pluginMaterialized",
      "skills.pluginLastSync",
      "skills.lastScan"
    ];
    let previousPaths = window.zion.state.get("skills.paths") || [];
    for (const k of keysToPersist) {
      try { disposers.push(window.zion.state.onDidChange(k, () => {
        if (k === "skills.paths") {
          const paths = window.zion.state.get(k) || [];
          if (!isApplyingSkillsSnapshot(window.zion.state)) {
            for (const path of previousPaths) {
              if (!paths.includes(path)) {
                const source = pathSourceFor(path, window.zion.state);
                removedSkillPaths.add(`${source.nodeId}\0${source.path}`);
              }
            }
          }
          previousPaths = paths;
        }
        saveSnapshotSoon();
      })); } catch {}
    }
    let previousRuntimeBackend = String(
      window.zion.state.get("runtime.connection")?.backend || ""
    );
    try {
      disposers.push(window.zion.state.onDidChange("runtime.connection", (value) => {
        const nextRuntimeBackend = String(value?.backend || "");
        if (
          nextRuntimeBackend === "runtime"
          && previousRuntimeBackend !== "runtime"
        ) {
          void restoreAndRescanRuntimeSkills().catch((error) => {
            console.warn("[skills] Runtime reconnect scan failed", error);
          });
        }
        previousRuntimeBackend = nextRuntimeBackend;
      }));
    } catch {}
    for (const key of ["runtime.baseUrl", "runtime.mode"]) {
      disposers.push(window.zion.state.onDidChange(key, () => {
        void restoreAndRescanRuntimeSkills().catch((error) => {
          console.warn("[skills] Runtime configuration scan failed", error);
        });
      }));
    }
  } catch {}
  return disposers;
}

function registerPluginSkillListeners(ready = Promise.resolve()) {
  let disposed = false;
  let manager = null;
  let retryTimer = 0;
  let scanTimer = 0;
  const events = ["installed", "uninstalled", "enabled", "disabled", "updated", "hotReloaded"];

  const scheduleScan = () => {
    if (disposed) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      void ready
        .then(() => scanAllSkills())
        .then(() => updateStatusBar())
        .catch((error) => console.warn("[skills] plugin skill rescan failed", error));
    }, 80);
  };

  const bind = () => {
    if (disposed) return;
    const candidate = window.zion?.plugins;
    if (!candidate || typeof candidate.on !== "function" || typeof candidate.off !== "function") {
      retryTimer = setTimeout(bind, 100);
      return;
    }
    manager = candidate;
    for (const event of events) manager.on(event, scheduleScan);
    scheduleScan();
  };

  bind();
  return {
    dispose() {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (scanTimer) clearTimeout(scanTimer);
      if (manager) {
        for (const event of events) {
          try { manager.off(event, scheduleScan); } catch {}
        }
      }
    }
  };
}

export async function activate(ctx) {
  skillsDisposed = false;
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  ensureDefaults();
  restoreFromSnapshotIfNeeded();
  const restorePromise = restoreFromRuntimeIfAvailable();
  void restorePromise.then((loaded) => {
    if (loaded) updateStatusBar();
  });

  const commands = registerCommands();
  registerSkillManagerTool();
  const contributor = registerMessageContributor();
  const listeners = registerStateListeners();
  const pluginSkillListeners = registerPluginSkillListeners(restorePromise);

  try { ctx.subscriptions.push(...commands); } catch {}
  try { ctx.subscriptions.push(contributor); } catch {}
  try { ctx.subscriptions.push(...listeners); } catch {}
  try { ctx.subscriptions.push(pluginSkillListeners); } catch {}

  // Register skills settings into core Settings Panel
  try {
    if (window.zion?.settings?.registerItem) {
      const state = getState();
      const paths = (state && state.get("skills.paths")) || [];
      const catalog = getCatalog();
      const enabled = getEnabledSet();

      window.zion.settings.registerItem({
        id: "skills-config",
        category: "Workspace",
        section: "Skills",
        title: "Skills 配置",
        description: t("settings.description", "管理技能目录、重新扫描技能索引，并批量启用或清理缓存。"),
        keywords: ["skills", "catalog", "scan", "paths", "workspace"],
        order: 30,
        render(container) {
          const st = getState();
          if (!st) return;
          container.innerHTML = "";

          const style = document.createElement("style");
          style.textContent = `
            .sk-cfg-info { font-size:11px;opacity:.7;margin-bottom:10px }
            .sk-cfg-path-row { display:flex;gap:6px;margin-bottom:8px;align-items:center }
            .sk-cfg-input { flex:1;padding:4px 8px;border:1px solid var(--border,#3c3c3c);border-radius:6px;background:transparent;color:var(--fg,#ccc);font-size:12px;font-family:var(--font-mono,monospace) }
            .sk-cfg-input:focus { outline:1px solid var(--accent,#6272a4) }
            .sk-cfg-btn { padding:4px 12px;border:1px solid var(--border,#3c3c3c);border-radius:6px;background:transparent;color:var(--fg,#ccc);cursor:pointer;font-size:12px }
            .sk-cfg-btn:hover { background:rgba(255,255,255,.06) }
            .sk-cfg-btn.primary { border-color:var(--accent,#6272a4);color:var(--accent,#6272a4) }
            .sk-cfg-path-item { display:flex;gap:6px;align-items:center;margin-bottom:4px }
            .sk-cfg-path-text { flex:1;font-size:11px;opacity:.8;font-family:var(--font-mono,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap }
            .sk-cfg-path-del { padding:2px 8px;border:1px solid var(--border,#3c3c3c);border-radius:4px;background:transparent;color:var(--fg,#ccc);cursor:pointer;font-size:11px;opacity:.7 }
            .sk-cfg-path-del:hover { opacity:1;color:#ff6b6b }
            .sk-cfg-actions { display:flex;gap:8px;margin-top:10px }
            .sk-cfg-label { font-size:12px;opacity:.85;font-weight:500;margin-bottom:4px }
            .sk-cfg-section { margin-bottom:12px }
          `;
          container.appendChild(style);

          // Stats
          const cat = getCatalog();
          const en = getEnabledSet();
          const info = document.createElement("div");
          info.className = "sk-cfg-info";
          info.textContent = t("settings.enabled", "已启用 {enabled}/{total} 个 skills", { enabled: en.size, total: cat.length });
          container.appendChild(info);

          // Paths section
          const pathsSection = document.createElement("div");
          pathsSection.className = "sk-cfg-section";
          const pathsLabel = document.createElement("div");
          pathsLabel.className = "sk-cfg-label";
          pathsLabel.textContent = t("settings.paths", "Skills 目录");
          pathsSection.appendChild(pathsLabel);

          const pathList = document.createElement("div");
          const refreshPaths = () => {
            pathList.innerHTML = "";
            const currentPaths = st.get("skills.paths") || [];
            for (let i = 0; i < currentPaths.length; i++) {
              const row = document.createElement("div");
              row.className = "sk-cfg-path-item";
              const text = document.createElement("div");
              text.className = "sk-cfg-path-text";
              text.textContent = currentPaths[i];
              text.title = currentPaths[i];
              const del = document.createElement("button");
              del.className = "sk-cfg-path-del";
              del.textContent = "×";
              del.onclick = () => {
                const next = currentPaths.slice();
                next.splice(i, 1);
                st.set("skills.paths", next);
                refreshPaths();
              };
              row.appendChild(text);
              row.appendChild(del);
              pathList.appendChild(row);
            }
          };
          refreshPaths();
          pathsSection.appendChild(pathList);

          const addRow = document.createElement("div");
          addRow.className = "sk-cfg-path-row";
          const input = document.createElement("input");
          input.className = "sk-cfg-input";
          input.type = "text";
          input.placeholder = "/path/to/skills/directory";
          const addBtn = document.createElement("button");
          addBtn.className = "sk-cfg-btn";
          addBtn.textContent = t("settings.add", "添加");
          addBtn.onclick = () => {
            const v = input.value.trim();
            if (!v) return;
            const current = st.get("skills.paths") || [];
            if (!current.includes(v)) {
              st.set("skills.paths", [...current, v]);
            }
            input.value = "";
            refreshPaths();
          };
          addRow.appendChild(input);
          addRow.appendChild(addBtn);
          pathsSection.appendChild(addRow);
          container.appendChild(pathsSection);

          // Actions
          const actions = document.createElement("div");
          actions.className = "sk-cfg-actions";

          const scanBtn = document.createElement("button");
          scanBtn.className = "sk-cfg-btn primary";
          scanBtn.textContent = t("settings.scan", "立即扫描");
          scanBtn.onclick = async () => {
            await window.zion.commands.executeCommand("skills.scanNow");
            refreshPaths();
            const newCat = getCatalog();
            const newEn = getEnabledSet();
            info.textContent = t("settings.enabled", "已启用 {enabled}/{total} 个 skills", { enabled: newEn.size, total: newCat.length });
          };
          actions.appendChild(scanBtn);

          const enableAllBtn = document.createElement("button");
          enableAllBtn.className = "sk-cfg-btn";
          enableAllBtn.textContent = t("settings.enableAll", "全部启用");
          enableAllBtn.onclick = () => {
            const allCat = getCatalog();
            st.set("skills.enabled", allCat.map(s => s.id));
            const newEn = getEnabledSet();
            info.textContent = t("settings.enabled", "已启用 {enabled}/{total} 个 skills", { enabled: newEn.size, total: allCat.length });
          };
          actions.appendChild(enableAllBtn);

          const clearBtn = document.createElement("button");
          clearBtn.className = "sk-cfg-btn";
          clearBtn.textContent = t("settings.clear", "清除缓存");
          clearBtn.onclick = () => {
            window.zion.commands.executeCommand("skills.clearCache");
          };
          actions.appendChild(clearBtn);

          container.appendChild(actions);
        }
      });
    }
  } catch (e) {
    console.warn("[dev.skills] failed to register settings item", e);
  }

  try {
    Promise.resolve().then(async () => {
      await restorePromise;
      try { await scanAllSkills(); } catch {}
      try { updateStatusBar(); } catch {}
    });
  } catch {}

  updateStatusBar();

  // Refresh only the Runtime catalog. Filesystem scans remain explicit or
  // plugin-event driven, and failed writes retry independently of reads.
  try {
    const refresh = startSkillsSnapshotRefresh({
      refresh: () => loadSkillsSnapshotFromRuntime({ state: getState() }),
      isActive: () => !!document.getElementById("zion-skills-panel")
    });
    const retryWrites = () => {
      if (document.hidden) clearTimeout(writeRetryTimer);
      else if (writeRetryNeeded) saveSnapshotSoon();
    };
    document.addEventListener("visibilitychange", retryWrites);
    window.addEventListener("online", retryWrites);
    window.addEventListener("focus", retryWrites);
    ctx.subscriptions.push(refresh, {
      dispose() {
        skillsDisposed = true;
        removedSkillPaths.clear();
        clearTimeout(writeRetryTimer);
        writeRetryNeeded = false;
        if (snapshotIdle) cancelIdleCallback(snapshotIdle);
        snapshotIdle = 0;
        document.removeEventListener("visibilitychange", retryWrites);
        window.removeEventListener("online", retryWrites);
        window.removeEventListener("focus", retryWrites);
        disposeSkillsRuntimeState(getState());
      }
    });
  } catch {}
}
