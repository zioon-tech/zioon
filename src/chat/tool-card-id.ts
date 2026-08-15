function encodeIdPart(value: unknown): string {
  return encodeURIComponent(String(value || "").trim());
}

/**
 * Provider tool-call ids are only guaranteed to correlate a call and result
 * within one model turn. Card ids live for the whole session, so scope them by
 * run while preserving the provider id separately.
 */
export function createToolCardId(runId: unknown, toolCallId: unknown): string {
  const callId = String(toolCallId || "").trim();
  if (!callId) return "";
  const rid = String(runId || "").trim();
  if (!rid) return callId;
  return `tool:${encodeIdPart(rid)}:${encodeIdPart(callId)}`;
}

export function resolveToolCardId(payload: any): string {
  const toolCall = payload?.toolCall || payload || {};
  const explicit = String(payload?.cardId || toolCall?.cardId || "").trim();
  if (explicit) return explicit;
  const toolCallId = toolCall?.id ?? payload?.toolCallId ?? payload?.id;
  return createToolCardId(payload?.runId, toolCallId);
}
