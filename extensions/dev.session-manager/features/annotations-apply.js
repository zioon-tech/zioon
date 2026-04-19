export function applyAnnotationsForSessionImpl(args) {
  const id = args?.id;
  const loadMeta = args?.loadMeta;
  const zion = args?.zion || window.zion;
  const targetPanelId = args?.panelId || null;
  if (!id) return;
  try {
    const meta = loadMeta(id);
    const ann = meta?.annotations;
    if (!ann) return;

    try { zion?.state?.set(`sessions.annotations.${id}`, ann); } catch {}
    const tools = Array.isArray(ann.tools) ? ann.tools : [];
    const thinking = Array.isArray(ann.thinking) ? ann.thinking : [];
    const panelId = targetPanelId || zion?.panelManager?.getActivePanelId?.() || null;
    if (tools.length) {
      try { zion?.state?.set(`sessions.pendingRestore.tools.${id}`, tools); } catch {}
      try { zion?.events?.emit("toolcards/restore", { items: tools, panelId }); } catch {}
    }
    if (thinking.length) {
      try { zion?.state?.set(`sessions.pendingRestore.thinking.${id}`, thinking); } catch {}
      try { zion?.events?.emit("thinking/restore", { items: thinking, panelId }); } catch {}
    }
  } catch (e) {
    console.error("[sessions] apply annotations error:", e);
  }
}
