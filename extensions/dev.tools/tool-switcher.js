/**
 * 工具切换器面板（与模型选择器交互保持一致：搜索、键盘导航、Enter/Esc）
 * 行为差异：Enter/点击为“切换启用状态”（多选），Esc 关闭。
 */
export function installToolSwitcher() {
  let root = document.getElementById("zion-tools-switcher-root");
  if (root) return createHandle(root);

  // 背景遮罩
  root = document.createElement("div");
  root.id = "zion-tools-switcher-root";
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    background: "transparent",
    zIndex: "100001",
    display: "none"
  });

  // 面板
  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed",
    top: "48px",
    right: "12px",
    width: "420px",
    maxHeight: "65vh",
    overflow: "auto",
    background: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    padding: "8px",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
  });

  // 标题
  const header = document.createElement("div");
  header.textContent = "Select Tools";
  Object.assign(header.style, {
    fontSize: "11px",
    opacity: "0.8",
    marginBottom: "6px",
    fontWeight: "500"
  });
  header.addEventListener("mousedown", (e) => e.preventDefault());

  // 搜索框
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Search tools…";
  Object.assign(input.style, {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    background: "var(--panel)",
    color: "var(--fg)",
    outline: "none",
    padding: "4px 6px",
    fontSize: "11px",
    marginBottom: "6px",
    fontFamily: "inherit"
  });
  panel.addEventListener("mousedown", (e) => {
    if (e.target === panel) {
      e.preventDefault();
      input.focus();
    }
  });

  // 列表容器
  const list = document.createElement("div");
  Object.assign(list.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px"
  });

  // 底部提示
  const footer = document.createElement("div");
  footer.textContent = "Enter: toggle • Esc: close • ↑↓: navigate";
  Object.assign(footer.style, {
    fontSize: "10px",
    opacity: "0.6",
    marginTop: "6px",
    textAlign: "center",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
  });

  panel.appendChild(header);
  panel.appendChild(input);
  panel.appendChild(list);
  panel.appendChild(footer);
  root.appendChild(panel);
  document.body.appendChild(root);

  let selectedIdx = 0;
  let currentItems = [];

  function allTools() {
    const arr = window.zion?.state?.get("chat.tools") || [];
    return arr
      .map(t => ({
        name: t?.function?.name || "",
        description: t?.function?.description || ""
      }))
      .filter(it => it.name);
  }
  function enabledSet() {
    const e = window.zion?.state?.get("chat.enabledTools");
    if (Array.isArray(e)) return new Set(e);
    return new Set(allTools().map(it => it.name));
  }
  function setEnabled(set) {
    const arr = Array.from(set);
    window.zion?.state?.set("chat.enabledTools", arr);
  }

  function rowStyle(div, active) {
    Object.assign(div.style, {
      padding: "4px 6px",
      borderRadius: "4px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      cursor: "pointer",
      background: active ? "var(--accent)" : "transparent",
      color: active ? "var(--panel)" : "var(--fg)",
      transition: "background-color 120ms ease, color 120ms ease",
      fontFamily: "inherit",
      fontSize: "11px",
      lineHeight: "1.3"
    });
  }

  function rightHint(text) {
    const el = document.createElement("span");
    el.textContent = text;
    Object.assign(el.style, {
      fontSize: "10px",
      opacity: "0.6",
      marginLeft: "8px",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      flexShrink: "0"
    });
    return el;
  }

  function renderItems(items) {
    list.innerHTML = "";
    const enabled = enabledSet();

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No tools found";
      Object.assign(empty.style, { 
        fontSize: "11px", 
        opacity: "0.6", 
        padding: "4px 6px",
        textAlign: "center",
        fontStyle: "italic"
      });
      list.appendChild(empty);
      return;
    }

    items.forEach((m, i) => {
      const row = document.createElement("div");
      row.dataset.index = String(i);
      rowStyle(row, i === selectedIdx);

      const isEnabled = enabled.has(m.name);

      // 复选框（最左侧）
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = isEnabled;
      Object.assign(cb.style, {
        flexShrink: "0",
        marginRight: "8px",
        cursor: "pointer"
      });
      cb.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(items[i]);
      });

      // 名称（中间，flex 占位）
      const left = document.createElement("div");
      left.textContent = m.name;
      Object.assign(left.style, {
        flex: "1",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      });

      // 描述（右侧，截断并弱化）
      const right = document.createElement("div");
      right.className = "meta-wrap";
      const desc = m.description || "";
      right.textContent = desc;
      Object.assign(right.style, {
        fontSize: "10px",
        opacity: i === selectedIdx ? "0.8" : "0.5",
        marginLeft: "10px",
        color: "var(--fg)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        textAlign: "left",
        flex: "0 1 60%",
        minWidth: "0",
        flexShrink: "1"
      });

      row.appendChild(cb);
      row.appendChild(left);
      row.appendChild(right);

      row.addEventListener("mouseenter", () => {
        selectedIdx = i;
        updateSelectionStyles();
        ensureSelectedVisible();
      });
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("click", (e) => {
        e.preventDefault();
        toggle(items[i]);
      });

      list.appendChild(row);
    });

    ensureSelectedVisible();
  }

  function updateSelectionStyles() {
    const rows = list.querySelectorAll('div[data-index]');
    rows.forEach((row) => {
      const idx = Number(row.dataset.index || -1);
      rowStyle(row, idx === selectedIdx);
      const right = row.querySelector("div > span, .meta-wrap");
      if (right && right.style) {
        right.style.opacity = idx === selectedIdx ? "0.8" : "0.5";
      }
    });
  }

  function ensureSelectedVisible() {
    const row = list.querySelector(`div[data-index="${selectedIdx}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  }

  function refresh() {
    const tools = allTools();
    const q = (input.value || "").trim().toLowerCase();
    const filtered = tools.filter(m => {
      const s = `${m.name} ${m.description}`.toLowerCase();
      return q ? s.includes(q) : true;
    });
    currentItems = filtered;

    // 优先选中第一个
    selectedIdx = Math.min(selectedIdx, Math.max(0, filtered.length - 1));
    renderItems(filtered);
  }

  function toggle(m) {
    if (!m?.name) return;
    const set = enabledSet();
    if (set.has(m.name)) set.delete(m.name); else set.add(m.name);
    try { localStorage.setItem("zion.enabledTools.userCustomized", "1"); } catch {}
    setEnabled(set);
    refresh();
  }

  input.addEventListener("input", refresh);
  input.addEventListener("keydown", (e) => {
    const last = Math.max(0, currentItems.length - 1);
    if (e.key === "ArrowDown") {
      selectedIdx = Math.min(selectedIdx + 1, last);
      renderItems(currentItems);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      selectedIdx = Math.max(selectedIdx - 1, 0);
      renderItems(currentItems);
      e.preventDefault();
    } else if (e.key === "PageDown") {
      selectedIdx = Math.min(selectedIdx + 5, last);
      renderItems(currentItems);
      e.preventDefault();
    } else if (e.key === "PageUp") {
      selectedIdx = Math.max(selectedIdx - 5, 0);
      renderItems(currentItems);
      e.preventDefault();
    } else if (e.key === "Home") {
      selectedIdx = 0;
      renderItems(currentItems);
      e.preventDefault();
    } else if (e.key === "End") {
      selectedIdx = last;
      renderItems(currentItems);
      e.preventDefault();
    } else if (e.key === "Enter") {
      toggle(currentItems[selectedIdx]);
      e.preventDefault();
    } else if (e.key === "Escape") {
      close();
      e.preventDefault();
    }
  });

  root.addEventListener("click", (e) => {
    if (e.target === root) close();
  });

  function positionPanel() {
    const btns = document.querySelectorAll("#statusbar .status-item");
    let btn = null;
    for (const b of btns) {
      if (b.textContent?.includes("Tools:")) { btn = b; break; }
    }
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    panel.style.top = `${rect.top - 8 - 400}px`;
    panel.style.right = `${window.innerWidth - rect.right}px`;
    if (parseFloat(panel.style.top) < 8) {
      panel.style.top = `${rect.bottom + 8}px`;
    }
  }

  function open() {
    refresh();
    positionPanel();
    root.style.display = "block";
    input.focus();
    input.select();
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
  const panel = root.querySelector("div");
  const input = panel?.querySelector("input");
  return {
    open() {
      input?.dispatchEvent(new Event("input"));
      root.style.display = "block";
      input?.focus();
      input?.select();
    },
    close() { root.style.display = "none"; },
    dispose() { root.remove(); }
  };
}
