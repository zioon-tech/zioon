import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
/**
 * 工具切换器面板（与模型选择器交互保持一致：搜索、键盘导航、Enter/Esc）
 * 行为差异：Enter/点击为“切换启用状态”（多选），Esc 关闭。
 */
function t(key, fallback, values) {
  const fullKey = `dev.tools.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

export function filterToolsForRuntime(tools, state = window.zion?.state) {
  const list = Array.isArray(tools) ? tools : [];
  const backend = String(
    state?.get?.("runtime.connection")?.backend
    || state?.get?.("runtime.mode")
    || ""
  ).toLowerCase();
  const injectableNames = state?.get?.("runtime.injectableToolNames");
  const supportedNames = state?.get?.("runtime.supportedToolNames");
  const modelToolNames = Array.isArray(injectableNames)
    ? injectableNames
    : supportedNames;
  const supported = new Set(
    Array.isArray(modelToolNames) ? modelToolNames.map(String) : []
  );
  if (backend !== "runtime") return list;
  if (!Array.isArray(modelToolNames)) return list;
  if (supported.size === 0) return [];
  const capabilities = new Map(
    (Array.isArray(state?.get?.("runtime.capabilityTools"))
      ? state.get("runtime.capabilityTools")
      : [])
      .map((tool) => [String(tool?.name || ""), tool])
      .filter(([name]) => !!name)
  );
  return list
    .filter((tool) => supported.has(String(
      tool?.function?.name || tool?.name || ""
    )))
    .map((tool) => {
      const name = String(tool?.function?.name || tool?.name || "");
      const capability = capabilities.get(name);
      if (!capability) return tool;
      return {
        ...tool,
        function: {
          ...(tool?.function || {}),
          name,
          description: String(
            capability.description
            || tool?.function?.description
            || ""
          ),
          parameters: capability.inputSchema
            && typeof capability.inputSchema === "object"
            ? capability.inputSchema
            : tool?.function?.parameters
        }
      };
    });
}

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
    width: "360px",
    maxWidth: "calc(100vw - 16px)",
    maxHeight: "65vh",
    overflow: "auto",
    background: "var(--panel)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "0 12px 32px rgba(0,0,0,0.32)",
    padding: "8px",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
  });
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("switcher.title", "Select Tools"));

  // 标题
  const header = document.createElement("div");
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
    return filterToolsForRuntime(arr)
      .map(t => ({
        name: t?.function?.name || "",
        description: t?.function?.description || "",
        schema: t?.function?.parameters || null
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

  function showToolPreview(tool) {
    if (!tool) return;
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(0,0,0,0.28)",
      zIndex: "100002"
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const modal = document.createElement("div");
    Object.assign(modal.style, {
      position: "fixed",
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      width: "520px",
      maxWidth: "calc(100vw - 24px)",
      maxHeight: "72vh",
      overflow: "auto",
      background: "var(--panel)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "8px",
      boxShadow: "0 12px 32px rgba(0,0,0,0.32)",
      padding: "12px",
      fontFamily: "inherit"
    });
    modal.addEventListener("click", (e) => e.stopPropagation());

    const title = document.createElement("div");
    title.textContent = tool.name || "Tool";
    Object.assign(title.style, { fontSize: "13px", fontWeight: "600", marginBottom: "6px" });

    const desc = document.createElement("div");
    desc.textContent = tool.description || t("switcher.noDescription", "No description");
    Object.assign(desc.style, { fontSize: "12px", opacity: "0.72", lineHeight: "1.5", marginBottom: "10px" });

    const schemaTitle = document.createElement("div");
    schemaTitle.textContent = t("switcher.parameters", "Parameters");
    Object.assign(schemaTitle.style, { fontSize: "11px", fontWeight: "600", opacity: "0.72", marginBottom: "6px" });

    const pre = document.createElement("pre");
    pre.textContent = tool.schema ? JSON.stringify(tool.schema, null, 2) : t("switcher.none", "(none)");
    Object.assign(pre.style, {
      margin: "0",
      padding: "8px",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      background: "color-mix(in srgb, var(--border) 14%, transparent)",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontSize: "11px",
      lineHeight: "1.45",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    });

    modal.appendChild(title);
    modal.appendChild(desc);
    modal.appendChild(schemaTitle);
    modal.appendChild(pre);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  function renderItems(items) {
    list.innerHTML = "";
    const enabled = enabledSet();

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = t("switcher.noTools", "No tools found");
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
        flex: "0 1 48%",
        minWidth: "0",
        flexShrink: "1"
      });

      const preview = document.createElement("button");
      preview.type = "button";
      preview.textContent = t("switcher.preview", "Preview");
      preview.title = t("switcher.previewTitle", "Preview tool details");
      Object.assign(preview.style, {
        flexShrink: "0",
        padding: "2px 6px",
        borderRadius: "4px",
        border: "1px solid var(--border)",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        fontSize: "10px",
        opacity: "0.62"
      });
      preview.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showToolPreview(m);
      });

      row.appendChild(cb);
      row.appendChild(left);
      row.appendChild(right);
      row.appendChild(preview);

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
    const btn = document.querySelector('[data-zion-status-id="dev.tools.button"]')
      || Array.from(document.querySelectorAll("#bottombar .status-item, #statusbar .status-item"))
        .find((b) => b.textContent?.includes("Tools:"));
    const pad = 8;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    panel.style.left = "";
    panel.style.right = "";
    panel.style.top = "";
    panel.style.bottom = "";
    panel.style.maxHeight = "min(65vh, calc(100vh - 24px))";
    if (!btn) {
      panel.style.right = "12px";
      panel.style.bottom = "36px";
      return;
    }
    const rect = btn.getBoundingClientRect();
    const width = Math.min(360, Math.max(240, vw - pad * 2));
    const maxRight = Math.max(pad, vw - width - pad);
    const right = Math.min(Math.max(pad, Math.round(vw - rect.right)), maxRight);
    const spaceAbove = Math.max(160, Math.round(rect.top - pad * 2));
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${Math.min(Math.round(vh * 0.65), spaceAbove)}px`;
    panel.style.right = `${right}px`;
    panel.style.bottom = `${Math.max(pad, Math.round(vh - rect.top + pad))}px`;
  }

  function open() {
    refresh();
    root.style.display = "block";
    positionPanel();
    input.focus();
    input.select();
  }

  function close() {
    root.style.display = "none";
  }

  function refreshLabels() {
    const titleText = t("switcher.title", "Select Tools");
    panel.setAttribute("aria-label", titleText);
    header.textContent = titleText;
    input.placeholder = t("switcher.search", "Search tools...");
    footer.textContent = t("switcher.footer", "Enter: toggle • Esc: close • ↑↓: navigate");
    refresh();
  }

  const dispI18n = window.zion?.events?.on?.("i18n/changed", refreshLabels);

  function dispose() {
    try { dispI18n?.dispose?.(); } catch {}
    root.remove();
  }

  refreshLabels();
  return { open, close, dispose };
}

