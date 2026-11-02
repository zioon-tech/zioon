import type { EditorProxy as IEditorProxy } from "../types/zion";
import type { EditorCore, EditorSetValueOptions } from "./EditorCore";
import type { Extension } from "@codemirror/state";

export class EditorProxy implements IEditorProxy {
  public panelId: string | null;

  constructor(private core: EditorCore, panelId?: string | null) {
    this.panelId = panelId ?? null;
    if (panelId) this.core.setPanelId(panelId);
  }

  setCore(core: EditorCore): void {
    this.core = core;
    if (this.panelId) this.core.setPanelId(this.panelId);
  }

  setPanelId(panelId: string | null): void {
    this.panelId = panelId;
    if (panelId) this.core.setPanelId(panelId);
  }

  get editorId(): string {
    return this.core.getEditorId();
  }

  get sessionId(): string | null {
    return this.core.getSessionId();
  }

  setSessionId(sessionId: string | null): void {
    this.core.setSessionId(sessionId);
  }

  getValue(): string {
    return this.core.getValue();
  }

  setValue(v: string, opts?: EditorSetValueOptions): void {
    this.core.setValue(v, opts);
  }

  replaceSelection(text: string): void {
    this.core.replaceSelection(text);
  }

  getSelection(): string {
    return this.core.getSelection();
  }

  replaceRange(text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }): void {
    this.core.replaceRange(text, from, to);
  }

  getCursor(): { line: number; ch: number } {
    return this.core.getCursor();
  }

  setCursor(pos: { line: number; ch: number }): void {
    this.core.setCursor(pos);
  }

  focus(): void {
    this.core.focus();
  }

  // Extensions can add CM6 visual extensions via EditorCore
  addVisualExtension(ext: Extension): void {
    (this.core as any).addExternalExtension(ext);
  }

  // Expose raw CM6 EditorView for advanced extensions
  getView(): any {
    return (this.core as any).view;
  }
}
