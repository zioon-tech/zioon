export function createAnnotationsLifecycle(opts) {
  const dbName = opts?.dbName;
  const idbGet = opts?.idbGet;
  const loadMeta = opts?.loadMeta;
  const saveMeta = opts?.saveMeta;
  const now = opts?.now;
  const getZion = () => {
    try {
      const v = opts?.getZion?.();
      if (v) return v;
    } catch {}
    return window.zion;
  };

  function getAnnotationsState(id) {
    try {
      return getZion()?.commands?.executeCommand?.("zion.chatCards.getSessionAnnotations", id) || null;
    } catch {
      return null;
    }
  }

  function persistCurrentAnnotations() {
    try {
      const id = getZion()?.state?.get("sessions.currentId");
      if (!id) return;
      const meta = loadMeta(id);
      const ann = getAnnotationsState(id) || meta.annotations;
      if (ann) {
        meta.annotations = ann;
        saveMeta(id, meta);
      }
    } catch (e) {
      console.warn("[sessions] persistCurrentAnnotations error:", e);
    }
  }

  function attachLifecyclePersistence(ctx) {
    try {
      const handler = () => {
        try { persistCurrentAnnotations(); } catch {}
      };
      const visHandler = () => {
        try { if (document.hidden) handler(); } catch {}
      };
      window.addEventListener("beforeunload", handler);
      window.addEventListener("pagehide", handler);
      window.addEventListener("blur", handler);
      document.addEventListener("visibilitychange", visHandler);
      ctx.subscriptions.push({
        dispose() {
          try { window.removeEventListener("beforeunload", handler); } catch {}
          try { window.removeEventListener("pagehide", handler); } catch {}
          try { window.removeEventListener("blur", handler); } catch {}
          try { document.removeEventListener("visibilitychange", visHandler); } catch {}
        }
      });
    } catch (e) {
      console.warn("[sessions] attachLifecyclePersistence error:", e);
    }
  }

  function attachLifecycleRestore(ctx) {
    try {
      let lastHidden = typeof document?.hidden === "boolean" ? document.hidden : false;
      let timer = null;
      let running = false;
      let queued = false;
      const schedule = () => {
        try {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            if (running) { queued = true; return; }
            running = true;
            Promise.resolve()
              .then(() => doRestore())
              .finally(() => {
                running = false;
                if (queued) {
                  queued = false;
                  schedule();
                }
              });
          }, 80);
        } catch {}
      };
      const listRestoreTargets = () => {
        try {
          const panels = getZion()?.panels?.list?.();
          if (Array.isArray(panels) && panels.length) {
            return panels
              .map((panel) => ({
                panelId: typeof panel?.id === "string" ? panel.id : null,
                sessionId: typeof panel?.activeTabId === "string" ? panel.activeTabId : null
              }))
              .filter((item) => !!item.panelId && !!item.sessionId);
          }
        } catch {}
        try {
          const id = getZion()?.state?.get("sessions.currentId");
          if (id) return [{ panelId: null, sessionId: id }];
        } catch {}
        return [];
      };
      const loadAnnotations = async (id) => {
        let ann = null;
        try {
          const rec = await idbGet(dbName, "metas", id);
          const meta = rec?.meta;
          if (meta && meta.annotations) {
            ann = meta.annotations;
            try { getZion()?.state?.set(`sessions.meta.${id}`, meta); } catch {}
          }
        } catch {}
        if (!ann) {
          try { ann = getZion()?.commands?.executeCommand?.("zion.chatCards.getSessionAnnotations", id) || null; } catch {}
        }
        return ann;
      };
      const doRestore = async () => {
        try {
          const targets = listRestoreTargets();
          if (!targets.length) return;
          const cache = new Map();
          for (const target of targets) {
            const id = target?.sessionId;
            if (!id) continue;
            let ann = cache.get(id);
            if (ann === undefined) {
              ann = await loadAnnotations(id);
              cache.set(id, ann || null);
            }
            if (!ann) continue;
            try {
              getZion()?.commands?.executeCommand?.("zion.chatCards.restoreSession", {
                sessionId: id,
                panelId: target.panelId,
                annotations: ann
              });
            } catch {}
          }
        } catch {}
      };
      const onPageShow = () => { schedule(); };
      const onVisible = () => {
        try {
          const nowHidden = !!document.hidden;
          const becameVisible = lastHidden && !nowHidden;
          lastHidden = nowHidden;
          if (becameVisible) schedule();
        } catch {}
      };
      const onFocus = () => { schedule(); };
      const onResume = () => { schedule(); };
      window.addEventListener("pageshow", onPageShow);
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVisible);
      document.addEventListener("resume", onResume);
      ctx.subscriptions.push({
        dispose() {
          try { window.removeEventListener("pageshow", onPageShow); } catch {}
          try { window.removeEventListener("focus", onFocus); } catch {}
          try { document.removeEventListener("visibilitychange", onVisible); } catch {}
          try { document.removeEventListener("resume", onResume); } catch {}
          try { if (timer) clearTimeout(timer); } catch {}
        }
      });
    } catch (e) {
      console.warn("[sessions] attachLifecycleRestore error:", e);
    }
  }

  function attachAnnotationsAutoPersistence(ctx) {
    let curId = null;
    let dispAnn = null;
    let dispCur = null;
    let timer = null;
    let lastJson = "";

    const clearTimer = () => {
      if (timer) {
        try { clearTimeout(timer); } catch {}
        timer = null;
      }
    };

    const persist = async (id) => {
      try {
        const ann = getAnnotationsState(id);
        if (!ann) return;
        let json = "";
        try { json = JSON.stringify(ann); } catch { json = ""; }
        if (json && json === lastJson) return;
        if (json) lastJson = json;

        let meta = null;
        try {
          const mem = getZion()?.state?.get(`sessions.meta.${id}`);
          if (mem && typeof mem === "object") meta = mem;
        } catch {}

        if (!meta || typeof meta !== "object") {
          try {
            const rec = await idbGet(dbName, "metas", id);
            if (rec && rec.meta && typeof rec.meta === "object") meta = rec.meta;
          } catch {}
        }

        if (!meta || typeof meta !== "object") {
          meta = { id, title: `Session ${id}`, createdAt: now(), updatedAt: now(), size: 0, hash: "", titleAuto: true };
        } else {
          meta = { ...meta };
        }

        meta.annotations = ann;
        saveMeta(id, meta);
      } catch (e) {
        try { console.warn("[sessions] auto persist annotations error:", e); } catch {}
      }
    };

    const schedule = (id) => {
      if (!id) return;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        persist(id);
      }, 800);
    };

    const setWatch = (id) => {
      if (id === curId) return;
      curId = id || null;
      lastJson = "";
      try { dispAnn?.dispose?.(); } catch {}
      dispAnn = null;
      if (!curId) return;
      try {
        dispAnn = getZion()?.state?.onDidChange(`sessions.annotations.${curId}`, () => schedule(curId));
      } catch {
        dispAnn = null;
      }
      schedule(curId);
    };

    try {
      const initial = getZion()?.state?.get("sessions.currentId");
      setWatch(typeof initial === "string" ? initial : null);
    } catch {}

    try {
      dispCur = getZion()?.state?.onDidChange("sessions.currentId", (nv, ov) => {
        const prev = typeof ov === "string" ? ov : null;
        if (prev) schedule(prev);
        setWatch(typeof nv === "string" ? nv : null);
      });
    } catch {
      dispCur = null;
    }

    ctx.subscriptions.push({
      dispose() {
        clearTimer();
        try { dispAnn?.dispose?.(); } catch {}
        try { dispCur?.dispose?.(); } catch {}
      }
    });
  }

  return {
    getAnnotationsState,
    persistCurrentAnnotations,
    attachLifecyclePersistence,
    attachLifecycleRestore,
    attachAnnotationsAutoPersistence
  };
}
