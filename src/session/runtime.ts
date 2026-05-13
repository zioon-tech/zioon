import type { Disposable, EditorProxy } from "../types/zion";

export type SessionPanelRecord = {
  id: string;
  activeTabId: string | null;
  tabs: Array<{ id: string; title?: string; isDirty?: boolean }>;
  editor?: EditorProxy | null;
};

export type ResolveSessionContextOptions = {
  panelId?: string | null;
  sessionId?: string | null;
  editor?: EditorProxy | null;
};

export type SessionContext = {
  panelId: string | null;
  sessionId: string | null;
  editor: EditorProxy | null;
  panel: SessionPanelRecord | null;
};

export type SwitchPanelSessionOptions = {
  focus?: boolean;
  skipPersistPrevious?: boolean;
};

export type SessionRuntimeOptions = {
  getActivePanelId(): string | null;
  getPanel(panelId: string): SessionPanelRecord | null;
  listPanels(): SessionPanelRecord[];
  getEditor(panelId: string): EditorProxy | null;
  getActiveEditor?(): EditorProxy | null;
  getGlobalSessionId?(): string | null;
  focusPanel?(panelId: string): void;
  activatePanelTab(panelId: string, sessionId: string): void;
  syncLegacyEditorTabsState?(panelId: string): void;
  switchSessionDocument?(args: { id: string; panelId: string; previousSessionId: string | null; skipPersistPrevious?: boolean }): void | Promise<unknown>;
  emit?(topic: string, payload?: any): void;
};

export class SessionRuntime implements Disposable {
  constructor(private readonly opts: SessionRuntimeOptions) {}

  dispose(): void {}

  getPanelSessionId(panelId: string | null | undefined): string | null {
    if (!panelId) return null;
    return this.opts.getPanel(panelId)?.activeTabId || null;
  }

  getPanelEditor(panelId: string | null | undefined): EditorProxy | null {
    if (!panelId) return null;
    return this.opts.getEditor(panelId) || null;
  }

  listPanelContexts(): SessionContext[] {
    return this.opts.listPanels().map((panel) => ({
      panelId: panel.id,
      sessionId: panel.activeTabId || null,
      editor: this.opts.getEditor(panel.id) || panel.editor || null,
      panel
    }));
  }

  resolveContext(resolveOpts: ResolveSessionContextOptions = {}): SessionContext {
    const explicitEditor = resolveOpts.editor || null;
    const editorPanelId = typeof (explicitEditor as any)?.panelId === "string" ? (explicitEditor as any).panelId : null;
    const panelId =
      resolveOpts.panelId ||
      editorPanelId ||
      this.opts.getActivePanelId() ||
      null;
    const panel = panelId ? this.opts.getPanel(panelId) : null;
    const sessionId =
      resolveOpts.sessionId ||
      panel?.activeTabId ||
      (!panelId ? this.opts.getGlobalSessionId?.() || null : null);
    const editor =
      explicitEditor ||
      (panelId ? this.opts.getEditor(panelId) : null) ||
      this.opts.getActiveEditor?.() ||
      null;

    return {
      panelId,
      sessionId: sessionId || null,
      editor,
      panel
    };
  }

  isEditorShowingSession(editor: EditorProxy | null | undefined, sessionId: string | null | undefined): boolean {
    if (!editor || !sessionId) return false;
    const panelId = typeof (editor as any)?.panelId === "string" ? (editor as any).panelId : null;
    if (panelId) return this.getPanelSessionId(panelId) === sessionId;
    return this.opts.getGlobalSessionId?.() === sessionId;
  }

  async openPanelSession(panelId: string, sessionId: string | null | undefined, openOpts: SwitchPanelSessionOptions = {}): Promise<boolean> {
    if (!sessionId) return false;
    const panel = this.opts.getPanel(panelId);
    if (!panel) return false;
    const exists = panel.tabs.some((tab) => tab.id === sessionId);
    if (!exists) {
      panel.tabs = [...panel.tabs, { id: sessionId, title: sessionId, isDirty: false }];
    }
    if (openOpts.focus !== false) {
      try { this.opts.focusPanel?.(panelId); } catch {}
    }
    return this.switchPanelSession(panelId, sessionId, openOpts);
  }

  async switchPanelSession(panelId: string, sessionId: string | null | undefined, switchOpts: SwitchPanelSessionOptions = {}): Promise<boolean> {
    if (!sessionId) return false;
    const panel = this.opts.getPanel(panelId);
    if (!panel) return false;
    const previousSessionId = panel.activeTabId || null;

    try {
      this.opts.emit?.("session/beforeSwitch", {
        panelId,
        previousSessionId,
        sessionId
      });
    } catch {}

    this.opts.activatePanelTab(panelId, sessionId);
    try { this.opts.syncLegacyEditorTabsState?.(panelId); } catch {}

    const documentSwitched = await (async () => {
      try {
        return await this.opts.switchSessionDocument?.({
          id: sessionId,
          panelId,
          previousSessionId,
          skipPersistPrevious: switchOpts.skipPersistPrevious
        });
      } catch {
        return false;
      }
    })();
    if (documentSwitched === false) return false;

    try {
      this.opts.emit?.("session/afterSwitch", {
        panelId,
        previousSessionId,
        sessionId
      });
    } catch {}

    return true;
  }
}
