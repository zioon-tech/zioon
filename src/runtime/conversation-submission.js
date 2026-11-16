// Keep the exact command until admission is known. A later click may contain
// different edits; it must first resolve the earlier command, using its ID.
const pending = new Map();
const inFlight = new Map();

export async function submitConversationInput(client, request, {
  scope, storage = globalThis.sessionStorage, onRecover = () => {}, assertIdentity = () => {}, signal
} = {}) {
  assertIdentity();
  signal?.throwIfAborted();
  const key = `zion.conversation-pending:${scope}:${request.sessionId}`;
  const active = inFlight.get(key);
  if (active) {
    if (!active.cancelled) throw Object.assign(new Error("上一条发送仍在确认中。"), { code: "INPUT_SUBMISSION_PENDING" });
    await active.promise.catch(() => {});
    assertIdentity();
    signal?.throwIfAborted();
  }
  const record = { cancelled: storage?.getItem(`${key}:cancel`) === "1" };
  const cancel = () => {
    record.cancelled = true;
    storage?.setItem(`${key}:cancel`, "1");
  };
  signal?.addEventListener("abort", cancel, { once: true });
  inFlight.set(key, record);
  record.promise = executeSubmission(client, request, { key, storage, onRecover, assertIdentity, signal }, record);
  try {
    return await record.promise;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (inFlight.get(key) === record) inFlight.delete(key);
  }
}

async function executeSubmission(client, request, { key, storage, onRecover, assertIdentity, signal }, record) {
  const saved = pending.get(key) || JSON.parse(storage?.getItem(key) || "null");
  const command = saved || JSON.parse(JSON.stringify(request));
  const previousCancellation = !!saved && record.cancelled;
  if (saved) onRecover(command.conversationInput.clientRequestId);
  // Requests contain model references, never provider credentials.
  storage?.setItem(key, JSON.stringify(command));
  pending.set(key, command);
  const clear = () => {
    storage?.removeItem(key);
    storage?.removeItem(`${key}:cancel`);
    pending.delete(key);
  };
  const finishAccepted = async accepted => {
    assertIdentity();
    if (record.cancelled) {
      try {
        await client.abort(accepted.runId, "cancelled-during-preparation", command.conversationInput.expectedAccount);
      } catch (error) {
        if (error.status !== 409) throw error;
      }
      assertIdentity();
      const run = await client.getRun(accepted.runId);
      assertIdentity();
      if (!["completed", "failed", "aborted", "interrupted"].includes(run.status)) {
        throw Object.assign(new Error("上一条请求正在停止；确认停止后再发送。"), { code: "INPUT_SUBMISSION_CANCELLING" });
      }
      clear();
      throw Object.assign(new Error("上一条发送已停止。"), { name: "AbortError", code: "INPUT_SUBMISSION_CANCELLED" });
    }
    clear();
    return accepted;
  };
  let receiptMissing = false;
  const receipt = async () => {
    assertIdentity();
    receiptMissing = false;
    try {
      const input = await client.getInputReceipt(
        command.sessionId, command.conversationInput.clientRequestId, command.conversationInput.expectedAccount
      );
      assertIdentity();
      if (input.status === "accepted" && input.response) {
        return await finishAccepted(input.response);
      }
      if (input.status === "rejected" || input.status === "expired") {
        clear();
        throw Object.assign(new Error("上一条请求未启动，输入已保留；可重新发送。"), { code: "INPUT_SUBMISSION_REJECTED" });
      }
      return null;
    } catch (error) {
      if (error.status === 404) {
        receiptMissing = true;
        return null;
      }
      throw error;
    }
  };
  if (saved) {
    try {
      const accepted = await receipt();
      if (accepted) return accepted;
    } catch (error) {
      if (previousCancellation && !signal?.aborted
        && ["INPUT_SUBMISSION_CANCELLED", "INPUT_SUBMISSION_REJECTED"].includes(error.code)
        && command.conversationInput.clientRequestId !== request.conversationInput.clientRequestId) {
        record.cancelled = false;
        return executeSubmission(client, request, { key, storage, onRecover, assertIdentity, signal }, record);
      }
      throw error;
    }
    if (previousCancellation) throw Object.assign(
      new Error("上一条停止请求的受理结果尚未确认；再次发送会继续查询回执。"),
      { code: "INPUT_SUBMISSION_UNKNOWN" }
    );
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertIdentity();
    try {
      const accepted = await client.createRun(command);
      return await finishAccepted(accepted);
    } catch (error) {
      if (["INPUT_SUBMISSION_ACCOUNT_CHANGED", "INPUT_SUBMISSION_CANCELLED", "INPUT_SUBMISSION_CANCELLING"].includes(error.code)) throw error;
      const rejected = error.status >= 400 && error.status < 500
        && ![408, 409, 425, 429].includes(error.status)
        && !["INPUT_SUBMISSION_PENDING", "INPUT_ID_CONFLICT"].includes(error.code);
      if (!saved && attempt === 0 && rejected) {
        clear();
        throw error;
      }
      try {
        const accepted = await receipt();
        if (accepted) return accepted;
      } catch (lookupError) {
        if (["INPUT_SUBMISSION_REJECTED", "INPUT_SUBMISSION_ACCOUNT_CHANGED", "INPUT_SUBMISSION_CANCELLED", "INPUT_SUBMISSION_CANCELLING"].includes(lookupError.code)) throw lookupError;
      }
      if (rejected && receiptMissing) {
        clear();
        throw error;
      }
      if (attempt === 1 || record.cancelled) throw Object.assign(
        new Error("发送结果尚未确认。再次发送将恢复这条请求；当前编辑已保留。"),
        { code: "INPUT_SUBMISSION_UNKNOWN", cause: error }
      );
    }
  }
}
