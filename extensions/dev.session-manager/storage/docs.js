export function createSessionDocRepo(opts) {
  const dbName = opts?.dbName;
  const idbGet = opts?.idbGet;
  const idbSet = opts?.idbSet;
  const warnStorageIssue = opts?.warnStorageIssue;
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

  function loadDoc(id) {
    const zion = getZion();
    try {
      const mem = zion?.state?.get(`sessions.doc.${id}`);
      if (typeof mem === "string") return mem;
    } catch {}
    (async () => {
      try {
        const rec = await idbGet(dbName, "docs", id);
        const text = rec?.text || "";
        try { zion?.state?.set(`sessions.doc.${id}`, text); } catch {}
      } catch {}
    })();
    return "";
  }

  function saveDoc(id, text) {
    const zion = getZion();
    (async () => {
      try {
        await idbSet(dbName, "docs", { id, text: String(text || "") });
      } catch (e) {
        try { warnStorageIssue?.("saveDoc", e); } catch {}
      } finally {
        try { zion?.state?.set(`sessions.doc.${id}`, String(text || "")); } catch {}
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
      const rec = await idbGet(dbName, "docs", id);
      const text = rec?.text || "";
      try { zion?.state?.set(`sessions.doc.${id}`, text); } catch {}
      return text;
    } catch {
      return "";
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
        const rec = await idbGet(dbName, "metas", id);
        const meta = rec?.meta || { id, title: `Session ${id}`, createdAt: now(), updatedAt: now(), size: 0, hash: "", titleAuto: true };
        try { zion?.state?.set(`sessions.meta.${id}`, meta); } catch {}
      } catch {}
    })();
    return { id, title: `Session ${id}`, createdAt: now(), updatedAt: now(), size: 0, hash: "", titleAuto: true };
  }

  function saveMeta(id, meta) {
    const zion = getZion();
    (async () => {
      try {
        await idbSet(dbName, "metas", { id, meta });
      } catch (e) {
        try { warnStorageIssue?.("saveMeta", e); } catch {}
      } finally {
        try { zion?.state?.set(`sessions.meta.${id}`, meta); } catch {}
      }
    })();
  }

  return { docKey, metaKey, loadDoc, saveDoc, loadDocAsync, loadMeta, saveMeta };
}
