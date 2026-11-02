function systemMessage(payload) {
  if (payload?.system != null) {
    return { role: "system", content: payload.system };
  }
  if (payload?.systemInstruction != null) {
    return {
      role: "system",
      content: payload.systemInstruction?.parts
        ?? payload.systemInstruction
    };
  }
  return null;
}

export function extractRequestMessages(payload = {}) {
  const system = systemMessage(payload);
  if (Array.isArray(payload?.messages)) {
    const hasSystem = payload.messages.some((message) =>
      String(message?.role || "") === "system"
    );
    return [
      ...(!hasSystem && system ? [system] : []),
      ...payload.messages
    ];
  }
  if (Array.isArray(payload?.contents)) {
    return [
      ...(system ? [system] : []),
      ...payload.contents.map((message) => ({
        ...message,
        role: message?.role === "model"
          ? "assistant"
          : String(message?.role || "unknown"),
        content: message?.content ?? message?.parts ?? ""
      }))
    ];
  }
  return system ? [system] : [];
}
