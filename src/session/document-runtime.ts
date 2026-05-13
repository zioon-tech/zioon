import type { EditorProxy } from "../types/zion";

export type SwitchSessionDocumentOptions = {
  id: string | null | undefined;
  panelId?: string | null;
  previousSessionId?: string | null;
  skipPersistPrevious?: boolean;
  writeUrl?: boolean;
  pushUrl?: boolean;
};

export type SessionDocumentRuntimeOptions = {
  getGlobalSessionId(): string | null;
  getPanelSessionId?(panelId: string): string | null;
  setGlobalSessionId(sessionId: string): void;
  getTargetEditor(panelId?: string | null): EditorProxy | null;
  persistPreviousSession(sessionId: string, editor: EditorProxy | null): void;
  setLastActiveId(sessionId: string, opts?: { push?: boolean }): void;
  loadDocument(sessionId: string): Promise<string> | string;
  applyAnnotations(sessionId: string, panelId?: string | null): void;
  restoreUiState?(sessionId: string, panelId?: string | null): void;
  afterSwitch?(sessionId: string, panelId?: string | null): void;
};

export class SessionDocumentRuntime {
  private switchSeq = 0;
  private readonly activeSwitches = new Map<string, number>();

  constructor(private readonly opts: SessionDocumentRuntimeOptions) {}

  async switchSession(switchOpts: SwitchSessionDocumentOptions): Promise<boolean> {
    const id = switchOpts?.id;
    if (!id) return false;
    const targetPanelId = typeof switchOpts?.panelId === "string" ? switchOpts.panelId : null;
    const switchKey = targetPanelId ? `panel:${targetPanelId}` : "global";
    const switchToken = ++this.switchSeq;
    this.activeSwitches.set(switchKey, switchToken);

    if (!switchOpts?.skipPersistPrevious) {
      const prevPanelSessionId =
        typeof switchOpts?.previousSessionId === "string" && switchOpts.previousSessionId
          ? switchOpts.previousSessionId
          : null;
      const previousSessionId = targetPanelId ? prevPanelSessionId : this.opts.getGlobalSessionId();
      if (previousSessionId && previousSessionId !== id) {
        this.opts.persistPreviousSession(previousSessionId, this.opts.getTargetEditor(targetPanelId));
      }
    }

    if (switchOpts?.writeUrl !== false) {
      this.opts.setLastActiveId(id, { push: switchOpts?.pushUrl !== false });
    }

    this.opts.setGlobalSessionId(id);

    try {
      const text = await this.opts.loadDocument(id);
      if (!this.isCurrentSwitch(switchKey, switchToken, id, targetPanelId)) return false;
      this.opts.getTargetEditor(targetPanelId)?.setValue(text);
      this.opts.applyAnnotations(id, targetPanelId);
    } catch {}

    if (!this.isCurrentSwitch(switchKey, switchToken, id, targetPanelId)) return false;
    try { this.opts.restoreUiState?.(id, targetPanelId); } catch {}
    try { this.opts.afterSwitch?.(id, targetPanelId); } catch {}

    return true;
  }

  private isCurrentSwitch(
    switchKey: string,
    switchToken: number,
    sessionId: string,
    panelId: string | null
  ): boolean {
    if (this.activeSwitches.get(switchKey) !== switchToken) return false;
    if (panelId && typeof this.opts.getPanelSessionId === "function") {
      return this.opts.getPanelSessionId(panelId) === sessionId;
    }
    if (!panelId) {
      return this.opts.getGlobalSessionId() === sessionId;
    }
    return true;
  }
}
