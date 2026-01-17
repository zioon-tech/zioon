/**
 * Terminal Enhanced Panel with PTY WebSocket + xterm.js (fallback to exec panel)
 */
export function installTerminalEnhancedPanel(api = { execute: async () => {}, connectPty: null }) {
  const HEIGHT_KEY = "zion.terminalEnhanced.panelHeightPx";
  const STYLE_ID = "zion-terminal-enhanced-style";

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const viewportH = () => window.innerHeight || document.documentElement?.clientHeight || 800;

  function ensurePanelStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
#zion-terminal-enhanced-root { pointer-events: none; }
#zion-terminal-enhanced-root .zte-panel { pointer-events: auto; }

.zte-panel {
  background: var(--panel);
  color: var(--fg);
}

.zte-resize-handle {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 6px;
  cursor: row-resize;
  z-index: 2;
}
.zte-resize-handle::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 1px;
  width: 34px;
  height: 4px;
  transform: translateX(-50%);
  border-radius: 999px;
  background: color-mix(in srgb, var(--fg) 25%, transparent);
  opacity: 0.55;
}
.zte-resize-handle:hover::after { opacity: 0.9; }

.zte-topbar {
  height: 32px;
  padding: 0 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--border);
}

.zte-tabs {
  display: flex;
  align-items: stretch;
  gap: 4px;
  overflow-x: auto;
  flex: 1;
  min-width: 0;
  scrollbar-width: thin;
}
.zte-tabs::-webkit-scrollbar { height: 8px; }
.zte-tabs::-webkit-scrollbar-track { background: transparent; }
.zte-tabs::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--fg) 18%, transparent);
  border-radius: 999px;
}

.zte-tab {
  height: 26px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  background: transparent;
  color: var(--fg);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  flex: 0 0 auto;
}
.zte-tab:hover { background: color-mix(in srgb, var(--fg) 6%, transparent); }
.zte-tab.is-active {
  background: color-mix(in srgb, var(--fg) 10%, transparent);
  border-color: color-mix(in srgb, var(--accent) 65%, var(--border));
}
.zte-tab-label {
  font-size: 11px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.zte-tab-close {
  border: none;
  background: transparent;
  color: var(--fg);
  opacity: 0;
  padding: 0 4px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  border-radius: 4px;
}
.zte-tab:hover .zte-tab-close { opacity: 0.85; }
.zte-tab-close:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--fg) 10%, transparent);
}

