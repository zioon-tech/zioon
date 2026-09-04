export const MEMORY_RUNTIME_PLUGIN_ID = "dev.memory";
export const MEMORY_RUNTIME_STATE_NAMESPACE = "memory";
export const MEMORY_RUNTIME_SNAPSHOT_KEY = "snapshot";
export const MEMORY_RUNTIME_KV_KEY =
  `runtime.plugins.${MEMORY_RUNTIME_PLUGIN_ID}.${MEMORY_RUNTIME_STATE_NAMESPACE}.${MEMORY_RUNTIME_SNAPSHOT_KEY}`;

export const MEMORY_ITEMS_STORAGE_KEY = "zion.memory.items.v1";
export const MEMORY_SETTINGS_STORAGE_KEY = "zion.memory.settings.v1";
export const MEMORY_ACTIVE_STORAGE_KEY = "memory.activeId";
export const DEFAULT_MEMORY_ROOT = "~/zion-next/memory";
export const MEMORY_MANAGE_TOOL_NAME = "memoryManage";
export const MEMORY_MANAGE_READONLY_ACTIONS = [
  "list",
  "tree",
  "read",
  "search",
  "build_context",
  "providers"
];
export const MEMORY_MANAGE_WRITE_ACTIONS = [
  "create",
  "update",
  "delete",
  "select",
  "settings"
];
export const MEMORY_MANAGE_RUNTIME_ACTIONS = [
  ...MEMORY_MANAGE_READONLY_ACTIONS,
  ...MEMORY_MANAGE_WRITE_ACTIONS
];

const MEMORY_TYPES = new Set(["semantic", "episodic", "procedural", "preference"]);
const MEMORY_SCOPES = new Set(["project", "workspace", "user", "agent"]);
const MEMORY_LAYERS = new Set(["working", "long-term"]);

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

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeMemoryPath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .trim() || "long-term/semantic/memory.md";
}

function slugify(value, fallback = "memory") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function defaultMemoryPath({ title, type, layer, id } = {}) {
  const name = slugify(title, "memory");
  if (layer === "working") return `working/${name}.md`;
  return `long-term/${type || "semantic"}/${name}-${String(id || "").slice(-6) || "memory"}.md`;
}

function generatedMemoryId(timestamp = Date.now()) {
  const random = globalThis.crypto?.randomUUID?.()
    || Math.random().toString(36).slice(2, 10);
  return `mem_${Number(timestamp) || Date.now()}_${String(random).replace(/[^a-zA-Z0-9]+/g, "").slice(0, 10)}`;
}

export function normalizeMemoryItem(item = {}) {
  const source = objectValue(item);
  const id = String(source.id || "").trim();
  if (!id) return null;
  const layer = MEMORY_LAYERS.has(source.layer)
    ? source.layer
    : (String(source.path || "").startsWith("working/") ? "working" : "long-term");
  const type = MEMORY_TYPES.has(source.type) ? source.type : "semantic";
  return {
    id,
    providerId: String(source.providerId || "local-markdown-files"),
    title: String(source.title || "Untitled Memory"),
    content: String(source.content || ""),
    type,
    layer,
    path: normalizeMemoryPath(source.path),
    scope: MEMORY_SCOPES.has(source.scope) ? source.scope : "project",
    tags: uniqueStrings(source.tags),
    enabled: source.enabled !== false,
    pinned: !!source.pinned,
    confidence: Math.max(0, Math.min(1, Number(source.confidence ?? 0.8))),
    source: String(source.source || ""),
    createdAt: Number(source.createdAt) || 0,
    updatedAt: Number(source.updatedAt) || Number(source.createdAt) || 0
  };
}

export function normalizeMemorySettings(settings = {}) {
  const source = objectValue(settings);
  const autoInjectLayer = MEMORY_LAYERS.has(source.autoInjectLayer)
    ? source.autoInjectLayer
    : "working";
  return {
    autoInject: source.autoInject !== false,
    memoryRootPath: String(source.memoryRootPath || DEFAULT_MEMORY_ROOT),
    maxContextChars: Math.max(800, Number(source.maxContextChars || 4000)),
    autoInjectLayer,
    includePinnedLongTerm: !!source.includePinnedLongTerm
  };
}

