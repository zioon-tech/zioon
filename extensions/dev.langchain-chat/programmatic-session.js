export async function projectRunEventToSession(
  zion,
  sessionId,
  event,
  options = {}
) {
  if (!sessionId || !event) return;
  const requestSource = String(options.requestSource || "scheduled-task");
  const payload = {
    runId: event.runId,
    assistantBlockId: event.runId,
    sessionId,
    panelId: null,
    requestSource
  };
  if (event.type === "run.started") {
    await zion.commands.executeCommand("zion.sessions.ensureAssistantBlock", {
      id: sessionId,
      assistantBlockId: event.runId
    });
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: true,
      aborted: false,
      awaiting: false,
      error: false
    });
    zion.events.emit("chat/runStarted", payload);
    return;
  }
  if (event.type === "message.delta") {
    await zion.commands.executeCommand("zion.sessions.appendAssistantToken", {
      id: sessionId,
      token: String(event.data?.delta || ""),
      runId: event.runId,
      assistantBlockId: event.runId
    });
    zion.events.emit("chat/token", {
      ...payload,
      token: String(event.data?.delta || "")
    });
    return;
  }
  if (event.type === "tool.requested") {
    zion.events.emit("chat/toolCall", {
      ...payload,
      toolCall: {
        id: event.data?.callId,
        name: event.data?.name,
        args: event.data?.args || {}
      }
    });
    return;
  }
  if (event.type === "tool.completed" || event.type === "tool.denied") {
    zion.events.emit("chat/toolResult", {
      ...payload,
      toolCallId: event.data?.callId,
      result: event.data?.result || event.data?.error || event.data?.reason || "",
      ok: event.type === "tool.completed" && !event.data?.error
    });
    return;
  }
  if (event.type === "run.completed") {
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: false,
      aborted: false,
      awaiting: true,
      error: false
    });
    zion.events.emit("chat/runFinished", payload);
    return;
  }
  if (event.type === "run.failed") {
    const error = event.data?.error || options.defaultError || "Programmatic run failed";
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: false,
      aborted: false,
      awaiting: false,
      error: true
    });
    zion.events.emit("chat/runError", { ...payload, error });
    zion.events.emit("chat/runFinished", payload);
    return;
  }
  if (event.type === "run.aborted") {
    zion.state?.set?.(`chat.runs.${sessionId}`, {
      runId: event.runId,
      streaming: false,
      aborted: true,
      awaiting: false,
      error: false
    });
    zion.events.emit("chat/aborted", {
      ...payload,
      reason: event.data?.reason || "user"
    });
    zion.events.emit("chat/runFinished", payload);
  }
}

export async function finalizeProgrammaticSession(zion, sessionId, metaPatch = {}) {
  if (!sessionId) return;
  await zion.commands.executeCommand("zion.sessions.transformDoc", {
    id: sessionId,
    transform: (doc) => {
      const text = String(doc || "");
      if (/\nuser\s*$/.test(text)) return text;
      return `${text}${text.endsWith("\n") ? "" : "\n"}user `;
    }
  });
  await zion.commands.executeCommand("zion.sessions.patchMeta", {
    id: sessionId,
    patch: metaPatch
  });
  zion.commands.executeCommand("zion.sessions.bumpUpdatedAt", sessionId);
}