.zte-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.zte-icon-btn {
  height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  padding: 0 8px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.zte-icon-btn:hover {
  background: color-mix(in srgb, var(--fg) 7%, transparent);
  border-color: color-mix(in srgb, var(--border) 80%, transparent);
}
.zte-icon-btn:active { transform: translateY(0.5px); }
.zte-icon-btn[disabled] {
  cursor: not-allowed;
  opacity: 0.55;
}

.zte-status {
  margin-left: 6px;
  font-size: 11px;
  opacity: 0.75;
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.zte-toast {
  position: absolute;
  right: 10px;
  bottom: 10px;
  z-index: 6;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  backdrop-filter: blur(10px);
  color: var(--fg);
  font-size: 12px;
  pointer-events: none;
  box-shadow: 0 10px 28px rgba(0,0,0,0.25);
}

.zte-find {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.zte-find-toggle {
  height: 28px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  padding: 0 8px;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.8;
}
.zte-find-toggle.is-on {
  opacity: 1;
  border-color: color-mix(in srgb, var(--accent) 65%, var(--border));
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.zte-find-toggle:hover { opacity: 1; }

.zte-menu {
  backdrop-filter: blur(10px);
}
.zte-menu-item:hover { background: color-mix(in srgb, var(--fg) 7%, transparent); }

.zte-palette-row:hover { background: color-mix(in srgb, var(--fg) 7%, transparent); }
`;
    document.head.appendChild(style);
  }

  function readSavedHeightPx() {
    try {
      const s = localStorage.getItem(HEIGHT_KEY);
      const n = s ? Number(s) : NaN;
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  function saveHeightPx(px) {
    try { localStorage.setItem(HEIGHT_KEY, String(px)); } catch {}
  }

  let root = document.getElementById("zion-terminal-enhanced-root");
  if (root) return createHandle(root);

  ensurePanelStyles();

  root = document.createElement("div");
  root.id = "zion-terminal-enhanced-root";
  Object.assign(root.style, {
    position: "fixed",
    left: "0",
    right: "0",
    bottom: "0",
    height: "35vh",
    background: "transparent",
    zIndex: "1001",
    display: "none"
  });

  const savedH = readSavedHeightPx();
  if (savedH) root.style.height = `${savedH}px`;

  const panel = document.createElement("div");
  panel.className = "zte-panel";
  Object.assign(panel.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    background: "var(--panel)",
    color: "var(--fg)",
    borderTop: "1px solid var(--border)",
    borderLeft: "0",
    borderRight: "0",
    borderBottom: "0",
    borderRadius: "0",
    boxShadow: "none",
    display: "grid",
    gridTemplateRows: "auto 1fr auto",
    padding: "0",
    boxSizing: "border-box",
    fontFamily: "var(--font-sans)"
  });

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "zte-resize-handle";
  resizeHandle.title = "Drag to resize terminal";
  panel.appendChild(resizeHandle);

  const topbar = document.createElement("div");
  topbar.className = "zte-topbar";
  Object.assign(topbar.style, {
    overflow: "hidden"
  });

  const tabs = document.createElement("div");
  tabs.className = "zte-tabs";
  topbar.appendChild(tabs);

  const actions = document.createElement("div");
  actions.className = "zte-actions";

  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "zte-icon-btn";
  newBtn.textContent = "New";
  newBtn.title = "New terminal session";

  const killBtn = document.createElement("button");
  killBtn.type = "button";
  killBtn.className = "zte-icon-btn";
  killBtn.textContent = "Kill";
  killBtn.title = "Kill active session";

  const findBtn = document.createElement("button");
  findBtn.type = "button";
  findBtn.className = "zte-icon-btn";
  findBtn.textContent = "Find";
  findBtn.title = "Find in terminal (Mod+F)";
  findBtn.disabled = true;

  const historyBtn = document.createElement("button");
  historyBtn.type = "button";
  historyBtn.className = "zte-icon-btn";
  historyBtn.textContent = "History";
  historyBtn.title = "Command history (Mod+R)";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "zte-icon-btn";
  closeBtn.textContent = "Close";
  closeBtn.title = "Close terminal panel (Esc)";

  const statusText = document.createElement("div");
  statusText.className = "zte-status";
  statusText.textContent = "";

  actions.appendChild(newBtn);
  actions.appendChild(killBtn);
  actions.appendChild(findBtn);
  actions.appendChild(historyBtn);
  actions.appendChild(closeBtn);
  actions.appendChild(statusText);
  topbar.appendChild(actions);

  // Content (either xterm or fallback pre)
  const content = document.createElement("div");
  Object.assign(content.style, {
    position: "relative",
    overflow: "hidden",
    padding: "0"
  });

  // xterm container
  const termWrap = document.createElement("div");
  Object.assign(termWrap.style, {
    width: "100%",
    height: "100%",
    display: "none",
    overflow: "hidden"
  });
  content.appendChild(termWrap);

  // Fallback Output area
  const fallbackPre = document.createElement("pre");
  Object.assign(fallbackPre.style, {
    margin: 0,
    padding: "8px",
    background: "transparent",
    border: "0",
    borderRadius: "0",
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
    borderTop: "1px solid var(--border)",
    position: "relative"
  });
  const cmdInput = document.createElement("input");
  cmdInput.type = "text";
  cmdInput.placeholder = "输入命令并回车执行…";
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
  footer.appendChild(cmdInput);

  const suggestBox = document.createElement("div");
  Object.assign(suggestBox.style, {
    position: "absolute",
    left: "8px",
    right: "8px",
    bottom: "46px",
    maxHeight: "220px",
    overflow: "auto",
    background: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    display: "none",
    zIndex: "1002"
  });
  footer.appendChild(suggestBox);

  panel.appendChild(topbar);
  panel.appendChild(content);
  panel.appendChild(footer);
  root.appendChild(panel);
  document.body.appendChild(root);

  const toast = document.createElement("div");
  toast.className = "zte-toast";
  toast.style.display = "none";
  panel.appendChild(toast);

  let toastTimer = 0;
  function showToast(message, ms = 1200) {
    const text = String(message || "").trim();
    if (!text) return;
    try { clearTimeout(toastTimer); } catch {}
    toast.textContent = text;
    toast.style.display = "block";
    toastTimer = setTimeout(() => {
      toast.style.display = "none";
    }, ms);
  }

  function setPanelHeightPx(nextPx, persist = true) {
    const maxPx = Math.floor(viewportH() * 0.85);
    const minPx = 180;
    const px = clamp(Math.floor(Number(nextPx || 0)), minPx, maxPx);
    root.style.height = `${px}px`;
    if (persist) saveHeightPx(px);
    try { fitAddon?.fit?.(); } catch {}
  }

  (function attachResize() {
    let dragging = false;
    let startY = 0;
    let startH = 0;
    let raf = 0;
    let pending = null;

    const onMove = (ev) => {
      if (!dragging) return;
      const dy = startY - ev.clientY;
      const h = startH + dy;
      pending = h;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (pending == null) return;
        setPanelHeightPx(pending, false);
        pending = null;
      });
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      try { document.body.style.userSelect = ""; } catch {}
      try { document.body.style.cursor = ""; } catch {}
      try { document.removeEventListener("mousemove", onMove); } catch {}
      try { document.removeEventListener("mouseup", onUp); } catch {}
      const rect = root.getBoundingClientRect();
      setPanelHeightPx(rect.height, true);
    };

    resizeHandle.addEventListener("mousedown", (ev) => {
      dragging = true;
      startY = ev.clientY;
      startH = root.getBoundingClientRect().height;
      try { document.body.style.userSelect = "none"; } catch {}
      try { document.body.style.cursor = "row-resize"; } catch {}
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    resizeHandle.addEventListener("dblclick", () => {
      const cur = root.getBoundingClientRect().height;
      const maxPx = Math.floor(viewportH() * 0.85);
      const defPx = Math.floor(viewportH() * 0.35);
      const nearMax = Math.abs(cur - maxPx) < 10;
      setPanelHeightPx(nearMax ? defPx : maxPx, true);
    });
  })();

  // State
  let currentSessionId = window.zion?.state?.get("terminal.activeSessionId") || null;
  let pty = null;           // { ws, ready, send, resize, onData, onError, onClose, dispose }
  let term = null;          // xterm instance
  let fitAddon = null;
  let searchAddon = null;
  let webLinksAddon = null;
  let xtermLoaded = false;
  let usingPty = false;
  let usingExec = false;
  let termDataDisp = null;
  let termContextMenu = null;
  let termFindWidget = null;
  let execLine = "";
  let execBusy = false;
  let execBootSessionId = null;
  let findState = { caseSensitive: false, regex: false, wholeWord: false };

  // Lazy load xterm (prefer local dependency; fallback to CDN)
  async function ensureXtermLoaded() {
    if (xtermLoaded) return;
    const ensureCss = (href) => {
      if (!href) return;
      if (document.getElementById("xterm-css")) return;
      const link = document.createElement("link");
      link.id = "xterm-css";
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
    };

    let Terminal = null;
    let FitAddon = null;
    let SearchAddon = null;
    let WebLinksAddon = null;

    const loadFromLocal = async () => {
      try {
        const cssMod = await import("xterm/css/xterm.css?url");
        ensureCss(cssMod?.default || cssMod);
      } catch {}

      const xtermMod = await import("xterm");
      Terminal = xtermMod?.Terminal || xtermMod?.default?.Terminal || xtermMod?.default;

      const fitMod = await import("xterm-addon-fit");
      FitAddon = fitMod?.FitAddon || fitMod?.default?.FitAddon || fitMod?.default;

      const searchMod = await import("xterm-addon-search");
      SearchAddon = searchMod?.SearchAddon || searchMod?.default?.SearchAddon || searchMod?.default;

      const webLinksMod = await import("xterm-addon-web-links");
      WebLinksAddon = webLinksMod?.WebLinksAddon || webLinksMod?.default?.WebLinksAddon || webLinksMod?.default;
    };

    const loadFromCdn = async () => {
      ensureCss("https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css");
      const xtermMod = await import("https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js");
      const fitMod = await import("https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js");
      const searchMod = await import("https://cdn.jsdelivr.net/npm/xterm-addon-search@0.15.0/lib/xterm-addon-search.js");
      const webLinksMod = await import("https://cdn.jsdelivr.net/npm/xterm-addon-web-links@0.11.0/lib/xterm-addon-web-links.js");

      Terminal = xtermMod?.Terminal || xtermMod?.default?.Terminal || xtermMod?.default;
      FitAddon = fitMod?.FitAddon || fitMod?.default?.FitAddon || fitMod?.default;
      SearchAddon = searchMod?.SearchAddon || searchMod?.default?.SearchAddon || searchMod?.default;
      WebLinksAddon = webLinksMod?.WebLinksAddon || webLinksMod?.default?.WebLinksAddon || webLinksMod?.default;
    };

    try {
      await loadFromLocal();
    } catch {
      await loadFromCdn();
    }

    if (!Terminal || !FitAddon || !SearchAddon || !WebLinksAddon) {
      throw new Error("xterm load failed");
    }

    term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      allowProposedApi: true,
      convertEol: true,
      scrollback: 5000,
      altClickMovesCursor: true,
      theme: {
        background: getComputedStyle(document.documentElement).getPropertyValue('--panel') || '#1e1e1e',
        foreground: getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#d4d4d4'
      }
    });
    fitAddon = new FitAddon();
    searchAddon = new SearchAddon();
    webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(webLinksAddon);
    term.open(termWrap);
    fitAddon.fit();
    installTerminalInteractions();
    ensureTermDataHandler();
    xtermLoaded = true;
  }

  function ensureTermDataHandler() {
    if (!term || termDataDisp) return;
    termDataDisp = term.onData((data) => {
      if (usingPty && pty) {
        try { pty.send(data); } catch {}
        return;
      }
      if (usingExec) {
        handleExecInput(data);
      }
    });
  }

  function getPromptForSession(sessionId) {
    const sid = String(sessionId || "");
    const sessions = window.zion?.state?.get("terminal.sessions") || [];
    const list = Array.isArray(sessions) ? sessions : [];
    const s = list.find(x => String(x?.id || "") === sid) || null;
    const cwd = String(s?.cwd || "");
    const cwdShort = cwd ? cwd.split("/").filter(Boolean).slice(-2).join("/") : "";
    return cwdShort ? `${sid}:${cwdShort}$ ` : `${sid}$ `;
  }

  function writeExecPrompt() {
    execLine = "";
    const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || "";
    const prompt = getPromptForSession(sid);
    try { term?.write?.(prompt); } catch {}
  }

  function bootstrapExecForSession(sessionId) {
    if (!term) return;
    if (execBootSessionId === sessionId) return;
    execBootSessionId = sessionId;
    try {
      term.reset();
      const text = currentOutputsToText();
      const lines = String(text || "").replace(/\r/g, "").split("\n");
      for (const ln of lines) term.writeln(ln);
      term.writeln("");
    } catch {}
    writeExecPrompt();
  }

  async function runExecCommand(command) {
    const cmd = String(command || "").trim();
    if (!cmd) {
      writeExecPrompt();
      return;
    }
    const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
    if (!sid) {
      try { term?.writeln?.("No active session"); } catch {}
      writeExecPrompt();
      return;
    }
    execBusy = true;
    try {
      const rec = await api.execute?.(cmd, sid);
      const out = typeof rec?.output === "string" ? rec.output : "";
      if (out) {
        const normalized = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        for (const ln of normalized) {
          try { term?.writeln?.(ln); } catch {}
        }
      }
    } catch (e) {
      try { term?.writeln?.(String(e?.message || e || "exec failed")); } catch {}
    } finally {
      execBusy = false;
      writeExecPrompt();
    }
  }

  function handleExecInput(data) {
    if (!term) return;
    if (execBusy) return;

    const s = String(data || "");
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];

      if (ch === "\r") {
        const cmd = execLine;
        execLine = "";
        try { term.write("\r\n"); } catch {}
        runExecCommand(cmd);
        continue;
      }

      if (ch === "\u007f") {
        if (execLine.length) {
          execLine = execLine.slice(0, -1);
          try { term.write("\b \b"); } catch {}
        }
        continue;
      }

      if (ch === "\u0003") {
        execLine = "";
        try { term.write("^C\r\n"); } catch {}
        writeExecPrompt();
        continue;
      }

      if (ch === "\t") {
        continue;
      }

      if (ch === "\n") {
        continue;
      }

      if (ch === "\u001b") {
        continue;
      }

      if (ch >= " ") {
        execLine += ch;
        try { term.write(ch); } catch {}
      }
    }
  }

  function setClipboardText(text) {
    const val = String(text || "");
    if (!val) return Promise.resolve(false);
    if (navigator?.clipboard?.writeText) return navigator.clipboard.writeText(val).then(() => true).catch(() => false);
    try {
      const ta = document.createElement("textarea");
      ta.value = val;
      ta.setAttribute("readonly", "true");
      Object.assign(ta.style, { position: "fixed", left: "-9999px", top: "-9999px" });
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.("copy");
      ta.remove();
      return Promise.resolve(!!ok);
    } catch {
      return Promise.resolve(false);
    }
  }

  function getClipboardText() {
    if (navigator?.clipboard?.readText) return navigator.clipboard.readText().catch(() => "");
    return Promise.resolve("");
  }

  function ensureTermFindWidget() {
    if (termFindWidget) return termFindWidget;

    const wrap = document.createElement("div");
    wrap.className = "zte-find";
    Object.assign(wrap.style, {
      position: "absolute",
      right: "10px",
      top: "10px",
      zIndex: "1004",
      display: "none",
      background: "var(--panel)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      padding: "6px",
      gap: "6px",
      alignItems: "center"
    });

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Find";
    Object.assign(input.style, {
      width: "220px",
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

    const mkBtn = (label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      Object.assign(b.style, {
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: "transparent",
        color: "var(--fg)",
        padding: "6px 10px",
        fontSize: "12px",
        cursor: "pointer",
        whiteSpace: "nowrap"
      });
      return b;
    };

    const mkToggle = (label, key, title) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.className = "zte-find-toggle";
      b.title = title;
      const paint = () => {
        const on = !!findState?.[key];
        b.classList.toggle("is-on", on);
      };
      paint();
      b.onclick = () => {
        findState = { ...findState, [key]: !findState?.[key] };
        paint();
        doFind(1);
      };
      return b;
    };

    const prevBtn = mkBtn("Prev");
    const nextBtn = mkBtn("Next");
    const closeBtn2 = mkBtn("Close");

    const caseBtn = mkToggle("Aa", "caseSensitive", "Case sensitive");
    const regexBtn = mkToggle(".*", "regex", "Regex");
    const wordBtn = mkToggle("W", "wholeWord", "Whole word");

    const doFind = (dir) => {
      const q = String(input.value || "");
      if (!q) return;
      try {
        const opts = { caseSensitive: !!findState.caseSensitive, regex: !!findState.regex, wholeWord: !!findState.wholeWord };
        if (dir < 0) searchAddon?.findPrevious?.(q, opts);
        else searchAddon?.findNext?.(q, opts);
      } catch {}
    };

    input.addEventListener("input", () => doFind(1));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        wrap.style.display = "none";
        term?.focus?.();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        doFind(e.shiftKey ? -1 : 1);
        return;
      }
    });
    prevBtn.onclick = () => doFind(-1);
    nextBtn.onclick = () => doFind(1);
    closeBtn2.onclick = () => {
      wrap.style.display = "none";
      term?.focus?.();
    };

    Object.assign(wrap.style, { display: "none", flexDirection: "row" });
    wrap.appendChild(input);
    wrap.appendChild(caseBtn);
    wrap.appendChild(regexBtn);
    wrap.appendChild(wordBtn);
    wrap.appendChild(prevBtn);
    wrap.appendChild(nextBtn);
    wrap.appendChild(closeBtn2);

    content.appendChild(wrap);
    termFindWidget = { wrap, input };
    return termFindWidget;
  }

  function openTermFind() {
    const w = ensureTermFindWidget();
    w.wrap.style.display = "flex";
    setTimeout(() => {
      try { w.input.focus(); w.input.select(); } catch {}
    }, 0);
  }

  function hideTermContextMenu() {
    try { termContextMenu?.remove(); } catch {}
    termContextMenu = null;
  }

  function openTermContextMenu(x, y) {
    hideTermContextMenu();
    const menu = document.createElement("div");
    menu.className = "zte-menu";
    Object.assign(menu.style, {
      position: "fixed",
      left: `${x}px`,
      top: `${y}px`,
      zIndex: "1005",
      minWidth: "160px",
      background: "var(--panel)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      padding: "6px",
      display: "grid",
      gap: "4px"
    });

    const mkItem = (label, onClick, opts = {}) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.className = "zte-menu-item";
      const disabled = !!opts.disabled;
      b.disabled = disabled;
      Object.assign(b.style, {
        width: "100%",
        textAlign: "left",
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: "transparent",
        color: "var(--fg)",
        padding: "6px 8px",
        fontSize: "12px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? "0.55" : "1"
      });
      b.onclick = async () => {
        if (disabled) return;
        hideTermContextMenu();
        await onClick?.();
      };
      return b;
    };

    const hasSel = !!term?.hasSelection?.();
    menu.appendChild(mkItem("Copy", async () => {
      const sel = term?.getSelection?.() || "";
      const ok = await setClipboardText(sel);
      showToast(ok ? "Copied" : "Copy failed");
    }, { disabled: !hasSel }));
    menu.appendChild(mkItem("Paste", async () => {
      const txt = await getClipboardText();
      if (!txt) return;
      try { term?.paste?.(txt); } catch { try { pty?.send?.(txt); } catch {} }
      showToast("Pasted");
    }));
    menu.appendChild(mkItem("Find", async () => { openTermFind(); }));
    menu.appendChild(mkItem("Select All", async () => { try { term?.selectAll?.(); } catch {} }));
    menu.appendChild(mkItem("Clear", async () => { try { term?.clear?.(); } catch {} }));

    document.body.appendChild(menu);
    termContextMenu = menu;

    const onDoc = (ev) => {
      if (!menu.contains(ev.target)) hideTermContextMenu();
    };
    setTimeout(() => document.addEventListener("mousedown", onDoc, { once: true }), 0);
  }

  function installTerminalInteractions() {
    if (!term) return;
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      const key = String(ev.key || "").toLowerCase();
      const mod = !!(ev.ctrlKey || ev.metaKey);

      if (mod && key === "f") {
        ev.preventDefault();
        openTermFind();
        return false;
      }

      if (mod && (key === "c" || key === "x") && term?.hasSelection?.()) {
        ev.preventDefault();
        const sel = term?.getSelection?.() || "";
        setClipboardText(sel).then((ok) => showToast(ok ? "Copied" : "Copy failed"));
        return false;
      }

      if ((mod && key === "v") || (ev.shiftKey && ev.key === "Insert")) {
        ev.preventDefault();
        getClipboardText().then((txt) => {
          if (!txt) return;
          try { term?.paste?.(txt); } catch { try { pty?.send?.(txt); } catch {} }
          showToast("Pasted");
        });
        return false;
      }

      if (mod && ev.shiftKey && key === "c" && term?.hasSelection?.()) {
        ev.preventDefault();
        const sel = term?.getSelection?.() || "";
        setClipboardText(sel).then((ok) => showToast(ok ? "Copied" : "Copy failed"));
        return false;
      }

      if (mod && ev.shiftKey && key === "v") {
        ev.preventDefault();
        getClipboardText().then((txt) => {
          if (!txt) return;
          try { term?.paste?.(txt); } catch { try { pty?.send?.(txt); } catch {} }
          showToast("Pasted");
        });
        return false;
      }

      return true;
    });

    termWrap.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openTermContextMenu(e.clientX, e.clientY);
    });
    termWrap.addEventListener("mousedown", () => {
      try { term?.focus?.(); } catch {}
    });
  }

  function setUiMode(mode) {
    const xtermReady = !!(xtermLoaded && term);
    const resolvedMode = xtermReady ? String(mode || "exec") : "pre";

    usingPty = resolvedMode === "pty";
    usingExec = resolvedMode === "exec";

    const showXterm = xtermReady && (resolvedMode === "pty" || resolvedMode === "exec");
    termWrap.style.display = showXterm ? "block" : "none";
    fallbackPre.style.display = showXterm ? "none" : "block";
    footer.style.display = showXterm ? "none" : "flex";

    findBtn.disabled = !xtermReady;
    updateStatusText();
  }

  function updateStatusText() {
    const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || "";
    const mode = usingPty ? "pty" : (usingExec ? "exec" : "pre");
    const prompt = sid ? getPromptForSession(sid).replace(/\$\s*$/, "") : "";
    statusText.textContent = sid ? `${prompt} · ${mode}` : `no session · ${mode}`;
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
      setUiMode("pty");
      // Cleanup previous
      try { pty?.dispose?.(); } catch {}
      try { termDataDisp?.dispose?.(); } catch {}
      termDataDisp = null;
      term.reset();
      ensureTermDataHandler();
      // Connect
      pty = api.connectPty(sessionId, term.cols, term.rows);
      pty.onData((chunk) => {
        try { term.write(chunk); } catch {}
      });
      pty.onError(() => {
        try { pty?.dispose?.(); } catch {}
        pty = null;
        setUiMode("exec");
        bootstrapExecForSession(sessionId);
      });
      pty.onClose(() => {
        try { pty?.dispose?.(); } catch {}
        pty = null;
        setUiMode("exec");
        bootstrapExecForSession(sessionId);
      });
      await pty.ready;
      try { term.focus(); } catch {}
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
      const RO = globalThis.ResizeObserver;
      const ro = typeof RO === "function" ? new RO(() => doFit()) : null;
      try { ro?.observe?.(termWrap); } catch {}
      window.addEventListener("resize", doFit);
      // Save disposers to cleanup on dispose
      term._zionCleanup = () => {
        try { ro?.disconnect?.(); } catch {}
        window.removeEventListener("resize", doFit);
      };
      return true;
    } catch (e) {
      try { pty?.dispose?.(); } catch {}
      pty = null;
      setUiMode("exec");
      bootstrapExecForSession(sessionId);
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
      updateStatusText();
      return;
    }
    sessions.forEach((s) => {
      const id = String(s?.id || "").trim();
      if (!id) return;
      const tab = document.createElement("div");
      tab.className = `zte-tab${currentSessionId === id ? " is-active" : ""}`;

      const label = document.createElement("div");
      label.textContent = s.type === "ssh" ? `${id} (ssh)` : id;
      label.className = "zte-tab-label";

      const xbtn = document.createElement("button");
      xbtn.type = "button";
      xbtn.textContent = "×";
      xbtn.className = "zte-tab-close";
      xbtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await window.zion?.commands?.executeCommand?.("terminal.closeSession", { session_id: id });
        } catch {}
      };

      tab.onclick = async () => {
        currentSessionId = id;
        try { window.zion?.state?.set("terminal.activeSessionId", id); } catch {}
        renderTabs();
        const ok = await connectPtyForSession(id);
        if (!ok) {
          if (xtermLoaded && term) {
            setUiMode("exec");
            bootstrapExecForSession(id);
          } else {
            fallbackPre.textContent = currentOutputsToText();
          }
        }
      };

      tab.appendChild(label);
      tab.appendChild(xbtn);
      tabs.appendChild(tab);
    });
    updateStatusText();
  }

  // Fallback render outputs
  function renderFallbackOutputs() {
    const text = currentOutputsToText();
    fallbackPre.textContent = text;
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
      cmdInput.focus();
    }
  }
  let suggestItems = [];
  let suggestIndex = 0;
  let suggestOpen = false;
  let suggestReqId = 0;
  let suggestTimer = 0;

  function hideSuggest() {
    suggestOpen = false;
    suggestItems = [];
    suggestIndex = 0;
    suggestBox.style.display = "none";
    suggestBox.innerHTML = "";
  }

  function renderSuggest() {
    if (!suggestItems.length) {
      hideSuggest();
      return;
    }
    suggestOpen = true;
    suggestBox.style.display = "block";
    suggestBox.innerHTML = "";

    const max = Math.min(suggestItems.length, 10);
    for (let i = 0; i < max; i++) {
      const it = suggestItems[i];
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px",
        padding: "6px 8px",
        cursor: "pointer",
        background: i === suggestIndex ? "rgba(255,255,255,0.08)" : "transparent"
      });
      const left = document.createElement("div");
      left.textContent = it.label;
      Object.assign(left.style, { fontFamily: "var(--font-mono)", fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
      const right = document.createElement("div");
      right.textContent = it.detail || "";
      Object.assign(right.style, { fontSize: "11px", opacity: "0.75", whiteSpace: "nowrap" });
      row.appendChild(left);
      row.appendChild(right);
      row.onmouseenter = () => {
        suggestIndex = i;
        renderSuggest();
      };
      row.onclick = () => {
        applySuggestion(it);
      };
      suggestBox.appendChild(row);
    }
  }

  function applySuggestion(it) {
    if (!it) return;
    cmdInput.value = String(it.insertText || it.label || "");
    hideSuggest();
    cmdInput.focus();
    try {
      cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length);
    } catch {}
  }

  function readBaseUrl() {
    const st1 = window.zion?.state?.get("localTools.baseUrl");
    if (typeof st1 === "string" && st1.trim()) return st1.trim();
    try {
      const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
      if (s) return s.trim();
    } catch {}
    return "http://127.0.0.1:8765";
  }

  async function readFileRaw(path, sessionId) {
    const base = readBaseUrl().replace(/\/$/, "");
    let url = `${base}/files/read?path=${encodeURIComponent(String(path || ""))}&offset=1&limit=5000`;
    if (sessionId) url += `&session_id=${encodeURIComponent(String(sessionId))}`;
    const res = await fetch(url, { method: "GET" });
    const data = await res.json().catch(() => null);
    const content = typeof data?.content === "string" ? data.content : "";
    const lines = String(content).replace(/\r/g, "").split("\n");
    const cleaned = lines.map(l => l.replace(/^\s*\d+\s*(\||→)\s?/, ""));
    return cleaned.join("\n");
  }

  async function glob(pattern, path, sessionId) {
    const base = readBaseUrl().replace(/\/$/, "");
    let url = `${base}/files/glob?pattern=${encodeURIComponent(String(pattern || ""))}`;
    if (path) url += `&path=${encodeURIComponent(String(path))}`;
    if (sessionId) url += `&session_id=${encodeURIComponent(String(sessionId))}`;
    const res = await fetch(url, { method: "GET" });
    const data = await res.json().catch(() => null);
    const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
    return results;
  }

  function getSessionInfo(sessionId) {
    const sessions = window.zion?.state?.get("terminal.sessions") || [];
    const list = Array.isArray(sessions) ? sessions : [];
    const s = list.find(x => String(x?.id || "").trim() === String(sessionId || "").trim());
    return s || null;
  }

  const projectCache = new Map();
  async function getProjectInfo(sessionId) {
    const sid = String(sessionId || "").trim();
    if (!sid) return { scripts: [], makeTargets: [], hasDockerCompose: false };
    const now = Date.now();
    const cached = projectCache.get(sid);
    if (cached && now - cached.ts < 15000) return cached.data;
    const s = getSessionInfo(sid);
    const cwd = String(s?.cwd || "").trim();
    const data = { scripts: [], makeTargets: [], hasDockerCompose: false };
    if (!cwd) {
      projectCache.set(sid, { ts: now, data });
      return data;
    }
    try {
      const pkgRaw = await readFileRaw(`${cwd.replace(/\/$/, "")}/package.json`, sid).catch(() => "");
      if (pkgRaw) {
        const pkg = JSON.parse(pkgRaw);
        const scripts = pkg && typeof pkg === "object" ? (pkg.scripts || {}) : {};
        const keys = scripts && typeof scripts === "object" ? Object.keys(scripts) : [];
        data.scripts = keys.filter(Boolean).slice(0, 80);
      }
    } catch {}
    try {
      const mk = await readFileRaw(`${cwd.replace(/\/$/, "")}/Makefile`, sid).catch(() => "");
      if (mk) {
        const targets = new Set();
        mk.replace(/\r/g, "").split("\n").forEach((ln) => {
          const s1 = ln.trimEnd();
          if (!s1 || s1.startsWith("#") || s1.startsWith(".")) return;
          if (/^\s/.test(ln)) return;
          const m = s1.match(/^([A-Za-z0-9_\-\.]+)\s*:/);
          if (m && m[1] && !m[1].includes("%")) targets.add(m[1]);
        });
        data.makeTargets = Array.from(targets).slice(0, 80);
      }
    } catch {}
    try {
      const g = await glob("docker-compose*.yml", cwd, sid).catch(() => []);
      data.hasDockerCompose = Array.isArray(g) && g.length > 0;
    } catch {}
    projectCache.set(sid, { ts: now, data });
    return data;
  }

  function uniqByInsert(items) {
    const seen = new Set();
    const out = [];
    items.forEach((it) => {
      const k = String(it.insertText || it.label || "");
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(it);
    });
    return out;
  }

  function scoreMatch(q, text) {
    const a = String(q || "").toLowerCase();
    const b = String(text || "").toLowerCase();
    if (!a) return 0;
    if (b === a) return 100;
    if (b.startsWith(a)) return 70;
    const idx = b.indexOf(a);
    if (idx >= 0) return 40 - Math.min(idx, 20);
    return -1;
  }

  async function buildSuggestions(query) {
    const q = String(query || "").trim();
    const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || "";
    const history = window.zion?.state?.get("terminal.history") || [];
    const histList = Array.isArray(history) ? history : [];
    const freq = new Map();
    histList.forEach((r) => {
      const c = String(r?.command || "").trim();
      if (!c) return;
      freq.set(c, (freq.get(c) || 0) + 1);
    });

    const items = [];
    const qc = window.zion?.state?.get("terminal.quickCommands") || {};
    Object.entries(qc).forEach(([name, cmd]) => {
      const label = String(cmd || "");
      const s1 = Math.max(scoreMatch(q, name), scoreMatch(q, label));
      if (q && s1 < 0) return;
      items.push({ label, insertText: label, detail: `quick:${name}`, score: (s1 < 0 ? 0 : s1) + 30 });
    });

    const seenCmd = new Set();
    histList
      .slice()
      .reverse()
      .forEach((r) => {
        const cmd = String(r?.command || "").trim();
        if (!cmd || seenCmd.has(cmd)) return;
        seenCmd.add(cmd);
        const s1 = q ? scoreMatch(q, cmd) : 0;
        if (q && s1 < 0) return;
        const w = Number(freq.get(cmd) || 1);
        const per = sid && String(r?.sessionId || "") === String(sid) ? 20 : 0;
        items.push({ label: cmd, insertText: cmd, detail: `history ×${w}`, score: (s1 < 0 ? 0 : s1) + per + Math.min(w, 20) });
      });

    const proj = await getProjectInfo(sid);
    if (proj?.scripts?.length) {
      proj.scripts.forEach((sc) => {
        const cmd = `npm run ${sc}`;
        const s1 = q ? scoreMatch(q, cmd) : 0;
        if (q && s1 < 0) return;
        items.push({ label: cmd, insertText: cmd, detail: "package.json", score: (s1 < 0 ? 0 : s1) + 15 });
      });
    }
    if (proj?.makeTargets?.length) {
      proj.makeTargets.forEach((t) => {
        const cmd = `make ${t}`;
        const s1 = q ? scoreMatch(q, cmd) : 0;
        if (q && s1 < 0) return;
        items.push({ label: cmd, insertText: cmd, detail: "Makefile", score: (s1 < 0 ? 0 : s1) + 10 });
      });
    }
    if (proj?.hasDockerCompose) {
      ["docker compose up", "docker compose down", "docker compose ps", "docker compose logs -f"].forEach((cmd) => {
        const s1 = q ? scoreMatch(q, cmd) : 0;
        if (q && s1 < 0) return;
        items.push({ label: cmd, insertText: cmd, detail: "docker-compose", score: (s1 < 0 ? 0 : s1) + 8 });
      });
    }

    const sorted = uniqByInsert(items)
      .sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)));
    return sorted.slice(0, 50);
  }

  async function refreshSuggest() {
    const q = cmdInput.value;
    const id = ++suggestReqId;
    const list = await buildSuggestions(q).catch(() => []);
    if (id !== suggestReqId) return;
    suggestItems = Array.isArray(list) ? list : [];
    suggestIndex = 0;
    renderSuggest();
  }

  function scheduleSuggest() {
    try { clearTimeout(suggestTimer); } catch {}
    suggestTimer = setTimeout(() => {
      refreshSuggest();
    }, 120);
  }

  function getHistoryCommandsForNav() {
    const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || "";
    const history = window.zion?.state?.get("terminal.history") || [];
    const list = Array.isArray(history) ? history : [];
    const seen = new Set();
    const out = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      const cmd = String(r?.command || "").trim();
      if (!cmd) continue;
      if (sid && String(r?.sessionId || "") !== String(sid)) continue;
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      out.push(cmd);
      if (out.length >= 200) break;
    }
    return out;
  }

  let histNav = { list: [], idx: -1, base: "" };
  function resetHistNav() {
    histNav = { list: getHistoryCommandsForNav(), idx: -1, base: cmdInput.value };
  }

  cmdInput.addEventListener("focus", () => resetHistNav());
  cmdInput.addEventListener("input", () => {
    resetHistNav();
    scheduleSuggest();
  });

  cmdInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (suggestOpen) {
        e.preventDefault();
        hideSuggest();
        return;
      }
      e.preventDefault();
      close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
      e.preventDefault();
      openHistoryPalette();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === " ") {
      e.preventDefault();
      refreshSuggest();
      return;
    }
    if (suggestOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      if (e.key === "ArrowDown") {
        suggestIndex = Math.min(suggestIndex + 1, Math.min(suggestItems.length, 10) - 1);
      } else {
        suggestIndex = Math.max(suggestIndex - 1, 0);
      }
      renderSuggest();
      return;
    }
    if (suggestOpen && e.key === "Tab") {
      e.preventDefault();
      applySuggestion(suggestItems[suggestIndex]);
      return;
    }
    if (!suggestOpen && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (!histNav.list.length) return;
      e.preventDefault();
      if (e.key === "ArrowUp") {
        histNav.idx = Math.min(histNav.idx + 1, histNav.list.length - 1);
        cmdInput.value = histNav.list[histNav.idx] || "";
      } else {
        histNav.idx = Math.max(histNav.idx - 1, -1);
        cmdInput.value = histNav.idx === -1 ? histNav.base : (histNav.list[histNav.idx] || "");
      }
      try { cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length); } catch {}
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      hideSuggest();
      runCommandFromInput();
      return;
    }
  });

  newBtn.onclick = async () => {
    try {
      const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
      const sessions = window.zion?.state?.get("terminal.sessions") || [];
      const list = Array.isArray(sessions) ? sessions : [];
      const s = sid ? list.find(x => String(x?.id || "").trim() === String(sid || "").trim()) : null;
      const initial_cwd = typeof s?.cwd === "string" && s.cwd.trim() ? s.cwd.trim() : undefined;
      await window.zion?.commands?.executeCommand?.("terminal.createSession", { type: "local", initial_cwd });
    } catch {}
  };

  killBtn.onclick = async () => {
    try {
      const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
      const sessionId = String(sid || "").trim();
      if (!sessionId) return;
      await window.zion?.commands?.executeCommand?.("terminal.closeSession", { session_id: sessionId });
    } catch {}
  };

  findBtn.onclick = async () => {
    try {
      await ensureXtermLoaded();
      openTermFind();
    } catch {}
  };

  closeBtn.onclick = () => close();
  historyBtn.onclick = () => openHistoryPalette();

  function openHistoryPalette() {
    const history = window.zion?.state?.get("terminal.history") || [];
    const list = Array.isArray(history) ? history.slice() : [];
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,0.35)",
      zIndex: "1003"
    });
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      left: "50%",
      top: "18%",
      transform: "translateX(-50%)",
      width: "720px",
      maxHeight: "60vh",
      overflow: "hidden",
      background: "var(--panel)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      display: "grid",
      gridTemplateRows: "auto 1fr",
      boxSizing: "border-box",
      fontFamily: "var(--font-sans)"
    });

    const head = document.createElement("div");
    Object.assign(head.style, { padding: "8px", borderBottom: "1px solid var(--border)", display: "flex", gap: "8px", alignItems: "center" });
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "搜索历史命令…";
    Object.assign(input.style, {
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
    const cbtn = document.createElement("button");
    cbtn.type = "button";
    cbtn.textContent = "Close";
    Object.assign(cbtn.style, {
      border: "1px solid var(--border)",
      borderRadius: "4px",
      background: "transparent",
      color: "var(--fg)",
      padding: "6px 10px",
      fontSize: "12px",
      cursor: "pointer"
    });
    cbtn.onclick = () => overlay.remove();
    head.appendChild(input);
    head.appendChild(cbtn);

    const body = document.createElement("div");
    Object.assign(body.style, { overflow: "auto" });

    let rows = [];
    let sel = 0;

    function render() {
      const q = String(input.value || "").trim().toLowerCase();
      const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || "";
      rows = list
        .slice()
        .reverse()
        .filter((r) => {
          const cmd = String(r?.command || "");
          if (!cmd) return false;
          if (sid && String(r?.sessionId || "") !== String(sid)) return false;
          if (!q) return true;
          return cmd.toLowerCase().includes(q);
        })
        .slice(0, 200);
      sel = Math.min(sel, Math.max(rows.length - 1, 0));
      body.innerHTML = "";
      rows.forEach((r, idx) => {
        const row = document.createElement("div");
        row.className = "zte-palette-row";
        Object.assign(row.style, {
          padding: "8px",
          borderBottom: "1px solid var(--border)",
          cursor: "pointer",
          background: idx === sel ? "rgba(127,127,127,0.18)" : "transparent"
        });
        const t = new Date(Number(r?.timestamp || Date.now())).toLocaleString();
        const meta = document.createElement("div");
        meta.textContent = `${t}  (${String(r?.sessionId || "").trim() || "-"})`;
        Object.assign(meta.style, { fontSize: "11px", opacity: "0.75", marginBottom: "4px" });
        const cmd = document.createElement("div");
        cmd.textContent = String(r?.command || "");
        Object.assign(cmd.style, { fontFamily: "var(--font-mono)", fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
        row.appendChild(meta);
        row.appendChild(cmd);
        row.onmouseenter = () => { sel = idx; render(); };
        row.onclick = () => {
          overlay.remove();
          cmdInput.value = String(r?.command || "");
          cmdInput.focus();
          try { cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length); } catch {}
          scheduleSuggest();
        };
        body.appendChild(row);
      });
    }

    input.addEventListener("input", () => render());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        overlay.remove();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        sel = Math.min(sel + 1, Math.max(rows.length - 1, 0));
        render();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        sel = Math.max(sel - 1, 0);
        render();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const r = rows[sel];
        if (!r) return;
        overlay.remove();
        cmdInput.value = String(r?.command || "");
        cmdInput.focus();
        try { cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length); } catch {}
        scheduleSuggest();
      }
    });

    box.appendChild(head);
    box.appendChild(body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    render();
    setTimeout(() => input.focus(), 0);
  }

  function openQuickPalette() {
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,0.35)",
      zIndex: "1003"
    });
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      left: "50%",
      top: "18%",
      transform: "translateX(-50%)",
      width: "720px",
      maxHeight: "60vh",
      overflow: "hidden",
      background: "var(--panel)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      display: "grid",
      gridTemplateRows: "auto 1fr",
      boxSizing: "border-box",
      fontFamily: "var(--font-sans)"
    });

    const head = document.createElement("div");
    Object.assign(head.style, { padding: "8px", borderBottom: "1px solid var(--border)", display: "flex", gap: "8px", alignItems: "center" });
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "搜索并执行命令…";
    Object.assign(input.style, {
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
    const cbtn = document.createElement("button");
    cbtn.type = "button";
    cbtn.textContent = "Close";
    Object.assign(cbtn.style, {
      border: "1px solid var(--border)",
      borderRadius: "4px",
      background: "transparent",
      color: "var(--fg)",
      padding: "6px 10px",
      fontSize: "12px",
      cursor: "pointer"
    });
    cbtn.onclick = () => overlay.remove();
    head.appendChild(input);
    head.appendChild(cbtn);

    const body = document.createElement("div");
    Object.assign(body.style, { overflow: "auto" });

    let rows = [];
    let sel = 0;
    let rid = 0;
    let timer = 0;

    function paint() {
      sel = Math.min(sel, Math.max(rows.length - 1, 0));
      body.innerHTML = "";
      rows.forEach((it, idx) => {
        const row = document.createElement("div");
        row.className = "zte-palette-row";
        Object.assign(row.style, {
          padding: "8px",
          borderBottom: "1px solid var(--border)",
          cursor: "pointer",
          background: idx === sel ? "rgba(127,127,127,0.18)" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px"
        });
        const left = document.createElement("div");
        left.textContent = String(it.label || "");
        Object.assign(left.style, { fontFamily: "var(--font-mono)", fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
        const right = document.createElement("div");
        right.textContent = String(it.detail || "");
        Object.assign(right.style, { fontSize: "11px", opacity: "0.75", whiteSpace: "nowrap" });
        row.appendChild(left);
        row.appendChild(right);
        row.onmouseenter = () => { sel = idx; paint(); };
        row.onclick = async () => {
          const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
          if (!sid) { alert("没有活动会话"); return; }
          const cmd = String(it.insertText || it.label || "");
          if (!cmd.trim()) return;
          overlay.remove();
          hideSuggest();
          cmdInput.value = "";
          if (usingPty && pty) {
            pty.send(cmd + "\r");
          } else {
            await api.execute?.(cmd, sid);
            renderFallbackOutputs();
          }
          cmdInput.focus();
        };
        body.appendChild(row);
      });
    }

    async function update() {
      const id = ++rid;
      const q = String(input.value || "");
      const next = await buildSuggestions(q).catch(() => []);
      if (id !== rid) return;
      rows = Array.isArray(next) ? next.slice(0, 200) : [];
      paint();
    }

    function scheduleUpdate() {
      try { clearTimeout(timer); } catch {}
      timer = setTimeout(() => update(), 120);
    }

    input.addEventListener("input", () => { scheduleUpdate(); });
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        overlay.remove();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        sel = Math.min(sel + 1, Math.max(rows.length - 1, 0));
        paint();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        sel = Math.max(sel - 1, 0);
        paint();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const it = rows[sel];
        if (!it) return;
        const sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
        if (!sid) { alert("没有活动会话"); return; }
        const cmd = String(it.insertText || it.label || "");
        if (!cmd.trim()) return;
        overlay.remove();
        hideSuggest();
        cmdInput.value = "";
        if (usingPty && pty) {
          pty.send(cmd + "\r");
        } else {
          await api.execute?.(cmd, sid);
          renderFallbackOutputs();
        }
        cmdInput.focus();
      }
    });

    box.appendChild(head);
    box.appendChild(body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    update();
    setTimeout(() => input.focus(), 0);
  }

  // Wiring state changes
  const disp1 = window.zion.state.onDidChange("terminal.sessions", () => { renderTabs(); });
  const disp2 = window.zion.state.onDidChange("terminal.activeSessionId", async (nv) => {
    currentSessionId = nv || currentSessionId;
    renderTabs();
    if (currentSessionId) {
      const ok = await connectPtyForSession(currentSessionId);
      if (!ok) {
        if (xtermLoaded && term) {
          setUiMode("exec");
          bootstrapExecForSession(currentSessionId);
        } else {
          renderFallbackOutputs();
        }
      }
    }
  });
  const disp3 = window.zion.state.onDidChange("terminal.outputs", () => { if (!usingPty) renderFallbackOutputs(); });
  const disp4 = window.zion.events.on("terminal/commandExecuted", () => { if (!usingPty) renderFallbackOutputs(); });

  async function open(opts = {}) {
    try {
      const sessions0 = window.zion?.state?.get("terminal.sessions") || [];
      const list0 = Array.isArray(sessions0) ? sessions0 : [];
      if (!list0.length) {
        await window.zion?.commands?.executeCommand?.("terminal.refreshSessions");
      }
    } catch {}

    try {
      const sessions1 = window.zion?.state?.get("terminal.sessions") || [];
      const list1 = Array.isArray(sessions1) ? sessions1 : [];
      if (!list1.length) {
        await window.zion?.commands?.executeCommand?.("terminal.createSession", { type: "local" });
      }
    } catch {}

    renderTabs();

    let sid = currentSessionId || window.zion?.state?.get("terminal.activeSessionId") || null;
    if (!sid) {
      try {
        const sessions2 = window.zion?.state?.get("terminal.sessions") || [];
        const list2 = Array.isArray(sessions2) ? sessions2 : [];
        const first = list2.find(s => String(s?.id || "").trim());
        sid = String(first?.id || "").trim() || null;
        if (sid) {
          currentSessionId = sid;
          window.zion?.state?.set("terminal.activeSessionId", sid);
        }
      } catch {}
    }

    try {
      await ensureXtermLoaded();
      setUiMode("exec");
    } catch {
      setUiMode("pre");
    }

    if (sid) {
      const ok = await connectPtyForSession(sid);
      if (!ok) {
        if (xtermLoaded && term) bootstrapExecForSession(sid);
        else renderFallbackOutputs();
      }
    } else {
      if (xtermLoaded && term) {
        try { term.reset(); term.writeln("No active session"); term.writeln(""); } catch {}
      } else {
        renderFallbackOutputs();
      }
    }
    root.style.display = "block";
    if (opts.openQuick) {
      setTimeout(() => openQuickPalette(), 0);
    } else if (opts.openHistory) {
      setTimeout(() => openHistoryPalette(), 0);
    } else if (opts.focusCommand) {
      setTimeout(() => {
        if (xtermLoaded && term) {
          try { term.focus(); } catch {}
          return;
        }
        cmdInput.focus();
      }, 0);
    }
  }
  function close() {
    root.style.display = "none";
    hideSuggest();
  }
  function dispose() {
    try { disp1?.dispose?.(); disp2?.dispose?.(); disp3?.dispose?.(); disp4?.dispose?.(); } catch {}
    try { term?._zionCleanup?.(); } catch {}
    try { termDataDisp?.dispose?.(); } catch {}
    try { hideTermContextMenu(); } catch {}
    try { termFindWidget?.wrap?.remove?.(); } catch {}
    try { pty?.dispose?.(); } catch {}
    try { root.remove(); } catch {}
  }

  try {
    root._zionTerminalEnhanced = { open, close, dispose, openQuickPalette, openHistoryPalette };
  } catch {}

  return { open, close, dispose, openQuickPalette, openHistoryPalette };
}

function createHandle(root) {
  return {
    open(opts) {
      try {
        const h = root._zionTerminalEnhanced;
        if (h?.open) return h.open(opts);
      } catch {}
      root.style.display = "block";
    },
    close() {
      try {
        const h = root._zionTerminalEnhanced;
        if (h?.close) return h.close();
      } catch {}
      root.style.display = "none";
    },
    dispose() {
      try {
        const h = root._zionTerminalEnhanced;
        if (h?.dispose) return h.dispose();
      } catch {}
      root.remove();
    }
  };
}
