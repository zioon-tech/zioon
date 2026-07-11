/**
 * 终端会话管理面板
 * - 创建本地/SSH 会话
 * - 列出/获取/关闭会话
 * - 设置会话 cwd
 * - 状态总线：terminal.sessions / terminal.activeSessionId
 */
function t(key, fallback, values) {
  const fullKey = `dev.terminal-manager.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

export function installTerminalManagerPanel() {
  let root = document.getElementById("zion-terminal-manager-root");
  if (root) return createHandle(root);

  root = document.createElement("div");
  root.id = "zion-terminal-manager-root";
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    background: "transparent",
    zIndex: "1000",
    display: "none"
  });

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed",
    top: "56px",
    right: "12px",
    width: "350px",
    maxHeight: "65vh",
    overflow: "auto",
    background: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    padding: "8px",
    boxSizing: "border-box",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
  });

  const header = document.createElement("div");
  header.textContent = t("ui.sessions", "Terminal Sessions");
  Object.assign(header.style, {
    fontSize: "11px",
    opacity: "0.85",
    marginBottom: "6px",
    fontWeight: "600"
  });
  header.addEventListener("mousedown", (e) => e.preventDefault());

  // 注入“在对话中注入终端上下文”的勾选（默认选中）
  const ctxWrap = document.createElement("label");
  Object.assign(ctxWrap.style, {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    marginBottom: "6px",
    fontSize: "11px",
    userSelect: "none",
    cursor: "pointer"
  });
  const cbCtx = document.createElement("input");
  cbCtx.type = "checkbox";
  cbCtx.style.margin = "0";
  const spanCtx = document.createElement("span");
  spanCtx.textContent = t("ui.injectContext", "在对话中注入终端上下文");
  ctxWrap.appendChild(cbCtx);
  ctxWrap.appendChild(spanCtx);
  try {
    let initFlag = window.zion?.state?.get("chat.includeTerminalContext");
    if (initFlag === undefined) {
      initFlag = true;
      window.zion?.state?.set("chat.includeTerminalContext", true);
    }
    cbCtx.checked = initFlag !== false;
  } catch {}
  cbCtx.addEventListener("change", () => {
    try { window.zion?.state?.set("chat.includeTerminalContext", !!cbCtx.checked); } catch {}
  });

  // Base URL reader
  const readBase = () => {
    const st1 = window.zion?.state?.get("localTools.baseUrl");
    if (typeof st1 === "string" && st1.trim()) return st1.trim();
    try {
      const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
      if (s) return s.trim();
    } catch {}
    return "http://127.0.0.1:8765";
  };

  // Human-readable last activity formatter
  function formatLastActivity(val) {
    if (val == null) return { text: `(${t("ui.unknown", "unknown")})`, title: "" };

    let ts = null;
    if (typeof val === "number") {
      // seconds -> ms heuristic
      ts = val < 1e11 ? val * 1000 : val;
    } else if (typeof val === "string") {
      const n = Number(val);
      if (!Number.isNaN(n)) {
        ts = n < 1e11 ? n * 1000 : n;
      } else {
        const parsed = Date.parse(val);
        if (!Number.isNaN(parsed)) ts = parsed;
      }
    } else if (val instanceof Date) {
      ts = val.getTime();
    }

    if (ts == null) return { text: `(${t("ui.unknown", "unknown")})`, title: "" };

    const d = new Date(ts);
    const diffMs = Date.now() - d.getTime();
    const sec = Math.floor(diffMs / 1000);
    let text;
    if (sec < 10) text = t("ui.justNow", "just now");
    else if (sec < 60) text = `${sec}s ago`;
    else if (sec < 3600) text = `${Math.floor(sec / 60)}m ago`;
    else if (sec < 86400) text = `${Math.floor(sec / 3600)}h ago`;
    else if (sec < 86400 * 30) text = `${Math.floor(sec / 86400)}d ago`;
    else text = d.toLocaleString();

    const title = d.toLocaleString();
    return { text, title };
  }

  // Create form
  const form = document.createElement("div");
  Object.assign(form.style, {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: "6px",
    marginBottom: "6px"
  });

  const mkInput = (label, placeholder = "", type = "text") => {
    const wrap = document.createElement("label");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.gap = "4px";
    const lb = document.createElement("span");
    lb.textContent = label;
    Object.assign(lb.style, { fontSize: "11px", opacity: "0.8" });
    const inp = document.createElement("input");
    inp.type = type;
    inp.placeholder = placeholder;
    Object.assign(inp.style, {
      width: "100%",
      boxSizing: "border-box",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      background: "var(--panel)",
      color: "var(--fg)",
      outline: "none",
      padding: "4px 6px",
      fontSize: "11px",
      fontFamily: "inherit"
    });
    wrap.appendChild(lb);
    wrap.appendChild(inp);
    return { wrap, inp };
  };

  const typeWrap = document.createElement("label");
  typeWrap.style.display = "flex";
  typeWrap.style.flexDirection = "column";
  typeWrap.style.gap = "4px";
  const typeLb = document.createElement("span");
  typeLb.textContent = t("ui.type", "Type");
  Object.assign(typeLb.style, { fontSize: "11px", opacity: "0.8" });
  const typeSel = document.createElement("select");
  ["local","ssh"].forEach(v => {
    const o = document.createElement("option");
    o.value = v; o.textContent = v;
    typeSel.appendChild(o);
  });
  Object.assign(typeSel.style, {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    background: "var(--panel)",
    color: "var(--fg)",
    outline: "none",
    padding: "4px 6px",
    fontSize: "11px",
    fontFamily: "inherit"
  });
  typeWrap.appendChild(typeLb);
  typeWrap.appendChild(typeSel);

  const sshUser = mkInput(t("ui.sshUser", "SSH User"), "root");
  const sshHost = mkInput(t("ui.sshHost", "SSH Host (or alias)"), "e.g., las-dev");
  sshHost.inp.title = t("ui.sshHostTitle", "You can use SSH config alias (e.g., las-dev) or direct hostname (e.g., 101.126.47.38)");
  const sshPort = mkInput(t("ui.sshPort", "SSH Port"), "22", "number");
  const initialCwd = mkInput(t("ui.initialCwd", "Initial CWD"), "/");

  form.appendChild(typeWrap);
  form.appendChild(initialCwd.wrap);
  form.appendChild(sshUser.wrap);
  form.appendChild(sshHost.wrap);
  form.appendChild(sshPort.wrap);

  const btns = document.createElement("div");
  Object.assign(btns.style, { display: "flex", gap: "8px", marginTop: "6px", justifyContent: "flex-end" });

  const createBtn = document.createElement("button");
  createBtn.textContent = t("ui.create", "Create");
  createBtn.title = t("ui.create", "创建会话");
  Object.assign(createBtn.style, {
    border: "1px solid var(--border)",
    borderRadius: "4px",
    background: "var(--accent)",
    color: "var(--panel)",
    padding: "4px 8px",
    fontSize: "11px",
    cursor: "pointer"
  });

  const refreshBtn = document.createElement("button");
  refreshBtn.textContent = t("ui.refresh", "Refresh");
  Object.assign(refreshBtn.style, {
    border: "1px solid var(--border)",
    borderRadius: "4px",
    background: "transparent",
    color: "var(--fg)",
    padding: "4px 8px",
    fontSize: "11px",
    cursor: "pointer"
  });

  btns.appendChild(createBtn);
  btns.appendChild(refreshBtn);

  const list = document.createElement("div");
  Object.assign(list.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginTop: "6px",
    width: "100%",
    boxSizing: "border-box"
  });

  panel.appendChild(header);
  panel.appendChild(ctxWrap);
  panel.appendChild(form);
  panel.appendChild(btns);
  panel.appendChild(list);
  root.appendChild(panel);
  document.body.appendChild(root);

  let selectedId = null;

  function renderList(items) {
    list.innerHTML = "";
    const arr = Array.isArray(items) ? items : [];
    const activeId = window.zion?.state?.get("terminal.activeSessionId") || null;

    if (arr.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = t("ui.noSessions", "No sessions");
      Object.assign(empty.style, { fontSize: "11px", opacity: "0.6", textAlign: "center", padding: "6px" });
      list.appendChild(empty);
      return;
    }

    arr.forEach(s => {
      const card = document.createElement("div");
      card.className = "zion-session-row";
      card.dataset.level = "0";
      card.dataset.sid = String(s.id || "");
      card.tabIndex = 0;
      Object.assign(card.style, {
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "8px",
        borderRadius: "6px",
        cursor: "pointer",
        border: "1px solid var(--border)",
        background: "var(--panel)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
        width: "100%",
        boxSizing: "border-box"
      });

      // Header: ID + type badge + active mark
      const headerRow = document.createElement("div");
      Object.assign(headerRow.style, { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" });

      const title = document.createElement("div");
      title.textContent = s.id || "(unknown id)";
      Object.assign(title.style, {
        flex: "1",
        minWidth: "0",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        fontSize: "12px",
        fontWeight: "600"
      });

      const typeBadge = document.createElement("span");
      typeBadge.textContent = (s.type || "local").toUpperCase();
      Object.assign(typeBadge.style, {
        fontSize: "10px",
        opacity: "0.8",
        border: "1px solid var(--border)",
        borderRadius: "3px",
        padding: "0 4px",
        background: "rgba(128,128,128,0.08)"
      });

      const activeMark = document.createElement("span");
      const isActive = activeId && s.id && activeId === s.id;
      activeMark.textContent = isActive ? `✓ ${t("ui.current", "Active")}` : "";
      Object.assign(activeMark.style, {
        fontSize: "10px",
        opacity: isActive ? "0.85" : "0",
        color: "var(--accent)"
      });

      headerRow.appendChild(title);
      headerRow.appendChild(typeBadge);
      headerRow.appendChild(activeMark);
      card.appendChild(headerRow);

      // Details: SSH info, CWD, last activity
      const details = document.createElement("div");
      Object.assign(details.style, { display: "grid", gridTemplateColumns: "1fr", rowGap: "4px" });

      const mkDetail = (labelText, valueText, titleText) => {
        const row = document.createElement("div");
        Object.assign(row.style, { display: "flex", alignItems: "baseline", gap: "6px" });
        const lab = document.createElement("span");
        lab.textContent = labelText;
        Object.assign(lab.style, { fontSize: "10px", opacity: "0.7", minWidth: "90px" });
        const val = document.createElement("span");
        val.textContent = valueText || "";
        if (titleText) val.title = titleText;
        Object.assign(val.style, {
          fontSize: "11px",
          flex: "1",
          minWidth: "0",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "normal",
          wordBreak: "break-word"
        });
        row.appendChild(lab);
        row.appendChild(val);
        return row;
      };

      if ((s.type || "local") === "ssh") {
        const user = String(s.ssh_user || "").trim();
        const host = String(s.ssh_host || "").trim();
        const port = typeof s.ssh_port === "number" ? s.ssh_port : (s.ssh_port ? Number(s.ssh_port) : 22);
        const conn = `${user ? user + "@" : ""}${host}${host ? ":" + port : ""}`;
        details.appendChild(mkDetail("SSH", conn || "(not set)"));
      } else {
        details.appendChild(mkDetail(t("ui.type", "Type"), t("ui.local", "local")));
      }
      details.appendChild(mkDetail("CWD", String(s.cwd || "") || `(${t("ui.unknown", "unknown")})`));
      const fa = formatLastActivity(s.last_activity);
      details.appendChild(mkDetail("Last Activity", fa.text || `(${t("ui.unknown", "unknown")})`, fa.title));
      card.appendChild(details);

      // Actions: Set Active / Reactivate / Close / CWD input + Apply
      const actions = document.createElement("div");
      Object.assign(actions.style, { display: "flex", alignItems: "center", gap: "8px", marginTop: "2px", flexWrap: "wrap" });

      const btnActive = document.createElement("button");
      btnActive.type = "button";
      btnActive.title = t("ui.current", "Set Active Session");
      btnActive.setAttribute("aria-label", t("ui.current", "Set Active Session"));
      btnActive.textContent = t("ui.current", "Set Active");
      Object.assign(btnActive.style, {
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: "transparent",
        color: "var(--fg)",
        padding: "4px 8px",
        fontSize: "11px",
        cursor: "pointer"
      });
      btnActive.addEventListener("click", (e) => {
        e.stopPropagation();
        setActiveSession(s.id);
        updateSelectedStyles();
      });

      // Show Reactivate button only for SSH sessions
      const isSsh = (s.type || "local") === "ssh";
      const btnReactivate = document.createElement("button");
      btnReactivate.type = "button";
      btnReactivate.title = t("ui.reconnect", "Reactivate Session (reconnect SSH)");
      btnReactivate.setAttribute("aria-label", t("ui.reconnect", "Reactivate Session"));
      const reactivateIcon = window.zionIcons?.createFromCodicon?.("loading");
      if (reactivateIcon) btnReactivate.appendChild(reactivateIcon);
      btnReactivate.appendChild(document.createTextNode(t("ui.reconnect", "Reactivate")));
      btnReactivate.style.display = isSsh ? "inline-flex" : "none";
      Object.assign(btnReactivate.style, {
        alignItems: "center",
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: isSsh && s.active === false ? "rgba(255,165,0,0.15)" : "transparent",
        color: isSsh && s.active === false ? "orange" : "var(--fg)",
        gap: "4px",
        padding: "4px 8px",
        fontSize: "11px",
        cursor: "pointer"
      });
      btnReactivate.addEventListener("click", async (e) => {
        e.stopPropagation();
        await reactivateSession(s.id);
      });

      const btnClose = document.createElement("button");
      btnClose.type = "button";
      btnClose.title = t("ui.closeSession", "Close Session");
      btnClose.setAttribute("aria-label", t("ui.closeSession", "Close Session"));
      btnClose.textContent = t("ui.closeSession", "Close");
      Object.assign(btnClose.style, {
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: "transparent",
        color: "var(--fg)",
        padding: "4px 8px",
        fontSize: "11px",
        cursor: "pointer"
      });
      btnClose.addEventListener("click", async (e) => {
        e.stopPropagation();
        await closeSession(s.id);
      });

      const cwdInp = document.createElement("input");
      cwdInp.type = "text";
      cwdInp.placeholder = t("ui.cwd", "Set CWD...");
      cwdInp.value = String(s.cwd || "");
      Object.assign(cwdInp.style, {
        flex: "1",
        boxSizing: "border-box",
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: "var(--panel)",
        color: "var(--fg)",
        outline: "none",
        padding: "4px 6px",
        fontSize: "11px",
        fontFamily: "inherit",
        minWidth: "0",
        maxWidth: "100%"
      });

      const btnApply = document.createElement("button");
      btnApply.type = "button";
      btnApply.title = t("ui.updateCwd", "Apply CWD");
      btnApply.setAttribute("aria-label", t("ui.updateCwd", "Apply CWD"));
      btnApply.textContent = t("ui.updateCwd", "Apply CWD");
      Object.assign(btnApply.style, {
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: "transparent",
        color: "var(--fg)",
        padding: "4px 8px",
        fontSize: "11px",
        cursor: "pointer"
      });
      btnApply.addEventListener("click", async (e) => {
        e.stopPropagation();
        const cwd = cwdInp.value.trim();
        if (cwd) await applyCwdTo(s.id, cwd);
      });

      actions.appendChild(btnActive);
      actions.appendChild(btnReactivate);
      actions.appendChild(btnClose);
      actions.appendChild(cwdInp);
      actions.appendChild(btnApply);
      card.appendChild(actions);

      card.addEventListener("click", () => { selectedId = s.id; updateSelectedStyles(); });
      list.appendChild(card);
    });

    updateSelectedStyles();
  }

  function updateSelectedStyles() {
    const rows = list.querySelectorAll(".zion-session-row");
    const activeId = window.zion?.state?.get("terminal.activeSessionId") || null;
    rows.forEach(r => {
      const sid = r.dataset.sid || "";
      const isActive = sid && activeId && sid === activeId;
      const isSelected = sid && selectedId && sid === selectedId;
      r.classList.toggle("is-current", !!isActive);
      r.classList.toggle("is-selected", !!isSelected);
    });
  }

  async function refresh() {
    try {
      const base = readBase().replace(/\/$/, "");
      const res = await fetch(`${base}/sessions`, { method: "GET" });
      const data = await res.json().catch(() => null);
      if (!res.ok) return;
      const arr = data?.sessions || [];
      window.zion?.state?.set("terminal.sessions", arr);
      renderList(arr);
    } catch {}
  }

  async function create() {
    try {
      const base = readBase().replace(/\/$/, "");
      const payload = {
        type: typeSel.value || "local",
        ssh_user: sshUser.inp.value.trim() || undefined,
        ssh_host: sshHost.inp.value.trim() || undefined,
        ssh_port: sshPort.inp.value ? parseInt(sshPort.inp.value, 10) : undefined,
        initial_cwd: initialCwd.inp.value.trim() || undefined
      };
      const res = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) return;
      selectedId = data?.session?.id || null;
      window.zion?.state?.set("terminal.activeSessionId", selectedId);
      const listArr = (window.zion?.state?.get("terminal.sessions") || []).slice();
      if (data?.session) listArr.push(data.session);
      window.zion?.state?.set("terminal.sessions", listArr);
      renderList(listArr);
    } catch {}
  }

  async function closeSession(sid) {
    if (!sid) return;
    try {
      const base = readBase().replace(/\/$/, "");
      const res = await fetch(`${base}/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" });
      await res.json().catch(() => null);
      if (!res.ok) return;
      const listArr = (window.zion?.state?.get("terminal.sessions") || []).filter(s => s?.id !== sid);
      window.zion?.state?.set("terminal.sessions", listArr);
      const cur = window.zion?.state?.get("terminal.activeSessionId");
      if (cur === sid) window.zion?.state?.set("terminal.activeSessionId", null);
      if (selectedId === sid) selectedId = null;
      renderList(listArr);
    } catch {}
  }

  function setActiveSession(sid) {
    if (!sid) return;
    window.zion?.state?.set("terminal.activeSessionId", sid);
    updateSelectedStyles();
  }

  async function applyCwdTo(sid, cwd) {
    if (!sid || !cwd) return;
    try {
      const base = readBase().replace(/\/$/, "");
      const res = await fetch(`${base}/sessions/${encodeURIComponent(sid)}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: `cd "${cwd}"` })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) return;
      const listArr = (window.zion?.state?.get("terminal.sessions") || []).slice();
      for (let i = 0; i < listArr.length; i++) {
        if (listArr[i]?.id === sid) {
          listArr[i] = { ...listArr[i], cwd };
          break;
        }
      }
      window.zion?.state?.set("terminal.sessions", listArr);
      renderList(listArr);
    } catch {}
  }

  async function reactivateSession(sid) {
    if (!sid) return;
    try {
      const base = readBase().replace(/\/$/, "");
      const res = await fetch(`${base}/sessions/${encodeURIComponent(sid)}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.session) {
        const listArr = (window.zion?.state?.get("terminal.sessions") || []).slice();
        const idx = listArr.findIndex(s => s?.id === sid);
        if (idx >= 0) {
          listArr[idx] = data.session;
        }
        window.zion?.state?.set("terminal.sessions", listArr);
        renderList(listArr);
      } else {
        alert(t("msg.reconnectFailedWithError", "Reactivate failed: {message}", { message: data?.error || "Unknown error" }));
      }
    } catch (e) {
      alert(t("msg.reconnectFailedWithError", "Reactivate error: {message}", { message: e?.message || String(e) }));
    }
  }

  createBtn.addEventListener("click", create);
  refreshBtn.addEventListener("click", refresh);

  root.addEventListener("click", (e) => { if (e.target === root) root.style.display = "none"; });

  function open() {
    refresh();
    root.style.display = "block";
  }
  function close() {
    root.style.display = "none";
  }
  function dispose() {
    root.remove();
  }
  return { open, close, dispose };
}

