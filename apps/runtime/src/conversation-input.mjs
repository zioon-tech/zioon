import { createHash } from "node:crypto";

const TRANSIENT_METADATA = new Set([
  "chatSubmission", "chatAdmission", "documentProjection",
  "panelId", "workbenchClientId"
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined)
      .map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function conversationRequestFingerprint(request) {
  const metadata = Object.fromEntries(Object.entries(request.metadata || {})
    .filter(([key]) => !TRANSIENT_METADATA.has(key)));
  return createHash("sha256").update(JSON.stringify(canonical({
    messages: request.messages,
    contextMessages: request.sessionHistory || request.messages,
    model: request.model,
    modelOptions: request.modelOptions,
    policy: request.policy,
    target: request.target,
    interactionProfileId: request.interactionProfileId,
    projectId: request.projectId,
    maxTurns: request.maxTurns,
    timeoutMs: request.timeoutMs,
    metadata
  }))).digest("hex");
}

export function conversationInputCommand(body) {
  if (body.conversationInput == null) return null;
  const input = body.conversationInput;
  if (input?.schemaVersion !== 1 || input.mode !== "snapshot") {
    throw Object.assign(new Error("Unsupported conversation input snapshot"), { statusCode: 400 });
  }
  const clientRequestId = String(input.clientRequestId || "").trim();
  if (!clientRequestId || clientRequestId.length > 200) {
    throw Object.assign(new Error("A clientRequestId of 1–200 characters is required"), { statusCode: 400 });
  }
  if (!String(body.sessionId || "").trim()) {
    throw Object.assign(new Error("A conversation Session is required"), { statusCode: 400 });
  }
  return {
    clientRequestId,
    ...(input.parentInputId ? { parentInputId: String(input.parentInputId) } : {}),
    ...(input.expectedAccount != null ? { expectedAccount: input.expectedAccount } : {})
  };
}

export function assertConversationInputAccount(expected, principal) {
  if (expected == null) return;
  if (!expected || typeof expected.userId !== "string" || !expected.userId
    || typeof expected.spaceId !== "string" || !expected.spaceId
    || expected.userId.length > 200 || expected.spaceId.length > 200) {
    throw Object.assign(new Error("Invalid expected conversation account"), { statusCode: 400 });
  }
  if (expected.userId !== String(principal?.user?.id || principal?.userId || "")
    || expected.spaceId !== String(principal?.space?.id || principal?.spaceId || "")) {
    throw Object.assign(new Error("账户已变化，旧请求已保留；请返回原账户确认。"), {
      statusCode: 403, code: "INPUT_SUBMISSION_ACCOUNT_CHANGED"
    });
  }
}

/**
 * Explicit context is a complete version, including edits and truncation.
 * It is never silently appended to the canonical history of another version.
 * Call only with normalized messages from the trusted HTTP admission boundary.
 */
export function createConversationInputSnapshot({
  id, sessionId, command, request, principalId = "", createdAt = Date.now()
}) {
  if (!Array.isArray(request.messages) || !request.messages.length) {
    throw Object.assign(new Error("A conversation input requires messages"), { statusCode: 400 });
  }
  return structuredClone({
    schemaVersion: 1,
    id,
    sessionId,
    principalId,
    clientRequestId: command.clientRequestId,
    parentInputId: command.parentInputId || null,
    fingerprint: conversationRequestFingerprint(request),
    contextMessages: request.sessionHistory || request.messages,
    messages: request.messages,
    model: request.model || null,
    modelOptions: request.modelOptions || null,
    policy: request.policy,
    createdAt
  });
}

export function snapshotContextMessages(snapshot, { sequence = 0 } = {}) {
  return (snapshot.contextMessages || []).map((message, index) => ({
    ...structuredClone(message),
    schemaVersion: 1,
    id: `input:${snapshot.id}:${index + 1}`,
    sessionId: snapshot.sessionId,
    inputSnapshotId: snapshot.id,
    sequence: sequence + index + 1,
    createdAt: snapshot.createdAt,
    provenance: "submitted-context"
  }));
}
