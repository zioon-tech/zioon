function entries(tree) {
  const result = new Map();
  const visit = (node, parentId = null) => {
    if (!node || !node.id || !["folder", "session"].includes(node.type)) {
      throw new Error("Invalid session tree node");
    }
    if (result.has(node.id)) throw new Error("Duplicate session tree node");
    result.set(node.id, { node, parentId });
    if (node.type === "folder") {
      if (!Array.isArray(node.children)) throw new Error("Invalid folder children");
      for (const child of node.children) visit(child, node.id);
    }
  };
  visit(tree);
  if (tree.id !== "root" || tree.type !== "folder") throw new Error("Invalid session tree root");
  return result;
}

export function sessionTreeChanges(base, desired) {
  const before = entries(base);
  const after = entries(desired);
  const changes = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const previous = before.get(id);
    const next = after.get(id);
    const summary = entry => entry ? {
      id, type: entry.node.type, title: entry.node.title, parentId: entry.parentId
    } : null;
    if (JSON.stringify(summary(previous)) !== JSON.stringify(summary(next))) {
      changes.push({ before: summary(previous), after: summary(next) });
    }
  }
  return changes;
}

export function mergeMigratedSessionTree(current, source) {
  const result = JSON.parse(JSON.stringify(current));
  const live = entries(result);
  entries(source);
  const importChildren = (sourceFolder, target) => {
    for (const child of sourceFolder.children) {
      const existing = live.get(child.id);
      if (child.type === "session") {
        if (existing) continue;
        const node = { ...child };
        target.children.push(node);
        live.set(node.id, { node, parentId: target.id });
        continue;
      }
      if (existing && existing.node.type !== "folder") throw new Error("Migration node type conflict");
      const folder = existing?.node || { ...child, children: [] };
      if (!existing) {
        target.children.push(folder);
        live.set(folder.id, { node: folder, parentId: target.id });
      }
      importChildren(child, folder);
    }
  };
  importChildren(source, result);
  return result;
}

// Apply only edits made since the client's base. Other clients' folders,
// placements and titles survive an old tab saving its tree.
export function mergeSessionTree(base, desired, current) {
  const before = entries(base);
  const after = entries(desired);
  const result = JSON.parse(JSON.stringify(current));
  const live = entries(result);
  const detach = (id) => {
    const entry = live.get(id);
    const parent = live.get(entry?.parentId)?.node;
    if (parent) parent.children = parent.children.filter(child => child.id !== id);
  };
  for (const [id] of before) {
    if (id === "root" || after.has(id) || !live.has(id)) continue;
    detach(id);
    live.delete(id);
  }
  for (const [id, entry] of after) {
    const previous = before.get(id);
    let existing = live.get(id);
    // A node removed remotely must not be resurrected by an unchanged tab.
    if (!existing && previous) continue;
    if (!existing) {
      const node = { ...entry.node, ...(entry.node.type === "folder" ? { children: [] } : {}) };
      existing = { node, parentId: null };
      live.set(id, existing);
    }
    if (previous && previous.node.type !== entry.node.type) throw new Error("Session tree node type changed");
    if (existing.node.type !== entry.node.type) throw new Error("Conflicting session tree node type");
    if (!previous || previous.node.title !== entry.node.title) existing.node.title = entry.node.title;
    if (id === "root") continue;
    if (previous && previous.parentId === entry.parentId) continue;
    const parent = live.get(entry.parentId);
    if (!parent || parent.node.type !== "folder") {
      throw Object.assign(new Error("Target folder was removed; refresh before moving"), { statusCode: 409 });
    }
    let ancestor = parent;
    const visited = new Set();
    while (ancestor) {
      if (ancestor.node.id === id || visited.has(ancestor.node.id)) {
        throw new Error("Session tree move creates a cycle");
      }
      visited.add(ancestor.node.id);
      ancestor = live.get(ancestor.parentId);
    }
    detach(id);
    // Preserve local insertion order using the nearest surviving predecessor.
    const siblings = after.get(entry.parentId).node.children;
    const position = siblings.findIndex(child => child.id === id);
    const preceding = siblings.slice(0, position).reverse().find(child =>
      parent.node.children.some(item => item.id === child.id)
    );
    const index = preceding ? parent.node.children.findIndex(child => child.id === preceding.id) + 1 : 0;
    parent.node.children.splice(index, 0, existing.node);
    existing.parentId = entry.parentId;
  }
  entries(result);
  return result;
}
