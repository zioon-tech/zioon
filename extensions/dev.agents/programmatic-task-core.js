export function buildProgrammaticTaskBody(prompt, output) {
  return `user ${String(prompt || "").trim()}\n\nassistant ${String(output || "")}`;
}

export function programmaticEventLogEntry(event) {
  const type = String(event?.type || "");
  if (!type || type === "message.delta" || type === "message.completed") return null;
  const data = event?.data || {};
  const details = type.startsWith("tool.")
    ? [
        String(data.name || "").trim(),
        String(data.error || data.reason || "").trim()
      ].filter(Boolean)
    : [
        String(data.error || data.reason || "").trim()
      ].filter(Boolean);
  return {
    id: String(event?.eventId || "").trim(),
    type,
    ts: Number(event?.ts || Date.now()),
    message: details.join(" · "),
    callId: String(data.callId || "").trim()
  };
}

export function programmaticCompletionState(completion = {}) {
  if (completion.status === "completed") {
    return { status: "done", error: "" };
  }
  if (completion.status === "aborted" && completion.reason === "user") {
    return { status: "aborted", error: "" };
  }
  if (completion.status === "aborted" && completion.reason === "timeout") {
    return { status: "error", error: "运行超时" };
  }
  return {
    status: "error",
    error: String(completion.error || completion.reason || "自动推进失败").trim()
  };
}
