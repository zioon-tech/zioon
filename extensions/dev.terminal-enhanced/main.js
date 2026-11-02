import { installTerminalEnhancedPanel } from "./panel.js";
import { getTerminalSessionRequirementError } from "../dev.tools/terminal-tool-context.js";
import {
  runtimeDeviceServiceBaseUrl
} from "../../src/runtime/workbench-runtime-config.ts";

const I18N_NS = "dev.terminal-enhanced";
const TERMINAL_SESSION_REQUIRED_ERROR = "Missing session_id. Use terminal_inventory workspace preferred_session_id, or call terminalManage with action=\"list\" to choose a terminal session. Do not use machine_id, workspace_id, local, or ssh as session_id.";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.terminal": "终端",
    "cmd.openPanel": "打开终端面板",
    "cmd.togglePanel": "切换终端面板",
    "cmd.switchSession": "终端：切换会话",
    "cmd.switchSession.description": "打开终端会话切换器",
    "cmd.executeCommand": "执行终端命令",
    "cmd.quickCommand": "快速命令选择器",
    "cmd.toggleContext": "切换对话中的终端上下文",
    "ui.terminal": "终端",
    "ui.noTerminal": "无终端",
    "ui.local": "本地",
    "ui.ssh": "SSH",
    "ui.noSessions": "没有会话",
    "ui.newLocalSession": "新建本地会话",
    "ui.openManager": "打开终端管理器",
    "ui.switchSession": "切换终端会话",
    "ui.active": "当前",
    "ui.none": "无",
    "ui.clickOpenPanel": "点击打开终端面板",
    "panel.resize": "拖拽调整终端大小",
    "panel.scrollLeft": "向左滚动标签页",
    "panel.scrollRight": "向右滚动标签页",
    "panel.showAll": "显示所有会话",
    "panel.newSession": "新建终端会话",
    "panel.hide": "隐藏终端面板",
    "panel.hideEsc": "隐藏终端面板 (Esc)",
    "panel.commandPlaceholder": "输入命令并回车执行...",
    "panel.followLink": "打开链接 (Cmd+点击)",
    "panel.dockBottom": "将终端面板停靠到底部",
    "panel.dockRight": "将终端面板停靠到右侧",
    "panel.find": "查找",
    "panel.noSessionsHint": "没有会话（请用终端管理器创建）",
    "panel.reactivate": "激活",
    "panel.reactivateSsh": "激活 SSH 会话",
    "panel.reactivating": "激活中",
    "panel.loadingComponents": "正在加载终端组件...",
    "panel.ready": "终端已就绪。输入命令以开始。",
    "panel.historyPlaceholder": "搜索历史命令...",
    "panel.quickPlaceholder": "搜索并执行命令...",
    "panel.close": "关闭",
    "panel.noActiveSession": "没有活动会话",
    "panel.noActiveSessionCreate": "没有活动会话，请先创建或切换会话",
    "panel.reactivateFailed": "激活会话失败：{message}",
    "panel.ptyReconnectTriggered": "PTY 未连接，已触发重连",
    "panel.transportConnecting": "连接中",
    "panel.transportDirect": "直连",
    "panel.transportRelay": "中转",
    "panel.transportLocal": "本机",
    "panel.transportDisconnected": "重连中",
    "panel.transportDirectTitle": "WebRTC 点对点直连",
    "panel.transportRelayTitle": "经 Runtime HTTP 中转",
    "panel.transportFallbackReason": "回退原因",
    "slash.commandPalette.title": "命令面板（终端）",
    "slash.commandPalette.description": "打开终端快速命令选择器",
    "slash.history.title": "终端历史",
    "slash.history.description": "打开终端命令历史",
    "slash.switch.title": "切换终端会话",
    "slash.switch.description": "打开终端会话切换器"
  },
  "en-US": {
    "category.terminal": "Terminal",
    "cmd.openPanel": "Open Terminal Panel",
    "cmd.togglePanel": "Toggle Terminal Panel",
    "cmd.switchSession": "Terminal: Switch Session",
    "cmd.switchSession.description": "Open terminal session switcher",
    "cmd.executeCommand": "Execute Terminal Command",
    "cmd.quickCommand": "Quick Command Selector",
    "cmd.toggleContext": "Toggle Terminal Context in Chat",
    "ui.terminal": "Terminal",
    "ui.noTerminal": "No Terminal",
    "ui.local": "Local",
    "ui.ssh": "SSH",
    "ui.noSessions": "No sessions",
    "ui.newLocalSession": "New Local Session",
    "ui.openManager": "Open Terminal Manager",
    "ui.switchSession": "Switch terminal session",
    "ui.active": "Active",
    "ui.none": "None",
    "ui.clickOpenPanel": "Click to open terminal panel",
    "panel.resize": "Drag to resize terminal",
    "panel.scrollLeft": "Scroll tabs left",
    "panel.scrollRight": "Scroll tabs right",
    "panel.showAll": "Show all sessions",
    "panel.newSession": "New terminal session",
    "panel.hide": "Hide terminal panel",
    "panel.hideEsc": "Hide terminal panel (Esc)",
    "panel.commandPlaceholder": "Enter a command and press Enter to run...",
    "panel.followLink": "Follow link (Cmd+Click)",
    "panel.dockBottom": "Dock terminal panel to bottom",
    "panel.dockRight": "Dock terminal panel to right",
    "panel.find": "Find",
    "panel.noSessionsHint": "No sessions (use Terminal Manager to create)",
    "panel.reactivate": "Reactivate",
    "panel.reactivateSsh": "Reactivate SSH session",
    "panel.reactivating": "Reactivating",
    "panel.loadingComponents": "Loading terminal components...",
    "panel.ready": "Terminal ready. Type a command to start.",
    "panel.historyPlaceholder": "Search command history...",
    "panel.quickPlaceholder": "Search and run commands...",
    "panel.close": "Close",
    "panel.noActiveSession": "No active session",
    "panel.noActiveSessionCreate": "No active session. Create or switch to a session first.",
    "panel.reactivateFailed": "Failed to reactivate session: {message}",
    "panel.ptyReconnectTriggered": "PTY is not connected; reconnect triggered",
    "panel.transportConnecting": "Connecting",
    "panel.transportDirect": "Direct",
    "panel.transportRelay": "Relay",
    "panel.transportLocal": "Local",
    "panel.transportDisconnected": "Reconnecting",
    "panel.transportDirectTitle": "WebRTC peer-to-peer connection",
    "panel.transportRelayTitle": "Relayed through Runtime HTTP",
    "panel.transportFallbackReason": "Fallback reason",
    "slash.commandPalette.title": "Command Palette (Terminal)",
    "slash.commandPalette.description": "Open terminal quick command selector",
    "slash.history.title": "Terminal History",
    "slash.history.description": "Open terminal command history",
    "slash.switch.title": "Switch Terminal Session",
    "slash.switch.description": "Open terminal session switcher"
  }
};

function t(key, fallback, values) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function insertAfterLeadingSystem(messages, injectedMessage) {
  const list = Array.isArray(messages) ? messages : [];
  let insertAt = 0;
  while (insertAt < list.length && list[insertAt]?.role === "system") insertAt += 1;
  return [
    ...list.slice(0, insertAt),
    injectedMessage,
    ...list.slice(insertAt)
  ];
}