export function normalizeMemorySnapshot(value = {}) {
  const source = objectValue(value);
  const items = (Array.isArray(source.items) ? source.items : [])
    .map(normalizeMemoryItem)
    .filter(Boolean)
    .sort((a, b) =>
      String(a.path || "").localeCompare(String(b.path || ""))
      || Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
    );
  const lastChangedAt = Math.max(
    Number(source.lastChangedAt) || 0,
    Number(source.savedAt) || 0,
    ...items.map((item) => Number(item.updatedAt || item.createdAt || 0))
  );
  return {
    version: 1,
    savedAt: Number(source.savedAt) || Date.now(),
    lastChangedAt,
    activeId: String(source.activeId || ""),
    settings: normalizeMemorySettings(source.settings),
    items
  };
}

export function scoreMemory(item, query = "") {
  const q = String(query || "").toLowerCase().trim();
  let score = 0;
  if (item.pinned) score += 20;
  if (item.layer === "working") score += 10;
  score += Math.max(0, Math.min(10, Number(item.confidence || 0) * 10));
  if (q) {
    const hay = [
      item.title,
      item.path,
      item.content,
      ...(item.tags || [])
    ].join("\n").toLowerCase();
    for (const token of q.split(/\s+/).filter(Boolean)) {
      if (hay.includes(token)) score += 8;
    }
  }
  score += Math.min(5, Math.max(0, Number(item.updatedAt || 0)) / 1_000_000_000_000);
  return score;
}

export function memoryManageToolDefinition({
  actions = MEMORY_MANAGE_READONLY_ACTIONS
} = {}) {
  return {
    name: MEMORY_MANAGE_TOOL_NAME,
    description: "Inspect and update Runtime-backed Zion Memory. Runtime supports list/tree/read/search/build_context/providers plus snapshot-backed create/update/delete/select/settings.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: actions,
          description: "Memory action"
        },
        id: { type: "string" },
        path: { type: "string" },
        query: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        layer: { type: "string", enum: Array.from(MEMORY_LAYERS) },
        type: { type: "string", enum: Array.from(MEMORY_TYPES) },
        scope: { type: "string", enum: Array.from(MEMORY_SCOPES) },
        tags: { type: "array", items: { type: "string" } },
        source: { type: "string" },
        providerId: { type: "string" },
        enabled: { type: "boolean" },
        pinned: { type: "boolean" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        autoInject: { type: "boolean" },
        memoryRootPath: { type: "string" },
        maxContextChars: { type: "number", minimum: 800 },
        autoInjectLayer: { type: "string", enum: Array.from(MEMORY_LAYERS) },
        includePinnedLongTerm: { type: "boolean" },
        enabled_only: { type: "boolean" },
        include_disabled: { type: "boolean" },
        max_items: { type: "number", minimum: 1, maximum: 100 }
      },
      required: ["action"],
      additionalProperties: false
    }
  };
}

