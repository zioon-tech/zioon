export async function removeDeletedSessions({
  zion, ids, getIndex, getLastActiveId, setLastActiveId, openSessionForPanel
}) {
  const deleted = new Set(ids);
  const valid = id => id && !deleted.has(id) && !zion?.state?.get(`sessions.deleted.${id}`)
    && !zion?.state?.get(`sessions.deleting.${id}`);
  const panels = zion?.panelManager?.listPanels?.() || zion?.panels?.list?.() || [];
  const previousCurrent = zion?.state?.get("sessions.currentId");
  const currentWasDeleted = deleted.has(previousCurrent);
  const lastWasDeleted = deleted.has(getLastActiveId());
  const changed = [];
  const switches = [];
  const clearEditor = editor => {
    editor?.setSessionId?.(null);
    editor?.setValue?.("", { source: "session-load" });
  };
  // Remove the complete batch before choosing a replacement tab.
  for (const panel of panels) {
    if (!Array.isArray(panel.tabs)) continue;
    const index = panel.tabs.findIndex(tab => deleted.has(tab.id));
    if (index < 0) continue;
    const activeWasDeleted = deleted.has(panel.activeTabId);
    panel.tabs = panel.tabs.filter(tab => !deleted.has(tab.id));
    changed.push(panel.id);
    if (!activeWasDeleted) continue;
    panel.activeTabId = null;
    clearEditor(zion?.panels?.getEditor?.(panel.id));
    const next = panel.tabs[Math.min(index, panel.tabs.length - 1)]?.id;
    if (valid(next)) switches.push([panel.id, next]);
  }
  if (currentWasDeleted) {
    zion?.state?.set("sessions.currentId", null);
    clearEditor(zion?.window?.activeEditor);
  }
  if (lastWasDeleted) setLastActiveId(null);
  // Retire all cached slots before an asynchronous replacement can become active.
  zion?.panels?.disposeSessionEditors?.(ids);
  for (const [panelId, id] of switches) {
    await openSessionForPanel(panelId, id, {
      focus: zion?.panels?.getActivePanelId?.() === panelId,
      forceReload: true, skipPersistPrevious: true
    });
  }
  if (currentWasDeleted || switches.length) {
    const activePanelId = zion?.panels?.getActivePanelId?.() || null;
    const activePanel = panels.find(panel => panel.id === activePanelId);
    const current = zion?.state?.get("sessions.currentId");
    let next = valid(activePanel?.activeTabId) ? activePanel.activeTabId
      : !currentWasDeleted && valid(previousCurrent) ? previousCurrent
      : valid(current) ? current : getIndex().find(entry => valid(entry.id))?.id || null;
    if (next && activePanel?.activeTabId !== next) {
      const opened = await openSessionForPanel(activePanelId, next, {
        focus: false, forceReload: true, skipPersistPrevious: true
      });
      if (opened === false) next = null;
    }
    zion?.state?.set("sessions.currentId", next);
    setLastActiveId(next);
  } else if (lastWasDeleted) {
    const current = zion?.state?.get("sessions.currentId");
    setLastActiveId(valid(current) ? current : getIndex().find(entry => valid(entry.id))?.id || null);
  }
  for (const panelId of changed) zion?.events?.emit?.("panel/tabsChanged", { panelId });
  return changed.length > 0;
}
