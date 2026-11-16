import { describe, expect, it, vi } from "vitest";
import { submitConversationInput } from "../src/runtime/conversation-submission.js";

const request = (id: string, content = "original") => ({
  sessionId: id, messages: [{ role: "user", content }],
  conversationInput: { schemaVersion: 1, mode: "snapshot", clientRequestId: `${id}:command` }
});
const accepted = { runId: "run", attemptId: "attempt", status: "accepted" };
const store = () => {
  const values = new Map();
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};

describe("conversation submission recovery", () => {
  it("recovers a lost acceptance response without starting another Run", async () => {
    const client = {
      createRun: vi.fn().mockRejectedValue(new TypeError("network lost")),
      getInputReceipt: vi.fn().mockResolvedValue({ status: "accepted", response: accepted })
    };
    const storage = store();
    await expect(submitConversationInput(client, request("lost"), { scope: "a", storage })).resolves.toEqual(accepted);
    expect(client.createRun).toHaveBeenCalledTimes(1);
    expect(storage.getItem("zion.conversation-pending:a:lost")).toBeUndefined();
  });

  it("retries exact captured bytes and recovers before a later edited command", async () => {
    const storage = store();
    const client = {
      createRun: vi.fn().mockRejectedValue(new TypeError("offline")),
      getInputReceipt: vi.fn().mockRejectedValue(Object.assign(new Error(), { status: 404 }))
    };
    await expect(submitConversationInput(client, request("offline"), { scope: "a", storage }))
      .rejects.toMatchObject({ code: "INPUT_SUBMISSION_UNKNOWN" });
    expect(client.createRun).toHaveBeenCalledTimes(2);
    client.createRun.mockResolvedValue(accepted);
    const onRecover = vi.fn();
    await expect(submitConversationInput(client, request("offline", "edited later"), { scope: "a", storage, onRecover }))
      .resolves.toEqual(accepted);
    expect(client.createRun.mock.calls[2][0].messages[0].content).toBe("original");
    expect(onRecover).toHaveBeenCalledWith("offline:command");
  });

  it("uses the persisted command after a page reload", async () => {
    const storage = store();
    storage.setItem("zion.conversation-pending:b:reload", JSON.stringify(request("reload")));
    const client = {
      createRun: vi.fn(), getInputReceipt: vi.fn().mockResolvedValue({ status: "accepted", response: accepted })
    };
    await expect(submitConversationInput(client, request("reload", "new"), { scope: "b", storage })).resolves.toEqual(accepted);
    expect(client.createRun).not.toHaveBeenCalled();
  });

  it("clears a definitively rejected command without automatically sending later edits", async () => {
    const storage = store();
    storage.setItem("zion.conversation-pending:b:rejected", JSON.stringify(request("rejected")));
    const client = {
      createRun: vi.fn(), getInputReceipt: vi.fn().mockResolvedValue({ status: "rejected" })
    };
    await expect(submitConversationInput(client, request("rejected", "new"), { scope: "b", storage }))
      .rejects.toMatchObject({ code: "INPUT_SUBMISSION_REJECTED" });
    expect(client.createRun).not.toHaveBeenCalled();
    expect(storage.getItem("zion.conversation-pending:b:rejected")).toBeUndefined();
  });

  it("never replays another account's pending command", async () => {
    const storage = store();
    storage.setItem("zion.conversation-pending:other:account", JSON.stringify(request("account", "other user")));
    const client = { createRun: vi.fn().mockResolvedValue(accepted), getInputReceipt: vi.fn() };
    await submitConversationInput(client, request("account", "mine"), { scope: "me", storage });
    expect(client.createRun.mock.calls[0][0].messages[0].content).toBe("mine");
    expect(client.getInputReceipt).not.toHaveBeenCalled();
  });

  it("keeps an uncertain command when its retry races an admission lock", async () => {
    const storage = store();
    const client = {
      createRun: vi.fn()
        .mockRejectedValueOnce(new TypeError("lost response"))
        .mockRejectedValueOnce(Object.assign(new Error("Session active"), { status: 409 })),
      getInputReceipt: vi.fn().mockRejectedValue(Object.assign(new Error(), { status: 404 }))
    };
    await expect(submitConversationInput(client, request("race"), { scope: "a", storage }))
      .rejects.toMatchObject({ code: "INPUT_SUBMISSION_UNKNOWN" });
    expect(JSON.parse(storage.getItem("zion.conversation-pending:a:race")).conversationInput.clientRequestId)
      .toBe("race:command");
    client.getInputReceipt.mockResolvedValue({ status: "accepted", response: accepted });
    await expect(submitConversationInput(client, request("race", "edited"), { scope: "a", storage })).resolves.toEqual(accepted);
    expect(client.createRun).toHaveBeenCalledTimes(2);
  });

  it.each([400, 413, 422])("releases a saved command on a confirmed HTTP %s rejection", async status => {
    const storage = store();
    const id = `rejected-${status}`;
    const key = `zion.conversation-pending:a:${id}`;
    storage.setItem(key, JSON.stringify(request(id, "original invalid input")));
    const client = {
      createRun: vi.fn().mockRejectedValue(Object.assign(new Error("Invalid input"), { status })),
      getInputReceipt: vi.fn().mockRejectedValue(Object.assign(new Error(), { status: 404 }))
    };
    await expect(submitConversationInput(client, request(id, "corrected"), { scope: "a", storage }))
      .rejects.toMatchObject({ status });
    expect(client.createRun).toHaveBeenCalledTimes(1);
    expect(client.createRun.mock.calls[0][0].messages[0].content).toBe("original invalid input");
    expect(storage.getItem(key)).toBeUndefined();
    client.createRun.mockResolvedValue(accepted);
    await submitConversationInput(client, request(id, "corrected"), { scope: "a", storage });
    expect(client.createRun.mock.calls[1][0].messages[0].content).toBe("corrected");
  });

  it("stops retry and preserves the old account's pending input when identity changes", async () => {
    const storage = store();
    let actor = "alice";
    const assertIdentity = () => {
      if (actor !== "alice") throw Object.assign(new Error("Account changed"), { code: "INPUT_SUBMISSION_ACCOUNT_CHANGED" });
    };
    const client = {
      createRun: vi.fn().mockImplementation(async () => {
        actor = "bob";
        throw new TypeError("lost before acceptance");
      }),
      getInputReceipt: vi.fn().mockRejectedValue(Object.assign(new Error(), { status: 404 }))
    };
    await expect(submitConversationInput(client, request("identity"), { scope: "alice", storage, assertIdentity }))
      .rejects.toMatchObject({ code: "INPUT_SUBMISSION_ACCOUNT_CHANGED" });
    expect(client.createRun).toHaveBeenCalledTimes(1);
    expect(client.getInputReceipt).not.toHaveBeenCalled();
    expect(storage.getItem("zion.conversation-pending:alice:identity")).toBeDefined();
  });

  it("preserves pending on a server identity mismatch even if browser identity is stale", async () => {
    const storage = store();
    const client = {
      createRun: vi.fn().mockRejectedValue(Object.assign(new Error("Account changed"), {
        status: 403, code: "INPUT_SUBMISSION_ACCOUNT_CHANGED"
      })),
      getInputReceipt: vi.fn()
    };
    await expect(submitConversationInput(client, request("cookie"), { scope: "alice", storage }))
      .rejects.toMatchObject({ code: "INPUT_SUBMISSION_ACCOUNT_CHANGED" });
    expect(client.createRun).toHaveBeenCalledTimes(1);
    expect(client.getInputReceipt).not.toHaveBeenCalled();
    expect(storage.getItem("zion.conversation-pending:alice:cookie")).toBeDefined();
  });

  it("cancels a delayed acceptance before an immediate new submission can own or execute it", async () => {
    const storage = store();
    const controller = new AbortController();
    let release;
    const oldAcceptance = new Promise(resolve => { release = resolve; });
    const client = {
      createRun: vi.fn().mockReturnValueOnce(oldAcceptance).mockResolvedValueOnce({ ...accepted, runId: "new-run" }),
      getInputReceipt: vi.fn(), abort: vi.fn().mockResolvedValue(undefined),
      getRun: vi.fn().mockResolvedValue({ status: "aborted" })
    };
    const old = submitConversationInput(client, request("cancel-owner"), { scope: "a", storage, signal: controller.signal });
    const oldResult = expect(old).rejects.toMatchObject({ code: "INPUT_SUBMISSION_CANCELLED" });
    controller.abort();
    const next = request("cancel-owner", "new text");
    next.conversationInput.clientRequestId = "next-command";
    const fresh = submitConversationInput(client, next, { scope: "a", storage });
    expect(client.createRun).toHaveBeenCalledTimes(1);
    release({ ...accepted, runId: "old-run" });
    await oldResult;
    await expect(fresh).resolves.toMatchObject({ runId: "new-run" });
    expect(client.abort).toHaveBeenCalledTimes(1);
    expect(client.abort).toHaveBeenCalledWith("old-run", "cancelled-during-preparation", undefined);
    expect(client.createRun.mock.calls[1][0].messages[0].content).toBe("new text");
    expect(client.getInputReceipt).not.toHaveBeenCalled();
  });

  it("retains a cancelled unknown receipt and never POSTs it again", async () => {
    const storage = store();
    const controller = new AbortController();
    const client = {
      createRun: vi.fn().mockImplementation(async () => { controller.abort(); throw new TypeError("lost"); }),
      getInputReceipt: vi.fn().mockRejectedValue(Object.assign(new Error(), { status: 404 }))
    };
    const old = request("cancel-unknown");
    await expect(submitConversationInput(client, old, { scope: "a", storage, signal: controller.signal }))
      .rejects.toMatchObject({ code: "INPUT_SUBMISSION_UNKNOWN" });
    const next = request("cancel-unknown", "next");
    next.conversationInput.clientRequestId = "next-command";
    await expect(submitConversationInput(client, next, { scope: "a", storage }))
      .rejects.toMatchObject({ code: "INPUT_SUBMISSION_UNKNOWN" });
    expect(client.createRun).toHaveBeenCalledTimes(1);
    expect(storage.getItem("zion.conversation-pending:a:cancel-unknown:cancel")).toBe("1");
  });

  it("recovers cancellation after reload before sending the explicitly new command", async () => {
    const storage = store();
    storage.setItem("zion.conversation-pending:a:cancel-reload", JSON.stringify(request("cancel-reload")));
    storage.setItem("zion.conversation-pending:a:cancel-reload:cancel", "1");
    const client = {
      getInputReceipt: vi.fn().mockResolvedValue({ status: "accepted", response: { ...accepted, runId: "old-run" } }),
      abort: vi.fn().mockResolvedValue(undefined), getRun: vi.fn().mockResolvedValue({ status: "aborted" }),
      createRun: vi.fn().mockResolvedValue({ ...accepted, runId: "new-run" })
    };
    const next = request("cancel-reload", "new text");
    next.conversationInput.clientRequestId = "new-command";
    await expect(submitConversationInput(client, next, { scope: "a", storage })).resolves.toMatchObject({ runId: "new-run" });
    expect(client.createRun.mock.calls[0][0].messages[0].content).toBe("new text");
    expect(storage.getItem("zion.conversation-pending:a:cancel-reload:cancel")).toBeUndefined();
  });

  it("keeps the previous owner's lock until the accepted Run actually stops", async () => {
    const storage = store();
    const key = "zion.conversation-pending:a:cancel-active";
    storage.setItem(key, JSON.stringify(request("cancel-active")));
    storage.setItem(`${key}:cancel`, "1");
    const client = {
      getInputReceipt: vi.fn().mockResolvedValue({ status: "accepted", response: { ...accepted, runId: "old-run" } }),
      abort: vi.fn().mockResolvedValue(undefined), getRun: vi.fn().mockResolvedValue({ status: "running" }),
      createRun: vi.fn().mockResolvedValue({ ...accepted, runId: "new-run" })
    };
    const next = request("cancel-active", "new text");
    next.conversationInput.clientRequestId = "new-command";
    await expect(submitConversationInput(client, next, { scope: "a", storage }))
      .rejects.toMatchObject({ code: "INPUT_SUBMISSION_CANCELLING" });
    expect(storage.getItem(key)).toBeDefined();
    expect(client.createRun).not.toHaveBeenCalled();
    client.getRun.mockResolvedValue({ status: "aborted" });
    await expect(submitConversationInput(client, next, { scope: "a", storage }))
      .resolves.toMatchObject({ runId: "new-run" });
    expect(client.createRun).toHaveBeenCalledTimes(1);
    expect(client.abort.mock.calls.every(call => call[0] === "old-run")).toBe(true);
  });
});