function buildRecentTerminalOutputsXml(outputs) {
  const recent = Array.isArray(outputs) ? outputs.slice(-8) : [];
  const entries = recent.map((r) => {
    const output = String(r?.output || "").split("\n").slice(0, 40).join("\n");
    const attrs = [
      `session_id="${escapeXml(r?.sessionId)}"`,
      `timestamp="${escapeXml(new Date(r?.timestamp || Date.now()).toISOString())}"`,
      r?.exitCode != null ? `exit_code="${escapeXml(r.exitCode)}"` : "",
      r?.duration != null ? `duration_ms="${escapeXml(r.duration)}"` : ""
    ].filter(Boolean).join(" ");
    return [
      `    <command_output ${attrs}>`,
      `      <command>${escapeXml(r?.command)}</command>`,
      `      <output>${escapeXml(output)}</output>`,
      "    </command_output>"
    ].join("\n");
  }).join("\n");
  return [
    "<terminal_recent_outputs>",
    "  <instructions>",
    "    These are recent terminal command outputs.",
    "    Use them as observed runtime evidence, including command, session, exit code, duration, and output.",
    "    Prefer this evidence over assumptions when reasoning about current environment state.",
    "  </instructions>",
    `  <outputs count="${recent.length}">`,
    entries,
    "  </outputs>",
    "</terminal_recent_outputs>"
  ].filter((line) => line !== "").join("\n");
}

/**
 * Read local tools base URL (shared convention with terminal-manager)
 */
function readBaseUrl() {
  const runtimeBase = runtimeDeviceServiceBaseUrl("local-tools");
  if (runtimeBase) return runtimeBase;
  const st1 = window.zion?.state?.get("localTools.baseUrl");
  if (typeof st1 === "string" && st1.trim()) return st1.trim();
  try {
    const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
    if (s) return s.trim();
  } catch {}
  return "http://127.0.0.1:8765";
}

/**
 * Push command output into terminal.outputs (keep max 100)
 */
function pushOutput(record) {
  try {
    const key = "terminal.outputs";
    const list = Array.isArray(window.zion?.state?.get(key)) ? window.zion.state.get(key) : [];
    const next = [...list, record];
    const trimmed = next.length > 100 ? next.slice(next.length - 100) : next;
    window.zion?.state?.set(key, trimmed);
  } catch (e) {
    console.warn("[dev.terminal-enhanced] pushOutput failed", e);
  }
}

function pushHistory(record) {
  try {
    const key = "terminal.history";
    const list = Array.isArray(window.zion?.state?.get(key)) ? window.zion.state.get(key) : [];
    const next = [...list, {
      id: record.id,
      sessionId: record.sessionId,
      command: record.command,
      timestamp: record.timestamp,
      duration: record.duration,
      exitCode: record.exitCode,
      success: record.success
    }];
    const trimmed = next.length > 500 ? next.slice(next.length - 500) : next;
    window.zion?.state?.set(key, trimmed);
    try {
      localStorage.setItem("zion.terminal.history", JSON.stringify(trimmed));
    } catch {}
  } catch (e) {
    console.warn("[dev.terminal-enhanced] pushHistory failed", e);
  }
}

/**
 * Execute a command on a session (POST /sessions/{id}/exec)
 * - Uses server's stdout/stderr and duration_ms
 * - Syncs CWD into terminal.sessions if provided
 */
async function executeInSession(sessionId, command, options = {}) {
  const base = readBaseUrl().replace(/\/$/, "");
  const payload = { command: String(command || ""), timeout: options.timeout && Number(options.timeout) || undefined };
  const started = Date.now();
  const url = `${base}/sessions/${encodeURIComponent(sessionId)}/exec`;
  const AS = globalThis.AbortSignal;
  const ctrl = typeof AS?.timeout === "function" && options.timeout ? { signal: AS.timeout(options.timeout) } : {};
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    ...(ctrl || {})
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  const clientDuration = Date.now() - started;

  const getCombinedOutput = (d) => {
    const stdout = typeof d?.stdout === "string" ? d.stdout : "";
    const stderr = typeof d?.stderr === "string" ? d.stderr : "";
    const fallbackMsg = d?.message || d?.error || "";
    if (stdout || stderr) {
      return `${stdout}${stdout && !stdout.endsWith("\n") && stderr ? "\n" : ""}${stderr}`.trimEnd();
    }
    return String(fallbackMsg || "");
  };

  const srvDuration = typeof data?.duration_ms === "number" ? data.duration_ms : clientDuration;
  const exitCode = typeof data?.exit_code === "number" ? data.exit_code : (data?.exitCode ?? (data?.code ?? (res.ok ? 0 : -1)));
  const combined = getCombinedOutput(data);

  const rec = {
    id: `rec_${Math.random().toString(36).slice(2)}`,
    sessionId,
    command: String(command || ""),
    output: combined,
    exitCode,
    truncated: data?.truncated === true,
    timestamp: Date.now(),
    duration: srvDuration,
    success: (typeof data?.ok === "boolean" ? data.ok : (exitCode === 0))
  };

  // Sync session cwd if server returned it
  try {
    if (typeof data?.cwd === "string" && data.cwd) {
      const sessions = window.zion?.state?.get("terminal.sessions") || [];
      const next = Array.isArray(sessions) ? sessions.map(s => (s?.id === sessionId ? { ...s, cwd: data.cwd } : s)) : sessions;
      window.zion?.state?.set("terminal.sessions", next);
    }
  } catch {}

  if (!options.silent) {
    pushOutput(rec);
    pushHistory(rec);
  }
  return rec;
}

const WEBRTC_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" }
];

