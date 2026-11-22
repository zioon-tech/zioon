import { accountError } from "../accounts/account-policy.mjs";

/** Only authoritative membership and document ACLs choose a Memory namespace.
 * A provider's identity or a client-supplied namespace never chooses the drive. */
export async function resolveMemoryScope(access, { principal, sessionId, write = false }) {
  const userId = principal?.userId || principal?.user?.id;
  const spaceId = principal?.spaceId || principal?.space?.id;
  if (!userId || !spaceId) throw accountError(403, "memory_identity_required");
  const documentId = sessionId || principal.documentId || principal.contentScope?.documentId;
  const originSpaceId = principal.contentScope?.originSpaceId || spaceId;
  if (principal.contentScope || documentId && access.sharing && await access.sharing.sharedMemory(originSpaceId, documentId)) {
    if (principal.contentScope && documentId !== principal.contentScope.documentId) throw accountError(403, "content_document_mismatch");
    await access.sharing.documentAccess(userId, originSpaceId, documentId, write ? "edit" : "view");
    return { kind: "document", spaceId: originSpaceId, documentId };
  }
  const space = await access.accounts.space(spaceId);
  if (!space) throw accountError(403, "memory_space_unavailable");
  if (space.kind !== "team") return { kind: "personal", spaceId, userId };
  if (principal.kind === "account" && !principal.explicitSpace) throw accountError(409, "explicit_space_required");
  if (documentId) {
    if (!access.sharedSpaces) throw accountError(503, "shared_memory_authority_unavailable");
    await access.sharedSpaces.requireDocument(userId, spaceId, documentId, write ? "edit" : "view");
    return { kind: "document", spaceId, documentId };
  }
  if (principal.kind !== "account") throw accountError(403, "shared_memory_document_required");
  return { kind: "space", spaceId };
}
