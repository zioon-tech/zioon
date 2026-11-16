import { describe, expect, it, vi } from "vitest";
import { authorizeCollaborationSends } from "../src/collaboration-service.mjs";

describe("collaboration outbound authorization", () => {
  it("shares one check for queued frames and checks later frames again in order", async () => {
    let finish;
    const sent = [];
    const socket = { readyState: 1, send: (...args) => sent.push(args), terminate: vi.fn() };
    const check = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(undefined);
    authorizeCollaborationSends(socket, new Set(["reader"]), check);
    socket.send("a");
    socket.send("b");
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    socket.send("c");
    expect(sent).toEqual([]);
    finish();
    await vi.waitFor(() => expect(sent).toEqual([["a"], ["b"], ["c"]]));
    expect(check).toHaveBeenCalledTimes(2);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("drops the whole batch after revocation and emits no later frames", async () => {
    const sent = vi.fn();
    const socket = { readyState: 1, send: sent, terminate: vi.fn(() => { socket.readyState = 3; }) };
    const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("membership removed"));
    authorizeCollaborationSends(socket, new Set(["reader"]), check);
    socket.send("allowed");
    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith("allowed"));
    socket.send("private-a");
    socket.send("private-b");
    await vi.waitFor(() => expect(socket.terminate).toHaveBeenCalledTimes(1));
    socket.send("private-c");
    await Promise.resolve();
    expect(sent).toHaveBeenCalledTimes(1);
  });
});
