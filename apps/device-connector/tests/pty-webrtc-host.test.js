import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { PtyWebRtcHost } from "../src/pty-webrtc-host.mjs";

class FakeEvent {
  constructor() {
    this.handlers = [];
  }

  subscribe(handler) {
    this.handlers.push(handler);
    return {
      unSubscribe: () => {
        this.handlers = this.handlers.filter((item) => item !== handler);
      }
    };
  }

  emit(value) {
    for (const handler of [...this.handlers]) handler(value);
  }
}

class FakeDataChannel {
  constructor() {
    this.label = "zion-terminal";
    this.readyState = "connecting";
    this.bufferedAmount = 0;
    this.onMessage = new FakeEvent();
    this.stateChanged = new FakeEvent();
    this.sent = [];
  }

  open() {
    this.readyState = "open";
    this.stateChanged.emit("open");
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.stateChanged.emit("closed");
  }
}

class FakePeerConnection {
  constructor() {
    this.onDataChannel = new FakeEvent();
    this.connectionStateChange = new FakeEvent();
    this.localDescription = null;
    this.closed = false;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  async createAnswer() {
    return { type: "answer", sdp: "answer-sdp" };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async close() {
    this.closed = true;
  }
}

class FakeWebSocket extends globalThis.EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  message(data) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

describe("PtyWebRtcHost", () => {
  it("bridges a WebRTC DataChannel to the local PTY WebSocket", async () => {
    const peer = new FakePeerConnection();
    const socket = new FakeWebSocket();
    const host = new PtyWebRtcHost({
      localToolsUrl: "http://127.0.0.1:8765",
      peerConnectionFactory: () => peer,
      webSocketFactory: () => {
        globalThis.queueMicrotask(() => socket.open());
        return socket;
      }
    });

    const answer = await host.acceptOffer(
      "terminal-1",
      "channel-1",
      {
        offer: { type: "offer", sdp: "offer-sdp" },
        cols: 100,
        rows: 30
      }
    );
    expect(answer).toEqual({
      channelId: "channel-1",
      answer: { type: "answer", sdp: "answer-sdp" }
    });

    const dataChannel = new FakeDataChannel();
    peer.onDataChannel.emit(dataChannel);
    dataChannel.open();
    await vi.waitFor(() => {
      expect(dataChannel.sent).toContain(JSON.stringify({ type: "ready" }));
    });
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "resize",
      cols: 100,
      rows: 30
    });

    dataChannel.onMessage.emit(JSON.stringify({
      type: "input",
      data: "pwd\r"
    }));
    expect(socket.sent[1]).toBe("pwd\r");

    socket.message(Buffer.from("/workspace\r\n"));
    await vi.waitFor(() => {
      expect(Buffer.isBuffer(dataChannel.sent.at(-1))).toBe(true);
    });
    expect(dataChannel.sent.at(-1).toString("utf8")).toBe("/workspace\r\n");

    host.close("channel-1");
    expect(socket.readyState).toBe(3);
    expect(peer.closed).toBe(true);
  });
});
