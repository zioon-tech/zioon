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
  forceReload?: boolean;
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
  restorePanelSession?(panelId: string, sessionId: string): boolean | void;
  syncLegacyEditorTabsState?(panelId: string): void;
  switchSessionDocument?(args: { id: string; panelId: string; previousSessionId: string | null; skipPersistPrevious?: boolean }): unknown | Promise<unknown>;
  emit?(topic: string, payload?: any): void;
};

function debugSessionRuntime(_event: string, _payload?: any): void {
}

export class SessionRuntime implements Disposable {
  private switchSeq = 0;
  private readonly activeSwitches = new Map<string, number>();

  constructor(private readonly opts: SessionRuntimeOptions) {}

  dispose(): void {
    this.activeSwitches.clear();
  }

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
    const editorSessionId =
      typeof (explicitEditor as any)?.sessionId === "string" && (explicitEditor as any).sessionId
        ? (explicitEditor as any).sessionId
        : null;
    const sessionId =
      resolveOpts.sessionId ||
      editorSessionId ||
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
    const editorSessionId = typeof (editor as any)?.sessionId === "string" ? (editor as any).sessionId : null;
    if (editorSessionId) return editorSessionId === sessionId;
    const panelId = typeof (editor as any)?.panelId === "string" ? (editor as any).panelId : null;
    if (panelId) return this.getPanelSessionId(panelId) === sessionId;
    return this.opts.getGlobalSessionId?.() === sessionId;
  }

  async openPanelSession(panelId: string, sessionId: string | null | undefined, openOpts: SwitchPanelSessionOptions = {}): Promise<boolean> {
    if (!sessionId) return false;
    const panel = this.opts.getPanel(panelId);
    if (!panel) return false;
    const exists = panel.tabs.some((tab) => tab.id === sessionId);
    debugSessionRuntime("openPanelSession.start", {
      panelId,
      sessionId,
      exists,
      activeTabId: panel.activeTabId || null,
      tabCount: panel.tabs.length,
      opts: openOpts
    });
    if (!exists) {
      panel.tabs = [...panel.tabs, { id: sessionId, title: sessionId, isDirty: false }];
      try {
        this.opts.emit?.("panel/tabsChanged", { panelId, sessionId });
      } catch {}
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
    const switchToken = ++this.switchSeq;
    this.activeSwitches.set(panelId, switchToken);
    const previousSessionId = panel.activeTabId || null;
    debugSessionRuntime("switchPanelSession.start", {
      panelId,
      previousSessionId,
      sessionId,
      forceReload: !!switchOpts.forceReload,
      skipPersistPrevious: !!switchOpts.skipPersistPrevious,
      focus: switchOpts.focus !== false,
      editorSessionId: (this.opts.getEditor(panelId) as any)?.sessionId || null,
      editorId: (this.opts.getEditor(panelId) as any)?.editorId || null
    });
    if (previousSessionId === sessionId && !switchOpts.forceReload) {
      try { (this.opts.getEditor(panelId) as any)?.setSessionId?.(sessionId); } catch {}
      if (switchOpts.focus !== false) {
        try { this.opts.focusPanel?.(panelId); } catch {}
        try { this.opts.getEditor(panelId)?.focus?.(); } catch {}
      }
      try { this.opts.syncLegacyEditorTabsState?.(panelId); } catch {}
      debugSessionRuntime("switchPanelSession.cachedNoReload", {
        panelId,
        sessionId,
        editorSessionId: (this.opts.getEditor(panelId) as any)?.sessionId || null,
        editorId: (this.opts.getEditor(panelId) as any)?.editorId || null
      });
      return true;
    }

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
    debugSessionRuntime("switchPanelSession.documentSwitched", {
      panelId,
      previousSessionId,
      sessionId,
      documentSwitched,
      activeTabId: this.opts.getPanel(panelId)?.activeTabId || null,
      editorSessionId: (this.opts.getEditor(panelId) as any)?.sessionId || null,
      editorId: (this.opts.getEditor(panelId) as any)?.editorId || null
    });
    if (documentSwitched === false) {
      const isCurrentSwitch = this.activeSwitches.get(panelId) === switchToken;
      if (isCurrentSwitch && this.opts.getPanel(panelId)?.activeTabId === sessionId) {
        if (previousSessionId) {
          let restored = false;
          try {
            restored = this.opts.restorePanelSession?.(panelId, previousSessionId) === true;
          } catch {}
          if (!restored) {
            try { this.opts.activatePanelTab(panelId, previousSessionId); } catch {}
          }
        } else {
          try { panel.activeTabId = null; } catch {}
        }
        try { this.opts.syncLegacyEditorTabsState?.(panelId); } catch {}
      }
      return false;
    }
    if (this.activeSwitches.get(panelId) !== switchToken) {
      return true;
    }
    if (this.opts.getPanel(panelId)?.activeTabId !== sessionId) {
      return true;
    }

    try {
      this.opts.emit?.("session/afterSwitch", {
        panelId,
        previousSessionId,
        sessionId
      });
    } catch {}
    if (switchOpts.focus !== false) {
      try { this.opts.focusPanel?.(panelId); } catch {}
      const focusEditor = () => {
        if (this.opts.getPanel(panelId)?.activeTabId !== sessionId) return;
        try { this.opts.getEditor(panelId)?.focus?.(); } catch {}
      };
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => setTimeout(focusEditor, 0));
      } else {
        focusEditor();
      }
    }

    debugSessionRuntime("switchPanelSession.done", {
      panelId,
      previousSessionId,
      sessionId,
      activeTabId: this.opts.getPanel(panelId)?.activeTabId || null,
      editorSessionId: (this.opts.getEditor(panelId) as any)?.sessionId || null,
      editorId: (this.opts.getEditor(panelId) as any)?.editorId || null
    });
    return true;
  }
}
