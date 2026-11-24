// Read the selection when the scan finishes: hydration or a user edit may have
// replaced the catalog while filesystem requests were in flight.
export function selectionAfterSkillScan(previousCatalog, enabled, catalog) {
  const previousIds = new Set(previousCatalog.map(skill => skill.id));
  const catalogIds = new Set(catalog.map(skill => skill.id));
  const next = new Set((Array.isArray(enabled) ? enabled : []).filter(id => catalogIds.has(id)));
  for (const skill of catalog) {
    if (!previousIds.has(skill.id)) next.add(skill.id);
  }
  return [...next];
}
