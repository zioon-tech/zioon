// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { connectPty } from "../src/pty";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readonly url: string;
  binaryType = "";
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(value: unknown) {
    this.sent.push(value);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe("Mobile PTY connection", () => {
  it("falls back to local-tools WebSocket when Runtime relay endpoints are unavailable", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ detail: "Not Found" }),
      {
        status: 404,
        headers: { "content-type": "application/json" },
      },
    )));
    const statuses: string[] = [];

    const connection = connectPty("terminal-1", 100, 30);
    connection.onTransportChange((status) => {
      statuses.push(`${status.transport}:${status.phase || ""}`);
    });
    await connection.ready;

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toMatch(
      /^ws:\/\/localhost:3000\/v1\/device-services\/local-tools\/sessions\/terminal-1\/pty\/ws$/,
    );
    expect(statuses.at(-1)).toBe("ws:connected");
    expect(socket.sent).toContain(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    connection.dispose();
  });
});
