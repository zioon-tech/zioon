import { runtimeBaseUrl } from "./api";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

const SERVICE_BASE = `${runtimeBaseUrl}/v1/device-services/local-tools`;

export type PtyTransportStatus = {
  transport: "connecting" | "webrtc" | "relay" | "disconnected";
  phase?: string;
  fallbackReason?: string;
  roundTripTimeMs?: number;
  localCandidateType?: string;
  remoteCandidateType?: string;
  protocol?: string;
};

export type PtyConnection = {
  readonly ready: Promise<void>;
  send(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (data: string) => void): () => void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: () => void): void;
  onTransportChange(handler: (status: PtyTransportStatus) => void): () => void;
  dispose(): void;
};

type TransportConnection = {
  transport: "webrtc" | "relay";
  ready: Promise<void>;
  send(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (data: string) => void): () => void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: () => void): void;
  dispose(): void;
  diagnostics?(): Promise<Partial<PtyTransportStatus>>;
};

async function request<T>(
  path: string,
  options: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${SERVICE_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(String(body?.error || `PTY HTTP ${response.status}`));
  }
  return body as T;
}

function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      peer.removeEventListener("icegatheringstatechange", onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const timer = window.setTimeout(finish, 1_500);
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

async function selectedRoute(
  peer: RTCPeerConnection,
): Promise<Partial<PtyTransportStatus>> {
  try {
    const reports = await peer.getStats();
    const values: Array<Record<string, unknown>> = [];
    reports.forEach((report) => values.push(report as Record<string, unknown>));
    const findReport = (id: unknown) =>
      values.find((report) => report.id === id);
    const transport = values.find(
      (report) => report.type === "transport" && report.selectedCandidatePairId,
    );
    const selected = transport?.selectedCandidatePairId
      ? findReport(transport.selectedCandidatePairId)
      : values.find(
          (report) =>
            report.type === "candidate-pair"
            && report.state === "succeeded"
            && (report.nominated || report.selected),
        );
    if (!selected) return {};
    const local = findReport(selected.localCandidateId);
    const remote = findReport(selected.remoteCandidateId);
    const roundTripTime = Number(selected.currentRoundTripTime);
    return {
      localCandidateType: String(local?.candidateType || ""),
      remoteCandidateType: String(remote?.candidateType || ""),
      protocol: String(local?.protocol || remote?.protocol || ""),
      ...(Number.isFinite(roundTripTime)
        ? { roundTripTimeMs: Math.max(0, Math.round(roundTripTime * 1000)) }
        : {}),
    };
  } catch {
    return {};
  }
}

function createWebRtcTransport(
  sessionId: string,
  cols: number,
  rows: number,
): TransportConnection {
  if (typeof RTCPeerConnection !== "function") {
    throw new Error("WebRTC is unavailable");
  }
  const sid = encodeURIComponent(sessionId);
  const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = peer.createDataChannel("zion-terminal", { ordered: true });
  channel.binaryType = "arraybuffer";
  const decoder = new TextDecoder();
  let channelId = "";
  let disposed = false;
  let opened = false;
  let dataHandler = (_data: string) => {};
  let errorHandler = (_error: Error) => {};
  let closeHandler = () => {};
  let inputBuffer = "";
  let inputTimer = 0;
  let pendingResize: { cols: number; rows: number } | null = { cols, rows };
  let resolveReady = () => {};
  let rejectReady = (_error: Error) => {};
  const channelReady = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const close = (error?: Error, notify = true) => {
    if (disposed) return;
    disposed = true;
    clearTimeout(inputTimer);
    if (!opened && error) rejectReady(error);
    try { channel.close(); } catch {}
    try { peer.close(); } catch {}
    if (error && notify) errorHandler(error);
    if (notify) closeHandler();
  };
  const sendControl = (value: Record<string, unknown>) => {
    if (!opened || disposed || channel.readyState !== "open") return;
    if (channel.bufferedAmount > 1024 * 1024) {
      close(new Error("PTY WebRTC input buffer exceeded the size limit"));
      return;
    }
    channel.send(JSON.stringify(value));
  };
  const flushInput = () => {
    inputTimer = 0;
    if (!inputBuffer || !opened || disposed) return;
    const data = inputBuffer;
    inputBuffer = "";
    sendControl({ type: "input", data });
  };

  channel.onmessage = (event) => {
    if (typeof event.data === "string") {
      try {
        const control = JSON.parse(event.data);
        if (control?.type === "ready") {
          opened = true;
          if (pendingResize) {
            sendControl({ type: "resize", ...pendingResize });
            pendingResize = null;
          }
          flushInput();
          resolveReady();
        } else if (control?.type === "error") {
          close(new Error(control.message || "PTY WebRTC failed"));
        } else if (control?.type === "close") {
          const tail = decoder.decode();
          if (tail) dataHandler(tail);
          close();
        }
        return;
      } catch {
        dataHandler(event.data);
        return;
      }
    }
    const bytes = event.data instanceof ArrayBuffer
      ? new Uint8Array(event.data)
      : ArrayBuffer.isView(event.data)
        ? new Uint8Array(
            event.data.buffer,
            event.data.byteOffset,
            event.data.byteLength,
          )
        : null;
    if (bytes) dataHandler(decoder.decode(bytes, { stream: true }));
  };
  channel.onerror = () => close(new Error("PTY WebRTC DataChannel failed"));
  channel.onclose = () => {
    if (!disposed) close(new Error("PTY WebRTC DataChannel closed"));
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "failed") {
      close(new Error("PTY WebRTC connection failed"));
    }
  };

  const ready = (async () => {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer);
    const local = peer.localDescription;
    if (!local?.sdp) throw new Error("PTY WebRTC offer is unavailable");
    const payload = await request<{
      channelId: string;
      answer: RTCSessionDescriptionInit;
    }>(
      `/sessions/${sid}/pty/webrtc/offer`,
      {
        method: "POST",
        body: JSON.stringify({
          offer: { type: local.type, sdp: local.sdp },
          cols,
          rows,
        }),
      },
    );
    channelId = String(payload.channelId || "");
    if (!channelId || !payload.answer?.sdp) {
      throw new Error("PTY WebRTC answer is unavailable");
    }
    await peer.setRemoteDescription(payload.answer);
    await Promise.race([
      channelReady,
      new Promise<never>((_, reject) => {
        window.setTimeout(
          () => reject(new Error("PTY WebRTC connection timed out")),
          5_000,
        );
      }),
    ]);
  })().catch((error) => {
    close(undefined, false);
    throw error;
  });

  return {
    transport: "webrtc",
    ready,
    diagnostics: () => selectedRoute(peer),
    send(data) {
      if (disposed) return;
      inputBuffer += data;
      if (inputBuffer.length >= 4_096) {
        clearTimeout(inputTimer);
        flushInput();
      } else if (!inputTimer) {
        inputTimer = window.setTimeout(flushInput, 4);
      }
    },
    resize(nextCols, nextRows) {
      pendingResize = {
        cols: Math.max(1, nextCols),
        rows: Math.max(1, nextRows),
      };
      if (opened) {
        sendControl({ type: "resize", ...pendingResize });
        pendingResize = null;
      }
    },
    onData(handler) {
      dataHandler = handler;
      return () => {
        dataHandler = () => {};
      };
    },
    onError(handler) {
      errorHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    dispose() {
      if (disposed) return;
      if (channelId) {
        void request(
          `/sessions/${sid}/pty/webrtc/${encodeURIComponent(channelId)}`,
          { method: "DELETE", keepalive: true },
        ).catch(() => {});
      }
      close(undefined, false);
    },
  };
}

