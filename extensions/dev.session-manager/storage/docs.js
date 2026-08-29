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

  function loadDoc(id) {
    const zion = getZion();
    try {
      const mem = zion?.state?.get(`sessions.doc.${id}`);
      if (typeof mem === "string") return mem;
    } catch {}
    (async () => {
      try {
        const rec = await onLoad?.(id);
        const text = rec?.text || "";
        try { zion?.state?.set(`sessions.doc.${id}`, text); } catch {}
      } catch (e) {
        if (!isMissingSession(e)) {
          try { warnStorageIssue?.("loadDoc", e); } catch {}
        }
      }
    })();
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
      const rec = await onLoad?.(id);
      const text = rec?.text || "";
      try { zion?.state?.set(`sessions.doc.${id}`, text); } catch {}
      return text;
    } catch (e) {
      if (!isMissingSession(e)) {
        try { warnStorageIssue?.("loadDocAsync", e); } catch {}
      }
      throw e;
    }
  }

  async function loadMetaAsync(id) {
    const zion = getZion();
    let mem = null;
    try {
      const value = zion?.state?.get(`sessions.meta.${id}`);
      if (value && typeof value === "object") mem = value;
    } catch {}
    try {
      const rec = await onLoad?.(id);
      const stored = rec?.meta && typeof rec.meta === "object" ? rec.meta : null;
      const base = stored || mem || { id, title: `Session ${id}`, createdAt: now(), updatedAt: now(), size: 0, hash: "", titleAuto: true };
      const meta = { ...base, id };
      if (stored && mem && typeof mem === "object") {
        for (const [key, value] of Object.entries(mem)) {
          if (!(key in meta)) meta[key] = value;
        }
      }
      try { zion?.state?.set(`sessions.meta.${id}`, meta); } catch {}
      return meta;
    } catch (e) {
      if (!isMissingSession(e)) {
        try { warnStorageIssue?.("loadMetaAsync", e); } catch {}
      }
      if (mem) return mem;
      throw e;
    }
  }

  function loadMeta(id) {
    const zion = getZion();
    try {
      const mem = zion?.state?.get(`sessions.meta.${id}`);
      if (mem && typeof mem === "object") return mem;
    } catch {}
    (async () => {
      try {
        const rec = await onLoad?.(id);
        const meta = rec?.meta || { id, title: `Session ${id}`, createdAt: now(), updatedAt: now(), size: 0, hash: "", titleAuto: true };
        try { zion?.state?.set(`sessions.meta.${id}`, meta); } catch {}
      } catch (e) {
        if (!isMissingSession(e)) {
          try { warnStorageIssue?.("loadMeta", e); } catch {}
        }
      }
    })();
    return { id, title: `Session ${id}`, createdAt: now(), updatedAt: now(), size: 0, hash: "", titleAuto: true };
  }

  function saveMeta(id, meta) {
    const zion = getZion();
    try { zion?.state?.set(`sessions.meta.${id}`, meta); } catch {}
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

  return { docKey, metaKey, loadDoc, saveDoc, loadDocAsync, loadMeta, loadMetaAsync, saveMeta };
}
