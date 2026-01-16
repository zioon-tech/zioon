/**
 * Terminal Enhanced Panel with PTY WebSocket + xterm.js (fallback to exec panel)
 */
export function installTerminalEnhancedPanel(api = { execute: async () => {}, connectPty: null }) {
  let root = document.getElementById("zion-terminal-enhanced-root");
  if (root) return createHandle(root);

  root = document.createElement("div");
  root.id = "zion-terminal-enhanced-root";
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    background: "transparent",
    zIndex: "1001",
    display: "none"
  });

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed",
    top: "56px",
    right: "12px",
    width: "720px",
    maxHeight: "70vh",
    overflow: "hidden",
    background: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    display: "grid",
    gridTemplateRows: "auto auto 1fr auto",
    padding: "0",
    boxSizing: "border-box",
    fontFamily: "var(--font-sans)"
  });

  // Header with title + context toggle
  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "8px",
    borderBottom: "1px solid var(--border)"
  });
  const title = document.createElement("div");
  title.textContent = "Terminal Enhanced";
  Object.assign(title.style, { fontSize: "12px", fontWeight: "600", opacity: "0.9" });

  const rightArea = document.createElement("div");
  Object.assign(rightArea.style, { display: "flex", alignItems: "center", gap: "8px" });

  const ctxToggle = document.createElement("label");
  Object.assign(ctxToggle.style, { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", userSelect: "none", cursor: "pointer" });
  const ctxCb = document.createElement("input");
  ctxCb.type = "checkbox";
  ctxCb.style.margin = "0";
  const ctxSpan = document.createElement("span");
  ctxSpan.textContent = "注入对话上下文";
  ctxToggle.appendChild(ctxCb);
  ctxToggle.appendChild(ctxSpan);
  try {
    let flag = window.zion?.state?.get("chat.includeTerminalContext");
    if (flag === undefined) {
      flag = true;
      window.zion?.state?.set("chat.includeTerminalContext", true);
    }
    ctxCb.checked = flag !== false;
  } catch {}
  ctxCb.addEventListener("change", () => {
    window.zion?.state?.set("chat.includeTerminalContext", !!ctxCb.checked);
  });

  const hint = document.createElement("span");
  hint.textContent = "PTY 模式（实验）";
  Object.assign(hint.style, { fontSize: "11px", opacity: "0.75" });

  rightArea.appendChild(hint);
  rightArea.appendChild(ctxToggle);

  header.appendChild(title);
  header.appendChild(rightArea);

  // Tabs
  const tabs = document.createElement("div");
  Object.assign(tabs.style, {
    display: "flex",
    gap: "4px",
    padding: "6px 8px",
    borderBottom: "1px solid var(--border)",
    overflowX: "auto"
  });

  // Mode bar (PTY connection state)
  const modeBar = document.createElement("div");
  Object.assign(modeBar.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 8px",
    borderBottom: "1px solid var(--border)",
    fontSize: "11px",
    opacity: "0.85"
  });
  const stateBadge = document.createElement("span");
  stateBadge.textContent = "准备就绪";
  Object.assign(stateBadge.style, { padding: "2px 6px", border: "1px solid var(--border)", borderRadius: "4px" });
  modeBar.appendChild(stateBadge);

  // Content (either xterm or fallback pre)
  const content = document.createElement("div");
  Object.assign(content.style, {
    position: "relative",
    overflow: "hidden",
    padding: "0 8px 8px 8px"
  });

  // xterm container
  const termWrap = document.createElement("div");
  Object.assign(termWrap.style, {
    width: "100%",
    height: "100%",
    display: "none",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    overflow: "hidden"
  });
  content.appendChild(termWrap);

  // Fallback Output area
  const fallbackPre = document.createElement("pre");
  Object.assign(fallbackPre.style, {
    margin: 0,
    padding: "8px",
    background: "rgba(0,0,0,0.08)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    minHeight: "280px",
    maxHeight: "100%",
    overflow: "auto",
    display: "block"
  });
  content.appendChild(fallbackPre);

  // Footer with command input + Run + Quick
  const footer = document.createElement("div");
  Object.assign(footer.style, {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "8px",
    borderTop: "1px solid var(--border)"
  });
  const cmdInput = document.createElement("input");
  cmdInput.type = "text";
  cmdInput.placeholder = "输入命令并回车执行…（PTY 模式下直接发送到终端）";
  Object.assign(cmdInput.style, {
    flex: "1",
    boxSizing: "border-box",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    background: "var(--panel)",
    color: "var(--fg)",
    outline: "none",
    padding: "6px 8px",
    fontSize: "12px",
    fontFamily: "var(--font-mono)"
  });
  const runBtn = document.createElement("button");
  runBtn.textContent = "Run";
  Object.assign(runBtn.style, {
    border: "1px solid var(--border)",
    borderRadius: "4px",
    background: "transparent",
    color: "var(--fg)",
    padding: "6px 10px",
    fontSize: "12px",
    cursor: "pointer"
  });

  const quickBtn = document.createElement("button");
  quickBtn.textContent = "Quick";
  Object.assign(quickBtn.style, {
    border: "1px solid var(--border)",
    borderRadius: "4px",
    background: "transparent",
    color: "var(--fg)",
    padding: "6px 10px",
    fontSize: "12px",
    cursor: "pointer"
  });

  footer.appendChild(cmdInput);
  footer.appendChild(runBtn);
  footer.appendChild(quickBtn);

  panel.appendChild(header);
  panel.appendChild(tabs);
  panel.appendChild(modeBar);
  panel.appendChild(content);
  panel.appendChild(footer);
  root.appendChild(panel);
  document.body.appendChild(root);

  // State
  let currentSessionId = window.zion?.state?.get("terminal.activeSessionId") || null;
  let pty = null;           // { ws, ready, send, resize, onData, onError, onClose, dispose }
  let term = null;          // xterm instance
  let fitAddon = null;
  let xtermLoaded = false;
  let usingPty = false;

  // Lazy load xterm from CDN (no build-time dependency)
  async function ensureXtermLoaded() {
    if (xtermLoaded) return;
    // CSS
    if (!document.getElementById("xterm-css")) {
      const link = document.createElement("link");
      link.id = "xterm-css";
      link.rel = "stylesheet";
      link.href = "https://cdn.jsdelivr.net/npm/xterm@5.4.0/css/xterm.css";
      document.head.appendChild(link);
    }
    const { Terminal } = await import("https://cdn.jsdelivr.net/npm/xterm@5.4.0/lib/xterm.js");
    const { FitAddon } = await import("https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.7.0/lib/xterm-addon-fit.js");
    term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      allowProposedApi: true,
      convertEol: true,
      theme: {
        background: getComputedStyle(document.documentElement).getPropertyValue('--panel') || '#1e1e1e',
        foreground: getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#d4d4d4'
      }
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termWrap);
    fitAddon.fit();
    xtermLoaded = true;
  }

  function setStateBadge(text, ok = true) {
    stateBadge.textContent = text;
    stateBadge.style.color = ok ? "var(--fg)" : "#f85149";
    stateBadge.style.borderColor = ok ? "var(--border)" : "#f85149";
  }

  function showPtyUI(show) {
    usingPty = !!show;
    termWrap.style.display = show ? "block" : "none";
    fallbackPre.style.display = show ? "none" : "block";
    setStateBadge(show ? "PTY 在线" : "回退模式", show);
  }

  function currentOutputsToText() {
    const outputs = window.zion?.state?.get("terminal.outputs") || [];
    const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
    if (!sid) return "无活动会话。请先创建或切换会话。";
    const items = Array.isArray(outputs) ? outputs.filter(r => r.sessionId === sid) : [];
    const lines = items.map(r => {
      const ok = r.success ? "0" : String(r.exitCode ?? -1);
      return `# ${new Date(r.timestamp).toLocaleString()} — $ ${r.command}\n${r.output}\n(exit=${ok}, ${r.duration}ms)\n`;
    });
    return lines.join("\n----------------------------------------\n");
  }

  async function connectPtyForSession(sessionId) {
    if (!api.connectPty) return false;
    try {
      await ensureXtermLoaded();
      showPtyUI(true);
      // Cleanup previous
      try { pty?.dispose?.(); } catch {}
      term.reset();
      // Connect
      pty = api.connectPty(sessionId, term.cols, term.rows);
      pty.onData((chunk) => {
        try { term.write(chunk); } catch {}
      });
      pty.onError(() => {
        showPtyUI(false);
        fallbackPre.textContent = currentOutputsToText();
      });
      pty.onClose(() => {
        showPtyUI(false);
        fallbackPre.textContent = currentOutputsToText();
      });
      await pty.ready;
      // Wire terminal input
      term.onData((data) => {
        try { pty?.send?.(data); } catch {}
      });
      // Resize handling
      const doFit = () => {
        try {
          fitAddon.fit();
          const cols = term.cols || 80;
          const rows = term.rows || 24;
          pty?.resize?.(cols, rows);
        } catch {}
      };
      doFit();
      const ro = new ResizeObserver(() => doFit());
      ro.observe(termWrap);
      window.addEventListener("resize", doFit);
      // Save disposers to cleanup on dispose
      term._zionCleanup = () => {
        try { ro.disconnect(); } catch {}
        window.removeEventListener("resize", doFit);
      };
      return true;
    } catch (e) {
      showPtyUI(false);
      fallbackPre.textContent = currentOutputsToText();
      return false;
    }
  }

  // Build tabs from sessions
  function renderTabs() {
    const sessions = window.zion?.state?.get("terminal.sessions") || [];
    tabs.innerHTML = "";
    if (!Array.isArray(sessions) || sessions.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No sessions (use Terminal Manager to create)";
      empty.style.fontSize = "11px";
      empty.style.opacity = "0.75";
      tabs.appendChild(empty);
      return;
    }
    sessions.forEach((s) => {
      const id = String(s?.id || "").trim();
      if (!id) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = s.type === "ssh" ? `${id} (ssh)` : id;
      Object.assign(btn.style, {
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: currentSessionId === id ? "var(--accent)" : "transparent",
        color: currentSessionId === id ? "var(--panel)" : "var(--fg)",
        padding: "4px 8px",
        fontSize: "11px",
        cursor: "pointer",
        whiteSpace: "nowrap"
      });
      btn.onclick = async () => {
        currentSessionId = id;
        try { window.zion?.state?.set("terminal.activeSessionId", id); } catch {}
        renderTabs();
        // Try PTY for this session
        const ok = await connectPtyForSession(id);
        if (!ok) {
          fallbackPre.textContent = currentOutputsToText();
        }
      };
      tabs.appendChild(btn);
    });
  }

  // Fallback render outputs
  function renderFallbackOutputs() {
    fallbackPre.textContent = currentOutputsToText();
    fallbackPre.scrollTop = fallbackPre.scrollHeight;
  }

  // Exec handlers
  async function runCommandFromInput() {
    const cmd = cmdInput.value.trim();
    if (!cmd) return;
    const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
    if (!sid) {
      alert("没有活动会话，请先创建或切换会话");
      return;
    }
    cmdInput.disabled = true;
    runBtn.disabled = true;
    try {
      if (usingPty && pty) {
        // Send to PTY directly (append newline)
        pty.send(cmd + "\r");
      } else {
        await api.execute?.(cmd, sid);
        renderFallbackOutputs();
      }
      cmdInput.value = "";
    } finally {
      cmdInput.disabled = false;
      runBtn.disabled = false;
      cmdInput.focus();
    }
  }
  runBtn.onclick = runCommandFromInput;
  cmdInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runCommandFromInput();
    }
  });

  // Quick commands popup
  quickBtn.onclick = () => openQuickPalette();

  function openQuickPalette() {
    const qc = window.zion?.state?.get("terminal.quickCommands") || {};
    const entries = Object.entries(qc);
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", background: "rgba(0,0,0,0.35)", zIndex: "1002"
    });
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      left: "50%", top: "25%",
      transform: "translateX(-50%)",
      width: "520px",
      maxHeight: "50vh",
      overflow: "auto",
      background: "var(--panel)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      padding: "8px",
      boxSizing: "border-box",
      fontFamily: "var(--font-sans)"
    });

    const title = document.createElement("div");
    title.textContent = "Quick Commands";
    Object.assign(title.style, { fontWeight: "600", fontSize: "12px", marginBottom: "6px" });

    const list = document.createElement("div");
    entries.forEach(([name, cmd]) => {
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "8px", alignItems: "center", padding: "6px 0" });
      const label = document.createElement("div");
      label.textContent = name;
      Object.assign(label.style, { fontSize: "12px", fontWeight: "600", minWidth: "80px" });
      const cmdEl = document.createElement("code");
      cmdEl.textContent = String(cmd);
      Object.assign(cmdEl.style, {
        fontFamily: "var(--font-mono)",
        fontSize: "11px",
        background: "rgba(0,0,0,0.08)",
        border: "1px solid var(--border)",
        padding: "2px 4px",
        borderRadius: "4px",
        flex: "1"
      });
      const run = document.createElement("button");
      run.textContent = "Run";
      Object.assign(run.style, {
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: "transparent",
        color: "var(--fg)",
        padding: "4px 8px",
        fontSize: "11px",
        cursor: "pointer"
      });
      run.onclick = async () => {
        const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
        if (!sid) { alert("没有活动会话"); return; }
        if (usingPty && pty) {
          pty.send(String(cmd) + "\r");
          overlay.remove();
        } else {
          await api.execute?.(String(cmd), sid);
          overlay.remove();
          renderFallbackOutputs();
        }
      };
      row.appendChild(label);
      row.appendChild(cmdEl);
      row.appendChild(run);
      list.appendChild(row);
    });

    box.appendChild(title);
    box.appendChild(list);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  // Wiring state changes
  const disp1 = window.zion.state.onDidChange("terminal.sessions", () => { renderTabs(); });
  const disp2 = window.zion.state.onDidChange("terminal.activeSessionId", async (nv) => {
    currentSessionId = nv || currentSessionId;
    renderTabs();
    if (currentSessionId) {
      const ok = await connectPtyForSession(currentSessionId);
      if (!ok) renderFallbackOutputs();
    }
  });
  const disp3 = window.zion.state.onDidChange("terminal.outputs", () => { if (!usingPty) renderFallbackOutputs(); });
  const disp4 = window.zion.events.on("terminal/commandExecuted", () => { if (!usingPty) renderFallbackOutputs(); });

  async function open(opts = {}) {
    renderTabs();
    // Try connect PTY for active or first session
    const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
    if (sid) {
      const ok = await connectPtyForSession(sid);
      if (!ok) renderFallbackOutputs();
    } else {
      showPtyUI(false);
      renderFallbackOutputs();
    }
    root.style.display = "block";
    if (opts.focusCommand) {
      setTimeout(() => cmdInput.focus(), 0);
    }
  }
  function close() {
    root.style.display = "none";
  }
  function dispose() {
    try { disp1?.dispose?.(); disp2?.dispose?.(); disp3?.dispose?.(); disp4?.dispose?.(); } catch {}
    try { term?._zionCleanup?.(); } catch {}
    try { pty?.dispose?.(); } catch {}
    try { root.remove(); } catch {}
  }

  return { open, close, dispose };
}

function createHandle(root) {
  return {
    open() { root.style.display = "block"; },
    close() { root.style.display = "none"; },
    dispose() { root.remove(); }
  };
}