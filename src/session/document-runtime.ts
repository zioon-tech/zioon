import type { EditorProxy } from "../types/zion";
import { beginSessionPresentation } from "./presentation";

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
  getActivePanelId?(): string | null;
  setGlobalSessionId(sessionId: string): void;
  getTargetEditor(panelId?: string | null): EditorProxy | null;
  persistPreviousSession(sessionId: string, editor: EditorProxy | null): void;
  setLastActiveId(sessionId: string, opts?: { push?: boolean }): void;
  loadDocument(sessionId: string): Promise<string> | string;
  applyAnnotations(sessionId: string, panelId?: string | null): unknown | Promise<unknown>;
  restoreUiState?(sessionId: string, panelId?: string | null): unknown | Promise<unknown>;
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

    const presentation = beginSessionPresentation(this.opts.getTargetEditor(targetPanelId));
    let text = "";
    try {
      const loaded = this.opts.loadDocument(id);
      text = loaded && typeof (loaded as Promise<string>)?.then === "function"
        ? await loaded
        : String(loaded || "");
      if (!this.isCurrentSwitch(switchKey, switchToken, id, targetPanelId)) {
        presentation.cancel();
        return false;
      }
    } catch (e) {
      void e;
      presentation.fail(() => { void this.switchSession({ ...switchOpts, skipPersistPrevious: true }); });
      return false;
    }

    const isForeground = !targetPanelId || !this.opts.getActivePanelId
      || this.opts.getActivePanelId() === targetPanelId;
    if (isForeground && switchOpts?.writeUrl !== false) {
      this.opts.setLastActiveId(id, { push: switchOpts?.pushUrl !== false });
    }
    if (isForeground) this.opts.setGlobalSessionId(id);
    const targetEditor = this.opts.getTargetEditor(targetPanelId);
    try { (targetEditor as any)?.setSessionId?.(id); } catch {}
    let currentText: string | undefined;
    try { currentText = targetEditor?.getValue?.(); } catch {}
    const collaborationOwnsDocument =
      (targetEditor as any)?.getView?.()?.dom?.dataset
        ?.zionCollaborationBound === "true";
    if (!collaborationOwnsDocument && currentText !== text) {
      targetEditor?.setValue(text, { source: "session-load" });
    }
    try {
      const restored = this.opts.applyAnnotations(id, targetPanelId);
      if (restored && typeof (restored as Promise<unknown>).then === "function") await restored;
    } catch {
      presentation.fail(() => { void this.switchSession({ ...switchOpts, skipPersistPrevious: true }); });
      return false;
    }

    if (!this.isCurrentSwitch(switchKey, switchToken, id, targetPanelId)) {
      presentation.cancel();
      return false;
    }
    try {
      const viewport = this.opts.restoreUiState?.(id, targetPanelId);
      if (viewport && typeof (viewport as Promise<unknown>).then === "function") await viewport;
    } catch {}
    if (!this.isCurrentSwitch(switchKey, switchToken, id, targetPanelId)) {
      presentation.cancel();
      return false;
    }
    try { this.opts.afterSwitch?.(id, targetPanelId); } catch {}
    await presentation.finish();

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
    if (!panelId) return true;
    return true;
  }
}