function waitForIceGathering(peer, timeoutMs = 3000) {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

async function readSelectedIceRoute(peer) {
  if (typeof peer?.getStats !== "function") return {};
  try {
    const stats = await peer.getStats();
    const reports = [];
    stats.forEach((report) => reports.push(report));
    const transport = reports.find((report) =>
      report?.type === "transport" && report.selectedCandidatePairId
    );
    const selectedPair = transport
      ? stats.get(transport.selectedCandidatePairId)
      : reports.find((report) =>
          report?.type === "candidate-pair"
          && report.state === "succeeded"
          && (report.nominated || report.selected)
        );
    if (!selectedPair) return {};
    const local = stats.get(selectedPair.localCandidateId);
    const remote = stats.get(selectedPair.remoteCandidateId);
    const roundTripTime = Number(selectedPair.currentRoundTripTime);
    return {
      localCandidateType: String(local?.candidateType || ""),
      remoteCandidateType: String(remote?.candidateType || ""),
      protocol: String(local?.protocol || remote?.protocol || ""),
      ...(Number.isFinite(roundTripTime)
        ? { roundTripTimeMs: Math.max(0, Math.round(roundTripTime * 1000)) }
        : {})
    };
  } catch {
    return {};
  }
}

export function connectRuntimePtyWebRtc(
  baseUrl,
  sessionId,
  cols = 80,
  rows = 24,
  options = {}
) {
  if (typeof globalThis.RTCPeerConnection !== "function") {
    throw new Error("WebRTC is unavailable");
  }
  const base = String(baseUrl || "").replace(/\/$/, "");
  const sid = encodeURIComponent(String(sessionId || ""));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 4000);
  const socketState = { readyState: WebSocket.CONNECTING };
  const peer = new globalThis.RTCPeerConnection({
    iceServers: options.iceServers || WEBRTC_ICE_SERVERS
  });
  const dataChannel = peer.createDataChannel("zion-terminal", {
    ordered: true
  });
  dataChannel.binaryType = "arraybuffer";
  const outputDecoder = new TextDecoder();
  const controller = new AbortController();
  let channelId = "";
  let releasedChannelId = "";
  let readyTimer = 0;
  let disposed = false;
  let closed = false;
  let opened = false;
  let inputBuffer = "";
  let inputTimer = 0;
  let pendingResize = { cols, rows };
  let dataHandler = () => {};
  let errorHandler = () => {};
  let closeHandler = () => {};
  let readyResolve;
  let readyReject;
  const transportReady = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const request = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {})
      }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || `PTY WebRTC HTTP ${response.status}`);
    }
    return payload;
  };
  const releaseChannel = () => {
    if (!channelId || releasedChannelId === channelId) return;
    releasedChannelId = channelId;
    fetch(`${base}/sessions/${sid}/pty/webrtc/${encodeURIComponent(channelId)}`,
      { method: "DELETE", keepalive: true }).catch(() => {});
  };
  const finish = (error, notify = true) => {
    if (closed) return;
    closed = true;
    controller.abort();
    clearTimeout(readyTimer);
    clearTimeout(inputTimer);
    socketState.readyState = WebSocket.CLOSED;
    if (!opened && error) readyReject(error);
    try { dataChannel.close(); } catch {}
    try { peer.close(); } catch {}
    releaseChannel();
    if (error && notify) errorHandler(error);
    if (notify) closeHandler();
  };
  const sendControl = (value) => {
    if (!opened || disposed || dataChannel.readyState !== "open") return;
    if (dataChannel.bufferedAmount > 1024 * 1024) {
      finish(new Error("PTY WebRTC input buffer exceeded the size limit"));
      return;
    }
    dataChannel.send(JSON.stringify(value));
  };
  const flushInput = () => {
    inputTimer = 0;
    if (!inputBuffer || !opened || disposed) return;
    const data = inputBuffer;
    inputBuffer = "";
    sendControl({ type: "input", data });
  };
  dataChannel.onmessage = (event) => {
    if (typeof event.data === "string") {
      let control;
      try {
        control = JSON.parse(event.data);
      } catch {
        dataHandler(event.data);
        return;
      }
      if (control?.type === "ready") {
        opened = true;
        socketState.readyState = WebSocket.OPEN;
        if (pendingResize) {
          sendControl({ type: "resize", ...pendingResize });
          pendingResize = null;
        }
        flushInput();
        readyResolve();
      } else if (control?.type === "error") {
        finish(new Error(control.message || "PTY WebRTC failed"));
      } else if (control?.type === "close") {
        const tail = outputDecoder.decode();
        if (tail) dataHandler(tail);
        finish();
      }
      return;
    }
    const bytes = event.data instanceof ArrayBuffer
      ? new Uint8Array(event.data)
      : ArrayBuffer.isView(event.data)
        ? new Uint8Array(
            event.data.buffer,
            event.data.byteOffset,
            event.data.byteLength
          )
        : null;
    if (bytes) dataHandler(outputDecoder.decode(bytes, { stream: true }));
  };
  dataChannel.onerror = () => {
    finish(new Error("PTY WebRTC DataChannel failed"));
  };
  dataChannel.onclose = () => {
    if (!disposed) finish(new Error("PTY WebRTC DataChannel closed"));
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "failed") {
      finish(new Error("PTY WebRTC connection failed"));
    }
  };

  const ready = (async () => {
    const offer = await peer.createOffer();
    if (disposed || closed) throw new Error("PTY connection cancelled");
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer);
    if (disposed || closed) throw new Error("PTY connection cancelled");
    const local = peer.localDescription;
    if (!local?.sdp) throw new Error("PTY WebRTC offer is unavailable");
    const payload = await request(`/sessions/${sid}/pty/webrtc/offer`, {
      method: "POST",
      body: JSON.stringify({
        offer: { type: local.type, sdp: local.sdp },
        cols,
        rows
      })
    });
    channelId = String(payload?.channelId || "");
    if (disposed || closed) {
      releaseChannel();
      throw new Error("PTY connection cancelled");
    }
    if (!channelId || !payload?.answer?.sdp) {
      throw new Error("PTY WebRTC answer is unavailable");
    }
    await peer.setRemoteDescription(payload.answer);
    await Promise.race([
      transportReady,
      new Promise((_, reject) => {
        readyTimer = setTimeout(
          () => reject(new Error("PTY WebRTC connection timed out")),
          timeoutMs
        );
      })
    ]);
    clearTimeout(readyTimer);
  })().catch((error) => {
    finish(null, false);
    throw error;
  });

  return {
    transport: "webrtc",
    ws: socketState,
    ready,
    getDiagnostics() {
      return readSelectedIceRoute(peer);
    },
    send(data) {
      if (disposed || closed) return;
      inputBuffer += String(data || "");
      if (inputBuffer.length >= 4096) {
        clearTimeout(inputTimer);
        flushInput();
      } else if (!inputTimer) {
        inputTimer = setTimeout(flushInput, 4);
      }
    },
    resize(nextCols, nextRows) {
      pendingResize = {
        cols: Math.max(1, Number(nextCols) || 80),
        rows: Math.max(1, Number(nextRows) || 24)
      };
      if (opened) {
        sendControl({ type: "resize", ...pendingResize });
        pendingResize = null;
      }
    },
    onData(handler) {
      dataHandler = typeof handler === "function" ? handler : () => {};
      return { dispose() { dataHandler = () => {}; } };
    },
    onError(handler) {
      errorHandler = typeof handler === "function" ? handler : () => {};
    },
    onClose(handler) {
      closeHandler = typeof handler === "function" ? handler : () => {};
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(inputTimer);
      socketState.readyState = WebSocket.CLOSING;
      releaseChannel();
      finish(null, false);
    }
  };
}

export function connectRuntimePtyRelay(
  baseUrl,
  sessionId,
  cols = 80,
  rows = 24
) {
  const base = String(baseUrl || "").replace(/\/$/, "");
  const sid = encodeURIComponent(String(sessionId || ""));
  const socketState = { readyState: WebSocket.CONNECTING };
  const controller = new AbortController();
  let channelId = "";
  let disposed = false;
  let closed = false;
  let inputBuffer = "";
  let inputTimer = 0;
  let inputInFlight = false;
  let dataHandler = () => {};
  let errorHandler = () => {};
  let closeHandler = () => {};
  let writeQueue = Promise.resolve();
  const outputDecoder = new TextDecoder();

  const request = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || `PTY relay HTTP ${response.status}`);
    }
    return payload;
  };
  const finish = (error, notify = true) => {
    if (closed) return;
    closed = true;
    socketState.readyState = WebSocket.CLOSED;
    controller.abort();
    if (error && notify) errorHandler(error);
    if (notify) closeHandler();
  };
  const enqueueWrite = (operation) => {
    writeQueue = writeQueue.then(operation).catch((error) => {
      finish(error);
    });
    return writeQueue;
  };
  const flushInput = () => {
    inputTimer = 0;
    if (inputInFlight || disposed || closed || !inputBuffer) return;
    const data = inputBuffer;
    inputBuffer = "";
    inputInFlight = true;
    void enqueueWrite(async () => {
      await ready;
      if (disposed || !channelId) return;
      await request(
        `/sessions/${sid}/pty/relay/${encodeURIComponent(channelId)}/input`,
        {
          method: "POST",
          body: JSON.stringify({ type: "input", data })
        }
      );
    }).finally(() => {
      inputInFlight = false;
      if (inputBuffer && !disposed && !closed) {
        inputTimer = setTimeout(flushInput, 0);
      }
    });
  };
  const readEvents = async () => {
    while (!disposed && !closed) {
      const payload = await request(
        `/sessions/${sid}/pty/relay/${encodeURIComponent(channelId)}`
        + "/events?waitMs=15000"
      );
      for (const event of payload?.events || []) {
        if (event?.type === "data" && event.dataBase64) {
          const binary = globalThis.atob(String(event.dataBase64));
          const bytes = Uint8Array.from(binary, (character) =>
            character.charCodeAt(0)
          );
          dataHandler(outputDecoder.decode(bytes, { stream: true }));
        } else if (event?.type === "error") {
          errorHandler(new Error(event.message || "PTY relay failed"));
        }
      }
      if (payload?.closed) {
        const tail = outputDecoder.decode();
        if (tail) dataHandler(tail);
        finish();
        return;
      }
    }
  };
  const ready = request(`/sessions/${sid}/pty/relay/open`, {
    method: "POST",
    body: JSON.stringify({ cols, rows })
  }).then((payload) => {
    channelId = String(payload?.channelId || "");
    if (!channelId) throw new Error("PTY relay returned no channel");
    socketState.readyState = WebSocket.OPEN;
    void readEvents().catch((error) => {
      if (!disposed) finish(error);
    });
  });

  return {
    transport: "relay",
    ws: socketState,
    ready,
    send(data) {
      if (disposed) return;
      inputBuffer += String(data || "");
      if (inputBuffer.length >= 4096) {
        clearTimeout(inputTimer);
        flushInput();
      } else if (!inputTimer) {
        inputTimer = setTimeout(flushInput, 4);
      }
    },
    resize(nextCols, nextRows) {
      enqueueWrite(async () => {
        await ready;
        if (disposed || !channelId) return;
        await request(
          `/sessions/${sid}/pty/relay/${encodeURIComponent(channelId)}/input`,
          {
            method: "POST",
            body: JSON.stringify({
              type: "resize",
              cols: nextCols,
              rows: nextRows
            })
          }
        );
      });
    },
    onData(handler) {
      dataHandler = typeof handler === "function" ? handler : () => {};
      return { dispose() { dataHandler = () => {}; } };
    },
    onError(handler) {
      errorHandler = typeof handler === "function" ? handler : () => {};
    },
    onClose(handler) {
      closeHandler = typeof handler === "function" ? handler : () => {};
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(inputTimer);
      socketState.readyState = WebSocket.CLOSING;
      const closingChannelId = channelId;
      if (closingChannelId) {
        fetch(
          `${base}/sessions/${sid}/pty/relay/`
          + encodeURIComponent(closingChannelId),
          { method: "DELETE", keepalive: true }
        ).catch(() => {});
      }
      finish(null, false);
    }
  };
}

