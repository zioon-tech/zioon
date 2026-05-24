export function appendAssistantTokenToDoc(doc, token) {
  const lines = String(doc || "").split("\n");
  let assistantLine = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*assistant\s+/.test(lines[i])) { assistantLine = i; break; }
  }
  if (assistantLine === -1) {
    const head = (String(doc || "").endsWith("\n") || String(doc || "").length === 0) ? "assistant " : "\nassistant ";
    return String(doc || "") + head + String(token);
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

  const enqueueDocWrite = (id, task) => {
    if (!id || typeof task !== "function") return Promise.resolve(false);
    const prev = docQueues.get(id) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (docQueues.get(id) === next) docQueues.delete(id);
      });
    docQueues.set(id, next);
    return next;
  };

  const applyDocText = (id, text) => {
    const nextText = String(text || "");
    saveDoc(id, nextText);
    const meta = loadMeta(id);
    meta.size = nextText.length;
    meta.hash = hashString(nextText);
    saveMeta(id, meta);
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
    if (isOpenInPanel) return true;
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
    return true;
  };

  const dGetDoc = zion.commands.registerCommand("zion.sessions.getDoc", (id) => {
    if (!id) return "";
    return loadDoc(id);
  });
  const dGetMeta = zion.commands.registerCommand("zion.sessions.getMeta", (id) => {
    if (!id) return null;
    return loadMeta(id);
  });
  const dSetDoc = zion.commands.registerCommand("zion.sessions.setDoc", ({ id, text }) => {
    if (!id) return false;
    return enqueueDocWrite(id, () => applyDocText(id, text));
  });
  const dTransformDoc = zion.commands.registerCommand("zion.sessions.transformDoc", ({ id, transform }) => {
    if (!id || typeof transform !== "function") return false;
    return enqueueDocWrite(id, () => {
      const current = loadDoc(id);
      const next = transform(current);
      if (next == null) return false;
      return applyDocText(id, String(next));
    });
  });
  const dAppendToken = zion.commands.registerCommand("zion.sessions.appendAssistantToken", ({ id, token }) => {
    if (!id || token == null) return false;
    return enqueueDocWrite(id, () => {
      const doc = loadDoc(id);
      const next = appendAssistantTokenToDoc(doc, token);
      return applyDocText(id, next);
    });
  });
  const dBumpUpdated = zion.commands.registerCommand("zion.sessions.bumpUpdatedAt", (id) => {
    if (!id) return false;
    const meta = loadMeta(id);
    meta.updatedAt = now();
    meta.size = loadDoc(id).length;
    meta.hash = hashString(loadDoc(id));
    saveMeta(id, meta);
    upsertIndexEntry({ id, title: meta.title, updatedAt: meta.updatedAt, size: meta.size, hash: meta.hash, createdAt: meta.createdAt });
    zion.state.set("sessions.catalog", getIndex());
    try { refreshSessionsSidebarViewIfOpen?.(); } catch {}
    return true;
  });

  return [dGetDoc, dGetMeta, dSetDoc, dTransformDoc, dAppendToken, dBumpUpdated];
}
