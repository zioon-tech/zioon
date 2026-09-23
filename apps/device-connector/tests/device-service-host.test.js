import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  DeviceServiceHost
} from "../src/device-service-host.mjs";

function signal() {
  return {
    onCancel() {
      return { dispose() {} };
    }
  };
}

function body(result) {
  const payload = JSON.parse(result.content);
  return payload.bodyBase64
    ? JSON.parse(Buffer.from(payload.bodyBase64, "base64").toString("utf8"))
    : null;
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

describe("DeviceServiceHost", () => {
  it("forwards an allowlisted local-tools request", async () => {
    const fetchImpl = vi.fn(async () => new globalThis.Response(
      JSON.stringify({ sessions: [{ id: "terminal-1" }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    ));
    const host = new DeviceServiceHost({ fetchImpl });

    const result = await host.invoke({
      service: "local-tools",
      method: "GET",
      path: "/sessions",
      headers: { accept: "application/json", authorization: "blocked" }
    }, signal());

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:8765/sessions"),
      expect.objectContaining({
        method: "GET",
        headers: { accept: "application/json" }
      })
    );
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe(200);
    expect(
      JSON.parse(Buffer.from(payload.bodyBase64, "base64").toString("utf8"))
    ).toEqual({ sessions: [{ id: "terminal-1" }] });
  });

  it("uses the configured request body limit", async () => {
    const payload = Buffer.from(JSON.stringify({ content: "x".repeat(2 * 1024) }))
      .toString("base64");
    const smallHost = new DeviceServiceHost({
      maxRequestBytes: "1KiB"
    });

    await expect(smallHost.invoke({
      service: "local-tools",
      method: "POST",
      path: "/files/write",
      bodyBase64: payload
    }, signal())).rejects.toThrow("Device service request exceeds 1 KiB");

    const fetchImpl = vi.fn(async () => new globalThis.Response(
      JSON.stringify({ ok: true }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    ));
    const largerHost = new DeviceServiceHost({
      fetchImpl,
      maxRequestBytes: "4KiB"
    });
    const result = await largerHost.invoke({
      service: "local-tools",
      method: "POST",
      path: "/files/write",
      bodyBase64: payload
    }, signal());

    expect(JSON.parse(result.content)).toMatchObject({ status: 200 });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("filters terminal inventory and file access through the Device policy", async () => {
    const authorizeInvocation = vi.fn(async () => ({
      fileRoots: ["/workspace"],
      allowedTerminalSessionIds: ["terminal-allowed"]
    }));
    const deviceAccess = {
      authorizeInvocation,
      state: vi.fn(async () => ({
        allowedTerminalSessionIds: ["terminal-allowed"]
      }))
    };
    const fetchImpl = vi.fn(async (url) => new globalThis.Response(
      JSON.stringify(url.pathname === "/sessions"
        ? {
            sessions: [
              { id: "terminal-allowed", cwd: "/workspace" },
              { id: "terminal-hidden", cwd: "/private" }
            ]
          }
        : { content: "allowed" }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    ));
    const host = new DeviceServiceHost({ fetchImpl, deviceAccess });

    const sessions = await host.invoke({
      service: "local-tools",
      method: "GET",
      path: "/sessions"
    }, signal(), { policy: { allowedTerminalSessionIds: [] } });
    expect(body(sessions).sessions).toEqual([
      { id: "terminal-allowed", cwd: "/workspace" }
    ]);

    await host.invoke({
      service: "local-tools",
      method: "GET",
      path: "/files/read?path=%2Fworkspace%2FREADME.md"
    }, signal(), { invocationId: "file:one" });
    expect(authorizeInvocation).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: "file:one",
      toolCall: expect.objectContaining({
        name: "read",
        arguments: expect.objectContaining({
          path: "/workspace/README.md"
        })
      })
    }));
  });

  it("forwards the normalized Device file path after authorization", async () => {
    const authorizeInvocation = vi.fn(async (request) => {
      request.toolCall.arguments.path = request.toolCall.name === "write"
        ? "/Users/test/gits/app/output.txt"
        : "/Users/test/gits/app/README.md";
      return { fileRoots: ["/"], allowedTerminalSessionIds: [] };
    });
    const fetchImpl = vi.fn(async () => new globalThis.Response(
      JSON.stringify({ ok: true }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    ));
    const host = new DeviceServiceHost({
      fetchImpl,
      deviceAccess: {
        authorizeInvocation,
        state: vi.fn(async () => ({ allowedTerminalSessionIds: [] }))
      }
    });

    await host.invoke({
      service: "local-tools",
      method: "GET",
      path: "/files/read?path=~%2Fgits%2Fapp%2FREADME.md"
    }, signal());
    expect(fetchImpl.mock.calls[0][0].searchParams.get("path"))
      .toBe("/Users/test/gits/app/README.md");

    await host.invoke({
      service: "local-tools",
      method: "POST",
      path: "/files/write",
      bodyBase64: Buffer.from(JSON.stringify({
        path: "~/gits/app/output.txt",
        content: "ok"
      })).toString("base64")
    }, signal());
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({
      path: "/Users/test/gits/app/output.txt",
      content: "ok"
    });
  });

  it("forwards plugin assets without exposing arbitrary local routes", async () => {
    const fetchImpl = vi.fn(async () => new globalThis.Response("export const ok = true;", {
      status: 200,
      headers: { "content-type": "text/javascript" }
    }));
    const host = new DeviceServiceHost({ fetchImpl });

    await expect(host.invoke({
      service: "plugin-service",
      method: "GET",
      path: "/plugins/dev/dev-123/dist/main.js"
    }, signal())).resolves.toMatchObject({ ok: true });
    await expect(host.invoke({
      service: "plugin-service",
      method: "GET",
      path: "/openapi.json"
    }, signal())).rejects.toThrow("route is not allowed");
    await expect(host.invoke({
      service: "local-tools",
      method: "POST",
      path: "/bash"
    }, signal())).rejects.toThrow("route is not allowed");
  });

  it("allows the bounded JSONL file APIs used by Identity", async () => {
    const fetchImpl = vi.fn(async () => new globalThis.Response(
      JSON.stringify({ ok: true }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    ));
    const host = new DeviceServiceHost({ fetchImpl });

    await expect(host.invoke({
      service: "local-tools",
      method: "GET",
      path: "/files/read-jsonl?path=%2Fmemory%2Fevents.jsonl&tail=20"
    }, signal())).resolves.toMatchObject({ ok: true });
    await expect(host.invoke({
      service: "local-tools",
      method: "POST",
      path: "/files/append-jsonl",
      bodyBase64: Buffer.from(JSON.stringify({
        path: "/memory/events.jsonl",
        records: []
      })).toString("base64")
    }, signal())).resolves.toMatchObject({ ok: true });
  });

  it("serves Device access policy operations without a loopback HTTP service", async () => {
    const handleRequest = vi.fn(async (request) => ({
      status: 200,
      body: {
        policy: { scope: request.body.scope || "workspace" },
        effectiveRoots: ["/workspace"]
      }
    }));
    const fetchImpl = vi.fn();
    const host = new DeviceServiceHost({
      fetchImpl,
      deviceAccess: { handleRequest }
    });

    const result = await host.invoke({
      service: "device-access",
      method: "PATCH",
      path: "/policy",
      bodyBase64: Buffer.from(JSON.stringify({
        scope: "registered-projects"
      })).toString("base64")
    }, signal());

    expect(body(result)).toMatchObject({
      policy: { scope: "registered-projects" },
      effectiveRoots: ["/workspace"]
    });
    expect(handleRequest).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/policy",
      body: { scope: "registered-projects" }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("routes authenticated WebRTC signaling to the PTY peer host", async () => {
    const ptyWebRtcHost = {
      acceptOffer: vi.fn(async (sessionId, channelId, input) => ({
        channelId,
        answer: {
          type: "answer",
          sdp: `${sessionId}:${input.offer.sdp}`
        }
      })),
      close: vi.fn(),
      closeAll: vi.fn()
    };
    const host = new DeviceServiceHost({ ptyWebRtcHost });
    const result = await host.invoke({
      service: "local-tools",
      method: "POST",
      path: "/sessions/terminal-1/pty/webrtc/offer",
      bodyBase64: Buffer.from(JSON.stringify({
        offer: { type: "offer", sdp: "offer-sdp" },
        cols: 100,
        rows: 30
      })).toString("base64")
    }, signal());
    const response = body(result);

    expect(ptyWebRtcHost.acceptOffer).toHaveBeenCalledWith(
      "terminal-1",
      expect.any(String),
      expect.objectContaining({
        offer: { type: "offer", sdp: "offer-sdp" }
      }),
      expect.anything()
    );
    expect(response.answer).toEqual({
      type: "answer",
      sdp: "terminal-1:offer-sdp"
    });

    await host.invoke({
      service: "local-tools",
      method: "DELETE",
      path: `/sessions/terminal-1/pty/webrtc/${response.channelId}`
    }, signal());
    expect(ptyWebRtcHost.close).toHaveBeenCalledWith(response.channelId);
  });

  it("relays a local PTY WebSocket through bounded HTTP operations", async () => {
    const socket = new FakeWebSocket();
    const host = new DeviceServiceHost({
      webSocketFactory: () => {
        globalThis.queueMicrotask(() => socket.open());
        return socket;
      }
    });
    const openResult = await host.invoke({
      service: "local-tools",
      method: "POST",
      path: "/sessions/terminal-1/pty/relay/open",
      bodyBase64: Buffer.from(JSON.stringify({
        cols: 100,
        rows: 30
      })).toString("base64")
    }, signal());
    const { channelId } = body(openResult);

    expect(channelId).toBeTruthy();
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: "resize",
      cols: 100,
      rows: 30
    });

    await host.invoke({
      service: "local-tools",
      method: "POST",
      path: `/sessions/terminal-1/pty/relay/${channelId}/input`,
      bodyBase64: Buffer.from(JSON.stringify({
        type: "input",
        data: "pwd\r"
      })).toString("base64")
    }, signal());
    expect(socket.sent[1]).toBe("pwd\r");

    socket.message(Buffer.from("/workspace\r\n"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const eventsResult = await host.invoke({
      service: "local-tools",
      method: "GET",
      path: `/sessions/terminal-1/pty/relay/${channelId}/events?waitMs=1`
    }, signal());
    const events = body(eventsResult);

    expect(events.closed).toBe(false);
    expect(Buffer.from(
      events.events[0].dataBase64,
      "base64"
    ).toString("utf8")).toBe("/workspace\r\n");

    await host.invoke({
      service: "local-tools",
      method: "DELETE",
      path: `/sessions/terminal-1/pty/relay/${channelId}`
    }, signal());
    expect(socket.readyState).toBe(3);
  });
});
