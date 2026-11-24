function scheduleAutoRename(run) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1500 });
  else setTimeout(run, 800);
}

export function createChatAutoRenameTrigger({
  getZion = () => globalThis.window?.zion,
  loadMeta,
  saveMeta,
  getLatestSessionText,
  isMeaningfulAutoRenameContent,
  now = Date.now,
  schedule = scheduleAutoRename
}) {
  const pending = new Set();
  return function trigger(id) {
    if (!id || pending.has(id)) return false;
    try {
      const zion = getZion();
      if (zion?.state?.get(`sessions.deleted.${id}`)
        || zion?.state?.get(`sessions.deleting.${id}`)) return false;
      try { zion.commands.executeCommand("zion.sessions.flushPendingSave", id); } catch {}
      const meta = loadMeta(id);
      // An old timestamp may belong to a failed call. Only an active local
      // request blocks retry; a generated or manual title has titleAuto=false.
      if (!meta || meta.titleAuto !== true) return false;
      if (!isMeaningfulAutoRenameContent(getLatestSessionText(id))) return false;
      const triggeredAt = now();
      const model = zion.state.get(`chat.runs.${id}`)?.model
        || zion.state.get("chat.activeModel") || null;
      const activeModel = model ? { ...model } : null;
      pending.add(id);
      meta.autoRenameChatTriggeredAt = triggeredAt;
      saveMeta(id, meta);
      try { zion.state.set(`sessions.meta.${id}`, meta); } catch {}
      schedule(async () => {
        let renamed = false;
        try {
          renamed = await zion.commands.executeCommand("zion.sessions.autoRename", {
            id, activeModel, onlyIfAuto: true, silent: true, reason: "chat-run-finished"
          }) === true;
        } catch {}
        finally {
          pending.delete(id);
          if (!renamed) {
            try {
              const current = loadMeta(id);
              if (current?.titleAuto === true && current.autoRenameChatTriggeredAt === triggeredAt) {
                delete current.autoRenameChatTriggeredAt;
                saveMeta(id, current);
                zion.state.set(`sessions.meta.${id}`, current);
              }
            } catch {}
          }
        }
      });
      return true;
    } catch {
      pending.delete(id);
      return false;
    }
  };
}
