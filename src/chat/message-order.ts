function getToolCallIds(message: any): string[] {
  if (!message || message.role !== "assistant" || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls
    .map((toolCall: any) => String(toolCall?.id || ""))
    .filter(Boolean);
}

/**
 * OpenAI-compatible chat APIs require every assistant.tool_calls message to be
 * followed directly by the matching tool messages. Contributors may inject
 * context messages after assembly, so repair accidental interleaving before the
 * provider request is built.
 */
export function repairToolCallMessageOrder(messages: any[]): any[] {
  if (!Array.isArray(messages) || messages.length < 2) return messages;

  const out: any[] = [];
  let changed = false;

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const requiredIds = getToolCallIds(message);
    if (!requiredIds.length) {
      out.push(message);
      continue;
    }

    out.push(message);
    const remaining = new Set(requiredIds);
    const toolMessages: any[] = [];
    const delayedMessages: any[] = [];
    let j = i + 1;

    for (; j < messages.length && remaining.size > 0; j += 1) {
      const next = messages[j];
      const toolCallId = next?.role === "tool" ? String(next?.tool_call_id || "") : "";
      if (toolCallId && remaining.has(toolCallId)) {
        toolMessages.push(next);
        remaining.delete(toolCallId);
      } else {
        delayedMessages.push(next);
      }
    }

    if (remaining.size === 0) {
      if (delayedMessages.length > 0) changed = true;
      out.push(...toolMessages, ...delayedMessages);
      i = j - 1;
      continue;
    }

    out.push(...delayedMessages);
    i = j - 1;
  }

  return changed ? out : messages;
}
