import {
  assistantBlockHeaderText,
  findAssistantBlockEndOffsetById
} from "../../../src/chat/restore";

export function ensureAssistantBlockInDoc(doc, assistantBlockId) {
  const src = String(doc || "");
  if (!assistantBlockId || findAssistantBlockEndOffsetById(src, assistantBlockId) != null) return src;
  const prefix = src.length === 0 || src.endsWith("\n") ? "" : "\n";
  return `${src}${prefix}${assistantBlockHeaderText(assistantBlockId)}`;
}

export function appendAssistantTokenToDoc(doc, token, assistantBlockId = null) {
  const src = String(doc || "");
  if (assistantBlockId) {
    const insertPos = findAssistantBlockEndOffsetById(src, assistantBlockId);
    if (insertPos == null) return src;
    return `${src.slice(0, insertPos)}${String(token)}${src.slice(insertPos)}`;
  }
  const lines = src.split("\n");
  let assistantLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*assistant\s+/.test(lines[i])) { assistantLine = i; break; }
  }
  if (assistantLine === -1) {
      const head = (src.endsWith("\n") || src.length === 0) ? "assistant " : "\nassistant ";
      return src + head + String(token);
  }
  let endLine = assistantLine;
  for (let i = assistantLine + 1; i < lines.length; i++) {
    if (/^\s*(system|user|assistant|tool)\s+/.test(lines[i])) break;
    endLine = i;
  }
  lines[endLine] = (lines[endLine] || "") + String(token);
  return lines.join("\n");
}

function dispatchMinimalDocUpdate(editor, nextText) {
  const view = editor?.getView?.();
  const currentText = String(editor?.getValue?.() ?? view?.state?.doc?.toString?.() ?? "");
  if (currentText === nextText) return true;
  if (!view?.state?.doc || typeof view.dispatch !== "function") {
    editor?.setValue?.(nextText, { source: "session-load" });
    return false;
  }

  let prefix = 0;
  const maxPrefix = Math.min(currentText.length, nextText.length);
  while (prefix < maxPrefix && currentText.charCodeAt(prefix) === nextText.charCodeAt(prefix)) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(currentText.length - prefix, nextText.length - prefix);
  while (
    suffix < maxSuffix &&
    currentText.charCodeAt(currentText.length - 1 - suffix) === nextText.charCodeAt(nextText.length - 1 - suffix)
  ) {
    suffix++;
  }

  view.dispatch({
    changes: {
      from: prefix,
      to: currentText.length - suffix,
      insert: nextText.slice(prefix, nextText.length - suffix)
    }
  });
  return true;
}

