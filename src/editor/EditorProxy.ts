import type { EditorProxy as IEditorProxy } from "../types/zion";
import type { EditorCore } from "./EditorCore";
import type { Extension } from "@codemirror/state";

export class EditorProxy implements IEditorProxy {
  constructor(private core: EditorCore) {}

  getValue(): string {
    return this.core.getValue();
  }

  setValue(v: string): void {
    this.core.setValue(v);
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
}