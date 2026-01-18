/**
 * 终端会话管理面板
 * - 创建本地/SSH 会话
 * - 列出/获取/关闭会话
 * - 设置会话 cwd
 * - 状态总线：terminal.sessions / terminal.activeSessionId
 */
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
  header.textContent = "Terminal Sessions";
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
  spanCtx.textContent = "在对话中注入终端上下文";
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
    if (val == null) return { text: "(unknown)", title: "" };

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

    if (ts == null) return { text: "(unknown)", title: "" };

    const d = new Date(ts);
    const diffMs = Date.now() - d.getTime();
    const sec = Math.floor(diffMs / 1000);
    let text;
    if (sec < 10) text = "just now";
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
  typeLb.textContent = "Type";
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

  const sshUser = mkInput("SSH User", "root");
  const sshHost = mkInput("SSH Host", "example.com");
  const sshPort = mkInput("SSH Port", "22", "number");
  const initialCwd = mkInput("Initial CWD", "/");

  form.appendChild(typeWrap);
  form.appendChild(initialCwd.wrap);
  form.appendChild(sshUser.wrap);
  form.appendChild(sshHost.wrap);
  form.appendChild(sshPort.wrap);

  const btns = document.createElement("div");
  Object.assign(btns.style, { display: "flex", gap: "8px", marginTop: "6px", justifyContent: "flex-end" });

  const createBtn = document.createElement("button");
  createBtn.textContent = "Create";
  createBtn.title = "创建会话";
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
  refreshBtn.textContent = "Refresh";
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
      empty.textContent = "No sessions";
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
      activeMark.textContent = isActive ? "✓ Active" : "";
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
        details.appendChild(mkDetail("Type", "local"));
      }
      details.appendChild(mkDetail("CWD", String(s.cwd || "") || "(unknown)"));
      const fa = formatLastActivity(s.last_activity);
      details.appendChild(mkDetail("Last Activity", fa.text || "(unknown)", fa.title));
      card.appendChild(details);

      // Actions: Set Active / Reactivate / Close / CWD input + Apply
      const actions = document.createElement("div");
      Object.assign(actions.style, { display: "flex", alignItems: "center", gap: "8px", marginTop: "2px", flexWrap: "wrap" });

      const btnActive = document.createElement("button");
      btnActive.type = "button";
      btnActive.title = "Set Active Session";
      btnActive.setAttribute("aria-label", "Set Active Session");
      btnActive.textContent = "Set Active";
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
      btnReactivate.title = "Reactivate Session (reconnect SSH)";
      btnReactivate.setAttribute("aria-label", "Reactivate Session");
      btnReactivate.textContent = "🔄 Reactivate";
      btnReactivate.style.display = isSsh ? "inline-block" : "none";
      Object.assign(btnReactivate.style, {
        border: "1px solid var(--border)",
        borderRadius: "4px",
        background: isSsh && s.active === false ? "rgba(255,165,0,0.15)" : "transparent",
        color: isSsh && s.active === false ? "orange" : "var(--fg)",
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
      btnClose.title = "Close Session";
      btnClose.setAttribute("aria-label", "Close Session");
      btnClose.textContent = "Close";
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
      cwdInp.placeholder = "Set CWD…";
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
      btnApply.title = "Apply CWD";
      btnApply.setAttribute("aria-label", "Apply CWD");
      btnApply.textContent = "Apply CWD";
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
        alert("Reactivate failed: " + (data?.error || "Unknown error"));
      }
    } catch (e) {
      alert("Reactivate error: " + (e?.message || String(e)));
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

function createHandle(root) {
  return {
    open() { root.style.display = "block"; },
    close() { root.style.display = "none"; },
    dispose() { root.remove(); }
  };
}