import { ViewPlugin } from "@codemirror/view";

export function createSessionAutoSavePlugin(opts) {
  const getCurrentId = opts?.getCurrentId;
  const onSaved = opts?.onSaved;
  const loadMeta = opts?.loadMeta;
  const saveDoc = opts?.saveDoc;
  const saveMeta = opts?.saveMeta;
  const hashString = opts?.hashString;
  const now = opts?.now;
  const getAnnotationsState = opts?.getAnnotationsState;
  const rebuildIndexFromTree = opts?.rebuildIndexFromTree;
  const upsertIndexEntry = opts?.upsertIndexEntry;
  const postSaved = opts?.postSaved;
  const zion = opts?.zion || window.zion;

  let timer = 0;
  let pendingDoc = null;
  let pendingId = null;
  let pendingView = null;

  const clearTimer = () => {
    try { if (timer) cancelIdleCallback(timer); } catch {}
    try { if (timer) clearTimeout(timer); } catch {}
    timer = 0;
  };

  const commit = (id, doc) => {
    if (!id || !doc) return false;
    const text = doc.toString();
    const meta = loadMeta(id);
    const newHash = hashString(text);
    if (newHash === (meta.hash || "")) {
      return false;
    }
    saveDoc(id, text);
    const rs = zion?.state?.get(`chat.runs.${id}`) || null;
    if (rs && rs.streaming) {
      meta.size = text.length;
      meta.hash = newHash;
      try {
        const ann = getAnnotationsState(id);
        if (ann) meta.annotations = ann;
      } catch {}
      saveMeta(id, meta);
      try { onSaved(meta); } catch {}
      return true;
    }
    meta.updatedAt = now();
    meta.size = text.length;
    meta.hash = newHash;
    try {
      const ann = getAnnotationsState(id);
      if (ann) meta.annotations = ann;
    } catch {}
    saveMeta(id, meta);
    rebuildIndexFromTree();
    upsertIndexEntry({ id, title: meta.title, updatedAt: meta.updatedAt, size: meta.size, hash: meta.hash, createdAt: meta.createdAt });
    try { postSaved(id, meta.updatedAt, meta.hash); } catch {}
    try { onSaved(meta); } catch {}
    return true;
  };

  const scheduleSave = () => {
    clearTimer();
    const idle = typeof requestIdleCallback === "function";
    const fn = () => {
      const id = pendingId || getCurrentId(pendingView);
      if (!id || !pendingDoc) return;
      const doc = pendingDoc;
      pendingDoc = null;
      pendingId = null;
      pendingView = null;
      commit(id, doc);
    };
    if (idle) {
      timer = requestIdleCallback(fn, { timeout: 1200 });
    } else {
      timer = setTimeout(fn, 600);
    }
  };

  const flush = (idOverride) => {
    const id = idOverride || pendingId || getCurrentId(pendingView);
    if (!id) return false;
    if (!pendingDoc) return false;
    if (pendingId && pendingId !== id) return false;
    const doc = pendingDoc;
    pendingDoc = null;
    pendingId = null;
    pendingView = null;
    clearTimer();
    return commit(id, doc);
  };

  return {
    extension: ViewPlugin.fromClass(class {
      constructor(view) {}
      update(update) {
        if (update.docChanged) {
          pendingView = update.view;
          pendingId = getCurrentId(update.view);
          pendingDoc = update.state.doc;
          scheduleSave();
        }
      }
      destroy() {
        clearTimer();
      }
    }),
    flush
  };
}
