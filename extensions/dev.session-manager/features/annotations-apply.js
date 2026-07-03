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
    zion?.commands?.executeCommand?.("zion.chatCards.restoreSession", {
      sessionId: id,
      panelId: targetPanelId || zion?.panelManager?.getActivePanelId?.() || null,
      annotations: ann,
      clearFirst: false
    });
  } catch (e) {
    console.error("[sessions] apply annotations error:", e);
  }
}