export function connectRuntimePty(
  baseUrl,
  sessionId,
  cols = 80,
  rows = 24
) {
  const socketState = { readyState: WebSocket.CONNECTING };
  let active = null;
  let attempt = null;
  let disposed = false;
  let queuedInput = "";
  let queuedResize = { cols, rows };
  let dataHandler = () => {};
  let errorHandler = () => {};
  let closeHandler = () => {};
  let transportStatus = { transport: "connecting", phase: "webrtc" };
  const transportHandlers = new Set();

  const wire = (connection) => {
    connection.onData((chunk) => {
      if (!disposed && (active === connection || attempt === connection)) dataHandler(chunk);
    });
    connection.onError((error) => {
      if (active === connection && !disposed) {
        socketState.readyState = WebSocket.CLOSED;
        errorHandler(error);
      }
    });
    connection.onClose(() => {
      if (active === connection && !disposed) {
        socketState.readyState = WebSocket.CLOSED;
        closeHandler();
      }
    });
  };
  const setTransportStatus = (next) => {
    transportStatus = { ...transportStatus, ...next };
    for (const handler of [...transportHandlers]) {
      try { handler({ ...transportStatus }); } catch {}
    }
  };
  const activate = async (connection) => {
    active = connection;
    await connection.ready;
    if (disposed) {
      connection.dispose();
      throw new Error("PTY connection cancelled");
    }
    if (connection.ws.readyState !== WebSocket.OPEN) throw new Error("PTY connection closed");
    socketState.readyState = WebSocket.OPEN;
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
    let negotiationTimer = 0;
    try {
      attempt = connectRuntimePtyWebRtc(baseUrl, sessionId, cols, rows);
      wire(attempt);
      await Promise.race([
        attempt.ready,
        new Promise((_, reject) => {
          negotiationTimer = setTimeout(
            () => reject(new Error("PTY WebRTC negotiation timed out")),
            5000
          );
        })
      ]);
      clearTimeout(negotiationTimer);
      await activate(attempt);
      setTransportStatus({ transport: "webrtc", phase: "connected" });
      void attempt.getDiagnostics?.().then((diagnostics) => {
        if (active === attempt && !disposed) {
          setTransportStatus({
            transport: "webrtc",
            phase: "connected",
            ...diagnostics
          });
        }
      });
      console.info("[dev.terminal-enhanced] PTY transport: WebRTC");
    } catch (error) {
      clearTimeout(negotiationTimer);
      try { attempt?.dispose?.(); } catch {}
      if (disposed) throw error;
      const fallbackReason = error?.message || String(error);
      console.info(
        "[dev.terminal-enhanced] WebRTC unavailable; using Runtime relay:",
        fallbackReason
      );
      setTransportStatus({
        transport: "connecting",
        phase: "relay",
        fallbackReason
      });
      attempt = connectRuntimePtyRelay(baseUrl, sessionId, cols, rows);
      wire(attempt);
      await activate(attempt);
      setTransportStatus({
        transport: "relay",
        phase: "connected",
        fallbackReason
      });
    }
  })();

  return {
    get transport() {
      return active?.transport || "connecting";
    },
    get transportStatus() {
      return { ...transportStatus };
    },
    ws: socketState,
    ready,
    send(data) {
      if (disposed) return;
      if (active && socketState.readyState === WebSocket.OPEN) {
        active.send(data);
      } else {
        queuedInput += String(data || "");
      }
    },
    resize(nextCols, nextRows) {
      if (disposed) return;
      queuedResize = { cols: nextCols, rows: nextRows };
      if (active && socketState.readyState === WebSocket.OPEN) {
        active.resize(nextCols, nextRows);
        queuedResize = null;
      }
    },
    onData(handler) {
      dataHandler = typeof handler === "function" ? handler : () => {};
      return { dispose() { dataHandler = () => {}; } };
    },
    onError(handler) {
      errorHandler = typeof handler === "function" ? handler : () => {};
    },
    onClose(handler) {
      closeHandler = typeof handler === "function" ? handler : () => {};
    },
    onTransportChange(handler) {
      if (typeof handler !== "function") return { dispose() {} };
      transportHandlers.add(handler);
      handler({ ...transportStatus });
      return { dispose: () => transportHandlers.delete(handler) };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      transportHandlers.clear();
      socketState.readyState = WebSocket.CLOSING;
      try { attempt?.dispose?.(); } catch {}
      socketState.readyState = WebSocket.CLOSED;
    }
  };
}

export function connectCommandRelay(sessionId) {
  const ws = { readyState: WebSocket.OPEN };
  let input = "";
  let disposed = false;
  let dataHandler = () => {};
  let errorHandler = () => {};
  let closeHandler = () => {};
  let queue = Promise.resolve();
  const setupCommand = /^(?:export (?:TERM|COLORTERM|CLICOLOR)=|alias ls=|ls --color=auto)/;
  const emit = (value) => {
    if (!disposed) dataHandler(String(value || ""));
  };
  const execute = (command, visible) => {
    queue = queue.then(async () => {
      if (visible) emit(`\r\n$ ${command}\r\n`);
      const result = await executeInSession(sessionId, command, {
        timeout: 120_000,
        silent: true
      });
      if (visible && result.output) {
        emit(`${String(result.output).replace(/\n/g, "\r\n")}\r\n`);
      }
      if (visible) emit("$ ");
    }).catch((error) => {
      errorHandler(error);
      emit(`\r\n${error?.message || String(error)}\r\n$ `);
    });
  };
  const ready = Promise.resolve().then(() => {
    emit("Remote command mode via Device Connector\r\n$ ");
  });

  return {
    transport: "command",
    ws,
    ready,
    send(value) {
      if (disposed) return;
      const chunk = String(value || "");
      const complete = !input && /[\r\n]$/.test(chunk);
      if (complete && setupCommand.test(chunk.trim())) {
        execute(chunk.trim(), false);
        return;
      }
      for (const character of chunk) {
        if (character === "\u0003") {
          input = "";
          emit("^C\r\n$ ");
          continue;
        }
        if (character === "\u007f" || character === "\b") {
          if (input) {
            input = input.slice(0, -1);
            emit("\b \b");
          }
          continue;
        }
        if (character === "\r" || character === "\n") {
          const command = input.trim();
          input = "";
          if (command) execute(command, true);
          else emit("\r\n$ ");
          continue;
        }
        if (character >= " ") {
          input += character;
          emit(character);
        }
      }
    },
    resize() {},
    onData(handler) {
      dataHandler = typeof handler === "function" ? handler : () => {};
      return { dispose() { dataHandler = () => {}; } };
    },
    onError(handler) {
      errorHandler = typeof handler === "function" ? handler : () => {};
    },
    onClose(handler) {
      closeHandler = typeof handler === "function" ? handler : () => {};
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ws.readyState = WebSocket.CLOSED;
      closeHandler();
    }
  };
}