function createRelayTransport(
  sessionId: string,
  cols: number,
  rows: number,
): TransportConnection {
  const sid = encodeURIComponent(sessionId);
  const controller = new AbortController();
  const decoder = new TextDecoder();
  let channelId = "";
  let disposed = false;
  let closed = false;
  let dataHandler = (_data: string) => {};
  let errorHandler = (_error: Error) => {};
  let closeHandler = () => {};
  let inputBuffer = "";
  let inputTimer = 0;
  let writeQueue = Promise.resolve();

  const finish = (error?: Error, notify = true) => {
    if (closed) return;
    closed = true;
    controller.abort();
    if (error && notify) errorHandler(error);
    if (notify) closeHandler();
  };
  const enqueue = (operation: () => Promise<void>) => {
    writeQueue = writeQueue.then(operation).catch((error) => finish(error));
  };
  const ready = request<{ channelId: string }>(
    `/sessions/${sid}/pty/relay/open`,
    {
      method: "POST",
      body: JSON.stringify({ cols, rows }),
    },
    controller.signal,
  ).then((payload) => {
    channelId = String(payload.channelId || "");
    if (!channelId) throw new Error("PTY relay returned no channel");
    void readEvents();
  });
  const readEvents = async () => {
    while (!disposed && !closed) {
      const payload = await request<{
        events?: Array<{
          type: string;
          dataBase64?: string;
          message?: string;
        }>;
        closed?: boolean;
      }>(
        `/sessions/${sid}/pty/relay/${encodeURIComponent(channelId)}/events?waitMs=15000`,
        {},
        controller.signal,
      );
      for (const event of payload.events || []) {
        if (event.type === "data" && event.dataBase64) {
          const binary = atob(event.dataBase64);
          const bytes = Uint8Array.from(binary, (character) =>
            character.charCodeAt(0));
          dataHandler(decoder.decode(bytes, { stream: true }));
        } else if (event.type === "error") {
          errorHandler(new Error(event.message || "PTY relay failed"));
        }
      }
      if (payload.closed) {
        const tail = decoder.decode();
        if (tail) dataHandler(tail);
        finish();
      }
    }
  };
  const flushInput = () => {
    inputTimer = 0;
    if (!inputBuffer || disposed || closed) return;
    const data = inputBuffer;
    inputBuffer = "";
    enqueue(async () => {
      await ready;
      await request(
        `/sessions/${sid}/pty/relay/${encodeURIComponent(channelId)}/input`,
        {
          method: "POST",
          body: JSON.stringify({ type: "input", data }),
        },
        controller.signal,
      );
    });
  };

  return {
    transport: "relay",
    ready,
    send(data) {
      if (disposed) return;
      inputBuffer += data;
      if (inputBuffer.length >= 4_096) flushInput();
      else if (!inputTimer) inputTimer = window.setTimeout(flushInput, 4);
    },
    resize(nextCols, nextRows) {
      enqueue(async () => {
        await ready;
        await request(
          `/sessions/${sid}/pty/relay/${encodeURIComponent(channelId)}/input`,
          {
            method: "POST",
            body: JSON.stringify({
              type: "resize",
              cols: Math.max(1, nextCols),
              rows: Math.max(1, nextRows),
            }),
          },
          controller.signal,
        );
      });
    },
    onData(handler) {
      dataHandler = handler;
      return () => {
        dataHandler = () => {};
      };
    },
    onError(handler) {
      errorHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(inputTimer);
      if (channelId) {
        void request(
          `/sessions/${sid}/pty/relay/${encodeURIComponent(channelId)}`,
          { method: "DELETE", keepalive: true },
        ).catch(() => {});
      }
      finish(undefined, false);
    },
  };
}

