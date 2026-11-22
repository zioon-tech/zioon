import { createHash } from "node:crypto";
import { documentDisplayIdentityInput } from "../../../../packages/runtime-client/src/document-display-identity.mjs";

/** Explicit public display projection; never forward document metadata/settings. */
export const documentReaderPayload = value => value.state === "read" ? ({
  state: "read", title: value.title, markdown: value.markdown, cards: value.cards || { tools: [], thinking: [] },
  contentRevision: value.contentRevision, updatedAt: value.updatedAt, mode: value.mode, role: value.role,
  displayIdentity: `document:${createHash("sha256").update(documentDisplayIdentityInput(value.originSpaceId, value.documentId)).digest("hex")}`
}) : { state: value.state };
