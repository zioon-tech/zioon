import { ViewPlugin } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import { extractDocumentLeadPreview } from "../../shared/session-preview.js";

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

  const buckets = new Map();
  const pendingPersistence = new Set();
  const autosaveQuietDelayMs = 700;
  const autosaveMaxDelayMs = 2000;

  const getBucketKey = (view) => {
    try {
      const editorId = view?.dom?.getAttribute?.("data-editor-id") || null;
      if (editorId) return `editor:${editorId}`;
      const panelId = view?.dom?.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id") || null;
      if (panelId) return `panel:${panelId}`;
    } catch {}
    return view || "global";
  };

  const getBucket = (view) => {
    const key = getBucketKey(view);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, timer: 0, maxTimer: 0, pendingDoc: null, pendingId: null, pendingView: null };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const isAutosaveIgnoredUpdate = (update) => {
    try {
      return !!update?.transactions?.some?.((tr) => {
        const userEvent = tr?.annotation?.(Transaction.userEvent);
        return userEvent === "zion.sessionLoad"
          || userEvent === "zion.sessionSeed"
          || userEvent === "zion.cardRestore";
      });
    } catch {
      return false;
    }
  };

  const clearQuietTimer = (bucket) => {
    try { if (bucket?.timer) cancelIdleCallback(bucket.timer); } catch {}
    try { if (bucket?.timer) clearTimeout(bucket.timer); } catch {}
    if (bucket) bucket.timer = 0;
  };

  const clearTimers = (bucket) => {
    clearQuietTimer(bucket);
    try { if (bucket?.maxTimer) clearTimeout(bucket.maxTimer); } catch {}
    if (bucket) bucket.maxTimer = 0;
  };

  const trackPersistence = (result) => {
    if (!result || typeof result.then !== "function") return;
    const pending = Promise.resolve(result).catch(() => false);
    pendingPersistence.add(pending);
    void pending.finally(() => pendingPersistence.delete(pending));
  };

  const commit = (id, doc) => {
    if (!id || !doc) return false;
    const text = doc.toString();
    const meta = loadMeta(id);
    const newHash = hashString(text);
    if (newHash === (meta.hash || "")) return false;
    trackPersistence(saveDoc(id, text));
    meta.documentPreview = extractDocumentLeadPreview(text);
    meta.documentPreviewVersion = 1;
    const rs = zion?.state?.get(`chat.runs.${id}`) || null;
    if (rs && rs.streaming) {
      meta.size = text.length;
      meta.hash = newHash;
      try {
        const ann = getAnnotationsState(id);
        if (ann) meta.annotations = ann;
      } catch {}
      trackPersistence(saveMeta(id, meta));
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
    trackPersistence(saveMeta(id, meta));
    upsertIndexEntry({ id, title: meta.title, updatedAt: meta.updatedAt, size: meta.size, hash: meta.hash, createdAt: meta.createdAt });
    try { postSaved(id, meta.updatedAt, meta.hash); } catch {}
    try { onSaved(meta); } catch {}
    return true;
  };

  const scheduleSave = (bucket) => {
    clearQuietTimer(bucket);
    const idle = typeof requestIdleCallback === "function";
    const fn = () => {
      clearTimers(bucket);
      const id = bucket.pendingId || getCurrentId(bucket.pendingView);
      if (!id || !bucket.pendingDoc) return;
      const doc = bucket.pendingDoc;
      bucket.pendingDoc = null;
      bucket.pendingId = null;
      bucket.pendingView = null;
      commit(id, doc);
    };
    const scheduleIdleCommit = () => {
      bucket.timer = 0;
      if (idle) {
        bucket.timer = requestIdleCallback(fn, { timeout: 1200 });
      } else {
        bucket.timer = setTimeout(fn, 0);
      }
    };
    bucket.timer = setTimeout(scheduleIdleCommit, autosaveQuietDelayMs);
    if (!bucket.maxTimer) {
      bucket.maxTimer = setTimeout(fn, autosaveMaxDelayMs);
    }
  };

  const flush = (idOverride) => {
    let saved = false;
    for (const bucket of buckets.values()) {
      const id = idOverride || bucket.pendingId || getCurrentId(bucket.pendingView);
      if (!id || !bucket.pendingDoc) continue;
      const bucketId = bucket.pendingId || getCurrentId(bucket.pendingView);
      if (idOverride && bucketId !== idOverride) continue;
      const doc = bucket.pendingDoc;
      bucket.pendingDoc = null;
      bucket.pendingId = null;
      bucket.pendingView = null;
      clearTimers(bucket);
      saved = commit(id, doc) || saved;
    }
    return saved;
  };

  const flushDurably = async (idOverride) => {
    const saved = flush(idOverride);
    while (pendingPersistence.size) {
      await Promise.allSettled([...pendingPersistence]);
    }
    return saved;
  };

  return {
    extension: ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view;
      }
      update(update) {
        if (update.docChanged) {
          if (isAutosaveIgnoredUpdate(update)) return;
          const bucket = getBucket(update.view);
          bucket.pendingView = update.view;
          bucket.pendingId = getCurrentId(update.view);
          bucket.pendingDoc = update.state.doc;
          scheduleSave(bucket);
        }
      }
      destroy() {
        const key = getBucketKey(this?.view);
        const bucket = buckets.get(key);
        clearTimers(bucket);
        buckets.delete(key);
      }
    }),
    flush,
    flushDurably
  };
}
