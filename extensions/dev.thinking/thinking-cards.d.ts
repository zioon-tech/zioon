import { EditorView, WidgetType } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
export class ThinkingCardWidget extends WidgetType {
  constructor(id: string, text?: string, options?: { readOnly?: boolean });
  toDOM(): HTMLElement;
}
export class ThinkingInlineWidget extends WidgetType {
  constructor(id: string, options?: { readOnly?: boolean });
  toDOM(view: EditorView): HTMLElement;
}
export function installThinkingCards(): Extension;