/**
 * Connect PTY via WebSocket for interactive terminal
 * - Returns { send(data), resize(cols, rows), dispose() }
 */
export function connectPty(sessionId, cols = 80, rows = 24) {
  const base = readBaseUrl().replace(/\/$/, "");
  if (base.includes("/v1/device-services/")) {
    return connectRuntimePty(base, sessionId, cols, rows);
  }
  const wsUrl = base.replace(/^http/i, "ws") + `/sessions/${encodeURIComponent(sessionId)}/pty/ws`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";
  const outputDecoder = new TextDecoder();
  let dataHandler = () => {};

  let openResolve;
  let openReject;
  let opened = false;
  const ready = new Promise((res, rej) => {
    openResolve = res;
    openReject = rej;
  });

  ws.onopen = () => {
    opened = true;
    // Send initial resize
    try {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    } catch {}
    openResolve?.();
  };

  ws.onerror = (e) => {
    try {
      if (!opened) openReject?.(e instanceof Error ? e : new Error("WebSocket error"));
    } catch {}
  };

  ws.onclose = () => {
    const tail = outputDecoder.decode();
    if (tail) dataHandler(tail);
    try {
      if (!opened) openReject?.(new Error("WebSocket closed"));
    } catch {}
  };

  return {
    transport: "local",
    ws,
    ready,
    send(data) {
      // data is string; convert to UTF-8 bytes for safer transmission
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      } catch {}
    },
    resize(c, r) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols: c, rows: r }));
        }
      } catch {}
    },
    onData(handler) {
      dataHandler = handler;
      ws.onmessage = (ev) => {
        try {
          if (ev.data instanceof ArrayBuffer) {
            const text = outputDecoder.decode(new Uint8Array(ev.data), { stream: true });
            handler(text);
          } else if (typeof ev.data === "string") {
            handler(ev.data);
          }
        } catch {}
      };
    },
    onError(handler) {
      ws.addEventListener("error", (e) => handler(e));
    },
    onClose(handler) {
      ws.addEventListener("close", () => handler());
    },
    dispose() {
      try { ws.close(); } catch {}
    }
  };
}

/**
 * Reactivate a session (for SSH sessions that have disconnected)
 */