function createHandle(root) {
  const panel = root.querySelector("div");
  const input = panel?.querySelector("input");
  const position = () => {
    if (!panel) return;
    const btn = document.querySelector('[data-zion-status-id="dev.tools.button"]')
      || Array.from(document.querySelectorAll("#bottombar .status-item, #statusbar .status-item"))
        .find((b) => b.textContent?.includes("Tools:"));
    const pad = 8;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    panel.style.left = "";
    panel.style.right = "";
    panel.style.top = "";
    panel.style.bottom = "";
    panel.style.maxHeight = "min(65vh, calc(100vh - 24px))";
    if (!btn) {
      panel.style.right = "12px";
      panel.style.bottom = "36px";
      return;
    }
    const rect = btn.getBoundingClientRect();
    const width = Math.min(360, Math.max(240, vw - pad * 2));
    const maxRight = Math.max(pad, vw - width - pad);
    const right = Math.min(Math.max(pad, Math.round(vw - rect.right)), maxRight);
    const spaceAbove = Math.max(160, Math.round(rect.top - pad * 2));
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${Math.min(Math.round(vh * 0.65), spaceAbove)}px`;
    panel.style.right = `${right}px`;
    panel.style.bottom = `${Math.max(pad, Math.round(vh - rect.top + pad))}px`;
  };
  return {
    open() {
      input?.dispatchEvent(new Event("input"));
      root.style.display = "block";
      position();
      input?.focus();
      input?.select();
    },
    close() { root.style.display = "none"; },
    dispose() { root.remove(); }
  };
}
