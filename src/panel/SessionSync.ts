import type { EditorProxy } from "../types/zion";


type Disposable = { dispose(): void };

type EventBusLike = {
  on(event: string, handler: (payload: any) => void): Disposable;
};

type SessionSyncOptions = {
  events: EventBusLike;
  getActivePanelId: () => string | null;
  listPanels: () => Array<{ id: string; activeTabId: string | null }>;
  getEditor: (panelId: string) => EditorProxy | null;
};

export class SessionSync {
  private syncingPanels = new Set<string>();
  private disp: Disposable | null = null;
  private opts: SessionSyncOptions;

  constructor(opts: SessionSyncOptions) {
    this.opts = opts;
    this.disp = opts.events.on("editor.change", (payload) => {
      this.syncFromPanel(payload?.panelId || null);
    });
  }

  dispose(): void {
    try { this.disp?.dispose?.(); } catch {}
    this.disp = null;
    this.syncingPanels.clear();
  }

  syncFromPanel(sourcePanelId: string | null): void {
    if (!sourcePanelId) {
      sourcePanelId = this.opts.getActivePanelId();
    }
    if (!sourcePanelId || this.syncingPanels.has(sourcePanelId)) return;

    const sourcePanel = this.opts.listPanels().find((panel) => panel.id === sourcePanelId);
    const sourceSessionId = sourcePanel?.activeTabId || null;
    // #region debug-point widget-lifecycle
    try { fetch("http://127.0.0.1:7777/event", { method: "POST", body: JSON.stringify({ sessionId: "widget-lifecycle", runId: "pre-fix", hypothesisId: "H2", location: "src/panel/SessionSync.ts", msg: "[DEBUG] sessionSync.source", data: { sourcePanelId, sourceSessionId, panels: this.opts.listPanels() }, ts: Date.now() }) }).catch(() => {}); } catch {}
    // #endregion
    if (!sourceSessionId) return;

    const sourceEditor = this.opts.getEditor(sourcePanelId);
    if (!sourceEditor) return;
    const nextText = String(sourceEditor.getValue?.() || "");

    for (const panel of this.opts.listPanels()) {
      if (panel.id === sourcePanelId) continue;
      if (panel.activeTabId !== sourceSessionId) continue;
      const targetEditor = this.opts.getEditor(panel.id);
      if (!targetEditor) continue;
      if (String(targetEditor.getValue?.() || "") === nextText) continue;

      try {
        this.syncingPanels.add(panel.id);
        const view = targetEditor.getView?.();
        if (view) {
          const currentText = String(view.state.doc?.toString?.() || "");
          const change = buildTextChange(currentText, nextText);
          view.dispatch({
            changes: change
          });
          // #region debug-point widget-lifecycle
          try { fetch("http://127.0.0.1:7777/event", { method: "POST", body: JSON.stringify({ sessionId: "widget-lifecycle", runId: "pre-fix", hypothesisId: "H2", location: "src/panel/SessionSync.ts", msg: "[DEBUG] sessionSync.dispatched", data: { sourcePanelId, targetPanelId: panel.id, sourceSessionId, change, currentLength: currentText.length, nextLength: nextText.length }, ts: Date.now() }) }).catch(() => {}); } catch {}
          // #endregion
        } else {
          targetEditor.setValue(nextText);
          // #region debug-point widget-lifecycle
          try { fetch("http://127.0.0.1:7777/event", { method: "POST", body: JSON.stringify({ sessionId: "widget-lifecycle", runId: "pre-fix", hypothesisId: "H2", location: "src/panel/SessionSync.ts", msg: "[DEBUG] sessionSync.setValue", data: { sourcePanelId, targetPanelId: panel.id, sourceSessionId, nextLength: nextText.length }, ts: Date.now() }) }).catch(() => {}); } catch {}
          // #endregion
        }
      } catch {
      } finally {
        this.syncingPanels.delete(panel.id);
      }
    }
  }
}

function buildTextChange(currentText: string, nextText: string) {
  if (currentText === nextText) {
    return { from: 0, to: 0, insert: "" };
  }

  let prefix = 0;
  const maxPrefix = Math.min(currentText.length, nextText.length);
  while (prefix < maxPrefix && currentText[prefix] === nextText[prefix]) {
    prefix += 1;
  }

  let currentSuffix = currentText.length;
  let nextSuffix = nextText.length;
  while (
    currentSuffix > prefix &&
    nextSuffix > prefix &&
    currentText[currentSuffix - 1] === nextText[nextSuffix - 1]
  ) {
    currentSuffix -= 1;
    nextSuffix -= 1;
  }

  return {
    from: prefix,
    to: currentSuffix,
    insert: nextText.slice(prefix, nextSuffix)
  };
}