export function connectPty(
  sessionId: string,
  cols = 80,
  rows = 24,
): PtyConnection {
  let active: TransportConnection | null = null;
  let attempt: TransportConnection | null = null;
  let disposed = false;
  let queuedInput = "";
  let queuedResize: { cols: number; rows: number } | null = { cols, rows };
  let dataHandler = (_data: string) => {};
  let errorHandler = (_error: Error) => {};
  let closeHandler = () => {};
  let status: PtyTransportStatus = {
    transport: "connecting",
    phase: "webrtc",
  };
  const statusHandlers = new Set<(value: PtyTransportStatus) => void>();
  const updateStatus = (patch: Partial<PtyTransportStatus>) => {
    status = { ...status, ...patch };
    for (const handler of statusHandlers) handler({ ...status });
  };
  const wire = (connection: TransportConnection) => {
    connection.onData((data) => dataHandler(data));
    connection.onError((error) => {
      if (active === connection && !disposed) errorHandler(error);
    });
    connection.onClose(() => {
      if (active === connection && !disposed) closeHandler();
    });
  };
  const activate = async (connection: TransportConnection) => {
    active = connection;
    await connection.ready;
    if (disposed) {
      connection.dispose();
      return;
    }
    if (queuedResize) {
      connection.resize(queuedResize.cols, queuedResize.rows);
      queuedResize = null;
    }
    if (queuedInput) {
      connection.send(queuedInput);
      queuedInput = "";
    }
  };
  const ready = (async () => {
    try {
      attempt = createWebRtcTransport(sessionId, cols, rows);
      wire(attempt);
      await activate(attempt);
      updateStatus({ transport: "webrtc", phase: "connected" });
      const diagnostics = await attempt.diagnostics?.();
      if (active === attempt && diagnostics) updateStatus(diagnostics);
    } catch (error) {
      attempt?.dispose();
      if (disposed) throw error;
      const fallbackReason = error instanceof Error ? error.message : String(error);
      updateStatus({
        transport: "connecting",
        phase: "relay",
        fallbackReason,
      });
      attempt = createRelayTransport(sessionId, cols, rows);
      wire(attempt);
      await activate(attempt);
      updateStatus({
        transport: "relay",
        phase: "connected",
        fallbackReason,
      });
    }
  })();

  return {
    ready,
    send(data) {
      if (disposed) return;
      if (active) active.send(data);
      else queuedInput += data;
    },
    resize(nextCols, nextRows) {
      queuedResize = { cols: nextCols, rows: nextRows };
      if (active) {
        active.resize(nextCols, nextRows);
        queuedResize = null;
      }
    },
    onData(handler) {
      dataHandler = handler;
      return () => {
        dataHandler = () => {};
      };
    },
    onError(handler) {
      errorHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    onTransportChange(handler) {
      statusHandlers.add(handler);
      handler({ ...status });
      return () => statusHandlers.delete(handler);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active?.dispose();
      attempt?.dispose();
      statusHandlers.clear();
      status = { transport: "disconnected" };
    },
  };
}
