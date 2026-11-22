export type PublicAnchor = {
  kind: "tools" | "thinking"; id: string | null; name: string; from: number; to: number; assistantBlockId?: string | null;
};
export function publicDocumentAnchors(markdown: string): PublicAnchor[];
export function projectPublicCards(markdown: string, annotations: unknown): { tools: unknown[]; thinking: unknown[] };
