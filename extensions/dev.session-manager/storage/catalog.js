export function catalogResponseIsCurrent(response, requestGeneration, currentGeneration, eventCursor) {
  return requestGeneration === currentGeneration
    && Number(response?.event_cursor) >= eventCursor;
}

export function hydrateSessionCatalog(catalog, {
  state, durableIds, revisions, invalidate, hasPending = () => false,
  isOpen = () => false
}) {
  if (!Array.isArray(catalog?.sessions) || !Array.isArray(catalog?.metas)) {
    throw new Error("Invalid session catalog");
  }
  const previousIds = new Set(durableIds);
  const staleIds = new Set(catalog.sessions.filter(item =>
    (revisions.get(String(item.id)) || 0) > (Number(item.session_revision) || 0)
  ).map(item => String(item.id)));
  const refreshIds = [];
  if (catalog.metadataPartial) {
    for (const entry of catalog.index || []) {
      if (!entry?.id || hasPending(entry.id) || staleIds.has(entry.id)) continue;
      const existing = state.get(`sessions.summary.${entry.id}`) || {};
      state.set(`sessions.summary.${entry.id}`, { ...existing, ...entry });
    }
  }
  for (const item of catalog.sessions) {
    const id = String(item?.id || "");
    if (!id) continue;
    durableIds.add(id);
    previousIds.delete(id);
    const revision = Number(item.session_revision) || 0;
    const previousRevision = revisions.get(id);
    if (hasPending(id) || previousRevision > revision) continue;
    if (previousRevision !== undefined && previousRevision !== revision) {
      if (isOpen(id)) refreshIds.push(id);
      else invalidate(id);
    }
    if (!refreshIds.includes(id)) revisions.set(id, revision);
  }
  for (const item of catalog.metas) {
    const id = String(item?.id || "");
    if (!id || hasPending(id) || staleIds.has(id)) continue;
    if (!state.get(`sessions.meta.${id}`)) state.set(`sessions.metaLoaded.${id}`, false);
    state.set(`sessions.summary.${id}`, { ...item.meta, id });
  }
  for (const id of previousIds) {
    if (hasPending(id)) continue;
    invalidate(id);
    state.set(`sessions.summary.${id}`, undefined);
    revisions.delete(id);
    durableIds.delete(id);
  }
  if (!hasPending("tree")) {
    if (catalog.tree?.type === "folder") state.set("sessions.treeMem", catalog.tree);
    state.set("sessions.indexMem", Array.isArray(catalog.index) ? catalog.index : []);
    state.set("sessions.catalog", Array.isArray(catalog.index) ? catalog.index : []);
  }
  state.set("sessions.metaReady", true);
  return refreshIds;
}
