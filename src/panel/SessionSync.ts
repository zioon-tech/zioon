import type { EditorProxy } from "../types/zion";
import { Transaction } from "@codemirror/state";


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

const SESSION_SYNC_USER_EVENT = "zion.sessionSync";

export class SessionSync {
  private syncingPanels = new Set<string>();
  private disp: Disposable | null = null;
  private opts: SessionSyncOptions;

  constructor(opts: SessionSyncOptions) {
    this.opts = opts;
    this.disp = opts.events.on("editor.change", (payload) => {
      if (isIgnoredChange(payload?.update)) return;
      this.syncFromPanel(payload?.panelId || null, payload?.view || null, payload?.update || null);
    });
  }

  dispose(): void {
    try { this.disp?.dispose?.(); } catch {}
    this.disp = null;
    this.syncingPanels.clear();
  }

  syncFromPanel(sourcePanelId: string | null, sourceView: any = null, sourceUpdate: any = null): void {
    if (!sourcePanelId) {
      sourcePanelId = this.opts.getActivePanelId();
    }
    if (!sourcePanelId || this.syncingPanels.has(sourcePanelId)) return;

    const panels = this.opts.listPanels();
    const sourcePanel = panels.find((panel) => panel.id === sourcePanelId);
    const sourceViewSessionId = getViewSessionId(sourceView);
    const sourceSessionId = sourceViewSessionId || sourcePanel?.activeTabId || null;
    if (!sourceSessionId) return;

    const sourceEditor = this.opts.getEditor(sourcePanelId);
    if (!sourceEditor && !sourceView) return;
    const sourceDoc = sourceUpdate?.state?.doc || sourceView?.state?.doc || null;
    const sourceStartDoc = sourceUpdate?.startState?.doc || null;
    const sourceChanges = sourceUpdate?.changes || null;
    let nextText: string | null = null;
    const readNextText = () => {
      if (nextText == null) {
        nextText = sourceDoc
          ? String(sourceDoc.toString?.() || "")
          : String(sourceEditor?.getValue?.() || "");
      }
      return nextText;
    };

    for (const panel of panels) {
      if (panel.id === sourcePanelId) continue;
      if (panel.activeTabId !== sourceSessionId) continue;
      const targetEditor = this.opts.getEditor(panel.id);
      if (!targetEditor) continue;
      const targetView = targetEditor.getView?.();
      const targetViewSessionId = getViewSessionId(targetView);
      if (targetViewSessionId && targetViewSessionId !== sourceSessionId) {
        // The panel says it is on this session, but the active editor view is bound elsewhere.
        // Skipping avoids copying text across session-bound views during tab transitions.
        continue;
      }

      try {
        this.syncingPanels.add(panel.id);
        if (
          targetView &&
          sourceChanges &&
          sourceStartDoc &&
          docsEqual(targetView.state?.doc, sourceStartDoc)
        ) {
          targetView.dispatch({
            changes: sourceChanges,
            annotations: Transaction.userEvent.of(SESSION_SYNC_USER_EVENT)
          });
          continue;
        }

        const targetText = String(targetEditor.getValue?.() || "");
        const resolvedNextText = readNextText();
        if (targetText === resolvedNextText) continue;
        if (targetView) {
          const change = buildTextChange(targetText, resolvedNextText);
          targetView.dispatch({
            changes: change,
            annotations: Transaction.userEvent.of(SESSION_SYNC_USER_EVENT)
          });
        } else {
          targetEditor.setValue(resolvedNextText);
        }
      } catch {
      } finally {
        this.syncingPanels.delete(panel.id);
      }
    }
  }
}

function docsEqual(left: any, right: any): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length !== right.length) return false;
  try {
    if (typeof left.eq === "function") return left.eq(right);
    if (typeof right.eq === "function") return right.eq(left);
  } catch {}
  return false;
}

function getViewSessionId(view: any): string | null {
  try {
    return view?.dom?.getAttribute?.("data-session-id") || null;
  } catch {
    return null;
  }
}

function isIgnoredChange(update: any): boolean {
  try {
    return !!update?.transactions?.some?.((tr: any) => {
      const userEvent = tr?.annotation?.(Transaction.userEvent);
        return userEvent === "zion.sessionLoad"
          || userEvent === "zion.cardRestore"
          || userEvent === SESSION_SYNC_USER_EVENT;
    });
  } catch {
    return false;
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
