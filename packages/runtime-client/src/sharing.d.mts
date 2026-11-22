export type Share = {
  id: string; kind: "model" | "document" | "folder"; name: string; sourceId: string;
  originSpaceId: string; role: "use" | "viewer" | "editor"; status: string;
  owner: { id: string; name: string }; expiresAt: number | null; monthlyCalls?: number;
  recipients?: Array<{ id: string; name: string; role: "use" | "viewer" | "editor"; status: string }>;
  invitations?: Array<{ id: string; status: string; claims: number; maxClaims: number; expiresAt: number }>;
  usage?: Record<string, any>;
};
export function sharingToken(value: string): string;
export type DocumentLink = { id: string; mode: "restricted" | "public" | "disabled"; url: string; revision: number };
export type DocumentAccessRequest = { id: string; userId: string; name: string; role: "viewer" | "editor";
  message: string; status: "pending" | "approved" | "rejected"; updatedAt: number };
export type DocumentParticipant = {
  id: string; name: string; role: "owner" | "editor" | "viewer"; inherited: boolean; online: boolean | null;
  visitor?: boolean;
  grants?: Array<{ shareId: string; kind: "document" | "folder"; sourceId: string; name: string; role: "viewer" | "editor" }>;
};
export type SharedContentNode = {
  id: string; type: "session" | "folder"; title: string; originSpaceId: string; providerName: string;
  shareId: string; role: "viewer" | "editor"; updatedAt?: number; children?: SharedContentNode[];
};
export function createSharingClient(options: {
  baseUrl: string; headers?: HeadersInit; fetchImpl?: typeof fetch; signal?: AbortSignal;
}): {
  list(direction?: string): Promise<{ shares: Share[] }>;
  sources(): Promise<{ sources: Array<Record<string, any>> }>;
  content(): Promise<{ received: SharedContentNode[]; sentIds: string[] }>;
  create(body: Record<string, any>): Promise<{ share: Share; invitation?: { url: string; expiresAt: number };
    recipient?: { id: string; name: string; role: string } }>;
  resolveRecipient(recipient: string): Promise<{ recipient: { id: string; name: string } }>;
  addRecipient(id: string, body: { recipient: string; role?: string }): Promise<any>;
  updateRecipient(id: string, recipientId: string, role: string): Promise<any>;
  updateDocumentCollaborator(id: string, recipientId: string, role: "viewer" | "editor" | "removed"): Promise<any>;
  updateSourceCollaborator(kind: "model" | "folder", sourceId: string, recipientId: string, role: string): Promise<any>;
  preview(token: string): Promise<{ share: Share; inviteExpiresAt: number }>;
  accept(token: string): Promise<{ share: Share }>;
  invite(id: string, body?: Record<string, any>): Promise<{ invitation: { url: string; expiresAt: number } }>;
  revoke(id: string, body?: Record<string, any>): Promise<any>;
  leave(id: string): Promise<any>;
  documents(id: string): Promise<{ share: Share; tree: any }>;
  participants(id: string, originSpaceId?: string): Promise<{
    documentId: string; title?: string; originSpaceId: string; selfId: string; participants: DocumentParticipant[];
    visitors?: DocumentParticipant[]; selfVisitorId?: string | null;
  }>;
  documentPrivacy(id: string): Promise<{ private: boolean; sharedContent: boolean }>;
  documentLink(id: string): Promise<{ link: DocumentLink | null }>;
  setDocumentLink(id: string, mode: DocumentLink["mode"]): Promise<{ link: DocumentLink }>;
  accessRequests(id: string): Promise<{ requests: DocumentAccessRequest[] }>;
  decideAccess(id: string, requestId: string, status: "approved" | "rejected", role?: "viewer" | "editor"): Promise<any>;
  openLink(id: string): Promise<{ documentId: string; originSpaceId: string; title: string; role: "owner" | "viewer" | "editor" }>;
  privacy(id: string, value: boolean): Promise<any>;
};
