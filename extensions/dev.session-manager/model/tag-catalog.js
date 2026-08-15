// Pure tag-catalog model: normalization, reconciliation, tree building, and
// catalog mutations. No DOM, no storage — everything here is data in/out.

const SEGMENT = "[\\p{L}\\p{N}_-]+";

export function normalizeTagPath(raw) {
  const trimmed = String(raw || "").replace(/^#/, "").trim();
  if (!trimmed) return null;
  const segments = trimmed.split("/").map((part) => part.trim()).filter(Boolean);
  if (!segments.length) return null;
  const path = segments.join("/");
  if (path.length > 200) return null;
  return path;
}

export function tagPathSegments(path) {
  const normalized = normalizeTagPath(path);
  return normalized ? normalized.split("/") : [];
}

export function tagPathDepth(path) {
  return tagPathSegments(path).length;
}

export function isDescendantPath(candidate, ancestor) {
  const a = normalizeTagPath(ancestor);
  const c = normalizeTagPath(candidate);
  if (!a || !c || a === c) return false;
  return c.startsWith(`${a}/`);
}

export function tagPathMatches(candidate, selected) {
  const a = normalizeTagPath(selected);
  const c = normalizeTagPath(candidate);
  if (!a || !c) return false;
  return c === a || c.startsWith(`${a}/`);
}

export function validateCatalogEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const path = normalizeTagPath(entry.path);
  if (!path) return null;
  const id = String(entry.id || `tag:${path}`);
  const order = Number.isFinite(entry.order) ? entry.order : 0;
  return {
    id,
    path,
    order,
    manual: entry.manual !== false
  };
}

export function validateCatalog(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const entries = [];
  for (const item of list) {
    const entry = validateCatalogEntry(item);
    if (!entry || seen.has(entry.path)) continue;
    seen.add(entry.path);
    entries.push(entry);
  }
  return { entries };
}

export function nextCatalogOrder(entries) {
  return entries.reduce((max, entry) => Math.max(max, entry.order + 1), 0);
}

// Merge durable catalog entries with tags scanned from documents. Catalog
// entries keep their identity/order; scanned-only tags become ephemeral
// entries appended afterwards (sorted alphabetically).
export function reconcileCatalog(catalogEntries, scannedPaths) {
  const base = validateCatalog(catalogEntries).entries;
  const byPath = new Map(base.map((entry) => [entry.path, entry]));
  const scanned = new Set();
  for (const raw of Array.isArray(scannedPaths) ? scannedPaths : []) {
    const path = normalizeTagPath(raw);
    if (path) scanned.add(path);
  }
  const ephemeral = Array.from(scanned)
    .filter((path) => !byPath.has(path))
    .sort((a, b) => a.localeCompare(b));
  let order = nextCatalogOrder(base);
  for (const path of ephemeral) {
    byPath.set(path, { id: `tag:${path}`, path, order: order++, manual: false });
  }
  // Scanned usage can also promote intermediate paths (e.g. "project" from
  // "project/zion") if they are not in the catalog yet.
  return Array.from(byPath.values());
}

export function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.path.localeCompare(b.path);
  });
}

// Build a hierarchical tree with session counts.
// sessionTags: iterable of [sessionId, string[] of tag paths (with or without #)]
export function buildTagTree(entries, sessionTags) {
  const list = sortEntries(entries);
  const byPath = new Map(list.map((entry) => [entry.path, { ...entry }]));
  // Ensure intermediate ancestors exist as implicit nodes.
  for (const entry of list) {
    const segments = tagPathSegments(entry.path);
    for (let depth = 1; depth < segments.length; depth += 1) {
      const parent = segments.slice(0, depth).join("/");
      if (!byPath.has(parent)) {
        byPath.set(parent, {
          id: `tag:${parent}`,
          path: parent,
          order: Number.MAX_SAFE_INTEGER / 2 + depth,
          manual: false,
          implicit: true
        });
      }
    }
  }
  const nodes = new Map();
  const root = { path: "", label: "", children: [], manual: false, sessionCount: 0, totalCount: 0 };
  const ensureNode = (path) => {
    if (nodes.has(path)) return nodes.get(path);
    const entry = byPath.get(path) || {
      id: `tag:${path}`,
      path,
      order: Number.MAX_SAFE_INTEGER / 2,
      manual: false,
      implicit: true
    };
    const segments = tagPathSegments(path);
    const node = { ...entry, label: segments[segments.length - 1], children: [], sessionCount: 0 };
    nodes.set(path, node);
    return node;
  };
  for (const entry of byPath.values()) {
    const segments = tagPathSegments(entry.path);
    let parent = root;
    for (let depth = 1; depth < segments.length; depth += 1) {
      const parentNode = ensureNode(segments.slice(0, depth).join("/"));
      if (!parent.children.includes(parentNode)) parent.children.push(parentNode);
      parent = parentNode;
    }
    const node = ensureNode(entry.path);
    Object.assign(node, entry, {
      label: segments[segments.length - 1],
      children: node.children
    });
    if (!parent.children.includes(node)) parent.children.push(node);
  }
  // Count sessions per node (a session counts toward a node when any of its
  // tags equals the node path or is a descendant of it).
  const countingNodes = nodes.size;
  for (const [sessionId, tags] of sessionTags || []) {
    const sid = String(sessionId || "");
    if (!sid) continue;
    const paths = (Array.isArray(tags) ? tags : [])
      .map((tag) => normalizeTagPath(tag))
      .filter(Boolean);
    if (!paths.length) continue;
    const counted = new Set();
    for (const path of paths) {
      const segments = tagPathSegments(path);
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const ancestorPath = segments.slice(0, depth).join("/");
        if (!counted.has(ancestorPath)) {
          counted.add(ancestorPath);
          const node = nodes.get(ancestorPath);
          if (node) node.sessionCount += 1;
        }
      }
    }
  }
  const sortChildren = (node) => {
    node.children.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.path.localeCompare(b.path);
    });
    for (const child of node.children) sortChildren(child);
  };
  sortChildren(root);
  const flatten = (node, depth, out) => {
    for (const child of node.children) {
      out.push({ ...child, depth });
      flatten(child, depth + 1, out);
    }
    return out;
  };
  return {
    root,
    rows: flatten(root, 0, []),
    nodeCount: countingNodes,
    totalTags: byPath.size
  };
}