export function registerSessionDocCommands(opts) {
  const zion = opts?.zion || window.zion;
  const loadDoc = opts?.loadDoc;
  const loadDocAsync = opts?.loadDocAsync || loadDoc;
  const loadMetaAsync = opts?.loadMetaAsync;
  const loadMeta = opts?.loadMeta;
  const saveDoc = opts?.saveDoc;
  const saveMeta = opts?.saveMeta;
  const now = opts?.now;
  const hashString = opts?.hashString;
  const upsertIndexEntry = opts?.upsertIndexEntry;
  const getIndex = opts?.getIndex;
  const refreshSessionsSidebarViewIfOpen = opts?.refreshSessionsSidebarViewIfOpen;
  const onDocChanged = opts?.onDocChanged;
  const docQueues = new Map();
  const isUnavailable = id => !id || zion?.state?.get?.(`sessions.deleted.${id}`)
    || zion?.state?.get?.(`sessions.deleting.${id}`);

  const enqueueDocWrite = (id, task) => {
    if (!id || typeof task !== "function") return Promise.resolve(false);
    const prev = docQueues.get(id) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => isUnavailable(id) ? false : task())
      .finally(() => {
        if (docQueues.get(id) === next) docQueues.delete(id);
      });
    docQueues.set(id, next);
    // Legacy callers may fire-and-forget; awaiting callers still receive failures.
    void next.catch(() => {});
    return next;
  };

  const applyDocText = async (id, text) => {
    if (isUnavailable(id)) return false;
    const meta = await (loadMetaAsync || loadMeta)(id);
    if (isUnavailable(id)) return false;
    const nextText = String(text || "");
    const saved = saveDoc(id, nextText);
    meta.size = nextText.length;
    meta.hash = hashString(nextText);
    const metaSaved = saveMeta(id, meta);
    const committed = Promise.all([saved, metaSaved]).then((results) => {
      if (results.includes(false)) throw new Error("Session write is pending durable storage");
      return true;
    });
    try { onDocChanged?.(id, nextText, meta); } catch {}
    const updatedEditors = new Set();
    try {
      const panelsApi = zion.panels || zion.panelManager;
      const editorEntries = panelsApi?.listEditors?.() || [];
      for (const entry of Array.isArray(editorEntries) ? editorEntries : []) {
        if (entry?.sessionId !== id || !entry?.panelId) continue;
        const editor = panelsApi?.getEditorBySession?.(entry.panelId, id) || null;
        if (!editor || updatedEditors.has(editor)) continue;
        updatedEditors.add(editor);
        dispatchMinimalDocUpdate(editor, nextText);
      }
    } catch {}
    const isOpenInPanel = (() => {
      try {
        const panelsApi = zion.panels || zion.panelManager;
        const panels = panelsApi?.list?.() || panelsApi?.listPanels?.() || [];
        return Array.isArray(panels) && panels.some((panel) => panel?.activeTabId === id || panel?.tabs?.some?.((tab) => tab?.id === id));
      } catch {
        return false;
      }
    })();
    if (isOpenInPanel) return committed;
    const cur = zion.state.get("sessions.currentId");
    if (cur === id) {
      try {
        const activeEditor = zion.window.activeEditor || null;
        const editorSessionId = activeEditor?.getView?.()?.dom?.getAttribute?.("data-session-id")
          || activeEditor?.getSessionId?.()
          || activeEditor?.core?.getSessionId?.()
          || null;
        if (editorSessionId === id) dispatchMinimalDocUpdate(activeEditor, nextText);
      } catch {}
    }
    return committed;
  };

  const dGetDoc = zion.commands.registerCommand("zion.sessions.getDoc", (id) => {
    if (!id) return "";
    return loadDoc(id);
  });
  const dGetDocAsync = zion.commands.registerCommand("zion.sessions.getDocAsync", async (id) => {
    if (!id) return "";
    if (typeof opts?.loadDocAsync === "function") return opts.loadDocAsync(id);
    return loadDoc(id);
  });
  const dGetMeta = zion.commands.registerCommand("zion.sessions.getMeta", (id) => {
    if (!id) return null;
    return loadMeta(id);
  });
    const dGetMetaAsync = zion.commands.registerCommand("zion.sessions.getMetaAsync", async (id) => {
      if (!id) return null;
      if (typeof loadMetaAsync === "function") return loadMetaAsync(id);
      return loadMeta(id);
    });
  const dPatchMeta = zion.commands.registerCommand("zion.sessions.patchMeta", ({ id, patch, updater } = {}) => {
    if (!id) return null;
    return enqueueDocWrite(id, async () => {
      const current = await (loadMetaAsync || loadMeta)(id);
      if (isUnavailable(id)) return false;
      const base = JSON.parse(JSON.stringify(current));
      const candidate = typeof updater === "function" ? updater(current) : { ...current, ...(patch || {}) };
      if (!candidate || typeof candidate !== "object") return null;
      const next = { ...candidate, id };
      if (await saveMeta(id, next, { base }) === false) throw new Error("Session metadata write failed");
      return next;
    });
  });
  const dSetDoc = zion.commands.registerCommand("zion.sessions.setDoc", ({ id, text }) => {
    if (!id) return false;
    return enqueueDocWrite(id, () => applyDocText(id, text));
  });
  const dTransformDoc = zion.commands.registerCommand("zion.sessions.transformDoc", ({ id, transform }) => {
    if (!id || typeof transform !== "function") return false;
    return enqueueDocWrite(id, async () => {
      const current = await loadDocAsync(id);
      const next = transform(current);
      if (next == null) return false;
      return applyDocText(id, String(next));
    });
  });
    const dEnsureAssistant = zion.commands.registerCommand("zion.sessions.ensureAssistantBlock", ({ id, assistantBlockId }) => {
      if (!id || !assistantBlockId) return false;
      return enqueueDocWrite(id, async () => {
        const doc = await loadDocAsync(id);
        const next = ensureAssistantBlockInDoc(doc, assistantBlockId);
        return applyDocText(id, next);
      });
    });
    const dAppendToken = zion.commands.registerCommand("zion.sessions.appendAssistantToken", ({ id, token, assistantBlockId }) => {
    if (!id || token == null) return false;
    return enqueueDocWrite(id, async () => {
      const doc = await loadDocAsync(id);
      if (isUnavailable(id)) return false;
      if (isUnavailable(id)) return false;
        const next = appendAssistantTokenToDoc(doc, token, assistantBlockId);
      return applyDocText(id, next);
    });
  });
  const dBumpUpdated = zion.commands.registerCommand("zion.sessions.bumpUpdatedAt", (id) => {
    if (!id) return false;
    return enqueueDocWrite(id, async () => {
      const text = await loadDocAsync(id);
      const meta = await (loadMetaAsync || loadMeta)(id);
      if (isUnavailable(id)) return false;
      meta.updatedAt = now();
      meta.size = text.length;
      meta.hash = hashString(text);
      if (await saveMeta(id, meta) === false) throw new Error("Session metadata write failed");
      upsertIndexEntry({ id, title: meta.title, updatedAt: meta.updatedAt, size: meta.size, hash: meta.hash, createdAt: meta.createdAt });
      zion.state.set("sessions.catalog", getIndex());
      try { refreshSessionsSidebarViewIfOpen?.(); } catch {}
      return true;
    });
  });

      return [dGetDoc, dGetDocAsync, dGetMeta, dGetMetaAsync, dPatchMeta, dSetDoc, dTransformDoc, dEnsureAssistant, dAppendToken, dBumpUpdated];
}
