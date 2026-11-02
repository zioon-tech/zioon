import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { DeviceServiceHost } from "../src/device-service-host.mjs";
import { PtyWebRtcHost } from "../src/pty-webrtc-host.mjs";

class Socket extends EventTarget {
  readyState = 1;
  send() {}
  close() {}
  message(data) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }
}
const signal = { onCancel: () => ({ dispose() {} }) };

describe("PTY final output", () => {
  it("retains relay output until the closed channel is drained", async () => {
    const socket = new Socket();
    const host = new DeviceServiceHost({ webSocketFactory: () => socket });
    try {
      const opened = await host.openPtyChannel("one", {}, signal);
      const channelId = JSON.parse(Buffer.from(JSON.parse(opened.content).bodyBase64, "base64").toString()).channelId;
      socket.message(Buffer.from("final 中文"));
      socket.dispatchEvent(new Event("close"));
      await new Promise(resolve => setTimeout(resolve, 0));
      const result = await host.invokePtyRelay({
        action: "events", channelId, sessionId: "one", query: new URLSearchParams("waitMs=1")
      }, "GET", null, signal);
      const response = JSON.parse(result.content);
      expect(response.status).toBe(200);
      const payload = JSON.parse(Buffer.from(response.bodyBase64, "base64").toString());
      expect(payload.closed).toBe(true);
      expect(Buffer.from(payload.events[0].dataBase64, "base64").toString()).toBe("final 中文");
      expect(host.ptyChannels.has(channelId)).toBe(false);
    } finally { host.close(); }
  });

  it("orders delayed binary output before WebRTC close", async () => {
    const socket = new Socket();
    const host = new PtyWebRtcHost({ localToolsUrl: "http://127.0.0.1:8765", webSocketFactory: () => socket });
    const sent = [];
    const channel = {
      sessionId: "one", channelId: "test", cols: 80, rows: 24, closed: false,
      dataChannel: { readyState: "open", bufferedAmount: 0, send: value => sent.push(value) }
    };
    const close = vi.spyOn(host, "close").mockImplementation(() => { channel.closed = true; });
    await host.openLocalPty(channel);
    let resolveBytes;
    socket.message({ arrayBuffer: () => new Promise(resolve => { resolveBytes = resolve; }) });
    socket.dispatchEvent(new Event("close"));
    await vi.waitFor(() => expect(resolveBytes).toBeTypeOf("function"));
    expect(close).not.toHaveBeenCalled();
    resolveBytes(Uint8Array.from(Buffer.from("tail")).buffer);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(sent.slice(-2).map(value => Buffer.isBuffer(value) ? value.toString() : value))
      .toEqual(["tail", JSON.stringify({ type: "close" })]);
  });
});
