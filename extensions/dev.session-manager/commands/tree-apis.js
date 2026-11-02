function cloneValue(value) {
  if (value == null) return value;
  try {
    if (typeof globalThis.structuredClone === "function") {
      return globalThis.structuredClone(value);
    }
  } catch {}
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function findParentId(root, id, parentId = null) {
  if (!root || !id) return null;
  if (root.id === id) return parentId;
  for (const child of root.children || []) {
    const found = findParentId(child, id, root.id);
    if (found) return found;
  }
  return null;
}

export function registerSessionTreeCommands(deps = {}) {
  const zion = deps.zion;
  const disposables = [];
  const register = (id, handler) => {
    const disposable = zion?.commands?.registerCommand?.(id, handler);
    if (disposable) disposables.push(disposable);
  };

  register("zion.sessions.getTreeSnapshot", () => cloneValue(deps.loadTree?.() || null));

  register("zion.sessions.createFolder", (payload = {}) => {
    const parentId = String(payload?.parentId || "root");
    const title = String(payload?.title || "").trim() || "New Folder";
    return deps.insertFolder?.(parentId, title) || null;
  });

  register("zion.sessions.moveNode", (payload = {}) => {
    const id = String(payload?.id || "").trim();
    const targetFolderId = String(payload?.targetFolderId || "").trim();
    if (!id || !targetFolderId) return false;
    if (findParentId(deps.loadTree?.(), id) === targetFolderId) return true;
    if (deps.moveNode?.(id, targetFolderId) !== true) return false;
    try { zion?.state?.set?.("sessions.catalog", deps.getIndex?.() || []); } catch {}
    try { deps.refreshSessionsSidebarViewIfOpen?.(); } catch {}
    return true;
  });

  return {
    dispose() {
      for (const disposable of disposables.splice(0)) {
        try { disposable?.dispose?.(); } catch {}
      }
    }
  };
}
