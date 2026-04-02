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
    saveDoc(id, String(text || ""));
    const meta = loadMeta(id);
    meta.size = String(text || "").length;
    meta.hash = hashString(String(text || ""));
    saveMeta(id, meta);
    const cur = zion.state.get("sessions.currentId");
    if (cur === id) {
      try { zion.window.activeEditor?.setValue(String(text || "")); } catch {}
    }
    return true;
  });
  const dAppendToken = zion.commands.registerCommand("zion.sessions.appendAssistantToken", ({ id, token }) => {
    if (!id || token == null) return false;
    const doc = loadDoc(id);
    const lines = doc.split("\n");
    let assistantLine = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*assistant\s+/.test(lines[i])) { assistantLine = i; break; }
    }
    if (assistantLine === -1) {
      const head = (doc.endsWith("\n") || doc.length === 0) ? "assistant " : "\nassistant ";
      const newDoc = doc + head + String(token);
      zion.commands.executeCommand("zion.sessions.setDoc", { id, text: newDoc });
      return true;
    }
    let endLine = assistantLine;
    for (let i = assistantLine + 1; i < lines.length; i++) {
      if (/^\s*(system|user|assistant|tool)\s+/.test(lines[i])) break;
      endLine = i;
    }
    lines[endLine] = (lines[endLine] || "") + String(token);
    const newDoc = lines.join("\n");
    zion.commands.executeCommand("zion.sessions.setDoc", { id, text: newDoc });
    return true;
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

  return [dGetDoc, dGetMeta, dSetDoc, dAppendToken, dBumpUpdated];
}

