import type { Extension } from "@codemirror/state";
export function stickyUserHeaderView(options?: {
  prefixes?: string[]; enabled?: () => boolean;
  subscribe?: (callback: () => void) => { dispose(): void };
}): Extension;
