export function openEditorConfigPanel(host: any, options?: {
  sessionId?: string; readOnly?: boolean; openAccessPanel?: (sessionId: string) => void;
  mountAppearance?: (panel: HTMLElement, cleanup: Array<() => void>) => void;
}): { dispose(): void } | undefined;
