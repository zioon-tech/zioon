export function createSessionTreeModel(opts) {
  const dbName = opts?.dbName;
  const idbSetKV = opts?.idbSetKV;
  const warnStorageIssue = opts?.warnStorageIssue;
  const onPersist = opts?.onPersist;
  const onDelete = opts?.onDelete;
  const loadMeta = opts?.loadMeta;
  const genId = opts?.genId;
  const getLastActiveId = opts?.getLastActiveId;
  const setLastActiveId = opts?.setLastActiveId;
  const docKey = opts?.docKey;
  const metaKey = opts?.metaKey;
  const getZion = () => {
    try {
      const v = opts?.getZion?.();
      if (v) return v;
    } catch {}
    return window.zion;
  };
  const lsFolderOpenKey = opts?.lsFolderOpenKey;
  const cloneValue = (value) => {
    try {
      if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
    } catch {}
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  };

  function loadTree() {
    try {
      const mem = getZion()?.state?.get("sessions.treeMem");
      if (mem && mem.type === "folder" && Array.isArray(mem.children)) return cloneValue(mem);
    } catch {}
    return null;
  }

  function saveTree(tree) {
    const optimistic = cloneValue(tree);
    let previous;
    try { previous = getZion()?.state?.get("sessions.treeMem"); } catch {}
    try { getZion()?.state?.set("sessions.treeMem", optimistic); } catch {}
    (async () => {
      try {
        await idbSetKV(dbName, "tree", optimistic);
        try { onPersist?.("tree"); } catch {}
      } catch (e) {
        try {
          if (getZion()?.state?.get("sessions.treeMem") === optimistic) {
            getZion()?.state?.set("sessions.treeMem", previous);
          }
        } catch {}
        try { warnStorageIssue?.("saveTree", e); } catch {}
      }
    })();
  }

  function getIndexLegacy() {
    try {
      const mem = getZion()?.state?.get("sessions.indexMem");
      if (Array.isArray(mem)) return cloneValue(mem);
    } catch {}
    return [];
  }

  function flattenTree(tree) {
    const out = [];
    const walk = (node) => {
      if (!node) return;
      if (node.type === "session") {
        const meta = loadMeta(node.id);
        const title = String(meta?.title || node.title || node.id || "").trim() || node.id;
        out.push({
          id: node.id,
          title,
          updatedAt: meta?.updatedAt ?? 0,
          size: meta?.size ?? 0,
          hash: meta?.hash ?? "",
          createdAt: meta?.createdAt ?? 0
        });
      } else if (node.type === "folder" && Array.isArray(node.children)) {
        node.children.forEach(walk);
      }
    };
    walk(tree);
    return out;
  }

  function getIndex() {
    try {
      const mem = getZion()?.state?.get("sessions.indexMem");
      if (Array.isArray(mem)) return cloneValue(mem);
    } catch {}
    const tree = loadTree();
    if (tree) return flattenTree(tree);
    return getIndexLegacy();
  }

  function setIndex(list) {
    const optimistic = cloneValue(list);
    let previous;
    try { previous = getZion()?.state?.get("sessions.indexMem"); } catch {}
    try { getZion()?.state?.set("sessions.indexMem", optimistic); } catch {}
    (async () => {
      try {
        await idbSetKV(dbName, "index", optimistic);
        try { onPersist?.("index"); } catch {}
      } catch (e) {
        try {
          if (getZion()?.state?.get("sessions.indexMem") === optimistic) {
            getZion()?.state?.set("sessions.indexMem", previous);
          }
        } catch {}
        try { warnStorageIssue?.("setIndex", e); } catch {}
      }
    })();
  }

  function rebuildIndexFromTree() {
    const tree = loadTree();
    if (!tree) return;
    const flat = flattenTree(tree);
    setIndex(flat);
  }

  function ensureInitialTree() {
    let tree = loadTree();
    if (tree) return tree;

    let legacy = getIndexLegacy();
    if (legacy.length === 0) {
      setIndex([]);
    }

    tree = {
      id: "root",
      type: "folder",
      title: "Sessions",
      children: legacy.map(it => ({ id: it.id, type: "session", title: it.title }))
    };
    saveTree(tree);
    return tree;
  }

  function isFolder(node) { return node && node.type === "folder"; }
  function isSession(node) { return node && node.type === "session"; }

  function findNodeAndParent(root, id) {
    let found = null, parent = null;
    const dfs = (node, p) => {
      if (!node) return;
      if (node.id === id) { found = node; parent = p; return; }
      if (isFolder(node) && Array.isArray(node.children)) {
        for (const ch of node.children) {
          dfs(ch, node);
          if (found) return;
        }
      }
    };
    dfs(root, null);
    return { node: found, parent };
  }

  function insertFolder(parentId, title) {
    const tree = loadTree() || ensureInitialTree();
    const { node: p } = parentId ? findNodeAndParent(tree, parentId) : { node: tree };
    const parent = p && isFolder(p) ? p : tree;
    const id = "fld_" + genId();
    const n = { id, type: "folder", title: title || "New Folder", children: [] };
    parent.children = parent.children || [];
    parent.children.unshift(n);
    saveTree(tree);
    try {
      rebuildIndexFromTree();
      try { getZion()?.state?.set("sessions.catalog", getIndex()); } catch {}
      console.info("[sessions] insertFolder:", { folderId: id, parentId: parent.id, title: n.title });
    } catch (e) {
      console.error("[sessions] insertFolder failed to rebuild index:", e);
    }
    return id;
  }

  function insertSessionNode(sessionId, parentId, title) {
    const tree = loadTree() || ensureInitialTree();
    const { node: p } = parentId ? findNodeAndParent(tree, parentId) : { node: tree };
    const parent = p && isFolder(p) ? p : tree;
    const n = { id: sessionId, type: "session", title: title || sessionId };
    parent.children = parent.children || [];
    parent.children.unshift(n);
    saveTree(tree);
    try {
      rebuildIndexFromTree();
      try { getZion()?.state?.set("sessions.catalog", getIndex()); } catch {}
      console.info("[sessions] insertSessionNode:", { sessionId, parentId: parent.id, title: n.title });
    } catch (e) {
      console.error("[sessions] insertSessionNode failed to rebuild index:", e);
    }
  }

  function insertSessionNodeAfter(sessionId, afterSessionId, title) {
    const tree = loadTree() || ensureInitialTree();
    const { node, parent } = afterSessionId ? findNodeAndParent(tree, afterSessionId) : { node: null, parent: null };
    if (!node || !parent || !isFolder(parent)) {
      insertSessionNode(sessionId, "root", title);
      return;
    }
    const n = { id: sessionId, type: "session", title: title || sessionId };
    parent.children = Array.isArray(parent.children) ? parent.children.slice() : [];
    const idx = parent.children.findIndex((child) => child.id === afterSessionId);
    if (idx === -1) {
      parent.children.unshift(n);
    } else {
      parent.children.splice(idx + 1, 0, n);
    }
    saveTree(tree);
    try {
      rebuildIndexFromTree();
      try { getZion()?.state?.set("sessions.catalog", getIndex()); } catch {}
      console.info("[sessions] insertSessionNodeAfter:", { sessionId, afterSessionId, parentId: parent.id, title: n.title });
    } catch (e) {
      console.error("[sessions] insertSessionNodeAfter failed to rebuild index:", e);
    }
  }

  function removeNode(nodeId) {
    const tree = loadTree();
    if (!tree) return false;
    const { node, parent } = findNodeAndParent(tree, nodeId);
    if (!node || !parent || !Array.isArray(parent.children)) return false;
    parent.children = parent.children.filter(c => c.id !== nodeId);
    saveTree(tree);
    return true;
  }

  function removeNodeRecursive(nodeId) {
    const tree = loadTree();
    if (!tree) return false;
    const { node, parent } = findNodeAndParent(tree, nodeId);
    if (!node || !parent || !Array.isArray(parent.children)) return false;

    const collectSessions = (n) => {
      if (isSession(n)) return [n.id];
      if (isFolder(n)) {
        return (n.children || []).flatMap(collectSessions);
      }
      return [];
    };
    const ids = collectSessions(node);
    for (const sid of ids) {
      try { void onDelete?.(sid); } catch {}
      try { if (docKey) localStorage.removeItem(docKey(sid)); } catch {}
      try { if (metaKey) localStorage.removeItem(metaKey(sid)); } catch {}
      try { getZion()?.state?.set(`sessions.doc.${sid}`, undefined); } catch {}
      try { getZion()?.state?.set(`sessions.meta.${sid}`, undefined); } catch {}
    }
    parent.children = parent.children.filter(c => c.id !== nodeId);
    saveTree(tree);
    rebuildIndexFromTree();
    const last = getLastActiveId();
    if (last && ids.includes(last)) {
      const flat = getIndex();
      const next = flat[0]?.id || null;
      if (next) setLastActiveId(next);
    }
    return true;
  }

  function moveNode(nodeId, targetFolderId) {
    const tree = loadTree() || ensureInitialTree();
    if (!tree) return false;
    if (!nodeId || !targetFolderId) return false;
    if (nodeId === "root") return false;

    const { node, parent } = findNodeAndParent(tree, nodeId);
    const { node: target } = findNodeAndParent(tree, targetFolderId);
    const dest = target && isFolder(target) ? target : tree;
    if (!node || !dest) return false;

    const isDescendant = (n, id) => {
      if (!n) return false;
      if (n.id === id) return true;
      if (isFolder(n)) {
        for (const ch of (n.children || [])) {
          if (isDescendant(ch, id)) return true;
        }
      }
      return false;
    };
    if (isFolder(node)) {
      if (node.id === dest.id) return false;
      if (isDescendant(node, dest.id)) return false;
    }

    if (parent && Array.isArray(parent.children)) {
      parent.children = parent.children.filter(c => c.id !== nodeId);
    } else {
      return false;
    }

    dest.children = dest.children || [];
    dest.children.unshift(node);

    saveTree(tree);
    rebuildIndexFromTree();
    return true;
  }

  function getFolderOpenMap() {
    const raw = lsFolderOpenKey ? localStorage.getItem(lsFolderOpenKey) : null;
    const m = raw ? (safeJSONParse(raw, {}) || {}) : {};
    return typeof m === "object" && m ? m : {};
  }

  function setFolderOpen(id, open) {
    if (!lsFolderOpenKey) return;
    const m = getFolderOpenMap();
    m[id] = !!open;
    try { localStorage.setItem(lsFolderOpenKey, JSON.stringify(m)); } catch {}
  }

  function isFolderOpen(id) {
    const m = getFolderOpenMap();
    const v = m[id];
    if (typeof v === "boolean") return v;
    return id === "root";
  }

  function openAncestors(id) {
    try {
      if (!id) return;
      const tree = loadTree() || ensureInitialTree();
      const { node, parent } = findNodeAndParent(tree, id);
      if (!node) return;
      let cur = parent;
      while (cur && cur.id && cur.type === "folder") {
        try { setFolderOpen(cur.id, true); } catch {}
        const up = findNodeAndParent(tree, cur.id)?.parent || null;
        cur = up;
      }
      try { setFolderOpen("root", true); } catch {}
    } catch {}
  }

  function safeJSONParse(text, fallback) {
    try { return JSON.parse(text); } catch { return fallback; }
  }

  return {
    loadTree,
    saveTree,
    getIndex,
    setIndex,
    rebuildIndexFromTree,
    ensureInitialTree,
    isFolder,
    isSession,
    findNodeAndParent,
    insertFolder,
    insertSessionNode,
    insertSessionNodeAfter,
    removeNode,
    removeNodeRecursive,
    moveNode,
    getFolderOpenMap,
    setFolderOpen,
    isFolderOpen,
    openAncestors
  };
}