export function mountTerminalManagerSidebarViewInto(container) {
  const root = document.createElement("div");
  Object.assign(root.style, {
    padding: "12px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    boxSizing: "border-box",
    width: "100%"
  });

  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px"
  });

  const title = document.createElement("div");
  title.textContent = t("ui.sessions", "终端会话");
  Object.assign(title.style, {
    fontSize: "15px",
    fontWeight: "600",
    letterSpacing: "0.01em"
  });

  const summary = document.createElement("div");
  summary.textContent = t("ui.loading", "正在读取会话...");
  Object.assign(summary.style, {
    fontSize: "11px",
    lineHeight: "1.5",
    opacity: "0.6"
  });

  header.appendChild(title);
  header.appendChild(summary);

  const toolbar = document.createElement("div");
  Object.assign(toolbar.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px"
  });

  const toolbarActions = document.createElement("div");
  Object.assign(toolbarActions.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap"
  });

  const makeButton = (text, primary = false) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    Object.assign(btn.style, {
      border: "1px solid var(--border)",
      borderRadius: "8px",
      background: primary ? "color-mix(in srgb, var(--accent) 18%, transparent)" : "transparent",
      color: "var(--fg)",
      padding: "6px 10px",
      fontSize: "12px",
      cursor: "pointer"
    });
    return btn;
  };

  const createToggleBtn = makeButton(t("ui.newTerminal", "新建终端"), true);
  const refreshBtn = makeButton(t("ui.refresh", "刷新"));
  toolbarActions.appendChild(createToggleBtn);
  toolbarActions.appendChild(refreshBtn);

  const ctxWrap = document.createElement("label");
  Object.assign(ctxWrap.style, {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "11px",
    lineHeight: "1.4",
    userSelect: "none",
    cursor: "pointer",
    opacity: "0.72"
  });
  const cbCtx = document.createElement("input");
  cbCtx.type = "checkbox";
  cbCtx.style.margin = "0";
  const spanCtx = document.createElement("span");
  spanCtx.textContent = t("ui.injectContext", "在对话中注入终端上下文");
  ctxWrap.appendChild(cbCtx);
  ctxWrap.appendChild(spanCtx);
  try {
    let initFlag = window.zion?.state?.get("chat.includeTerminalContext");
    if (initFlag === undefined) {
      initFlag = true;
      window.zion?.state?.set("chat.includeTerminalContext", true);
    }
    cbCtx.checked = initFlag !== false;
  } catch {}
  cbCtx.addEventListener("change", () => {
    try {
      window.zion?.state?.set("chat.includeTerminalContext", !!cbCtx.checked);
    } catch {}
  });

  toolbar.appendChild(toolbarActions);
  toolbar.appendChild(ctxWrap);

  const form = document.createElement("div");
  Object.assign(form.style, {
    display: "none",
    gridTemplateColumns: "1fr",
    gap: "8px",
    padding: "12px",
    border: "1px solid color-mix(in srgb, var(--border) 38%, transparent)",
    borderRadius: "12px",
    background: "color-mix(in srgb, var(--panel) 82%, transparent)"
  });

  const mkInput = (label, placeholder = "", type = "text") => {
    const wrap = document.createElement("label");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.gap = "4px";
    const lb = document.createElement("span");
    lb.textContent = label;
    Object.assign(lb.style, { fontSize: "10px", opacity: "0.62", textTransform: "uppercase", letterSpacing: "0.03em" });
    const inp = document.createElement("input");
    inp.type = type;
    inp.placeholder = placeholder;
    Object.assign(inp.style, {
      width: "100%",
      boxSizing: "border-box",
      border: "1px solid var(--border)",
      borderRadius: "8px",
      background: "transparent",
      color: "var(--fg)",
      outline: "none",
      padding: "6px 10px",
      fontSize: "12px",
      fontFamily: "inherit"
    });
    wrap.appendChild(lb);
    wrap.appendChild(inp);
    return { wrap, inp };
  };

  const typeWrap = document.createElement("label");
  typeWrap.style.display = "flex";
  typeWrap.style.flexDirection = "column";
  typeWrap.style.gap = "4px";
  const typeLb = document.createElement("span");
  typeLb.textContent = t("ui.type", "Type");
  Object.assign(typeLb.style, { fontSize: "10px", opacity: "0.62", textTransform: "uppercase", letterSpacing: "0.03em" });
  const typeSel = document.createElement("select");
  ["local", "ssh"].forEach((v) => {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    typeSel.appendChild(o);
  });
  Object.assign(typeSel.style, {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    background: "transparent",
    color: "var(--fg)",
    outline: "none",
    padding: "6px 10px",
    fontSize: "12px",
    fontFamily: "inherit"
  });
  typeWrap.appendChild(typeLb);
  typeWrap.appendChild(typeSel);

  const sshUser = mkInput(t("ui.sshUser", "SSH User"), "root");
  const sshHost = mkInput(t("ui.sshHost", "SSH Host (or alias)"), "e.g., las-dev");
  sshHost.inp.title = t("ui.sshHostTitle", "You can use SSH config alias (e.g., las-dev) or direct hostname (e.g., 101.126.47.38)");
  const sshPort = mkInput(t("ui.sshPort", "SSH Port"), "22", "number");
  const initialCwd = mkInput(t("ui.initialCwd", "Initial CWD"), "/");

  form.appendChild(typeWrap);
  form.appendChild(initialCwd.wrap);
  form.appendChild(sshUser.wrap);
  form.appendChild(sshHost.wrap);
  form.appendChild(sshPort.wrap);

  const btns = document.createElement("div");
  Object.assign(btns.style, { display: "flex", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap" });

  const createBtn = makeButton(t("ui.create", "创建终端"), true);
  const cancelCreateBtn = makeButton(t("ui.cancel", "取消"));

  btns.appendChild(createBtn);
  btns.appendChild(cancelCreateBtn);

  const list = document.createElement("div");
  Object.assign(list.style, {
    display: "flex",
    flexDirection: "column",
    gap: "0",
    width: "100%",
    boxSizing: "border-box"
  });

  const message = document.createElement("div");
  Object.assign(message.style, {
    display: "none",
    fontSize: "11px",
    lineHeight: "1.45",
    padding: "8px 10px",
    borderRadius: "8px",
    border: "1px solid color-mix(in srgb, var(--border) 36%, transparent)",
    background: "color-mix(in srgb, var(--panel) 82%, transparent)"
  });

  const readBase = () => {
    const st1 = window.zion?.state?.get("localTools.baseUrl");
    if (typeof st1 === "string" && st1.trim()) return st1.trim();
    try {
      const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
      if (s) return s.trim();
    } catch {}
    return "http://127.0.0.1:8765";
  };

  function basename(path) {
    const value = String(path || "").trim();
    if (!value) return "";
    const parts = value.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : value;
  }

  function shortPath(path) {
    const value = String(path || "").trim();
    if (!value) return "";
    const parts = value.split("/").filter(Boolean);
    if (parts.length <= 2) return value;
    return `.../${parts.slice(-2).join("/")}`;
  }

  function sessionTitle(s) {
    if ((s?.type || "local") === "ssh") {
      const host = String(s?.ssh_host || "").trim();
      const user = String(s?.ssh_user || "").trim();
      if (host) return `${user ? `${user}@` : ""}${host}`;
      return t("ui.sshSession", "SSH 会话");
    }
    return basename(s?.cwd) || t("ui.localTerminal", "本地终端");
  }

  function sessionMeta(s) {
    const type = (s?.type || "local") === "ssh" ? "SSH" : t("ui.local", "Local");
    const cwd = shortPath(s?.cwd) || t("ui.cwdUnset", "未设置工作目录");
    const fa = formatLastActivity(s?.last_activity);
    return { text: `${type} · ${cwd} · ${fa.text || "(unknown)"}`, title: fa.title || String(s?.cwd || "") };
  }

  function showMessage(text, tone = "info") {
    const value = String(text || "").trim();
    if (!value) {
      message.style.display = "none";
      message.textContent = "";
      return;
    }
    message.textContent = value;
    message.style.display = "block";
    message.style.color = tone === "error" ? "#f2a7a7" : "var(--fg)";
    message.style.background = tone === "error"
      ? "rgba(190, 70, 70, 0.12)"
      : "color-mix(in srgb, var(--panel) 82%, transparent)";
  }

  function formatLastActivity(val) {
    if (val == null) return { text: `(${t("ui.unknown", "unknown")})`, title: "" };

    let ts = null;
    if (typeof val === "number") {
      ts = val < 1e11 ? val * 1000 : val;
    } else if (typeof val === "string") {
      const n = Number(val);
      if (!Number.isNaN(n)) {
        ts = n < 1e11 ? n * 1000 : n;
      } else {
        const parsed = Date.parse(val);
        if (!Number.isNaN(parsed)) ts = parsed;
      }
    } else if (val instanceof Date) {
      ts = val.getTime();
    }

    if (ts == null) return { text: `(${t("ui.unknown", "unknown")})`, title: "" };

    const d = new Date(ts);
    const diffMs = Date.now() - d.getTime();
    const sec = Math.floor(diffMs / 1000);
    let text;
    if (sec < 10) text = t("ui.justNow", "just now");
    else if (sec < 60) text = `${sec}s ago`;
    else if (sec < 3600) text = `${Math.floor(sec / 60)}m ago`;
    else if (sec < 86400) text = `${Math.floor(sec / 3600)}h ago`;
    else if (sec < 86400 * 30) text = `${Math.floor(sec / 86400)}d ago`;
    else text = d.toLocaleString();

    const title = d.toLocaleString();
    return { text, title };
  }

  let selectedId = null;
  let expandedId = null;
  let currentItems = [];
  let createExpanded = false;

  function syncCreateVisibility() {
    form.style.display = createExpanded ? "grid" : "none";
    createToggleBtn.textContent = createExpanded ? t("ui.collapseNew", "收起新建") : t("ui.newTerminal", "新建终端");
    const isSsh = typeSel.value === "ssh";
    sshUser.wrap.style.display = isSsh ? "flex" : "none";
    sshHost.wrap.style.display = isSsh ? "flex" : "none";
    sshPort.wrap.style.display = isSsh ? "flex" : "none";
  }

  function updateSummary(items) {
    const arr = Array.isArray(items) ? items : [];
    const activeId = window.zion?.state?.get("terminal.activeSessionId") || null;
    const active = arr.find((item) => item?.id && item.id === activeId) || null;
    if (!arr.length) {
      summary.textContent = t("ui.noSessionsSummary", "还没有终端会话。可以先新建一个本地终端。");
      return;
    }
    summary.textContent = active
      ? t("ui.summaryActive", "共 {count} 个会话，当前使用 {name}。", { count: arr.length, name: sessionTitle(active) })
      : t("ui.summaryNoActive", "共 {count} 个会话，还没有当前终端。", { count: arr.length });
  }

  function updateSelectedStyles() {
    const rows = list.querySelectorAll(".zion-session-row");
    const activeId = window.zion?.state?.get("terminal.activeSessionId") || null;
    rows.forEach((r) => {
      const sid = r.dataset.sid || "";
      const isActive = sid && activeId && sid === activeId;
      const isSelected = sid && selectedId && sid === selectedId;
      r.classList.toggle("is-current", !!isActive);
      r.classList.toggle("is-selected", !!isSelected);
    });
  }

  function setActiveSession(sid) {
    if (!sid) return;
    window.zion?.state?.set("terminal.activeSessionId", sid);
    updateSelectedStyles();
  }

  async function closeSession(sid) {
    if (!sid) return;
    try {
      const base = readBase().replace(/\/$/, "");
      const res = await fetch(`${base}/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" });
      await res.json().catch(() => null);
      if (!res.ok) {
        showMessage(t("msg.closeFailed", "关闭终端失败，请稍后再试。"), "error");
        return;
      }
      const listArr = (window.zion?.state?.get("terminal.sessions") || []).filter((s) => s?.id !== sid);
      window.zion?.state?.set("terminal.sessions", listArr);
      const cur = window.zion?.state?.get("terminal.activeSessionId");
      if (cur === sid) window.zion?.state?.set("terminal.activeSessionId", null);
      if (selectedId === sid) selectedId = null;
      renderList(listArr);
    } catch (e) {
      showMessage(t("msg.closeFailedWithError", "关闭终端失败：{message}", { message: e?.message || String(e) }), "error");
    }
  }

  async function applyCwdTo(sid, cwd) {
    if (!sid || !cwd) return;
    try {
      const base = readBase().replace(/\/$/, "");
      const res = await fetch(`${base}/sessions/${encodeURIComponent(sid)}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: `cd "${cwd}"` })
      });
      await res.json().catch(() => null);
      if (!res.ok) {
        showMessage(t("msg.cwdFailed", "更新工作目录失败，请稍后再试。"), "error");
        return;
      }
      const listArr = (window.zion?.state?.get("terminal.sessions") || []).slice();
      for (let i = 0; i < listArr.length; i++) {
        if (listArr[i]?.id === sid) {
          listArr[i] = { ...listArr[i], cwd };
          break;
        }
      }
      window.zion?.state?.set("terminal.sessions", listArr);
      renderList(listArr);
    } catch (e) {
      showMessage(t("msg.cwdFailedWithError", "更新工作目录失败：{message}", { message: e?.message || String(e) }), "error");
    }
  }

  async function reactivateSession(sid) {
    if (!sid) return;
    try {
      const base = readBase().replace(/\/$/, "");
      const res = await fetch(`${base}/sessions/${encodeURIComponent(sid)}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.session) {
        const listArr = (window.zion?.state?.get("terminal.sessions") || []).slice();
        const idx = listArr.findIndex((s) => s?.id === sid);
        if (idx >= 0) {
          listArr[idx] = data.session;
        }
        window.zion?.state?.set("terminal.sessions", listArr);
        renderList(listArr);
        showMessage(t("msg.reconnected", "已重新连接终端会话。"));
      } else {
        showMessage(t("msg.reconnectFailed", "重新连接失败，请稍后再试。"), "error");
      }
    } catch (e) {
      showMessage(t("msg.reconnectFailedWithError", "重新连接失败：{message}", { message: e?.message || String(e) }), "error");
    }
  }

  function renderList(items) {
    currentItems = Array.isArray(items) ? items : [];
    list.innerHTML = "";
    const arr = currentItems;
    const activeId = window.zion?.state?.get("terminal.activeSessionId") || null;
    updateSummary(arr);

    if (arr.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = t("ui.noSessions", "还没有终端会话。点击“新建终端”创建一个本地会话。");
      Object.assign(empty.style, {
        fontSize: "12px",
        lineHeight: "1.5",
        opacity: "0.72",
        textAlign: "left",
        padding: "10px 0"
      });
      list.appendChild(empty);
      return;
    }

    arr.forEach((s) => {
      const card = document.createElement("div");
      card.className = "zion-session-row";
      card.dataset.level = "0";
      card.dataset.sid = String(s.id || "");
      card.tabIndex = 0;
      Object.assign(card.style, {
        display: "flex",
        flexDirection: "column",
        gap: "0",
        padding: "12px 0",
        borderRadius: "0",
        cursor: "default",
        border: "none",
        borderBottom: "1px solid color-mix(in srgb, var(--border) 18%, transparent)",
        background: "transparent",
        boxShadow: "none",
        width: "100%",
        boxSizing: "border-box",
        whiteSpace: "normal"
      });

      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) auto",
        gap: "12px",
        alignItems: "center"
      });

      const main = document.createElement("button");
      main.type = "button";
      Object.assign(main.style, {
        border: "none",
        background: "transparent",
        color: "var(--fg)",
        padding: "0",
        textAlign: "left",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        minWidth: "0"
      });
      main.addEventListener("click", () => {
        selectedId = s.id;
        setActiveSession(s.id);
        renderList(currentItems);
      });

      const mainTitle = document.createElement("div");
      mainTitle.textContent = sessionTitle(s);
      Object.assign(mainTitle.style, {
        fontSize: "12px",
        fontWeight: "600",
        lineHeight: "1.4",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis"
      });

      const meta = sessionMeta(s);
      const mainMeta = document.createElement("div");
      mainMeta.textContent = meta.text;
      if (meta.title) mainMeta.title = meta.title;
      Object.assign(mainMeta.style, {
        fontSize: "11px",
        lineHeight: "1.5",
        opacity: "0.6",
        whiteSpace: "normal",
        wordBreak: "break-word"
      });

      const rawId = document.createElement("div");
      rawId.textContent = String(s.id || "");
      Object.assign(rawId.style, {
        fontSize: "10px",
        lineHeight: "1.3",
        opacity: "0.38",
        fontFamily: "var(--font-mono, monospace)"
      });

      main.appendChild(mainTitle);
      main.appendChild(mainMeta);
      if (String(s.id || "") && String(s.id || "") !== sessionTitle(s)) main.appendChild(rawId);

      const side = document.createElement("div");
      Object.assign(side.style, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap",
        justifyContent: "flex-end"
      });

      const isActive = activeId && s.id && activeId === s.id;
      if (isActive) {
        const current = document.createElement("span");
        current.textContent = t("ui.current", "当前");
        Object.assign(current.style, {
          fontSize: "10px",
          lineHeight: "1.2",
          opacity: "0.72",
          padding: "0 6px",
          minHeight: "18px",
          display: "inline-flex",
          alignItems: "center",
          borderRadius: "999px",
          background: "color-mix(in srgb, var(--accent) 14%, transparent)"
        });
        side.appendChild(current);
      }

      const moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.textContent = expandedId === s.id ? t("ui.collapse", "收起") : t("ui.more", "更多");
      Object.assign(moreBtn.style, {
        border: "none",
        background: "transparent",
        color: "var(--fg)",
        opacity: "0.64",
        padding: "0",
        fontSize: "11px",
        cursor: "pointer"
      });
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedId = s.id;
        expandedId = expandedId === s.id ? null : s.id;
        renderList(currentItems);
      });
      side.appendChild(moreBtn);

      row.appendChild(main);
      row.appendChild(side);
      card.appendChild(row);

      if (expandedId === s.id) {
        const detail = document.createElement("div");
        Object.assign(detail.style, {
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: "10px",
          marginTop: "10px",
          paddingTop: "10px",
          borderTop: "1px solid color-mix(in srgb, var(--border) 16%, transparent)"
        });

        if ((s.type || "local") === "ssh") {
          const sshInfo = document.createElement("div");
          sshInfo.textContent = `SSH: ${String(s.ssh_user || "").trim() ? `${String(s.ssh_user || "").trim()}@` : ""}${String(s.ssh_host || "").trim() || "(unknown host)"}:${typeof s.ssh_port === "number" ? s.ssh_port : s.ssh_port ? Number(s.ssh_port) : 22}`;
          Object.assign(sshInfo.style, { fontSize: "11px", lineHeight: "1.5", opacity: "0.62" });
          detail.appendChild(sshInfo);
        }

        const cwdRow = document.createElement("div");
        Object.assign(cwdRow.style, {
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) auto",
          gap: "8px",
          alignItems: "center"
        });

        const cwdInp = document.createElement("input");
        cwdInp.type = "text";
        cwdInp.placeholder = t("ui.cwd", "工作目录");
        cwdInp.value = String(s.cwd || "");
        Object.assign(cwdInp.style, {
          width: "100%",
          boxSizing: "border-box",
          border: "1px solid var(--border)",
          borderRadius: "8px",
          background: "transparent",
          color: "var(--fg)",
          outline: "none",
          padding: "6px 10px",
          fontSize: "12px",
          fontFamily: "inherit",
          minWidth: "0"
        });

        const btnApply = makeButton(t("ui.updateCwd", "更新目录"));
        btnApply.addEventListener("click", async () => {
          const cwd = cwdInp.value.trim();
          if (!cwd) return;
          await applyCwdTo(s.id, cwd);
          showMessage(t("msg.cwdUpdated", "已更新工作目录。"));
        });
        cwdRow.appendChild(cwdInp);
        cwdRow.appendChild(btnApply);
        detail.appendChild(cwdRow);

        const actions = document.createElement("div");
        Object.assign(actions.style, {
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flexWrap: "wrap"
        });

        const openBtn = makeButton(t("ui.openTerminal", "打开终端"));
        openBtn.addEventListener("click", async () => {
          setActiveSession(s.id);
          try { await window.zion.commands.executeCommand("terminal.openPanel"); } catch {}
        });
        actions.appendChild(openBtn);

        if ((s.type || "local") === "ssh" && s.active === false) {
          const reactivateBtn = makeButton(t("ui.reconnect", "重新连接"));
          reactivateBtn.addEventListener("click", async () => {
            await reactivateSession(s.id);
          });
          actions.appendChild(reactivateBtn);
        }

        const closeBtn = makeButton(t("ui.closeSession", "关闭会话"));
        closeBtn.addEventListener("click", async () => {
          await closeSession(s.id);
          showMessage(t("msg.closed", "已关闭终端会话。"));
        });
        actions.appendChild(closeBtn);

        detail.appendChild(actions);
        card.appendChild(detail);
      }

      list.appendChild(card);
    });

    updateSelectedStyles();
  }

  async function refresh() {
    try {
      const base = readBase().replace(/\/$/, "");
      const res = await fetch(`${base}/sessions`, { method: "GET" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showMessage(t("msg.refreshFailed", "刷新终端列表失败。"), "error");
        return;
      }
      const arr = data?.sessions || [];
      window.zion?.state?.set("terminal.sessions", arr);
      renderList(arr);
      showMessage("");
    } catch (e) {
      showMessage(t("msg.refreshFailedWithError", "刷新终端列表失败：{message}", { message: e?.message || String(e) }), "error");
    }
  }

  async function create() {
    try {
      const base = readBase().replace(/\/$/, "");
      const payload = {
        type: typeSel.value || "local",
        ssh_user: sshUser.inp.value.trim() || undefined,
        ssh_host: sshHost.inp.value.trim() || undefined,
        ssh_port: sshPort.inp.value ? parseInt(sshPort.inp.value, 10) : undefined,
        initial_cwd: initialCwd.inp.value.trim() || undefined
      };
      const res = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showMessage(t("msg.createFailed", "创建终端失败，请检查填写内容。"), "error");
        return;
      }
      selectedId = data?.session?.id || null;
      expandedId = selectedId;
      window.zion?.state?.set("terminal.activeSessionId", selectedId);
      const listArr = (window.zion?.state?.get("terminal.sessions") || []).slice();
      if (data?.session) listArr.push(data.session);
      window.zion?.state?.set("terminal.sessions", listArr);
      createExpanded = false;
      syncCreateVisibility();
      renderList(listArr);
      showMessage(t("msg.created", "终端已创建，并设为当前会话。"));
    } catch (e) {
      showMessage(t("msg.createFailedWithError", "创建终端失败：{message}", { message: e?.message || String(e) }), "error");
    }
  }

  createToggleBtn.addEventListener("click", () => {
    createExpanded = !createExpanded;
    syncCreateVisibility();
  });
  cancelCreateBtn.addEventListener("click", () => {
    createExpanded = false;
    syncCreateVisibility();
  });
  typeSel.addEventListener("change", syncCreateVisibility);
  createBtn.addEventListener("click", create);
  refreshBtn.addEventListener("click", refresh);

  function refreshI18n() {
    title.textContent = t("ui.sessions", "终端会话");
    spanCtx.textContent = t("ui.injectContext", "在对话中注入终端上下文");
    typeLb.textContent = t("ui.type", "Type");
    try { sshUser.wrap.querySelector("span").textContent = t("ui.sshUser", "SSH User"); } catch {}
    try { sshHost.wrap.querySelector("span").textContent = t("ui.sshHost", "SSH Host (or alias)"); } catch {}
    try { sshPort.wrap.querySelector("span").textContent = t("ui.sshPort", "SSH Port"); } catch {}
    try { initialCwd.wrap.querySelector("span").textContent = t("ui.initialCwd", "Initial CWD"); } catch {}
    sshHost.inp.title = t("ui.sshHostTitle", "You can use SSH config alias (e.g., las-dev) or direct hostname (e.g., 101.126.47.38)");
    createBtn.textContent = t("ui.create", "创建终端");
    cancelCreateBtn.textContent = t("ui.cancel", "取消");
    refreshBtn.textContent = t("ui.refresh", "刷新");
    syncCreateVisibility();
    renderList(currentItems);
  }

  syncCreateVisibility();

  form.appendChild(btns);

  root.appendChild(header);
  root.appendChild(toolbar);
  root.appendChild(form);
  root.appendChild(message);
  root.appendChild(list);

  container.appendChild(root);

  const disp1 = window.zion?.state?.onDidChange?.("terminal.sessions", (nv) => {
    try {
      if (Array.isArray(nv)) renderList(nv);
    } catch {}
  });
  const disp2 = window.zion?.state?.onDidChange?.("terminal.activeSessionId", () => {
    try {
      updateSelectedStyles();
    } catch {}
  });
  const disp3 = window.zion?.state?.onDidChange?.("chat.includeTerminalContext", (nv) => {
    try {
      cbCtx.checked = nv !== false;
    } catch {}
  });
  const disp4 = window.zion?.events?.on?.("i18n/changed", refreshI18n);

  void refresh();

  return {
    dispose: () => {
      try {
        disp1?.dispose?.();
      } catch {}
      try {
        disp2?.dispose?.();
      } catch {}
      try {
        disp3?.dispose?.();
      } catch {}
      try {
        disp4?.dispose?.();
      } catch {}
      try {
        root.remove();
      } catch {}
    }
  };
}

function createHandle(root) {
  return {
    open() { root.style.display = "block"; },
    close() { root.style.display = "none"; },
    dispose() { root.remove(); }
  };
}
