const navigationId = globalThis.crypto?.randomUUID?.() || `page-${Date.now().toString(36)}`;
const marks: Array<{ name: string; ms: number; panelId?: string }> = [];

export function workbenchNavigationId() { return navigationId; }
export function markWorkbenchStage(name: string, panelId?: string) {
  const value = { name, ms: Math.round(performance.now() * 10) / 10, ...(panelId ? { panelId } : {}) };
  marks.push(value);
  if (marks.length > 64) marks.shift();
  try {
    globalThis.window?.zion?.state?.set("workbench.performance", { navigationId, stages: [...marks] });
    performance.mark(`zion.${name}`, { detail: { navigationId, panelId } });
  } catch {}
}