async function reactivateSession(sessionId) {
  try {
    const base = readBaseUrl().replace(/\/$/, "");
    const res = await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.session) {
      // Update the session in the state
      const sessions = window.zion?.state?.get("terminal.sessions") || [];
      const list = Array.isArray(sessions) ? sessions : [];
      const idx = list.findIndex(s => s?.id === sessionId);
      if (idx >= 0) {
        list[idx] = data.session;
        window.zion?.state?.set("terminal.sessions", list);
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Ensure sessions list is populated at least once
 */
async function ensureSessions() {
  const list = window.zion?.state?.get("terminal.sessions");
  if (Array.isArray(list) && list.length) return list;
  try {
    const base = readBaseUrl().replace(/\/$/, "");
    const res = await fetch(`${base}/sessions`, { method: "GET" });
    const data = await res.json().catch(() => null);
    if (res.ok) {
      const arr = Array.isArray(data?.sessions) ? data.sessions : [];
      window.zion?.state?.set("terminal.sessions", arr);
      return arr;
    }
  } catch {}
  return Array.isArray(list) ? list : [];
}

export async function activate(ctx) {
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  try {
    const st = window.zion?.state;
    if (st && !Array.isArray(st.get("terminal.history"))) {
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem("zion.terminal.history") || "null");
      } catch {}
      if (Array.isArray(saved)) {
        st.set("terminal.history", saved.slice(-500));
      } else {
        st.set("terminal.history", []);
      }
    }
  } catch {}

  // 1) Quick Commands seed
  const defaultQuick = {
    build: "npm run build && npm test",
    deploy: "npm run build && npm run deploy",
    logs: "tail -f logs/app.log"
  };
  try {
    const exists = window.zion?.state?.get("terminal.quickCommands");
    if (!exists) window.zion?.state?.set("terminal.quickCommands", defaultQuick);
  } catch {}

  // 2) Register tool schema: terminalExecute
  try {
    const tools = Array.isArray(window.zion?.state?.get("chat.tools")) ? window.zion.state.get("chat.tools") : [];
    const exists = new Set(tools.map(t => t?.function?.name).filter(Boolean));
    if (!exists.has("terminalExecute")) {
      tools.push({
        type: "function",
        function: {
          name: "terminalExecute",
          description: "Execute a command in an explicitly selected terminal session and return output. session_id is required and must be an exact terminal session id from terminal_inventory workspace preferred_session_id or terminalManage list sessions[].session_id. Do not pass machine_id, workspace_id, local, or ssh.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Shell command to execute" },
              session_id: { type: "string", description: "Required exact terminal session_id. Do not use machine_id, workspace_id, local, or ssh." },
              timeout: { type: "number", description: "Timeout milliseconds", default: 30000 },
              capture_ansi: { type: "boolean", description: "No-op on server; output already plain text", default: false }
            },
            required: ["command", "session_id"],
            additionalProperties: false
          }
        }
      });
      window.zion?.state?.set("chat.tools", tools);
    }

    const handlers = { ...(window.zion?.state?.get("chat.toolHandlers") || {}) };
    if (!handlers.terminalExecute) {
      handlers.terminalExecute = async (args) => {
        const cmd = String(args?.command || "").trim();
        if (!cmd) return "Missing command";
        const sid = String(args?.session_id || "").trim();
        const terminalSessions = window.zion?.state?.get("terminal.sessions") || [];
        const requirementError = getTerminalSessionRequirementError("terminalExecute", { session_id: sid }, terminalSessions);
        if (requirementError) return requirementError || TERMINAL_SESSION_REQUIRED_ERROR;
        await ensureSessions();
        const timeout = typeof args?.timeout === "number" ? args.timeout : 30000;
        const rec = await executeInSession(sid, cmd, { timeout });
        return JSON.stringify({
          session_id: sid,
          command: rec.command,
          output: rec.output,
          exitCode: rec.exitCode,
          duration: rec.duration,
          success: rec.success
        }, null, 2);
      };
      window.zion?.state?.set("chat.toolHandlers", handlers);
    }
  } catch (e) {
    console.warn("[dev.terminal-enhanced] register tool failed", e);
  }

  const VIEW_ID = "terminal.enhanced.view";
  const AUX_VIEW_ID = "terminal.enhanced.aux.view";
  let bottomPanel = null;
  let auxPanel = null;
  const prewarmTerminalClientModules = () => {
    const load = () => Promise.allSettled([
      import("xterm/css/xterm.css?url"),
      import("xterm"),
      import("xterm-addon-fit"),
      import("xterm-addon-search"),
      import("xterm-addon-web-links")
    ]).catch(() => {});
    try {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(() => { void load(); }, { timeout: 3000 });
      } else {
        window.setTimeout(() => { void load(); }, 1200);
      }
    } catch {}
  };
  prewarmTerminalClientModules();

  const ensureBottomPanelReady = async () => {
    try {
      window.zion.bottomPanel?.activateView?.(VIEW_ID);
    } catch {}
    for (let i = 0; i < 40; i++) {
      if (bottomPanel) return bottomPanel;
      await new Promise((r) => setTimeout(r, 25));
    }
    return bottomPanel;
  };

  const ensureAuxPanelReady = async () => {
    try {
      window.zion.auxiliaryBar?.activateView?.(AUX_VIEW_ID);
    } catch {}
    for (let i = 0; i < 40; i++) {
      if (auxPanel) return auxPanel;
      await new Promise((r) => setTimeout(r, 25));
    }
    return auxPanel;
  };

  const openWhenReady = async (getHandle) => {
    for (let i = 0; i < 40; i++) {
      const h = getHandle();
      if (h && typeof h.open === "function") {
        try {
          h.open();
        } catch {}
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  const isPanelVisible = () => {
    try {
      const v = window.zion?.state?.get("ui.bottomPanel.visible");
      return v === true;
    } catch {
      return false;
    }
  };

  // 3) Register commands
  const cmdOpen = window.zion.commands.registerCommand("terminal.openPanel", async () => {
    const h = await ensureBottomPanelReady();
    try { h?.open?.(); } catch {}
  });
  const cmdToggle = window.zion.commands.registerCommand("terminal.togglePanel", async () => {
    if (isPanelVisible()) {
      try { window.zion.bottomPanel?.hide?.(); } catch {}
      return;
    }
    const lastOpenedViewId = (() => {
      try { return window.zion?.bottomPanel?.getLastOpenedViewId?.() || ""; } catch { return ""; }
    })();
    if (lastOpenedViewId && lastOpenedViewId !== VIEW_ID) {
      try { window.zion.bottomPanel?.activateView?.(lastOpenedViewId); } catch {}
      return;
    }
    const h = await ensureBottomPanelReady();
    try { h?.open?.(); } catch {}
  });
  const cmdOpenHistory = window.zion.commands.registerCommand("terminal.openHistory", async () => {
    const h = await ensureBottomPanelReady();
    try { h?.open?.({ openHistory: true }); } catch {}
  });
  const cmdOpenAux = window.zion.commands.registerCommand("terminal.openAuxPanel", async () => {
    try {
      window.zion.auxiliaryBar?.activateView?.(AUX_VIEW_ID);
    } catch {}
  });
  const cmdToggleAux = window.zion.commands.registerCommand("terminal.toggleAuxPanel", async () => {
    try {
      const visible = window.zion?.state?.get("ui.auxiliaryBar.visible") === true;
      const active = window.zion?.state?.get("ui.auxiliaryBar.activeViewId") === AUX_VIEW_ID;
      if (visible && active) window.zion.auxiliaryBar?.hide?.();
      else window.zion.auxiliaryBar?.activateView?.(AUX_VIEW_ID);
    } catch {}
  });
  const cmdExec = window.zion.commands.registerCommand("terminal.executeCommand", async (args) => {
    const command = typeof args === "string" ? args : String(args?.command || "").trim();
    const sessionId = typeof args === "object" && args?.session_id ? String(args.session_id).trim() : "";
    if (!command) return false;
    if (!sessionId) return TERMINAL_SESSION_REQUIRED_ERROR;
    try {
      const silent = typeof args === "object" && (args?.silent === true || args?.internal === true);
      const rec = await executeInSession(sessionId, command, {
        timeout: Number(args?.timeout || 30000),
        silent
      });
      if (!silent) window.zion.events.emit("terminal/commandExecuted", rec);
      return rec;
    } catch (e) {
      return `terminal.executeCommand error: ${e?.message || String(e)}`;
    }
  });
  const cmdQuick = window.zion.commands.registerCommand("terminal.quickCommand", async () => {
    const h = await ensureBottomPanelReady();
    try { h?.open?.({ openQuick: true }); } catch {}
  });
  const cmdReactivate = window.zion.commands.registerCommand("terminal.reactivateSession", async (args) => {
    const sid = typeof args === "string" ? args : args?.session_id;
    const sessionId = String(sid || "").trim();
    if (!sessionId) return false;
    try {
      return await reactivateSession(sessionId);
    } catch {
      return false;
    }
  });
  const cmdToggleCtx = window.zion.commands.registerCommand("terminal.toggleContext", () => {
    const cur = window.zion?.state?.get("chat.includeTerminalContext");
    const next = cur === false ? true : false;
    window.zion?.state?.set("chat.includeTerminalContext", next);
    return next;
  });
  ctx.subscriptions.push(cmdOpen, cmdToggle, cmdOpenHistory, cmdOpenAux, cmdToggleAux, cmdExec, cmdQuick, cmdReactivate, cmdToggleCtx);

  // 4) Register keybindings
  try {
    ctx.subscriptions.push(
      window.zion.keybindings.register({ command: "terminal.openPanel", key: "Mod-`", when: "editorFocus" })
    );
    ctx.subscriptions.push(
      window.zion.keybindings.register({ command: "terminal.quickCommand", key: "Mod-Shift-P", when: "editorFocus" })
    );
    ctx.subscriptions.push(
      window.zion.keybindings.register({ command: "terminal.openHistory", key: "Mod-Shift-H", when: "editorFocus" })
    );
    window.zion.__applyKeymap?.();
  } catch (e) {
    console.warn("[dev.terminal-enhanced] keybindings register failed", e);
  }

  const onGlobalKeydown = (e) => {
    try {
      if (e?.defaultPrevented || e?.isComposing || e?.keyCode === 229) return;
      if (!(e?.metaKey || e?.ctrlKey) || e?.altKey) return;
      if (String(e.key || "").toLowerCase() !== "j") return;
      const inTerminal = !!e.target?.closest?.(".zion-terminal-enhanced-root");
      if (inTerminal && e.ctrlKey && !e.metaKey && !e.shiftKey) return;
      if (e.shiftKey && !(inTerminal && e.ctrlKey && !e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      window.zion?.commands?.executeCommand?.("terminal.togglePanel");
    } catch {}
  };
  try {
    window.addEventListener("keydown", onGlobalKeydown, true);
    ctx.subscriptions.push({ dispose: () => window.removeEventListener("keydown", onGlobalKeydown, true) });
  } catch {}

  // 5) Register message contributor for terminal context
  try {
    const disp = window.zion.messages.registerContributor({
      id: "dev.terminal-enhanced.context",
      order: 60,
      stage: "pre",
      contribute: async (messages, ctx) => {
        try {
          const include = window.zion?.state?.get("chat.includeTerminalContext");
          if (include === false) return messages;
            const includeRecentOutputs = window.zion?.state?.get("chat.includeRecentTerminalOutputs");
            if (includeRecentOutputs !== true) return messages;
          const outputs = window.zion?.state?.get("terminal.outputs") || [];
          if (!Array.isArray(outputs) || outputs.length === 0) return messages;
          const injectedMessage = { role: "user", content: buildRecentTerminalOutputsXml(outputs) };
          return insertAfterLeadingSystem(messages, injectedMessage);
        } catch {
          return messages;
        }
      }
    });
    ctx.subscriptions.push(disp);
  } catch (e) {
    console.warn("[dev.terminal-enhanced] message contributor failed", e);
  }

  // 7) Register as bottom panel view
  try {
    const dispView = window.zion.bottomPanel?.registerView?.({
      id: VIEW_ID,
      pluginId: "dev.terminal-enhanced",
      title: "Terminal",
      titleKey: "dev.terminal-enhanced.ui.terminal",
      icon: "$(remote)",
      order: 10,
      keepWhenActive: true,
      maximizable: true,
      onActivate: () => {
        try {
          bottomPanel?.open?.({ focusCommand: true });
        } catch {}
      },
      component: {
        render: (container) => {
          const h = installTerminalEnhancedPanel(
            {
              execute: async (command, sessionId) => {
                return await window.zion.commands.executeCommand("terminal.executeCommand", { command, session_id: sessionId });
              },
              connectPty,
              requestClose: () => {
                try { window.zion.bottomPanel?.hide?.(); } catch {}
              }
            },
            { mount: container, rootId: "zion-terminal-enhanced-root-bottom", embedTabsInBottomHeader: true }
          );
          bottomPanel = h;
          try { h?.preload?.(); } catch {}
          try {
            setTimeout(() => {
              try {
                h?.open?.();
              } catch {}
            }, 0);
          } catch {}
          return {
            dispose: () => {
              try { bottomPanel?.dispose?.(); } catch {}
              bottomPanel = null;
            }
          };
        }
      }
    });
    if (dispView) ctx.subscriptions.push(dispView);
  } catch (e) {
    console.warn("[dev.terminal-enhanced] bottomPanel register failed", e);
  }

  // Prefer terminal as the default bottom panel view when opening Bottom Panel
  try {
    const st = window.zion.state;
    const cur = st?.get?.("ui.bottomPanel.activeViewId");
    if (!cur) {
      st?.set?.("ui.bottomPanel.activeViewId", VIEW_ID);
    }
    const disp = st?.onDidChange?.("ui.bottomPanel.visible", (nv) => {
      if (!nv) return;
      const active = st?.get?.("ui.bottomPanel.activeViewId");
      if (active === VIEW_ID) return;
      if (!active) {
        window.zion.bottomPanel?.activateView?.(VIEW_ID);
      }
    });
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  // 7.1) Also register as auxiliary bar view (for evaluation)
  try {
    const dispAuxView = window.zion.auxiliaryBar?.registerView?.({
      id: AUX_VIEW_ID,
      pluginId: "dev.terminal-enhanced",
      title: "Terminal",
      titleKey: "dev.terminal-enhanced.ui.terminal",
      icon: "$(remote)",
      order: 30,
      keepWhenActive: true,
      onActivate: () => {
        try {
          auxPanel?.open?.({ focusCommand: true });
        } catch {}
      },
      component: {
        render: (container) => {
          const h = installTerminalEnhancedPanel(
            {
              execute: async (command, sessionId) => {
                return await window.zion.commands.executeCommand("terminal.executeCommand", { command, session_id: sessionId });
              },
              connectPty,
              requestClose: () => {
                try { window.zion.auxiliaryBar?.hide?.(); } catch {}
              }
            },
            { mount: container, rootId: "zion-terminal-enhanced-root-aux" }
          );
          auxPanel = h;
          try { h?.preload?.(); } catch {}
          try {
            setTimeout(() => {
              try {
                h?.open?.();
              } catch {}
            }, 0);
          } catch {}
          return {
            dispose: () => {
              try { auxPanel?.dispose?.(); } catch {}
              auxPanel = null;
            }
          };
        }
      }
    });
    if (dispAuxView) ctx.subscriptions.push(dispAuxView);
  } catch (e) {
    console.warn("[dev.terminal-enhanced] auxiliaryBar register failed", e);
  }

  // 8) Initial sessions sync to ensure panel has data
  try { await ensureSessions(); } catch {}

  // 9) Bottom bar: active terminal indicator + switcher
  try {
    let wrap = null;
    let infoBtn = null;
    let triggerBtn = null;
    let menuEl = null;
    let cleanupMenu = null;
    let deferred = null;

    const ensureBottomRight = () => {
      const bar = document.getElementById("bottombar");
      if (!bar) return null;
      let right = document.getElementById("bottombar-right");
      if (!right) {
        right = document.createElement("div");
        right.id = "bottombar-right";
        bar.appendChild(right);
      }
      return right;
    };

    const getBasename = (p) => {
      const s = String(p || "").trim();
      if (!s) return "";
      const parts = s.split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : s;
    };

    const getSessionDisplayName = (s) => {
      if (!s || typeof s !== "object") return t("ui.terminal", "Terminal");
      const name = String(s.name || s.label || "").trim();
      if (name) return name;
      const type = String(s.type || "local").trim() || "local";
      const cwd = String(s.cwd || "").trim();
      const cwdBase = getBasename(cwd);
      if (type === "ssh") {
        const user = String(s.ssh_user || "").trim();
        const host = String(s.ssh_host || "").trim();
        const conn = `${user ? `${user}@` : ""}${host || "SSH"}`;
        return cwdBase ? `${conn} · ${cwdBase}` : conn;
      }
      return cwdBase || t("ui.local", "Local");
    };

    const getInfoText = () => {
      const sid = window.zion?.state?.get("terminal.activeSessionId");
      const activeId = typeof sid === "string" ? sid : "";
      const sessions = window.zion?.state?.get("terminal.sessions");
      const list = Array.isArray(sessions) ? sessions : [];
      const cur = list.find(s => s?.id === activeId) || null;
      const name = cur ? getSessionDisplayName(cur) : t("ui.noTerminal", "No Terminal");
      return name;
    };

    const setActiveSession = async (sid) => {
      const sessionId = String(sid || "").trim();
      if (!sessionId) return false;
      try {
        await window.zion.commands.executeCommand("terminal.setActiveSession", { session_id: sessionId });
        return true;
      } catch {
        try { window.zion?.state?.set("terminal.activeSessionId", sessionId); } catch {}
        return true;
      }
    };

    const closeMenu = () => {
      try { cleanupMenu?.(); } catch {}
      cleanupMenu = null;
      try { menuEl?.remove?.(); } catch {}
      menuEl = null;
    };

    const positionMenu = () => {
      if (!menuEl || !triggerBtn) return;
      const r = triggerBtn.getBoundingClientRect();
      const mw = menuEl.offsetWidth || 200;
      const mh = menuEl.offsetHeight || 120;
      const pad = 8;
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      let left = Math.round(r.right - mw);
      let top = Math.round(r.top - 6 - mh);
      if (top < pad) top = Math.round(r.bottom + 6);
      left = Math.max(pad, Math.min(left, Math.max(pad, vw - mw - pad)));
      top = Math.max(pad, Math.min(top, Math.max(pad, vh - mh - pad)));
      menuEl.style.left = `${left}px`;
      menuEl.style.top = `${top}px`;
    };

    const renderMenu = async () => {
      if (!menuEl) return;
      menuEl.innerHTML = "";

      const addItem = (label, onClick, opts) => {
        const row = document.createElement("div");
        row.className = "zion-context-menu-row";
        const it = document.createElement("button");
        it.className = "zion-context-menu-item";
        it.type = "button";
        it.textContent = label;
        if (opts?.disabled) {
          it.style.opacity = "0.6";
          it.style.cursor = "default";
          it.disabled = true;
        } else if (typeof onClick === "function") {
          it.onclick = async (e) => {
            try { e.stopPropagation(); } catch {}
            try { await onClick(); } catch {}
            closeMenu();
          };
        }
        row.appendChild(it);
        menuEl.appendChild(row);
      };

      const addDivider = () => {
        const div = document.createElement("div");
        div.style.height = "1px";
        div.style.margin = "4px 6px";
        div.style.background = "var(--border)";
        menuEl.appendChild(div);
      };

      const sessions = await ensureSessions();
      const list = Array.isArray(sessions) ? sessions : [];
      const activeId = String(window.zion?.state?.get("terminal.activeSessionId") || "");
      if (!list.length) {
        addItem(t("ui.noSessions", "No sessions"), null, { disabled: true });
        return;
      }

      for (const s of list.slice(0, 12)) {
        const sid = String(s?.id || "").trim();
        if (!sid) continue;
        const prefix = sid === activeId ? "✓ " : "";
        const label = `${prefix}${getSessionDisplayName(s)}`;
        addItem(label, async () => {
          await setActiveSession(sid);
        });
      }

      addDivider();
      addItem(t("ui.newLocalSession", "New Local Session"), async () => {
        try {
          await window.zion.commands.executeCommand("terminal.createSession", { type: "local" });
          await window.zion.commands.executeCommand("terminal.openPanel");
        } catch {}
      });
      addItem(t("ui.openManager", "Open Terminal Manager"), () => window.zion.commands.executeCommand("terminal.openManager"));
    };

    const openMenu = async () => {
      if (menuEl) return closeMenu();
      const menu = document.createElement("div");
      menu.className = "zion-context-menu zion-terminal-bottombar-menu";
      menu.style.position = "fixed";
      menu.style.zIndex = "99999";
      menu.style.maxWidth = "260px";
      menu.style.width = "auto";
      menu.style.minWidth = "200px";
      menu.style.maxHeight = "60vh";
      menu.style.overflowY = "auto";
      document.body.appendChild(menu);
      menuEl = menu;
      await renderMenu();
      positionMenu();

      const escHandler = (ev) => {
        if (ev.key === "Escape") closeMenu();
      };
      const clickAway = (ev) => {
        try {
          const t = ev.target;
          if (!t) return closeMenu();
          if (menuEl && menuEl.contains(t)) return;
          if (wrap && wrap.contains(t)) return;
          closeMenu();
        } catch {
          closeMenu();
        }
      };
      const resizeHandler = () => {
        try { positionMenu(); } catch {}
      };

      document.addEventListener("keydown", escHandler);
      document.addEventListener("mousedown", clickAway, true);
      window.addEventListener("resize", resizeHandler, { passive: true });

      cleanupMenu = () => {
        document.removeEventListener("keydown", escHandler);
        document.removeEventListener("mousedown", clickAway, true);
        window.removeEventListener("resize", resizeHandler);
      };
    };

    const switchSession = async () => {
      try { await ensureSessions(); } catch {}
      try { ensureControl(); } catch {}
      try { await openMenu(); } catch {}
      return true;
    };

    const ensureControl = () => {
      const right = ensureBottomRight();
      if (!right) return null;
      if (!wrap || !wrap.isConnected) {
        wrap = document.createElement("div");
        wrap.className = "zion-terminal-bottombar-switcher";
        wrap.setAttribute("data-zion-bottombar-terminal", "1");

        infoBtn = document.createElement("button");
        infoBtn.type = "button";
        infoBtn.className = "zion-terminal-bottombar-info";
        infoBtn.innerHTML = '<span class="zion-terminal-bottombar-label"></span>';
        infoBtn.onclick = (e) => {
          try { e.stopPropagation(); } catch {}
          try { window.zion.commands.executeCommand("terminal.togglePanel"); } catch {}
        };

        triggerBtn = document.createElement("button");
        triggerBtn.type = "button";
        triggerBtn.className = "zion-terminal-bottombar-trigger";
        triggerBtn.setAttribute("aria-label", t("ui.switchSession", "Switch terminal session"));
        triggerBtn.innerHTML = window.zionIcons?.htmlFromCodicon?.("terminal") || '<span class="codicon codicon-terminal" aria-hidden="true"></span>';
        triggerBtn.onclick = (e) => {
          try { e.stopPropagation(); } catch {}
          switchSession();
        };

        wrap.appendChild(triggerBtn);
        wrap.appendChild(infoBtn);
        const metrics = document.getElementById("bottombar-metrics");
        const status = document.getElementById("bottombar-status") || document.getElementById("bottombar-left");
        if (status && status.parentElement === right) {
          right.insertBefore(wrap, status);
        } else if (metrics && metrics.parentElement === right) {
          right.insertBefore(wrap, metrics.nextSibling);
        } else {
          right.insertBefore(wrap, right.firstChild);
        }
      }

      if (infoBtn) {
        const label = infoBtn.querySelector(".zion-terminal-bottombar-label");
        if (label) label.textContent = getInfoText();
      }
      try {
        const sid = window.zion?.state?.get("terminal.activeSessionId");
        const activeId = typeof sid === "string" ? sid : "";
        const sessions = window.zion?.state?.get("terminal.sessions");
        const list = Array.isArray(sessions) ? sessions : [];
        const cur = list.find(s => s?.id === activeId) || null;
        const cwd = cur?.cwd ? String(cur.cwd) : "";
        const disp = cur ? getSessionDisplayName(cur) : "";
        if (infoBtn) infoBtn.title = `${disp || t("ui.terminal", "Terminal")}\n${t("ui.active", "Active")}: ${activeId || t("ui.none", "None")}${cwd ? `\nCWD: ${cwd}` : ""}\n\n${t("ui.clickOpenPanel", "Click to open terminal panel")}`;
        if (triggerBtn) triggerBtn.title = t("ui.switchSession", "Switch terminal session");
      } catch {
        if (infoBtn) infoBtn.title = t("ui.clickOpenPanel", "Click to open terminal panel");
        if (triggerBtn) triggerBtn.title = t("ui.switchSession", "Switch terminal session");
      }
      return wrap;
    };

    try {
      const cmd = window.zion.commands.registerCommand("terminal.switchSession", () => switchSession());
      ctx.subscriptions.push(cmd);
    } catch {}

    const update = () => {
      try {
        ensureControl();
      } catch {}
      try {
        if (menuEl) {
          renderMenu().then(() => positionMenu()).catch(() => {});
        }
      } catch {}
    };

    if (!ensureControl()) {
      deferred = window.setInterval(() => {
        if (ensureControl()) {
          try { window.clearInterval(deferred); } catch {}
          deferred = null;
        }
      }, 500);
    }

    const sub1 = window.zion.state.onDidChange("terminal.activeSessionId", update);
    const sub2 = window.zion.state.onDidChange("terminal.sessions", update);
    const sub3 = window.zion.events.on("i18n/changed", update);
    ctx.subscriptions.push({ dispose: () => { try { sub1.dispose?.(); } catch {} } });
    ctx.subscriptions.push({ dispose: () => { try { sub2.dispose?.(); } catch {} } });
    ctx.subscriptions.push({ dispose: () => { try { sub3.dispose?.(); } catch {} } });

    ctx.subscriptions.push({
      dispose: () => {
        try { closeMenu(); } catch {}
        try { if (deferred) window.clearInterval(deferred); } catch {}
        try { wrap?.remove?.(); } catch {}
        wrap = null;
        infoBtn = null;
        triggerBtn = null;
      }
    });
  } catch {}

  try {
    for (let i = 1; i <= 9; i++) {
      const id = `terminal.setActiveSession${i}`;
      const idx = i - 1;
      const cmd = window.zion.commands.registerCommand(id, async () => {
        await ensureSessions();
        const sessions = window.zion?.state?.get("terminal.sessions") || [];
        const list = Array.isArray(sessions) ? sessions : [];
        const s = list[idx];
        const sid = String(s?.id || "").trim();
        if (!sid) return false;
        return window.zion.commands.executeCommand("terminal.setActiveSession", { session_id: sid });
      });
      ctx.subscriptions.push(cmd);
      try {
        ctx.subscriptions.push(
          window.zion.keybindings.register({ command: id, key: `Mod-${i}`, when: "editorFocus" })
        );
      } catch {}
    }
    window.zion.__applyKeymap?.();
  } catch {}

  try {
    const slash = window.zion.slash;
    if (slash?.registerCommand) {
      const d1 = slash.registerCommand({
        id: "terminal.cmd",
        trigger: ["cmd"],
        title: t("slash.commandPalette.title", "Command Palette (Terminal)"),
        description: t("slash.commandPalette.description", "Open terminal quick command selector"),
        category: t("category.terminal", "terminal"),
        icon: "$(terminal)",
        priority: 95,
        execute: () => window.zion.commands.executeCommand("terminal.quickCommand")
      });
      const d2 = slash.registerCommand({
        id: "terminal.history",
        trigger: ["terminal-history", "term-history", "history"],
        title: t("slash.history.title", "Terminal History"),
        description: t("slash.history.description", "Open terminal command history"),
        category: t("category.terminal", "terminal"),
        icon: "$(history)",
        priority: 94,
        execute: () => window.zion.commands.executeCommand("terminal.openHistory")
      });
      const d3 = slash.registerCommand({
        id: "terminal.switchSession",
        trigger: ["term", "terminal", "switch", "ts"],
        title: t("slash.switch.title", "Switch Terminal Session"),
        description: t("slash.switch.description", "Open terminal session switcher"),
        category: t("category.terminal", "terminal"),
        icon: "$(chevron-up)",
        priority: 93,
        execute: () => window.zion.commands.executeCommand("terminal.switchSession")
      });
      if (d1) ctx.subscriptions.push(d1);
      if (d2) ctx.subscriptions.push(d2);
      if (d3) ctx.subscriptions.push(d3);
    }
  } catch {}
}