function publicMemoryItem(item) {
  return {
    id: item.id,
    providerId: item.providerId,
    title: item.title,
    content: item.content,
    type: item.type,
    layer: item.layer,
    path: item.path,
    scope: item.scope,
    tags: item.tags,
    enabled: item.enabled,
    pinned: item.pinned,
    confidence: item.confidence,
    source: item.source,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

export function listMemoryItems(snapshot, args = {}) {
  const normalized = normalizeMemorySnapshot(snapshot);
  const maxItems = Math.max(1, Math.min(100, Number(args.max_items || 100)));
  const includeDisabled = args.include_disabled === true || args.enabled_only === false;
  return normalized.items
    .filter((item) => !args.layer || item.layer === args.layer)
    .filter((item) => !args.type || item.type === args.type)
    .filter((item) => !args.scope || item.scope === args.scope)
    .filter((item) => includeDisabled || item.enabled !== false)
    .slice(0, maxItems)
    .map(publicMemoryItem);
}

export function memoryTree(snapshot) {
  const normalized = normalizeMemorySnapshot(snapshot);
  return {
    root: normalized.settings.memoryRootPath || DEFAULT_MEMORY_ROOT,
    activeId: normalized.activeId,
    items: normalized.items.map((item) => ({
      id: item.id,
      path: item.path,
      layer: item.layer,
      type: item.type,
      scope: item.scope,
      title: item.title,
      enabled: item.enabled,
      pinned: item.pinned,
      updatedAt: item.updatedAt
    }))
  };
}

export function readMemoryItem(snapshot, args = {}) {
  const normalized = normalizeMemorySnapshot(snapshot);
  const id = String(args.id || "").trim();
  const path = normalizeMemoryPath(args.path || "");
  return normalized.items.find((item) =>
    (id && item.id === id) || (path && item.path === path)
  ) || null;
}

export function searchMemoryItems(snapshot, args = {}) {
  const normalized = normalizeMemorySnapshot(snapshot);
  const query = String(args.query || "").trim();
  const lowered = query.toLowerCase();
  const maxItems = Math.max(1, Math.min(100, Number(args.max_items || 20)));
  const includeDisabled = args.include_disabled === true || args.enabled_only === false;
  return normalized.items
    .filter((item) => !args.layer || item.layer === args.layer)
    .filter((item) => includeDisabled || item.enabled !== false)
    .filter((item) => {
      if (!lowered) return true;
      return [
        item.title,
        item.path,
        item.content,
        ...(item.tags || [])
      ].join("\n").toLowerCase().includes(lowered);
    })
    .map((item) => ({ item, score: scoreMemory(item, query) }))
    .sort((left, right) =>
      right.score - left.score
      || String(left.item.path || "").localeCompare(String(right.item.path || ""))
    )
    .slice(0, maxItems)
    .map(({ item }) => publicMemoryItem(item));
}

export function memoryProvidersSnapshot(snapshot = {}) {
  const normalized = normalizeMemorySnapshot(snapshot);
  return [{
    id: "local-markdown-files",
    label: "Local Markdown Files",
    runtimeBacked: true,
    readOnlyInRuntime: false,
    root: normalized.settings.memoryRootPath || DEFAULT_MEMORY_ROOT
  }];
}

function updateMemorySnapshot(snapshot, {
  items,
  activeId,
  settings = snapshot.settings,
  timestamp = Date.now()
} = {}) {
  return normalizeMemorySnapshot({
    ...snapshot,
    savedAt: timestamp,
    lastChangedAt: timestamp,
    activeId: String(activeId || ""),
    settings,
    items
  });
}

export function createMemoryItem(snapshot, args = {}, timestamp = Date.now()) {
  const current = normalizeMemorySnapshot(snapshot);
  const id = String(args.id || "").trim() || generatedMemoryId(timestamp);
  if (current.items.some((item) => item.id === id)) {
    throw new Error(`Memory already exists: ${id}`);
  }
  const title = String(args.title || "Untitled Memory").trim() || "Untitled Memory";
  const type = MEMORY_TYPES.has(args.type) ? args.type : "semantic";
  const layer = MEMORY_LAYERS.has(args.layer) ? args.layer : "long-term";
  const item = normalizeMemoryItem({
    id,
    title,
    content: String(args.content || ""),
    type,
    layer,
    path: args.path || defaultMemoryPath({ title, type, layer, id }),
    scope: MEMORY_SCOPES.has(args.scope) ? args.scope : "project",
    tags: uniqueStrings(args.tags),
    enabled: args.enabled !== false,
    pinned: !!args.pinned,
    confidence: args.confidence ?? 0.8,
    source: String(args.source || "runtime"),
    providerId: String(args.providerId || "local-markdown-files"),
    createdAt: timestamp,
    updatedAt: timestamp
  });
  return {
    snapshot: updateMemorySnapshot(current, {
      items: [item, ...current.items],
      activeId: item.id,
      timestamp
    }),
    item
  };
}

export function updateMemoryItem(snapshot, id, patch = {}, timestamp = Date.now()) {
  const current = normalizeMemorySnapshot(snapshot);
  const targetId = String(id || "").trim();
  if (!targetId) throw new Error("memory id is required");
  const index = current.items.findIndex((item) => item.id === targetId);
  if (index < 0) throw new Error(`Memory not found: ${targetId}`);
  const nextItem = normalizeMemoryItem({
    ...current.items[index],
    ...objectValue(patch),
    id: targetId,
    updatedAt: timestamp
  });
  const items = current.items.slice();
  items[index] = nextItem;
  return {
    snapshot: updateMemorySnapshot(current, {
      items,
      activeId: current.activeId,
      timestamp
    }),
    item: nextItem
  };
}

export function deleteMemoryItem(snapshot, id, timestamp = Date.now()) {
  const current = normalizeMemorySnapshot(snapshot);
  const targetId = String(id || "").trim();
  if (!targetId) throw new Error("memory id is required");
  const items = current.items.filter((item) => item.id !== targetId);
  if (items.length === current.items.length) throw new Error(`Memory not found: ${targetId}`);
  const activeId = current.activeId === targetId ? (items[0]?.id || "") : current.activeId;
  return {
    snapshot: updateMemorySnapshot(current, { items, activeId, timestamp }),
    deleted: targetId
  };
}

export function selectMemoryItem(snapshot, id, timestamp = Date.now()) {
  const current = normalizeMemorySnapshot(snapshot);
  const targetId = String(id || "").trim();
  if (!targetId) throw new Error("memory id is required");
  if (!current.items.some((item) => item.id === targetId)) {
    throw new Error(`Memory not found: ${targetId}`);
  }
  return {
    snapshot: updateMemorySnapshot(current, {
      items: current.items,
      activeId: targetId,
      timestamp
    }),
    selected: targetId
  };
}

export function updateMemorySettings(snapshot, patch = {}, timestamp = Date.now()) {
  const current = normalizeMemorySnapshot(snapshot);
  const settingsPatch = Object.fromEntries(
    Object.entries(objectValue(patch))
      .filter(([key]) => [
        "autoInject",
        "memoryRootPath",
        "maxContextChars",
        "autoInjectLayer",
        "includePinnedLongTerm"
      ].includes(key))
  );
  const settings = normalizeMemorySettings({
    ...current.settings,
    ...settingsPatch
  });
  return {
    snapshot: updateMemorySnapshot(current, {
      items: current.items,
      activeId: current.activeId,
      settings,
      timestamp
    }),
    settings
  };
}

export function selectMemoriesForContext(snapshot, query = "", opts = {}) {
  const normalized = normalizeMemorySnapshot(snapshot);
  const settings = {
    ...normalized.settings,
    ...objectValue(opts.settings)
  };
  const maxItems = Number(opts.maxItems || 12);
  const layer = String(opts.layer || settings.autoInjectLayer || "working");
  return normalized.items
    .filter((item) => item.enabled !== false)
    .filter((item) => item.layer === layer || (!!settings.includePinnedLongTerm && item.pinned))
    .map((item) => ({ item, score: scoreMemory(item, query) }))
    .sort((a, b) =>
      b.score - a.score
      || String(a.item.path || "").localeCompare(String(b.item.path || ""))
    )
    .slice(0, maxItems)
    .map((entry) => entry.item);
}

export function buildMemoryContextFromSnapshot(snapshot, query = "", opts = {}) {
  const normalized = normalizeMemorySnapshot(snapshot);
  const settings = {
    ...normalized.settings,
    ...objectValue(opts.settings)
  };
  const items = selectMemoriesForContext(normalized, query, opts);
  const maxChars = Math.max(800, Number(opts.maxChars || settings.maxContextChars || 5000));
  const footer = "\n</working_memory>";
  const parts = [
    "<working_memory>",
    `  <root>${escapeXml(settings.memoryRootPath || DEFAULT_MEMORY_ROOT)}</root>`,
    "  <instructions>",
    "    These notes are working memory and are intentionally kept in the model context.",
    "    Treat them as persistent user/project preferences and relevant facts.",
    "    Long-term memory lives under the same root and should be retrieved on demand with the memoryManage tool.",
    "  </instructions>",
    `  <memories count="${items.length}">`
  ];
  let truncated = false;
  for (const item of items) {
    const attrs = [
      `id="${escapeXml(item.id)}"`,
      `path="${escapeXml(item.path)}"`,
      `type="${escapeXml(item.type)}"`,
      `scope="${escapeXml(item.scope)}"`,
      `layer="${escapeXml(item.layer)}"`,
      `provider="${escapeXml(item.providerId)}"`,
      `enabled="${item.enabled !== false ? "true" : "false"}"`,
      item.pinned ? "pinned=\"true\"" : "",
      item.confidence != null ? `confidence="${escapeXml(item.confidence)}"` : "",
      item.tags?.length ? `tags="${escapeXml(item.tags.join(","))}"` : ""
    ].filter(Boolean).join(" ");
    const prefix = [
      `    <memory ${attrs}>`,
      `      <title>${escapeXml(item.title)}</title>`,
      "      <content>"
    ].join("\n");
    const suffix = "\n      </content>\n    </memory>";
    const currentLen = `${parts.join("\n")}\n  </memories>${footer}`.length;
    const remaining = maxChars - currentLen - prefix.length - suffix.length - 64;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    let content = String(item.content || "").trim();
    if (content.length > remaining) {
      content = `${content.slice(0, Math.max(0, remaining))}\n[Memory truncated]`;
      truncated = true;
    }
    parts.push(`${prefix}\n${escapeXml(content)}${suffix}`);
  }
  if (truncated) parts.push("    <truncated>true</truncated>");
  parts.push("  </memories>");
  return {
    text: `${parts.join("\n")}${footer}`,
    items,
    maxChars
  };
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
