import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectCommandRelay,
  connectRuntimePty,
  connectRuntimePtyWebRtc,
  connectRuntimePtyRelay
} from "../extensions/dev.terminal-enhanced/main.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  delete window.zion;
});

describe("remote terminal command relay", () => {
  it("uses a WebRTC DataChannel for direct PTY input and output", async () => {
    const sent = [];
    const dataChannel = {
      readyState: "connecting",
      bufferedAmount: 0,
      binaryType: "",
      send: vi.fn((value) => sent.push(value)),
      close: vi.fn()
    };
    class FakePeerConnection {
      constructor() {
        this.iceGatheringState = "complete";
        this.connectionState = "new";
        this.localDescription = null;
      }

      createDataChannel() {
        return dataChannel;
      }

      async createOffer() {
        return { type: "offer", sdp: "offer-sdp" };
      }

      async setLocalDescription(description) {
        this.localDescription = description;
      }

      async setRemoteDescription() {
        dataChannel.readyState = "open";
        globalThis.queueMicrotask(() => {
          dataChannel.onmessage?.({
            data: JSON.stringify({ type: "ready" })
          });
        });
      }

      async getStats() {
        return new Map([
          ["transport-1", {
            id: "transport-1",
            type: "transport",
            selectedCandidatePairId: "pair-1"
          }],
          ["pair-1", {
            id: "pair-1",
            type: "candidate-pair",
            state: "succeeded",
            nominated: true,
            localCandidateId: "local-1",
            remoteCandidateId: "remote-1",
            currentRoundTripTime: 0.012
          }],
          ["local-1", {
            id: "local-1",
            type: "local-candidate",
            candidateType: "host",
            protocol: "udp"
          }],
          ["remote-1", {
            id: "remote-1",
            type: "remote-candidate",
            candidateType: "host",
            protocol: "udp"
          }]
        ]);
      }

      addEventListener() {}
      removeEventListener() {}
      close() {
        this.connectionState = "closed";
      }
    }
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith("/pty/webrtc/offer")) {
        return new globalThis.Response(JSON.stringify({
          channelId: "webrtc-1",
          answer: { type: "answer", sdp: "answer-sdp" }
        }), {
          status: 201,
          headers: { "content-type": "application/json" }
        });
      }
      return new globalThis.Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    let output = "";
    const direct = connectRuntimePtyWebRtc(
      "https://runtime.test/v1/device-services/local-tools",
      "terminal-1"
    );
    direct.onData((chunk) => {
      output += chunk;
    });
    await direct.ready;
    direct.send("pwd\r");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(direct.transport).toBe("webrtc");
    await expect(direct.getDiagnostics()).resolves.toEqual({
      localCandidateType: "host",
      remoteCandidateType: "host",
      protocol: "udp",
      roundTripTimeMs: 12
    });
    expect(sent.map((value) =>
      typeof value === "string" ? JSON.parse(value) : value
    )).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "input", data: "pwd\r" }
    ]);
    dataChannel.onmessage?.({
      data: Uint8Array.from(Buffer.from("/workspace\r\n")).buffer
    });
    expect(output).toBe("/workspace\r\n");
    direct.dispose();
    expect(fetchImpl.mock.calls.some(([url, init]) =>
      String(url).endsWith("/pty/webrtc/webrtc-1")
      && init?.method === "DELETE"
    )).toBe(true);
  });

  it("falls back to the Runtime relay when WebRTC negotiation fails", async () => {
    let resolveEvents;
    class FailingPeerConnection {
      constructor() {
        this.iceGatheringState = "complete";
        this.localDescription = null;
        this.connectionState = "new";
      }

      createDataChannel() {
        return {
          readyState: "connecting",
          bufferedAmount: 0,
          send() {},
          close() {}
        };
      }

      async createOffer() {
        return { type: "offer", sdp: "offer-sdp" };
      }

      async setLocalDescription(description) {
        this.localDescription = description;
      }

      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    vi.stubGlobal("RTCPeerConnection", FailingPeerConnection);
    const fetchImpl = vi.fn(async (url) => {
      const value = String(url);
      if (value.endsWith("/pty/webrtc/offer")) {
        return new globalThis.Response(JSON.stringify({
          error: "WebRTC is unavailable"
        }), {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      }
      if (value.endsWith("/pty/relay/open")) {
        return new globalThis.Response(JSON.stringify({
          channelId: "relay-1"
        }), {
          status: 201,
          headers: { "content-type": "application/json" }
        });
      }
      if (value.includes("/events?")) {
        return new Promise((resolve) => {
          resolveEvents = resolve;
        });
      }
      return new globalThis.Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const connection = connectRuntimePty(
      "https://runtime.test/v1/device-services/local-tools",
      "terminal-1"
    );
    const statuses = [];
    connection.onTransportChange((status) => statuses.push(status));

    await connection.ready;
    expect(connection.transport).toBe("relay");
    expect(statuses.at(-1)).toMatchObject({
      transport: "relay",
      phase: "connected",
      fallbackReason: "WebRTC is unavailable"
    });
    expect(fetchImpl.mock.calls.some(([url]) =>
      String(url).endsWith("/pty/webrtc/offer")
    )).toBe(true);
    expect(fetchImpl.mock.calls.some(([url]) =>
      String(url).endsWith("/pty/relay/open")
    )).toBe(true);

    resolveEvents(new globalThis.Response(JSON.stringify({
      events: [],
      closed: true
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    connection.dispose();
  });

  it("streams PTY input and output through the Runtime relay", async () => {
    let resolveEvents;
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const value = String(url);
      if (value.endsWith("/pty/relay/open")) {
        return new globalThis.Response(JSON.stringify({
          channelId: "channel-1"
        }), {
          status: 201,
          headers: { "content-type": "application/json" }
        });
      }
      if (value.includes("/events?")) {
        return new Promise((resolve) => {
          resolveEvents = resolve;
        });
      }
      return new globalThis.Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    let output = "";
    const relay = connectRuntimePtyRelay(
      "https://runtime.test/v1/device-services/local-tools",
      "terminal-1",
      100,
      30
    );
    relay.onData((chunk) => {
      output += chunk;
    });
    await relay.ready;
    relay.send("pwd\r");

    await vi.waitFor(() => {
      const inputCall = fetchImpl.mock.calls.find(([url]) =>
        String(url).endsWith("/channel-1/input")
      );
      expect(inputCall).toBeTruthy();
      expect(JSON.parse(inputCall[1].body)).toEqual({
        type: "input",
        data: "pwd\r"
      });
    });

    resolveEvents(new globalThis.Response(JSON.stringify({
      events: [{
        type: "data",
        dataBase64: Buffer.from("/workspace\r\n").toString("base64")
      }],
      closed: true
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    await vi.waitFor(() => {
      expect(output).toBe("/workspace\r\n");
      expect(relay.ws.readyState).toBe(WebSocket.CLOSED);
    });
  });

  it("coalesces input typed while a Runtime write is in flight", async () => {
    let resolveEvents;
    let resolveFirstInput;
    const inputBodies = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const value = String(url);
      if (value.endsWith("/pty/relay/open")) {
        return new globalThis.Response(JSON.stringify({
          channelId: "channel-1"
        }), {
          status: 201,
          headers: { "content-type": "application/json" }
        });
      }
      if (value.includes("/events?")) {
        return new Promise((resolve) => {
          resolveEvents = resolve;
        });
      }
      if (value.endsWith("/channel-1/input")) {
        inputBodies.push(JSON.parse(options.body));
        if (inputBodies.length === 1) {
          return new Promise((resolve) => {
            resolveFirstInput = resolve;
          });
        }
      }
      return new globalThis.Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const relay = connectRuntimePtyRelay(
      "https://runtime.test/v1/device-services/local-tools",
      "terminal-1"
    );
    await relay.ready;

    relay.send("a");
    await vi.waitFor(() => expect(inputBodies).toHaveLength(1));
    relay.send("b");
    await new Promise((resolve) => setTimeout(resolve, 10));
    relay.send("c");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inputBodies).toEqual([{ type: "input", data: "a" }]);

    resolveFirstInput(new globalThis.Response(null, { status: 204 }));
    await vi.waitFor(() => expect(inputBodies).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inputBodies[1]).toEqual({ type: "input", data: "bc" });

    resolveEvents(new globalThis.Response(JSON.stringify({
      events: [],
      closed: true
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    relay.dispose();
  });

  it("executes completed command lines through the same-origin Device service", async () => {
    const values = new Map([
      ["runtime.mode", "runtime"],
      ["runtime.baseUrl", "https://runtime.test"]
    ]);
    window.zion = {
      state: {
        get: (key) => values.get(key),
        set: (key, value) => values.set(key, value)
      }
    };
    const fetchImpl = vi.fn(async () => new globalThis.Response(JSON.stringify({
      ok: true,
      stdout: "/workspace\n",
      stderr: "",
      exit_code: 0,
      cwd: "/workspace"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchImpl);
    let output = "";
    const relay = connectCommandRelay("terminal-1");
    relay.onData((chunk) => {
      output += chunk;
    });

    await relay.ready;
    relay.send("pwd");
    relay.send("\r");
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(output).toContain("/workspace");
    });

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      "https://runtime.test/v1/device-services/local-tools/"
      + "sessions/terminal-1/exec"
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      command: "pwd",
      timeout: 120_000
    });
    relay.dispose();
  });
});
