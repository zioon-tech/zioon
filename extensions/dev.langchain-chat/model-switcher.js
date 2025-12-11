/**
 * 模型切换器面板（搜索、键盘导航、点击选择、Esc 关闭）
 * 增强交互：
 * - 打开时自动定位到“当前激活模型”
 * - 支持 PageUp/PageDown/Home/End 快捷导航
 * - 列表中标记当前激活模型 ✓
 * - 空结果占位提示
 * - 行为：点击空白处关闭；Enter 选择并关闭；↑/↓ 导航时自动滚入视口
 * - 元数据徽标（stream/img）按需异步解析，带缓存
 */
export function installModelSwitcher() {
  let root = document.getElementById("zion-model-switcher-root");
  if (root) return createHandle(root);

  // 背景遮罩，点击空白处关闭
  root = document.createElement("div");
  root.id = "zion-model-switcher-root";
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    background: "transparent",
    zIndex: "1000",
    display: "none"
  });

  // 面板
  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed",
    top: "48px",
    right: "12px",
    width: "360px",
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

  // 标题与说明
  const header = document.createElement("div");
  header.textContent = "Select Model";
  Object.assign(header.style, {
    fontSize: "11px",
    opacity: "0.8",
    marginBottom: "6px",
    fontWeight: "500"
  });
  // 保持键盘可用：点击标题不改变焦点
  header.addEventListener("mousedown", (e) => e.preventDefault());

  // 搜索框
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Search models…";
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
  // 点击面板空白不打断输入焦点
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
  footer.textContent = "Enter: select • Esc: close • ↑↓: navigate";
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
  const metaCache = new Map(); // spec -> { stream?: boolean, supportsImage?: boolean }

  function activeSpec() {
    const a = window.zion?.state?.get("chat.activeModel");
    return a ? `${a.providerId}:${a.modelId}` : null;
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

  function badge(text) {
    const el = document.createElement("span");
    el.textContent = text;
    Object.assign(el.style, {
      fontSize: "9px",
      opacity: "0.7",
      border: "1px solid var(--border)",
      borderRadius: "3px",
      padding: "0 2px",
      marginLeft: "4px",
      background: "rgba(128,128,128,0.08)",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      lineHeight: "1.2",
      height: "14px",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: "14px"
    });
    return el;
  }

  async function populateMeta(row, item) {
    const spec = `${item.providerId}:${item.id}`;
    if (metaCache.has(spec)) {
      const m = metaCache.get(spec);
      const metaWrap = row.querySelector(".meta-wrap");
      if (metaWrap && m) {
        if (m.stream) metaWrap.appendChild(badge("stream"));
        if (m.supportsImage) metaWrap.appendChild(badge("img"));
      }
      return;
    }
    try {
      const prov = window.zion?.models?.getProvider(item.providerId);
      const cfg = await prov?.resolve?.(item.id);
      const m = {
        stream: cfg && cfg.stream !== false,
        supportsImage: !!cfg?.supportsImage
      };
      metaCache.set(spec, m);
      const metaWrap = row.querySelector(".meta-wrap");
      if (metaWrap && m) {
        if (m.stream) metaWrap.appendChild(badge("stream"));
        if (m.supportsImage) metaWrap.appendChild(badge("img"));
      }
    } catch {
      // 忽略解析失败
    }
  }

  function renderItems(items) {
    list.innerHTML = "";

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No models found";
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

    const act = activeSpec();
    items.forEach((m, i) => {
      const row = document.createElement("div");
      row.dataset.index = String(i);
      rowStyle(row, i === selectedIdx);

      const left = document.createElement("div");
      const isActive = act === `${m.providerId}:${m.id}`;
      left.textContent = (m.label || m.id) + (isActive ? " ✓" : "");
      Object.assign(left.style, {
        flex: "1",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      });

      const right = document.createElement("div");
      right.className = "meta-wrap";
      // 简化显示，只显示 providerId 而不是完整的 providerId:modelId
      right.textContent = m.providerId;
      Object.assign(right.style, { 
        fontSize: "10px", 
        opacity: i === selectedIdx ? "0.8" : "0.5", 
        display: "flex", 
        alignItems: "center",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        marginLeft: "8px",
        flexShrink: "0"
      });

      row.appendChild(left);
      row.appendChild(right);

      // 悬浮仅更新样式，避免整列表重建导致点击事件丢失
      row.addEventListener("mouseenter", () => {
        selectedIdx = i;
        updateSelectionStyles();
        ensureSelectedVisible();
      });
      // 防止失焦，保持键盘导航可用
      row.addEventListener("mousedown", (e) => e.preventDefault());
      // 点击选择并关闭
      row.addEventListener("click", (e) => {
        e.preventDefault();
        select(items[i]);
      });

      list.appendChild(row);
      populateMeta(row, m);
    });

    ensureSelectedVisible();
  }

  function updateSelectionStyles() {
    const rows = list.querySelectorAll('div[data-index]');
    rows.forEach((row) => {
      const idx = Number(row.dataset.index || -1);
      rowStyle(row, idx === selectedIdx);
      const right = row.querySelector(".meta-wrap");
      if (right) {
        right.style.opacity = idx === selectedIdx ? "0.8" : "0.5";
      }
    });
  }

  function ensureSelectedVisible() {
    const row = list.querySelector(`div[data-index="${selectedIdx}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  }

  function refresh() {
    const catalog = window.zion?.state?.get("models.catalog") || [];
    const q = (input.value || "").trim().toLowerCase();
    const filtered = catalog.filter(m => {
      const s = `${m.label || ""} ${m.id} ${m.providerId}`.toLowerCase();
      return q ? s.includes(q) : true;
    });
    currentItems = filtered;

    // 优先选中当前激活模型
    const act = activeSpec();
    const actIdx = act ? filtered.findIndex(m => `${m.providerId}:${m.id}` === act) : -1;
    if (actIdx >= 0) {
      selectedIdx = actIdx;
    } else {
      selectedIdx = Math.min(selectedIdx, Math.max(0, filtered.length - 1));
    }

    renderItems(filtered);
  }

  function select(m) {
    if (!m) return;
    window.zion?.commands?.executeCommand("models.selectModel", `${m.providerId}:${m.id}`);
    close();
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
      select(currentItems[selectedIdx]);
      e.preventDefault();
    } else if (e.key === "Escape") {
      close();
      e.preventDefault();
    }
  });

  root.addEventListener("click", (e) => {
    if (e.target === root) close();
  });

  function open() {
    window.zion?.commands?.executeCommand("models.listModels");
    refresh();
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
      window.zion?.commands?.executeCommand("models.listModels");
      root.style.display = "block";
      input?.focus();
      input?.select();
    },
    close() { root.style.display = "none"; },
    dispose() { root.remove(); }
  };
}