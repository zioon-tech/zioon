import { applySessionMetadataChanges, sessionMetadataChanges } from "../../../packages/runtime-client/src/session-metadata.mjs";
import { clientAnnotationSnapshot } from "../../../packages/runtime-client/src/session-annotations.mjs";

export function createSessionDocRepo(opts) {
  const warnStorageIssue = opts?.warnStorageIssue;
  const onPersist = opts?.onPersist;
  const onLoad = opts?.onLoad;
  const now = opts?.now;
  const getZion = () => {
    try {
      const v = opts?.getZion?.();
      if (v) return v;
    } catch {}
    return window.zion;
  };

  const docKey = (id) => `zion.session.${id}.doc`;
  const metaKey = (id) => `zion.session.${id}.meta`;
  const isMissingSession = (error) => Number(error?.status) === 404;
  const pendingLoads = new Map();
  const pendingMetadataLoads = new Map();
  const generations = new Map();
  const pendingMetaWrites = new Map();
  const editBases = new WeakMap();
  const loadedMetadataRevisions = new WeakMap();
  const copy = value => JSON.parse(JSON.stringify(value));
  const editCopy = value => {
    const result = copy(value || {});
    // Cached metadata is replaced, never edited in place by this repository.
    // Keep its immutable comparison base instead of another full JSON copy.
    editBases.set(result, value || {});
    return result;
  };
  const defaultMeta = (id) => ({
    id, title: `Session ${id}`, createdAt: now(), updatedAt: now(),
    size: 0, hash: "", titleAuto: true
  });

  function invalidate(id) {
    generations.set(id, (generations.get(id) || 0) + 1);
    const state = getZion()?.state;
    state?.set(`sessions.doc.${id}`, undefined);
    state?.set(`sessions.meta.${id}`, undefined);
    state?.set(`sessions.metaLoaded.${id}`, false);
  }

  function loadRecord(id, { metadataOnly = false } = {}) {
    if (pendingLoads.has(id)) return pendingLoads.get(id);
    const loads = metadataOnly ? pendingMetadataLoads : pendingLoads;
    if (loads.has(id)) return loads.get(id);
    const state = getZion()?.state;
    const previousDoc = state?.get(`sessions.doc.${id}`);
    const previousMeta = state?.get(`sessions.meta.${id}`);
    const generation = generations.get(id);
    const pending = Promise.resolve().then(async () => {
      // A summary/event can advance the known head while a full read is in
      // flight. Never publish that stale body, even into an empty cache.
      for (let attempt = 0; attempt < 3; attempt++) {
        const read = metadataOnly && typeof opts?.onLoadMeta === "function" ? opts.onLoadMeta : onLoad;
        const record = await read?.(id);
        if (record && Number(record.session_revision || 0) < Number(opts?.getKnownRevision?.(id) || 0)) continue;
        if (!record || record.deleted) {
          throw Object.assign(new Error("Session not found"), { status: 404 });
        }
        if (generations.get(id) !== generation) throw new Error("Session changed while loading");
        if (!metadataOnly && state?.get(`sessions.doc.${id}`) === previousDoc) {
          state?.set(`sessions.doc.${id}`, String(record.text ?? ""));
        }
        const currentMeta = state?.get(`sessions.meta.${id}`);
        const revision = Number(record.session_revision || 0);
        // Another read can replace this cache while the body is in flight.
        // Repository-published objects are immutable; local writes replace
        // them and deliberately do not carry this remote-revision marker.
        if (currentMeta === previousMeta || (currentMeta && loadedMetadataRevisions.has(currentMeta)
          && revision >= loadedMetadataRevisions.get(currentMeta))) {
          const next = { ...(record.meta || defaultMeta(id)), id };
          loadedMetadataRevisions.set(next, revision);
          state?.set(`sessions.meta.${id}`, next);
          state?.set(`sessions.metaLoaded.${id}`, true);
        } else if (state?.get(`sessions.metaLoaded.${id}`) === false) {
          const summary = state?.get(`sessions.summary.${id}`) || {};
          const local = currentMeta || {};
          const patch = Object.fromEntries(Object.entries(local).filter(
            ([key, value]) => JSON.stringify(value) !== JSON.stringify(summary[key])
          ));
          state?.set(`sessions.meta.${id}`, { ...record.meta, ...patch, id });
          state?.set(`sessions.metaLoaded.${id}`, true);
        }
        opts?.onLoaded?.(id, record, { metadataOnly });
        return record;
      }
      throw Object.assign(new Error("Session changed while loading"), { code: "STALE_SESSION_READ" });
    }).finally(() => {
      if (loads.get(id) === pending) loads.delete(id);
    });
    loads.set(id, pending);
    return pending;
  }

  function loadDoc(id) {
    const zion = getZion();
    try {
      const mem = zion?.state?.get(`sessions.doc.${id}`);
      if (typeof mem === "string") return mem;
    } catch {}
    void loadDocAsync(id).catch(() => {});
    return "";
  }

  function saveDoc(id, text) {
    const zion = getZion();
    const nextText = String(text || "");
    try { zion?.state?.set(`sessions.doc.${id}`, nextText); } catch {}
    return (async () => {
      try {
        if (typeof onPersist !== "function") {
          throw new Error("durable session storage unavailable");
        }
        await onPersist("doc", id, nextText);
        return true;
      } catch (error) {
        try {
          warnStorageIssue?.("saveDoc", error);
        } catch {}
        return false;
      }
    })();
  }

  async function loadDocAsync(id) {
    const zion = getZion();
    try {
      const mem = zion?.state?.get(`sessions.doc.${id}`);
      if (typeof mem === "string") return mem;
    } catch {}
    try {
      await loadRecord(id);
      return zion?.state?.get(`sessions.doc.${id}`) ?? "";
    } catch (e) {
      if (!isMissingSession(e)) {
        try { warnStorageIssue?.("loadDocAsync", e); } catch {}
      }
      throw e;
    }
  }

  async function loadMetaAsync(id, { refresh = false } = {}) {
    const zion = getZion();
    let mem = null;
    try {
      const value = zion?.state?.get(`sessions.meta.${id}`);
      if (value && typeof value === "object") mem = value;
    } catch {}
    try {
      if (mem && !refresh && zion?.state?.get(`sessions.metaLoaded.${id}`) !== false) return editCopy(mem);
      await loadRecord(id, { metadataOnly: typeof zion?.state?.get(`sessions.doc.${id}`) !== "string" });
      return editCopy(zion?.state?.get(`sessions.meta.${id}`));
    } catch (e) {
      if (!isMissingSession(e)) {
        try { warnStorageIssue?.("loadMetaAsync", e); } catch {}
      }
      if (mem && zion?.state?.get(`sessions.metaLoaded.${id}`) !== false) return editCopy(mem);
      throw e;
    }
  }

  function loadMeta(id) {
    const zion = getZion();
    try {
      const mem = zion?.state?.get(`sessions.meta.${id}`);
      if (mem && typeof mem === "object" && zion?.state?.get(`sessions.metaLoaded.${id}`) !== false) return editCopy(mem);
      const summary = zion?.state?.get(`sessions.summary.${id}`);
      if (summary && typeof summary === "object") return editCopy(summary);
    } catch {}
    void loadMetaAsync(id).catch(() => {});
    return editCopy(defaultMeta(id));
  }

  // For display and annotation lookup only. Call loadMeta for an editable copy.
  function peekMeta(id) {
    const state = getZion()?.state;
    return state?.get(`sessions.meta.${id}`) || state?.get(`sessions.summary.${id}`) || null;
  }

  function saveMeta(id, meta, { base, automaticTitle = false } = {}) {
    const zion = getZion();
    const summary = zion?.state?.get(`sessions.summary.${id}`);
    const before = base || editBases.get(meta)
      || zion?.state?.get(`sessions.meta.${id}`) || summary || {};
    const desired = meta || {};
    // Compare against the snapshot the editor read, even if the cache has
    // since received another window's title or annotations.
    const allChanges = sessionMetadataChanges(before, desired);
    if (!allChanges.length) return Promise.resolve(true);
    const localFields = ["size", "hash", "updatedAt", "documentPreview", "documentPreviewVersion"];
    const annotationSnapshot = value => Object.hasOwn(value, "annotations") && value.annotations !== undefined
      ? { annotations: value.annotations == null ? value.annotations : clientAnnotationSnapshot(value.annotations) } : {};
    const annotationChanges = allChanges.some(change => change.path[0] === "annotations")
      ? sessionMetadataChanges(
        annotationSnapshot(before), annotationSnapshot(desired)
      ) : [];
    const changes = [
      ...allChanges.filter(change => !localFields.includes(change.path[0]) && change.path[0] !== "annotations"),
      ...annotationChanges
    ];
    const localChanges = allChanges.filter(change => localFields.includes(change.path[0]));
    const persist = async () => {
      const current = zion?.state?.get(`sessions.meta.${id}`) || summary || {};
      const next = annotationChanges.length
        ? applySessionMetadataChanges(current, annotationChanges).meta : { ...current };
      for (const change of [...changes.filter(change => change.path[0] !== "annotations"), ...localChanges]) {
        let parent = next;
        for (const key of change.path.slice(0, -1)) {
          if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid metadata path");
          parent[key] = parent[key] && typeof parent[key] === "object" && !Array.isArray(parent[key])
            ? { ...parent[key] } : {};
          parent = parent[key];
        }
        const key = change.path.at(-1);
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid metadata path");
        if (change.afterPresent) parent[key] = copy(change.after);
        else delete parent[key];
      }
      zion?.state?.set(`sessions.meta.${id}`, next);
      if (changes.length) {
        zion?.state?.set(`sessions.metaLoaded.${id}`, true);
        if (typeof onPersist !== "function") throw new Error("durable session storage unavailable");
        await onPersist("meta", id, next, { changes, ...(automaticTitle ? { automaticTitle: true } : {}) });
      }
      return true;
    };
    const fail = error => {
      try { warnStorageIssue?.("saveMeta", error); } catch {}
      return false;
    };
    if (changes.length && summary && (!zion?.state?.get(`sessions.meta.${id}`)
      || zion?.state?.get(`sessions.metaLoaded.${id}`) === false)) {
      const previous = pendingMetaWrites.get(id) || Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        await loadRecord(id, { metadataOnly: typeof zion?.state?.get(`sessions.doc.${id}`) !== "string" });
        return persist();
      }).catch(fail).finally(() => {
        if (pendingMetaWrites.get(id) === pending) pendingMetaWrites.delete(id);
      });
      pendingMetaWrites.set(id, pending);
      return pending;
    }
    return persist().catch(fail);
  }

  return { docKey, metaKey, loadDoc, saveDoc, loadDocAsync, peekMeta, loadMeta, loadMetaAsync, saveMeta, invalidate };
}
