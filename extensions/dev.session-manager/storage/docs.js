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
  const generations = new Map();
  const pendingMetaWrites = new Map();
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

  function loadRecord(id) {
    if (pendingLoads.has(id)) return pendingLoads.get(id);
    const state = getZion()?.state;
    const previousDoc = state?.get(`sessions.doc.${id}`);
    const previousMeta = state?.get(`sessions.meta.${id}`);
    const generation = generations.get(id);
    const pending = Promise.resolve().then(() => onLoad?.(id)).then((record) => {
      if (!record || record.deleted) {
        throw Object.assign(new Error("Session not found"), { status: 404 });
      }
      if (generations.get(id) !== generation) throw new Error("Session changed while loading");
      if (state?.get(`sessions.doc.${id}`) === previousDoc) {
        state?.set(`sessions.doc.${id}`, String(record.text ?? ""));
      }
      if (state?.get(`sessions.meta.${id}`) === previousMeta) {
        state?.set(`sessions.meta.${id}`, { ...(record.meta || defaultMeta(id)), id });
        state?.set(`sessions.metaLoaded.${id}`, true);
      } else if (state?.get(`sessions.metaLoaded.${id}`) === false) {
        const summary = state?.get(`sessions.summary.${id}`) || {};
        const local = state?.get(`sessions.meta.${id}`) || {};
        const patch = Object.fromEntries(Object.entries(local).filter(
          ([key, value]) => JSON.stringify(value) !== JSON.stringify(summary[key])
        ));
        state?.set(`sessions.meta.${id}`, { ...record.meta, ...patch, id });
        state?.set(`sessions.metaLoaded.${id}`, true);
      }
      opts?.onLoaded?.(id, record);
      return record;
    }).finally(() => {
      if (pendingLoads.get(id) === pending) pendingLoads.delete(id);
    });
    pendingLoads.set(id, pending);
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
      if (mem && !refresh && zion?.state?.get(`sessions.metaLoaded.${id}`) !== false) return mem;
      await loadRecord(id);
      return zion?.state?.get(`sessions.meta.${id}`);
    } catch (e) {
      if (!isMissingSession(e)) {
        try { warnStorageIssue?.("loadMetaAsync", e); } catch {}
      }
      if (mem && zion?.state?.get(`sessions.metaLoaded.${id}`) !== false) return mem;
      throw e;
    }
  }

  function loadMeta(id) {
    const zion = getZion();
    try {
      const mem = zion?.state?.get(`sessions.meta.${id}`);
      if (mem && typeof mem === "object" && zion?.state?.get(`sessions.metaLoaded.${id}`) !== false) return mem;
      const summary = zion?.state?.get(`sessions.summary.${id}`);
      if (summary && typeof summary === "object") return { ...summary };
    } catch {}
    void loadMetaAsync(id).catch(() => {});
    return defaultMeta(id);
  }

  function saveMeta(id, meta) {
    const zion = getZion();
    const summary = zion?.state?.get(`sessions.summary.${id}`);
    if (summary && (!zion?.state?.get(`sessions.meta.${id}`)
      || zion?.state?.get(`sessions.metaLoaded.${id}`) === false)) {
      const patch = Object.fromEntries(Object.entries(meta || {}).filter(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(summary[key])
      ));
      const previous = pendingMetaWrites.get(id) || Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        const stored = await loadMetaAsync(id);
        return saveMeta(id, { ...stored, ...patch, id });
      }).catch((error) => {
        warnStorageIssue?.("saveMeta", error);
        return false;
      }).finally(() => {
        if (pendingMetaWrites.get(id) === pending) pendingMetaWrites.delete(id);
      });
      pendingMetaWrites.set(id, pending);
      return pending;
    }
    try { zion?.state?.set(`sessions.meta.${id}`, meta); } catch {}
    try { zion?.state?.set(`sessions.metaLoaded.${id}`, true); } catch {}
    return (async () => {
      try {
        if (typeof onPersist !== "function") {
          throw new Error("durable session storage unavailable");
        }
        await onPersist("meta", id, meta);
        return true;
      } catch (error) {
        try {
          warnStorageIssue?.("saveMeta", error);
        } catch {}
        return false;
      }
    })();
  }

  return { docKey, metaKey, loadDoc, saveDoc, loadDocAsync, loadMeta, loadMetaAsync, saveMeta, invalidate };
}
