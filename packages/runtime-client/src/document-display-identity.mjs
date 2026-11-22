/** The same opaque document identity in native and shared reading surfaces. */
export const documentDisplayIdentityInput = (spaceId, documentId) =>
  JSON.stringify(["zion.document.v1", spaceId, documentId]);
export async function documentDisplayIdentity(spaceId, documentId) {
  const bytes = new TextEncoder().encode(documentDisplayIdentityInput(spaceId, documentId));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `document:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
