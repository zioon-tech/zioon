import { installTerminalEnhancedPanel } from "./panel.js";

/**
 * Read local tools base URL (shared convention with terminal-manager)
 */
function readBaseUrl() {
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

  pushOutput(rec);
  pushHistory(rec);
  return rec;
}

/**
 * Connect PTY via WebSocket for interactive terminal
 * - Returns { send(data), resize(cols, rows), dispose() }
 */
function connectPty(sessionId, cols = 80, rows = 24) {
  const base = readBaseUrl().replace(/\/$/, "");
  const wsUrl = base.replace(/^http/i, "ws") + `/sessions/${encodeURIComponent(sessionId)}/pty/ws`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  let openResolve;
  const ready = new Promise(res => { openResolve = res; });

  ws.onopen = () => {
    // Send initial resize
    try {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    } catch {}
    openResolve?.();
  };

  return {
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
      ws.onmessage = (ev) => {
        try {
          if (ev.data instanceof ArrayBuffer) {
            const text = new TextDecoder().decode(new Uint8Array(ev.data));
            handler(text);
          } else if (typeof ev.data === "string") {
            handler(ev.data);
          }
        } catch {}
      };
    },
    onError(handler) {
      ws.onerror = (e) => handler(e);
    },
    onClose(handler) {
      ws.onclose = () => handler();
    },
    dispose() {
      try { ws.close(); } catch {}
    }
  };
}

/**
 * Resolve active session id from state
 */
function getActiveSessionId() {
  const sid = window.zion?.state?.get("terminal.activeSessionId");
  return typeof sid === "string" && sid ? sid : null;
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
          description: "Execute command in terminal session and return output",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Shell command to execute" },
              session_id: { type: "string", description: "Target session id (optional)" },
              timeout: { type: "number", description: "Timeout milliseconds", default: 30000 },
              capture_ansi: { type: "boolean", description: "No-op on server; output already plain text", default: false }
            },
            required: ["command"],
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
        await ensureSessions();
        const sid = String(args?.session_id || getActiveSessionId() || "").trim();
        if (!sid) return "Missing session_id (no active session)";
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

  // 3) Register commands
  const cmdOpen = window.zion.commands.registerCommand("terminal.openPanel", () => {
    try { panel?.open?.(); } catch {}
  });
  const cmdOpenHistory = window.zion.commands.registerCommand("terminal.openHistory", () => {
    try { panel?.open?.({ openHistory: true }); } catch {}
  });
  const cmdExec = window.zion.commands.registerCommand("terminal.executeCommand", async (args) => {
    const command = typeof args === "string" ? args : String(args?.command || "").trim();
    const sessionId = typeof args === "object" && args?.session_id ? String(args.session_id) : (getActiveSessionId() || "");
    if (!command) return false;
    if (!sessionId) return "No active session";
    try {
      const rec = await executeInSession(sessionId, command, { timeout: Number(args?.timeout || 30000) });
      window.zion.events.emit("terminal/commandExecuted", rec);
      return rec;
    } catch (e) {
      return `terminal.executeCommand error: ${e?.message || String(e)}`;
    }
  });
  const cmdQuick = window.zion.commands.registerCommand("terminal.quickCommand", async () => {
    panel?.open?.({ openQuick: true });
  });
  const cmdToggleCtx = window.zion.commands.registerCommand("terminal.toggleContext", () => {
    const cur = window.zion?.state?.get("chat.includeTerminalContext");
    const next = cur === false ? true : false;
    window.zion?.state?.set("chat.includeTerminalContext", next);
    return next;
  });
  ctx.subscriptions.push(cmdOpen, cmdOpenHistory, cmdExec, cmdQuick, cmdToggleCtx);

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
          const outputs = window.zion?.state?.get("terminal.outputs") || [];
          if (!Array.isArray(outputs) || outputs.length === 0) return messages;
          const recent = outputs.slice(-8);
          const text = recent.map(r => {
            const ts = new Date(r.timestamp || Date.now()).toISOString();
            const header = `[${ts}] (${r.sessionId}) $ ${r.command}`;
            const out = String(r.output || "").split("\n").slice(0, 40).join("\n");
            return `${header}\n${out}\n(exit=${r.exitCode}, ${r.duration}ms)\n`;
          }).join("\n----\n");
          const systemMsg = { role: "system", content: `Recent terminal context:\n${text}` };
          return [...messages, systemMsg];
        } catch {
          return messages;
        }
      }
    });
    ctx.subscriptions.push(disp);
  } catch (e) {
    console.warn("[dev.terminal-enhanced] message contributor failed", e);
  }

  // 6) Status bar item
  let statusDisp = null;
  const updateStatus = () => {
    const sid = getActiveSessionId();
    statusDisp?.dispose?.();
    statusDisp = window.zion.statusBar.registerItem({
      id: "dev.terminal.enhanced.button",
      text: `Terminal+${sid ? `: ${sid}` : ""}`,
      tooltip: "Open Terminal Enhanced Panel",
      onClick: () => window.zion.commands.executeCommand("terminal.openPanel")
    });
  };
  updateStatus();
  ctx.subscriptions.push({ dispose: () => statusDisp?.dispose?.() });
  ctx.subscriptions.push(window.zion.state.onDidChange("terminal.activeSessionId", updateStatus));

  // 7) Install panel as decorator (with PTY connector)
  let panel = null;
  const dispDec = window.zion.editor.registerDecorator({
    id: "dev.terminal.enhanced.panel",
    apply() {
      panel = installTerminalEnhancedPanel({
        execute: async (command, sessionId) => {
          return await window.zion.commands.executeCommand("terminal.executeCommand", { command, session_id: sessionId });
        },
        connectPty
      });
      return { dispose() { panel?.dispose?.(); panel = null; } };
    }
  });
  ctx.subscriptions.push(dispDec);

  // 8) Initial sessions sync to ensure panel has data
  try { await ensureSessions(); } catch {}

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
        title: "Command Palette (Terminal)",
        description: "Open terminal quick command selector",
        category: "terminal",
        icon: "⌨️",
        priority: 95,
        execute: () => window.zion.commands.executeCommand("terminal.quickCommand")
      });
      const d2 = slash.registerCommand({
        id: "terminal.history",
        trigger: ["terminal-history", "term-history", "history"],
        title: "Terminal History",
        description: "Open terminal command history",
        category: "terminal",
        icon: "🕘",
        priority: 94,
        execute: () => window.zion.commands.executeCommand("terminal.openHistory")
      });
      if (d1) ctx.subscriptions.push(d1);
      if (d2) ctx.subscriptions.push(d2);
    }
  } catch {}
}
