import type { ConversationSearchOptions, ConversationSearchMatch } from "../../src/editor/search-panel";
export function createConversationSearchController(ctx: { subscriptions: Array<{ dispose(): void }> },
  host: unknown, options?: { readOnly?: boolean; idPrefix?: string; translate?: (key: string, fallback: string) => string;
    matches?: (query: string, options: ConversationSearchOptions) => { ranges: ConversationSearchMatch[]; invalid: boolean };
  }): { show(): void; hide(): void; refresh(): void; readonly panel: HTMLElement | null; dispose(): void };
export function activate(ctx: unknown): unknown;
