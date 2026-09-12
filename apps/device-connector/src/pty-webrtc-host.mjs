import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { RTCPeerConnection } from "werift";

export const DEFAULT_WEBRTC_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: "stun:stun.l.google.com:19302" }),
  Object.freeze({ urls: "stun:global.stun.twilio.com:3478" })
]);

function toBuffer(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function sessionDescription(value) {
  const type = String(value?.type || "");
  const sdp = String(value?.sdp || "");
  if (type !== "offer" || !sdp) {
    throw new Error("PTY WebRTC offer requires an SDP offer");
  }
  return { type, sdp };
}

export class PtyWebRtcHost {
  constructor({
    localToolsUrl,
    webSocketFactory = (url) => new globalThis.WebSocket(url),
    peerConnectionFactory = (config) => new RTCPeerConnection(config),
    iceServers = DEFAULT_WEBRTC_ICE_SERVERS,
    openTimeoutMs = 15_000,
    idleTimeoutMs = 10 * 60_000,
    maxLifetimeMs = 5 * 60_000,
    maxChannels = 8,
    maxBufferedBytes = 1024 * 1024
  }) {
    this.localToolsUrl = localToolsUrl;
    this.webSocketFactory = webSocketFactory;
    this.peerConnectionFactory = peerConnectionFactory;
    this.iceServers = iceServers;
    this.openTimeoutMs = openTimeoutMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxLifetimeMs = maxLifetimeMs;
    this.maxChannels = maxChannels;
    this.maxBufferedBytes = maxBufferedBytes;
    this.channels = new Map();
  }

  async acceptOffer(sessionId, channelId, input, signal) {
    this.prune();
    if (this.channels.size >= this.maxChannels) {
      throw new Error("Too many PTY WebRTC channels");
    }
    const peer = this.peerConnectionFactory({
      iceServers: this.iceServers,
      iceUseIpv4: true,
      iceUseIpv6: false
    });
    const channel = {
      channelId,
      sessionId,
      peer,
      dataChannel: null,
      socket: null,
      opening: false,
      ready: false,
      closed: false,
      cols: Math.max(1, Number(input?.cols) || 80),
      rows: Math.max(1, Number(input?.rows) || 24),
      lastActivityAt: Date.now(),
      openTimer: null,
      leaseTimer: null
    };
    this.channels.set(channelId, channel);
    peer.onDataChannel.subscribe((dataChannel) => {
      this.attachDataChannel(channel, dataChannel);
    });
    peer.connectionStateChange.subscribe((state) => {
      if (state === "failed" || state === "closed") {
        this.close(channelId);
      }
    });
    channel.openTimer = setTimeout(() => {
      if (!channel.ready) this.close(channelId);
    }, this.openTimeoutMs);
    channel.leaseTimer = setTimeout(() => {
      this.sendControl(channel, {
        type: "close",
        reason: "authorization-refresh"
      });
      this.close(channelId);
    }, this.maxLifetimeMs);

    const cancellation = signal?.onCancel?.(() => this.close(channelId))
      || { dispose() {} };
    try {
      await peer.setRemoteDescription(sessionDescription(input?.offer));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      const local = peer.localDescription;
      if (!local?.sdp) throw new Error("PTY WebRTC answer is unavailable");
      return {
        channelId,
        answer: {
          type: local.type,
          sdp: local.sdp
        }
      };
    } catch (error) {
      this.close(channelId);
      throw error;
    } finally {
      cancellation.dispose();
    }
  }

  attachDataChannel(channel, dataChannel) {
    if (
      channel.closed
      || channel.dataChannel
      || dataChannel.label !== "zion-terminal"
    ) {
      dataChannel.close();
      return;
    }
    channel.dataChannel = dataChannel;
    dataChannel.onMessage.subscribe((value) => {
      this.acceptDataMessage(channel, value);
    });
    const openLocalPty = () => {
      void this.openLocalPty(channel).catch((error) => {
        this.sendControl(channel, {
          type: "error",
          message: error?.message || String(error)
        });
        this.close(channel.channelId);
      });
    };
    dataChannel.stateChanged.subscribe((state) => {
      if (state === "open") {
        openLocalPty();
      } else if (state === "closed") {
        this.close(channel.channelId);
      }
    });
    if (dataChannel.readyState === "open") {
      openLocalPty();
    }
  }

  async openLocalPty(channel) {
    if (channel.closed || channel.opening || channel.ready) return;
    channel.opening = true;
    const socketUrl = new URL(
      `/sessions/${encodeURIComponent(channel.sessionId)}/pty/ws`,
      this.localToolsUrl
    );
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.webSocketFactory(socketUrl.toString());
    channel.socket = socket;
    await this.waitForSocketOpen(channel);
    if (channel.closed) return;
    socket.addEventListener("message", (event) => {
      void this.forwardPtyOutput(channel, event?.data);
    });
    socket.addEventListener("close", () => {
      this.sendControl(channel, { type: "close" });
      this.close(channel.channelId);
    });
    socket.addEventListener("error", () => {
      this.sendControl(channel, {
        type: "error",
        message: "Local PTY WebSocket failed"
      });
    });
    socket.send(JSON.stringify({
      type: "resize",
      cols: channel.cols,
      rows: channel.rows
    }));
    channel.ready = true;
    channel.opening = false;
    channel.lastActivityAt = Date.now();
    clearTimeout(channel.openTimer);
    this.sendControl(channel, { type: "ready" });
  }

  waitForSocketOpen(channel) {
    if (channel.socket.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.socket.removeEventListener("open", onOpen);
        channel.socket.removeEventListener("error", onError);
        channel.socket.removeEventListener("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onError = () => finish(new Error("Cannot open local PTY WebSocket"));
      const onClose = () => finish(new Error("Local PTY WebSocket closed"));
      const timer = setTimeout(
        () => finish(new Error("Local PTY WebSocket timed out")),
        this.openTimeoutMs
      );
      channel.socket.addEventListener("open", onOpen, { once: true });
      channel.socket.addEventListener("error", onError, { once: true });
      channel.socket.addEventListener("close", onClose, { once: true });
    });
  }

  acceptDataMessage(channel, value) {
    if (channel.closed || channel.socket?.readyState !== 1) return;
    channel.lastActivityAt = Date.now();
    let input;
    try {
      const text = Buffer.isBuffer(value)
        ? value.toString("utf8")
        : String(value || "");
      input = JSON.parse(text);
    } catch {
      return;
    }
    if (input?.type === "resize") {
      channel.socket.send(JSON.stringify({
        type: "resize",
        cols: Math.max(1, Number(input.cols) || 80),
        rows: Math.max(1, Number(input.rows) || 24)
      }));
    } else if (input?.type === "input") {
      channel.socket.send(String(input.data || ""));
    } else if (input?.type === "close") {
      this.close(channel.channelId);
    } else if (input?.type === "ping") {
      this.sendControl(channel, { type: "pong" });
    }
  }

  async forwardPtyOutput(channel, value) {
    if (channel.closed || channel.dataChannel?.readyState !== "open") return;
    const body = toBuffer(value)
      || (value?.arrayBuffer ? Buffer.from(await value.arrayBuffer()) : null);
    if (!body) return;
    channel.lastActivityAt = Date.now();
    if (
      channel.dataChannel.bufferedAmount + body.length
      > this.maxBufferedBytes
    ) {
      this.sendControl(channel, {
        type: "error",
        message: "PTY WebRTC output buffer exceeded the size limit"
      });
      this.close(channel.channelId);
      return;
    }
    channel.dataChannel.send(body);
  }

  sendControl(channel, value) {
    if (channel.closed || channel.dataChannel?.readyState !== "open") return;
    channel.dataChannel.send(JSON.stringify(value));
  }

  prune(now = Date.now()) {
    for (const [channelId, channel] of this.channels) {
      if (
        channel.closed
        || now - channel.lastActivityAt > this.idleTimeoutMs
      ) {
        this.close(channelId);
      }
    }
  }

  close(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.channels.delete(channelId);
    channel.closed = true;
    clearTimeout(channel.openTimer);
    clearTimeout(channel.leaseTimer);
    try {
      channel.socket?.close(1000, "PTY WebRTC closed");
    } catch {
      // The local PTY socket may already be closed.
    }
    try {
      channel.dataChannel?.close();
    } catch {
      // The DataChannel may already be closed.
    }
    try {
      const closing = channel.peer.close();
      closing?.catch?.(() => {});
    } catch {
      // The PeerConnection may already be closed.
    }
  }

  closeAll() {
    for (const channelId of [...this.channels.keys()]) this.close(channelId);
  }
}