export function addCatalogEntry(entries, path, { manual = true } = {}) {
  const normalized = normalizeTagPath(path);
  if (!normalized) return { entries: [...entries], added: null };
  const existing = entries.find((entry) => entry.path === normalized);
  if (existing) {
    if (manual && !existing.manual) {
      const next = entries.map((entry) => (entry.path === normalized ? { ...entry, manual: true } : entry));
      return { entries: next, added: normalized };
    }
    return { entries: [...entries], added: null };
  }
  const entry = {
    id: `tag:${normalized}`,
    path: normalized,
    order: nextCatalogOrder(entries),
    manual: manual !== false
  };
  return { entries: [...entries, entry], added: normalized };
}

export function renameCatalogPath(entries, fromPath, toPath) {
  const from = normalizeTagPath(fromPath);
  const to = normalizeTagPath(toPath);
  if (!from || !to || from === to) return { entries: [...entries], renamed: null, affected: 0 };
  if (to.startsWith(`${from}/`) || from.startsWith(`${to}/`)) return { entries: [...entries], renamed: null, affected: 0 };
  let affected = 0;
  const next = entries.map((entry) => {
    if (entry.path === from) {
      affected += 1;
      return { ...entry, path: to, id: `tag:${to}` };
    }
    if (isDescendantPath(entry.path, from)) {
      affected += 1;
      return { ...entry, path: `${to}/${entry.path.slice(from.length + 1)}`, id: `tag:${to}/${entry.path.slice(from.length + 1)}` };
    }
    return entry;
  });
  // If the target already exists, merge by dropping the renamed duplicates.
  const seen = new Set();
  const deduped = [];
  for (const entry of sortEntries(next)) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    deduped.push(entry);
  }
  return { entries: deduped, renamed: { from, to }, affected };
}

export function deleteCatalogPaths(entries, paths) {
  const targets = (Array.isArray(paths) ? paths : []).map((p) => normalizeTagPath(p)).filter(Boolean);
  if (!targets.length) return { entries: [...entries], removed: [] };
  const kept = entries.filter((entry) => !targets.some((target) => entry.path === target || isDescendantPath(entry.path, target)));
  return { entries: kept, removed: targets };
}

// Reorder `path` to sit immediately before (or after when `after` is true)
// `referencePath`, both sharing the same parent path.
export function reorderCatalogEntry(entries, path, referencePath, { after = false } = {}) {
  const target = normalizeTagPath(path);
  const reference = normalizeTagPath(referencePath);
  if (!target || !reference || target === reference) return [...entries];
  const parentOf = (p) => {
    const segments = tagPathSegments(p);
    segments.pop();
    return segments.join("/");
  };
  if (parentOf(target) !== parentOf(reference)) return [...entries];
  const siblings = sortEntries(entries.filter((entry) => parentOf(entry.path) === parentOf(reference)));
  const refIndex = siblings.findIndex((entry) => entry.path === reference);
  if (refIndex < 0) return [...entries];
  const refOrder = siblings[refIndex].order;
  let newOrder;
  if (after) {
    const nextSibling = siblings[refIndex + 1];
    newOrder = nextSibling ? (refOrder + nextSibling.order) / 2 : refOrder + 1;
  } else if (refIndex === 0) {
    newOrder = refOrder - 0.5;
  } else {
    const before = siblings[refIndex - 1];
    if (before.path === target) return [...entries];
    newOrder = (before.order + refOrder) / 2;
  }
  return entries.map((entry) => (entry.path === target ? { ...entry, order: newOrder } : entry));
}
