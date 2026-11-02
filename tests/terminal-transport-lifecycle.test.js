import { afterEach, describe, expect, it, vi } from "vitest";
import { connectPty, connectRuntimePtyWebRtc } from "../extensions/dev.terminal-enhanced/main.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.zion;
  localStorage.clear();
});

describe("terminal transport lifecycle", () => {
  it("decodes Chinese and emoji across local WebSocket frames", async () => {
    let socket;
    class FakeSocket extends EventTarget {
      static OPEN = 1;
      constructor() { super(); this.readyState = 0; socket = this; }
      send() {}
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const connection = connectPty("one");
    socket.readyState = 1;
    socket.onopen();
    await connection.ready;
    let output = "";
    connection.onData(chunk => { output += chunk; });
    const bytes = new TextEncoder().encode("中文🙂");
    for (const byte of bytes) socket.onmessage({ data: Uint8Array.of(byte).buffer });
    socket.onclose();
    expect(output).toBe("中文🙂");
    connection.dispose();
  });

  it("deletes a WebRTC channel returned after disposal", async () => {
    let resolveOffer;
    const setRemote = vi.fn();
    class Peer {
      constructor() { this.iceGatheringState = "complete"; }
      createDataChannel() { return { close() {}, readyState: "connecting" }; }
      async createOffer() { return { type: "offer", sdp: "offer" }; }
      async setLocalDescription(value) { this.localDescription = value; }
      setRemoteDescription = setRemote;
      close() {}
    }
    vi.stubGlobal("RTCPeerConnection", Peer);
    const fetchMock = vi.fn(url => {
      if (String(url).endsWith("/offer")) return new Promise(resolve => { resolveOffer = resolve; });
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const connection = connectRuntimePtyWebRtc("https://runtime.test", "one");
    const result = connection.ready.catch(error => error);
    await vi.waitFor(() => expect(resolveOffer).toBeTypeOf("function"));
    connection.dispose();
    resolveOffer(new Response(JSON.stringify({
      channelId: "late",
      answer: { type: "answer", sdp: "answer" }
    }), { status: 201 }));
    expect(await result).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://runtime.test/sessions/one/pty/webrtc/late",
      { method: "DELETE", keepalive: true }
    );
    expect(setRemote).not.toHaveBeenCalled();
  });
});
