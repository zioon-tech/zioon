import { WidgetType } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
export class ToolCallCardWidget extends WidgetType {
  constructor(id: string, name: string, args: unknown, result: unknown, ok: boolean | null | undefined,
    sessionId?: string | null, action?: string | null, options?: { readOnly?: boolean });
  toDOM(): HTMLElement;
}
export class ToolInlineWidget extends WidgetType {
  constructor(id: string, name: string, args: unknown, ok: boolean | null | undefined, done: boolean,
    action?: string | null, result?: unknown, sessionId?: string | null, options?: { readOnly?: boolean });
  toDOM(): HTMLElement;
}
export function installToolCallCards(): Extension;
export function resolveToolActionTarget(...args: any[]): any;
