export function createConversationOutlineController(ctx: { subscriptions: Array<{ dispose(): void }> },
  host: unknown, options?: { readOnly?: boolean; translate?: (key: string, fallback: string) => string }): {
    toggle(): void; isOpen(): boolean; dispose(): void;
  };
export function activate(ctx: unknown): unknown;
export function deactivate(): void;
