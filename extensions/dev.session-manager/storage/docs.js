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
      } catch (e) {
        try { warnStorageIssue?.("loadDoc", e); } catch {}
      }
    })();
    return "";
  }

  function saveDoc(id, text) {
    const zion = getZion();
    const nextText = String(text || "");
    let previous;
    try { previous = zion?.state?.get(`sessions.doc.${id}`); } catch {}
    try { zion?.state?.set(`sessions.doc.${id}`, nextText); } catch {}
    (async () => {
      try {
        await idbSet(dbName, "docs", { id, text: nextText });
      } catch (e) {
        try {
          if (zion?.state?.get(`sessions.doc.${id}`) === nextText) {
            zion?.state?.set(`sessions.doc.${id}`, previous);
          }
        } catch {}
        try { warnStorageIssue?.("saveDoc", e); } catch {}
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
    } catch (e) {
      try { warnStorageIssue?.("loadDocAsync", e); } catch {}
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
        const rec = await idbGet(dbName, "metas", id);
        const meta = rec?.meta || { id, title: `Session ${id}`, createdAt: now(), updatedAt: now(), size: 0, hash: "", titleAuto: true };
        try { zion?.state?.set(`sessions.meta.${id}`, meta); } catch {}
      } catch (e) {
        try { warnStorageIssue?.("loadMeta", e); } catch {}
      }
    })();
    return { id, title: `Session ${id}`, createdAt: now(), updatedAt: now(), size: 0, hash: "", titleAuto: true };
  }

  function saveMeta(id, meta) {
    const zion = getZion();
    let previous;
    try { previous = zion?.state?.get(`sessions.meta.${id}`); } catch {}
    try { zion?.state?.set(`sessions.meta.${id}`, meta); } catch {}
    (async () => {
      try {
        await idbSet(dbName, "metas", { id, meta });
      } catch (e) {
        try {
          if (zion?.state?.get(`sessions.meta.${id}`) === meta) {
            zion?.state?.set(`sessions.meta.${id}`, previous);
          }
        } catch {}
        try { warnStorageIssue?.("saveMeta", e); } catch {}
      }
    })();
  }

  return { docKey, metaKey, loadDoc, saveDoc, loadDocAsync, loadMeta, saveMeta };
}
