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
    try {
      if (!opened) openReject?.(new Error("WebSocket closed"));
    } catch {}
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
 * Resolve active session id from state
 */
function getActiveSessionId() {
  const sid = window.zion?.state?.get("terminal.activeSessionId");
  return typeof sid === "string" && sid ? sid : null;
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

  const VIEW_ID = "terminal.enhanced.view";
  const AUX_VIEW_ID = "terminal.enhanced.aux.view";
  let bottomPanel = null;
  let auxPanel = null;

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

  const isPanelActive = () => {
    try {
      return window.zion?.state?.get("ui.bottomPanel.activeViewId") === VIEW_ID;
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
    if (isPanelVisible() && isPanelActive()) {
      try { window.zion.bottomPanel?.hide?.(); } catch {}
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
      if (e?.defaultPrevented || e?.isComposing) return;
      if (!(e?.metaKey || e?.ctrlKey) || e?.altKey) return;
      if (String(e.key || "").toLowerCase() !== "j") return;
      if (e.shiftKey) return;
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

  // 7) Register as bottom panel view
  try {
    const dispView = window.zion.bottomPanel?.registerView?.({
      id: VIEW_ID,
      pluginId: "dev.terminal-enhanced",
      title: "Terminal",
      icon: "⌨️",
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
            { mount: container, rootId: "zion-terminal-enhanced-root-bottom" }
          );
          bottomPanel = h;
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
    if (!cur || cur === "core.output") {
      st?.set?.("ui.bottomPanel.activeViewId", VIEW_ID);
    }
    const disp = st?.onDidChange?.("ui.bottomPanel.visible", (nv) => {
      if (!nv) return;
      const active = st?.get?.("ui.bottomPanel.activeViewId");
      if (active === VIEW_ID) return;
      if (!active || active === "core.output") {
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
      icon: "⌨️",
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
      if (!s || typeof s !== "object") return "Terminal";
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
      return cwdBase || "Local";
    };

    const getInfoText = () => {
      const sid = window.zion?.state?.get("terminal.activeSessionId");
      const activeId = typeof sid === "string" ? sid : "";
      const sessions = window.zion?.state?.get("terminal.sessions");
      const list = Array.isArray(sessions) ? sessions : [];
      const cur = list.find(s => s?.id === activeId) || null;
      const name = cur ? getSessionDisplayName(cur) : "No Terminal";
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
        addItem("No sessions", null, { disabled: true });
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
      addItem("New Local Session", async () => {
        try {
          await window.zion.commands.executeCommand("terminal.createSession", { type: "local" });
          await window.zion.commands.executeCommand("terminal.openPanel");
        } catch {}
      });
      addItem("Open Terminal Manager", () => window.zion.commands.executeCommand("terminal.openManager"));
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
        triggerBtn.setAttribute("aria-label", "Switch terminal session");
        triggerBtn.innerHTML = '<span class="codicon codicon-terminal" aria-hidden="true"></span>';
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
        if (infoBtn) infoBtn.title = `${disp || "Terminal"}\nActive: ${activeId || "None"}${cwd ? `\nCWD: ${cwd}` : ""}\n\nClick to open terminal panel`;
        if (triggerBtn) triggerBtn.title = "Switch terminal session";
      } catch {
        if (infoBtn) infoBtn.title = "Click to open terminal panel";
        if (triggerBtn) triggerBtn.title = "Switch terminal session";
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
    ctx.subscriptions.push({ dispose: () => { try { sub1.dispose?.(); } catch {} } });
    ctx.subscriptions.push({ dispose: () => { try { sub2.dispose?.(); } catch {} } });

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
      const d3 = slash.registerCommand({
        id: "terminal.switchSession",
        trigger: ["term", "terminal", "switch", "ts"],
        title: "Switch Terminal Session",
        description: "Open terminal session switcher",
        category: "terminal",
        icon: "🔼",
        priority: 93,
        execute: () => window.zion.commands.executeCommand("terminal.switchSession")
      });
      if (d1) ctx.subscriptions.push(d1);
      if (d2) ctx.subscriptions.push(d2);
      if (d3) ctx.subscriptions.push(d3);
    }
  } catch {}
}
