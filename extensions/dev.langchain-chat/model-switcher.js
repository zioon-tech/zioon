/**
 * 模型切换器面板（搜索、键盘导航、点击选择、Esc 关闭）
 * 强化：支持新增/编辑/删除模型（user.dynamic），并提供连通性测试。
 * UI/UX：
 * - 统一使用 CSS 变量与紧凑样式；按钮加 aria-label 与 title；键盘可达
 * - 打开时自动定位到当前激活模型；支持 PageUp/PageDown/Home/End
 * - 空列表时提供“创建第一个模型”入口
 * - 行内操作：编辑/删除（仅 user.dynamic 可删除/保存）
 */
import {
  DEFAULT_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS,
  MAX_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS,
  MAX_MODEL_DESCRIPTION_LENGTH,
  THINKING_MODE_FIELDS,
  getThinkingEffortOptions,
  getThinkingEffortOptionLabel,
  getThinkingModeBadge,
  getThinkingModeLabel,
  getThinkingModeOptions,
  getThinkingModeOptionLabel,
  normalizeAutoContinueOnColonMaxAttempts,
  normalizeModelDescription,
  normalizeThinkingEffort,
  normalizeThinkingMode
} from "./model-config-fields.js";
import {
  DYNAMIC_PROVIDER_ID,
  deleteDynamicModel,
  loadLocalDynamicModelStore,
  upsertDynamicModel
} from "./runtime-user-model-store.js";
import {
  loadProviderConfig,
  saveProviderConfig
} from "./provider-config-storage.js";

function t(key, fallback, values) {
  const fullKey = `dev.langchain-chat.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

export function installModelSwitcher() {
  function loadDynamicStore() {
    return loadLocalDynamicModelStore();
  }
  async function refreshCatalog() {
    try { await window.zion?.commands?.executeCommand("models.listModels"); } catch {}
  }
  function getActive() {
    return window.zion?.state?.get("chat.activeModel");
  }
  function setActive(providerId, modelId, label) {
    window.zion?.state?.set("chat.activeModel", { providerId, modelId, label: label || modelId });
  }

  let root = document.getElementById("zion-model-switcher-root");
  if (root) return createHandle(root);

  // 遮罩
  root = document.createElement("div");
  root.id = "zion-model-switcher-root";
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
    background: "var(--surface-overlay, var(--panel))",
    color: "var(--fg)",
    border: "1px solid var(--surface-border, var(--border))",
    borderRadius: "10px",
    boxShadow: "var(--elevation-overlay, 0 18px 56px rgba(0,0,0,0.18))",
    padding: "8px",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
  });
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("modelSwitcher.title", "Select Model"));

  // 标题区 + 操作按钮
  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "6px"
  });
  const title = document.createElement("div");
  Object.assign(title.style, {
    fontSize: "11px",
    opacity: "0.8",
    fontWeight: "500"
  });
  title.addEventListener("mousedown", (e) => e.preventDefault());

  const actions = document.createElement("div");
  const btnAdd = document.createElement("button");
  btnAdd.type = "button";
  btnAdd.title = t("modelSwitcher.addModel", "Add Model");
  btnAdd.setAttribute("aria-label", t("modelSwitcher.addModel", "Add Model"));
  Object.assign(btnAdd.style, {
    border: "1px solid transparent",
    background: "var(--active-bg)",
    color: "var(--accent)",
    borderRadius: "8px",
    padding: "4px 8px",
    fontSize: "11px",
    cursor: "pointer"
  });
  btnAdd.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;">
    ${svgPlus()}
    <span>${t("modelSwitcher.add", "Add")}</span>
  </span>`;
  btnAdd.addEventListener("click", (e) => {
    e.stopPropagation();
    openEditor(null); // 新建
  });
  actions.appendChild(btnAdd);
  header.appendChild(title);
  header.appendChild(actions);

  // 搜索框
  const input = document.createElement("input");
  input.type = "text";
  Object.assign(input.style, {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid var(--surface-border-soft, var(--border))",
    borderRadius: "8px",
    background: "var(--surface-raised, var(--panel))",
    color: "var(--fg)",
    outline: "none",
    padding: "4px 6px",
    fontSize: "11px",
    marginBottom: "6px",
    fontFamily: "inherit"
  });

  // 列表容器
  const list = document.createElement("div");
  Object.assign(list.style, {
    display: "flex",
    flexDirection: "column",
    gap: "4px"
  });

  // 编辑器容器（内嵌）
  const editorWrap = document.createElement("div");
  Object.assign(editorWrap.style, {
    display: "none",
    border: "1px solid var(--surface-border-soft, var(--border))",
    borderRadius: "10px",
    padding: "8px",
    background: "var(--surface-raised, var(--panel))",
    marginTop: "6px"
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

  // 装配
  panel.appendChild(header);
  panel.appendChild(input);
  panel.appendChild(list);
  panel.appendChild(editorWrap);
  panel.appendChild(footer);
  root.appendChild(panel);
  document.body.appendChild(root);

  // 保持键盘焦点
  panel.addEventListener("mousedown", (e) => {
    if (e.target === panel) {
      e.preventDefault();
      if (editorWrap.style.display === "none") input.focus();
    }
  });

  let selectedIdx = 0;
  let currentItems = [];
  const metaCache = new Map(); // spec -> { stream?: boolean, supportsImage?: boolean, preservedThinking?: boolean, interleavedThinking?: boolean }

  function withCatalogRuntimeConfig(item, config) {
    const next = { ...(config || {}) };
    if (!item?.runtimeProfileId) return next;
    for (const key of [
      "supportsImage",
      "supportsThinking",
      "supportsThinkingEffort",
      "thinkingMode",
      "thinkingEffort",
      "preservedThinking",
      "interleavedThinking"
    ]) {
      if (item[key] !== undefined) next[key] = item[key];
    }
    next._runtimeBacked = true;
    next._runtimeProfileId = item.runtimeProfileId;
    next._credentialConfigured =
      item.credentialConfigured === true
      || next._credentialConfigured === true;
    return next;
  }

  function activeSpec() {
    const a = window.zion?.state?.get("chat.activeModel");
    return a ? `${a.providerId}:${a.modelId}` : null;
  }

  function rowStyle(div, active, requiresConfig) {
    Object.assign(div.style, {
      padding: "6px 8px",
      borderRadius: "8px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      cursor: "pointer",
      background: active ? "var(--active-bg)" : (requiresConfig ? "rgba(255, 200, 0, 0.1)" : "transparent"),
      color: active ? "var(--accent)" : (requiresConfig ? "rgb(220, 150, 0)" : "var(--fg)"),
      border: requiresConfig ? "1px solid rgba(255, 200, 0, 0.3)" : "1px solid transparent",
      transition: "background-color 120ms ease, color 120ms ease",
      fontFamily: "inherit",
      fontSize: "11px",
      lineHeight: "1.3"
    });
  }

  function metaBadge(text) {
    const el = document.createElement("span");
    el.textContent = text;
    Object.assign(el.style, {
      fontSize: "9px",
      opacity: "0.7",
      border: "1px solid transparent",
      borderRadius: "999px",
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

  function iconButton(svg, title) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    Object.assign(btn.style, {
      border: "none",
      background: "transparent",
      color: "color-mix(in srgb, var(--fg) 64%, transparent)",
      borderRadius: "7px",
      padding: "2px",
      width: "20px",
      height: "20px",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      marginLeft: "4px",
      opacity: "0.7",
      transition: "opacity 120ms ease, background-color 120ms ease"
    });
    btn.innerHTML = svg;
    btn.addEventListener("mouseenter", () => {
      btn.style.opacity = "1";
      btn.style.backgroundColor = "var(--hover-bg)";
      btn.style.color = "var(--fg)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.opacity = "0.7";
      btn.style.backgroundColor = "transparent";
      btn.style.color = "color-mix(in srgb, var(--fg) 64%, transparent)";
    });
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => e.stopPropagation());
    return btn;
  }

  async function populateMeta(row, item) {
    const spec = `${item.providerId}:${item.id}`;
    if (metaCache.has(spec)) {
      const m = metaCache.get(spec);
      const metaWrap = row.querySelector(".meta-wrap");
      if (metaWrap && m) {
        if (m.stream) metaWrap.appendChild(metaBadge("stream"));
        if (m.supportsImage) metaWrap.appendChild(metaBadge("img"));
        if (m.thinkingMode && m.thinkingMode !== "auto") metaWrap.appendChild(metaBadge(getThinkingModeOptionLabel(m.thinkingMode)));
        if (m.thinkingEffort && m.thinkingEffort !== "auto") metaWrap.appendChild(metaBadge(getThinkingEffortOptionLabel(m.thinkingEffort)));
        if (m.preservedThinking) metaWrap.appendChild(metaBadge(getThinkingModeBadge("preservedThinking")));
        if (m.interleavedThinking) metaWrap.appendChild(metaBadge(getThinkingModeBadge("interleavedThinking")));
      }
      return;
    }
    try {
      const prov = window.zion?.models?.getProvider(item.providerId);
      const cfg = withCatalogRuntimeConfig(
        item,
        await prov?.resolve?.(item.id)
      );
      const m = {
        stream: cfg && cfg.stream !== false,
        supportsImage: !!cfg?.supportsImage,
        thinkingMode: normalizeThinkingMode(cfg?.thinkingMode),
        thinkingEffort: normalizeThinkingEffort(cfg?.thinkingEffort),
        preservedThinking: !!cfg?.preservedThinking,
        interleavedThinking: !!cfg?.interleavedThinking
      };
      metaCache.set(spec, m);
      const metaWrap = row.querySelector(".meta-wrap");
      if (metaWrap && m) {
        if (m.stream) metaWrap.appendChild(metaBadge("stream"));
        if (m.supportsImage) metaWrap.appendChild(metaBadge("img"));
        if (m.thinkingMode && m.thinkingMode !== "auto") metaWrap.appendChild(metaBadge(getThinkingModeOptionLabel(m.thinkingMode)));
        if (m.thinkingEffort && m.thinkingEffort !== "auto") metaWrap.appendChild(metaBadge(getThinkingEffortOptionLabel(m.thinkingEffort)));
        if (m.preservedThinking) metaWrap.appendChild(metaBadge(getThinkingModeBadge("preservedThinking")));
        if (m.interleavedThinking) metaWrap.appendChild(metaBadge(getThinkingModeBadge("interleavedThinking")));
      }
    } catch {
      // ignore
    }
  }

  function renderItems(items) {
    list.innerHTML = "";

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = t("modelSwitcher.noModels", "No models found");
      Object.assign(empty.style, {
        fontSize: "11px",
        opacity: "0.6",
        padding: "6px",
        textAlign: "center",
        fontStyle: "italic"
      });
      list.appendChild(empty);

      const cta = document.createElement("div");
      Object.assign(cta.style, {
        display: "flex",
        justifyContent: "center",
        marginTop: "6px"
      });
      const btnFirst = document.createElement("button");
      btnFirst.type = "button";
      btnFirst.title = t("modelSwitcher.createFirst", "Create your first model");
      btnFirst.setAttribute("aria-label", t("modelSwitcher.createFirst", "Create your first model"));
      Object.assign(btnFirst.style, {
        border: "1px solid var(--border)",
        background: "var(--panel)",
        color: "var(--fg)",
        borderRadius: "4px",
        padding: "4px 8px",
        fontSize: "11px",
        cursor: "pointer"
      });
      btnFirst.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px;">${svgPlus()}<span>${t("modelSwitcher.addModel", "Add Model")}</span></span>`;
      btnFirst.addEventListener("click", (e) => { e.stopPropagation(); openEditor(null); });
      cta.appendChild(btnFirst);
      list.appendChild(cta);
      return;
    }

    const act = activeSpec();
    items.forEach((m, i) => {
      const row = document.createElement("div");
      row.dataset.index = String(i);
      rowStyle(row, i === selectedIdx, m.requiresConfig);

      const left = document.createElement("div");
      const isActive = act === `${m.providerId}:${m.id}`;
      let labelText = (m.label || m.id);
      if (m.requiresConfig) {
        labelText += " ⚠️";
      }
      if (isActive) {
        labelText += " ✓";
      }
      left.textContent = labelText;
      Object.assign(left.style, {
        flex: "1",
        minWidth: "0",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      });

      const right = document.createElement("div");
      right.className = "meta-wrap";
      Object.assign(right.style, {
        fontSize: "10px",
        opacity: i === selectedIdx ? "0.8" : "0.5",
        display: "flex",
        alignItems: "center",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        marginLeft: "8px",
        flexShrink: "0"
      });
      // providerId 显示
      const provSpan = document.createElement("span");
      provSpan.textContent = m.providerId;
      right.appendChild(provSpan);

      // 操作按钮
      const canEdit = m.providerId === DYNAMIC_PROVIDER_ID;
      const btnEdit = iconButton(svgEdit(), canEdit ? t("modelSwitcher.edit", "Edit Model") : t("modelSwitcher.view", "View Model (read-only)"));
      btnEdit.addEventListener("click", async () => {
        const prov = window.zion?.models?.getProvider(m.providerId);
        let cfg = null;
        try { cfg = await prov?.resolve?.(m.id); } catch {}
        openEditor({
          providerId: m.providerId,
          id: m.id,
          label: m.label,
          cfg: {
            ...withCatalogRuntimeConfig(m, cfg),
            _credentialConfigured:
              m.credentialConfigured === true
              || cfg?._credentialConfigured === true
          },
          readonly: !canEdit
        });
      });
      right.appendChild(btnEdit);

      if (canEdit) {
        const btnDel = iconButton(svgTrash(), t("modelSwitcher.delete", "Delete Model"));
        btnDel.addEventListener("click", () => { doDeleteModel(m); });
        right.appendChild(btnDel);
      }

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
      const item = currentItems[idx];
      rowStyle(row, idx === selectedIdx, item?.requiresConfig);
      const right = row.querySelector(".meta-wrap");
      if (right) right.style.opacity = idx === selectedIdx ? "0.8" : "0.5";
    });
  }

  function ensureSelectedVisible() {
    const row = list.querySelector(`div[data-index="${selectedIdx}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  }

  function catalog() {
    return window.zion?.state?.get("models.catalog") || [];
  }

  function refresh() {
    const models = catalog();
    const q = (input.value || "").trim().toLowerCase();
    const filtered = models.filter(m => {
      const s = `${m.label || ""} ${m.id} ${m.providerId}`.toLowerCase();
      return q ? s.includes(q) : true;
    });
    currentItems = filtered;

    const act = activeSpec();
    const actIdx = act ? filtered.findIndex(m => `${m.providerId}:${m.id}` === act) : -1;
    if (actIdx >= 0) selectedIdx = actIdx;
    else selectedIdx = Math.min(selectedIdx, Math.max(0, filtered.length - 1));

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
    if (e.key === "ArrowDown") { selectedIdx = Math.min(selectedIdx + 1, last); renderItems(currentItems); e.preventDefault(); }
    else if (e.key === "ArrowUp") { selectedIdx = Math.max(selectedIdx - 1, 0); renderItems(currentItems); e.preventDefault(); }
    else if (e.key === "PageDown") { selectedIdx = Math.min(selectedIdx + 5, last); renderItems(currentItems); e.preventDefault(); }
    else if (e.key === "PageUp") { selectedIdx = Math.max(selectedIdx - 5, 0); renderItems(currentItems); e.preventDefault(); }
    else if (e.key === "Home") { selectedIdx = 0; renderItems(currentItems); e.preventDefault(); }
    else if (e.key === "End") { selectedIdx = last; renderItems(currentItems); e.preventDefault(); }
    else if (e.key === "Enter") { select(currentItems[selectedIdx]); e.preventDefault(); }
    else if (e.key === "Escape") { if (editorWrap.style.display !== "none") closeEditor(); else close(); e.preventDefault(); }
  });

  root.addEventListener("click", (e) => { if (e.target === root) close(); });

  function positionPanel() {
    const btn = document.querySelector('[data-zion-status-id="langchain.chat.model"]')
      || Array.from(document.querySelectorAll("#bottombar .status-item, #statusbar .status-item"))
        .find((b) => b.textContent?.includes("Model:"));
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
    const width = Math.min(360, Math.max(220, vw - pad * 2));
    const maxRight = Math.max(pad, vw - width - pad);
    const right = Math.min(Math.max(pad, Math.round(vw - rect.right)), maxRight);
    const spaceAbove = Math.max(160, Math.round(rect.top - pad * 2));
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${Math.min(Math.round(vh * 0.65), spaceAbove)}px`;
    panel.style.right = `${right}px`;
    panel.style.bottom = `${Math.max(pad, Math.round(vh - rect.top + pad))}px`;
  }

  function open() {
    refreshLabels();
    refresh();
    root.style.display = "block";
    positionPanel();
    input.focus();
    input.select();
  }
  function close() { root.style.display = "none"; }
  function refreshLabels() {
    const titleText = t("modelSwitcher.title", "Select Model");
    panel.setAttribute("aria-label", titleText);
    title.textContent = titleText;
    btnAdd.title = t("modelSwitcher.addModel", "Add Model");
    btnAdd.setAttribute("aria-label", t("modelSwitcher.addModel", "Add Model"));
    btnAdd.querySelector("span span").textContent = t("modelSwitcher.add", "Add");
    input.placeholder = t("modelSwitcher.search", "Search models...");
    footer.textContent = t("modelSwitcher.footer", "Enter: select • Esc: close • ↑↓: navigate");
    refresh();
  }
  const dispI18n = window.zion?.events?.on?.("i18n/changed", refreshLabels);
  const dispCatalog = window.zion?.state?.onDidChange?.("models.catalog", () => {
    metaCache.clear();
    refresh();
  });
  function dispose() {
    try { dispI18n?.dispose?.(); } catch {}
    try { dispCatalog?.dispose?.(); } catch {}
    root.remove();
  }

  // ====== 编辑器实现 ======
  function fieldRow(labelText, inputEl) {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" });
    const lab = document.createElement("label");
    lab.textContent = labelText;
    lab.style.fontSize = "11px";
    lab.style.opacity = "0.8";
    lab.style.minWidth = "100px";
    lab.style.userSelect = "none";
    row.appendChild(lab);
    row.appendChild(inputEl);
    return row;
  }
  function textInput(placeholder, type = "text") {
    const el = document.createElement("input");
    el.type = type;
    el.placeholder = placeholder || "";
    Object.assign(el.style, {
      flex: "1",
      minWidth: "0",
      boxSizing: "border-box",
      border: "1px solid var(--surface-border-soft, var(--border))",
      borderRadius: "8px",
      background: "var(--surface-raised, var(--panel))",
      color: "var(--fg)",
      outline: "none",
      padding: "4px 6px",
      fontSize: "11px",
      fontFamily: "inherit"
    });
    return el;
  }
  function numberInput(placeholder) {
    const el = textInput(placeholder, "number");
    el.step = "0.1";
    return el;
  }
  function checkboxInput(label) {
    const wrap = document.createElement("label");
    Object.assign(wrap.style, { display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer" });
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const span = document.createElement("span");
    span.textContent = label;
    span.style.fontSize = "11px";
    wrap.appendChild(cb);
    wrap.appendChild(span);
    return { wrap, cb };
  }
  function buttonsRow(...btns) {
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px", marginTop: "8px" });
    btns.forEach(b => row.appendChild(b));
    return row;
  }
  function primaryButton(text, aria, iconSvg) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = text;
    btn.setAttribute("aria-label", aria || text);
    Object.assign(btn.style, {
      border: "1px solid transparent",
      background: "var(--active-bg)",
      color: "var(--accent)",
      borderRadius: "8px",
      padding: "4px 8px",
      fontSize: "11px",
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      gap: "4px"
    });
    btn.innerHTML = `${iconSvg || ""}<span>${text}</span>`;
    return btn;
  }
  function secondaryButton(text, aria, iconSvg) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = text;
    btn.setAttribute("aria-label", aria || text);
    Object.assign(btn.style, {
      border: "1px solid var(--surface-border-soft, var(--border))",
      background: "transparent",
      color: "var(--fg)",
      borderRadius: "8px",
      padding: "4px 8px",
      fontSize: "11px",
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      gap: "4px"
    });
    btn.innerHTML = `${iconSvg || ""}<span>${text}</span>`;
    return btn;
  }
  function dangerButton(text, aria, iconSvg) {
    const btn = secondaryButton(text, aria, iconSvg);
    btn.style.borderColor = "rgba(255,0,0,0.35)";
    btn.style.color = "rgb(220,80,80)";
    return btn;
  }

  function closeEditor() {
    editorWrap.style.display = "none";
    editorWrap.innerHTML = "";
    // 重新聚焦搜索
    setTimeout(() => input.focus(), 0);
  }

  async function doDeleteModel(m) {
    if (!m || m.providerId !== DYNAMIC_PROVIDER_ID) return;
    const ok = window.confirm(`Delete model "${m.id}"?`);
    if (!ok) return;
    await deleteDynamicModel({ modelId: m.id });
    await refreshCatalog();
    // 如果删除的是激活模型，选择第一个
    const act = getActive();
    if (act?.providerId === m.providerId && act?.modelId === m.id) {
      const cat = catalog();
      const next = cat[0] || null;
      if (next) setActive(next.providerId, next.id, next.label);
      else window.zion?.state?.set("chat.activeModel", null);
    }
    refresh();
  }

  async function testConnectivity(cfg, statusEl) {
    if (!cfg?.url || !(cfg?.key || cfg?.apiKey)) {
      statusEl.textContent = t("modelSwitcher.missingUrlOrKey", "Missing url or key");
      statusEl.style.color = "rgb(220,80,80)";
      return;
    }
    const body = {
      model: cfg.modelName || cfg.model || cfg.id || "gpt-3.5-turbo",
      messages: [{ role: "user", content: "ping" }],
      stream: false
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const t0 = performance.now();
    statusEl.textContent = t("modelSwitcher.testing", "Testing...");
    statusEl.style.color = "inherit";
    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${cfg.key || cfg.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const ms = Math.round(performance.now() - t0);
      if (res.ok) {
        statusEl.textContent = `OK (${ms}ms)`;
        statusEl.style.color = "rgb(60,180,90)";
      } else {
        const txt = await res.text().catch(() => "");
        statusEl.textContent = `HTTP ${res.status}: ${txt.slice(0,120)}`;
        statusEl.style.color = "rgb(220,80,80)";
      }
    } catch (e) {
      statusEl.textContent = e?.name === "AbortError" ? t("modelSwitcher.timeout", "Timeout") : (e?.message || String(e));
      statusEl.style.color = "rgb(220,80,80)";
    } finally {
      clearTimeout(timer);
    }
  }

  function openEditor(spec) {
    editorWrap.innerHTML = "";
    editorWrap.style.display = "block";

    const isNew = !spec;
    const providerId = spec?.providerId || DYNAMIC_PROVIDER_ID;
    // 对于 deepseek 提供者，允许编辑 API Key，其他字段只读
    const isDeepseekProvider = providerId === "deepseek";
    const readonly = !!spec?.readonly && !isDeepseekProvider;

    const title = document.createElement("div");
    title.textContent = isNew ? t("modelSwitcher.addModel", "Add Model") : (readonly ? t("modelSwitcher.viewModel", "View Model") : t("modelSwitcher.edit", "Edit Model"));
    Object.assign(title.style, { fontSize: "11px", opacity: "0.8", fontWeight: "500", marginBottom: "6px" });
    editorWrap.appendChild(title);

    // 字段
    const inpId = textInput(t("modelSwitcher.placeholder.modelId", "e.g. deepseek-v4-flash"));
    const inpLabel = textInput(t("modelSwitcher.placeholder.label", "e.g. My Model"));
    const inpDescription = textInput(t("modelSwitcher.placeholder.description", "Model purpose or strengths"));
    inpDescription.maxLength = MAX_MODEL_DESCRIPTION_LENGTH;
    const selProviderType = document.createElement("select");
    Object.assign(selProviderType.style, {
      flex: "1",
      minWidth: "0",
      boxSizing: "border-box",
      border: "1px solid var(--surface-border-soft, var(--border))",
      borderRadius: "8px",
      background: "var(--surface-raised, var(--panel))",
      color: "var(--fg)",
      outline: "none",
      padding: "4px 6px",
      fontSize: "11px",
      fontFamily: "inherit"
    });
    ["openai", "claude", "gemini"].forEach(v => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v === "openai" ? t("modelSwitcher.openaiCompatible", "OpenAI compatible") : (v === "claude" ? "Claude" : "Gemini");
      selProviderType.appendChild(opt);
    });
    const createSelect = (options) => {
      const el = document.createElement("select");
      Object.assign(el.style, {
        flex: "1",
        minWidth: "0",
        boxSizing: "border-box",
        border: "1px solid var(--surface-border-soft, var(--border))",
        borderRadius: "8px",
        background: "var(--surface-raised, var(--panel))",
        color: "var(--fg)",
        outline: "none",
        padding: "4px 6px",
        fontSize: "11px",
        fontFamily: "inherit"
      });
      options.forEach((option) => {
        const opt = document.createElement("option");
        opt.value = option.value;
        opt.textContent = option.label;
        el.appendChild(opt);
      });
      return el;
    };
    const selThinkingMode = createSelect(getThinkingModeOptions());
    const selectedCfg = spec?.cfg || {};
    const selThinkingEffort = createSelect(getThinkingEffortOptions(isNew ? null : {
      providerId,
      providerType: selectedCfg.providerType || selectedCfg.provider_type,
      modelId: spec?.id,
      modelName: selectedCfg.modelName || selectedCfg.model || spec?.id,
      cfg: selectedCfg
    }));
    const inpUrl = textInput(t("modelSwitcher.placeholder.baseUrl", "e.g. https://api.openai.com/v1/chat/completions"));
    const inpKey = textInput("API Key", "password");
    const inpModelName = textInput(t("modelSwitcher.placeholder.modelOverride", "Optional, e.g. gpt-4o-mini"));
    const inpTemp = numberInput("0.7");
    const inpMaxTok = numberInput("4096");
    const inpContextWindow = numberInput("128000");
    const inpMaxInput = numberInput("128000");
    const inpMaxOutput = numberInput("8192");
    const inpAutoContinueOnColon = numberInput(String(DEFAULT_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS));
    inpAutoContinueOnColon.min = "0";
    inpAutoContinueOnColon.max = String(MAX_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS);
    inpAutoContinueOnColon.step = "1";
    const inpInputPrice = numberInput("0");
    const inpOutputPrice = numberInput("0");
    const { wrap: cbStreamWrap, cb: cbStream } = checkboxInput(t("modelSwitcher.stream", "Stream"));
    const { wrap: cbImgWrap, cb: cbImg } = checkboxInput(t("modelSwitcher.supportsImage", "Supports images"));
    const thinkingControls = Object.fromEntries(
      THINKING_MODE_FIELDS.map((field) => [field.key, checkboxInput(getThinkingModeLabel(field.key))])
    );
    const cbPreservedThinking = thinkingControls.preservedThinking.cb;
    const cbInterleavedThinking = thinkingControls.interleavedThinking.cb;

    // 赋初值
    if (isNew) {
      inpId.value = "";
      inpLabel.value = "";
      inpDescription.value = "";
      selProviderType.value = "openai";
      inpUrl.value = "";
      inpKey.value = "";
      inpModelName.value = "";
      inpTemp.value = "0";
      inpMaxTok.value = "";
      inpContextWindow.value = "";
      inpMaxInput.value = "";
      inpMaxOutput.value = "";
      inpAutoContinueOnColon.value = String(DEFAULT_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS);
      inpInputPrice.value = "";
      inpOutputPrice.value = "";
      cbStream.checked = true;
      cbImg.checked = false;
      selThinkingMode.value = "auto";
      selThinkingEffort.value = "auto";
      cbPreservedThinking.checked = false;
      cbInterleavedThinking.checked = false;
    } else {
      const cfg = spec?.cfg || {};
      inpId.value = spec.id || "";
      inpLabel.value = spec.label || "";
      inpDescription.value = cfg.description || spec.description || "";
      selProviderType.value = cfg.providerType || cfg.provider_type || "openai";
      inpUrl.value = cfg.url || cfg.baseURL || "";
      inpKey.value = cfg.key || cfg.apiKey || "";
      if (cfg._credentialConfigured && !inpKey.value) {
        inpKey.placeholder = t(
          "modelSwitcher.runtimeCredentialStored",
          "Stored securely in Runtime; leave blank to keep"
        );
      }
      inpModelName.value = cfg.modelName || cfg.model || "";
      inpTemp.value = typeof cfg.temperature === "number" ? String(cfg.temperature) : "0";
      inpMaxTok.value = cfg.max_tokens != null ? String(cfg.max_tokens) : "";
      inpContextWindow.value = cfg.contextWindowTokens ?? cfg.limits?.contextWindowTokens ?? "";
      inpMaxInput.value = cfg.maxInputTokens ?? cfg.limits?.maxInputTokens ?? "";
      inpMaxOutput.value = cfg.maxOutputTokens ?? cfg.limits?.maxOutputTokens ?? "";
      inpAutoContinueOnColon.value = String(
        normalizeAutoContinueOnColonMaxAttempts(cfg.autoContinueOnColonMaxAttempts)
      );
      inpInputPrice.value = cfg.pricing?.inputPerMTok != null ? String(cfg.pricing.inputPerMTok) : "";
      inpOutputPrice.value = cfg.pricing?.outputPerMTok != null ? String(cfg.pricing.outputPerMTok) : "";
      cbStream.checked = cfg.stream !== false;
      cbImg.checked = !!cfg.supportsImage;
      selThinkingMode.value = normalizeThinkingMode(cfg.thinkingMode);
      selThinkingEffort.value = normalizeThinkingEffort(cfg.thinkingEffort);
      cbPreservedThinking.checked = !!cfg.preservedThinking;
      cbInterleavedThinking.checked = !!cfg.interleavedThinking;
      
      // 对于 deepseek 提供者，允许编辑所有参数，但 Model ID、Base URL 保持只读
      if (isDeepseekProvider) {
        // Model ID 和 Base URL 保持只读（系统默认值）
        inpId.disabled = true;
        inpUrl.disabled = true;
        // 其他字段都可编辑
        inpLabel.disabled = false;
        inpDescription.disabled = false;
        inpKey.disabled = false;
        inpModelName.disabled = false;
        inpTemp.disabled = false;
        inpMaxTok.disabled = false;
        inpContextWindow.disabled = false;
        inpMaxInput.disabled = false;
        inpMaxOutput.disabled = false;
        inpAutoContinueOnColon.disabled = false;
        inpInputPrice.disabled = false;
        inpOutputPrice.disabled = false;
        selThinkingMode.disabled = false;
        selThinkingEffort.disabled = false;
        cbStream.disabled = false;
        cbImg.disabled = false;
        cbPreservedThinking.disabled = false;
        cbInterleavedThinking.disabled = false;
      } else if (readonly) {
        [inpId, inpLabel, inpDescription, selProviderType, inpUrl, inpKey, inpModelName, inpTemp, inpMaxTok, inpContextWindow, inpMaxInput, inpMaxOutput, inpAutoContinueOnColon, inpInputPrice, inpOutputPrice, selThinkingMode, selThinkingEffort].forEach(el => el.disabled = true);
        [cbStream, cbImg, cbPreservedThinking, cbInterleavedThinking].forEach(el => el.disabled = true);
      }
    }

    // ID 只在新建时可编辑；编辑时避免改 keyPath 带来不一致
    if (!isNew && !isDeepseekProvider) inpId.disabled = true;

    editorWrap.appendChild(fieldRow(t("modelSwitcher.provider", "Provider"), (() => {
      const el = document.createElement("div");
      let providerText = providerId;
      if (isDeepseekProvider) {
        providerText += t("modelSwitcher.editableSuffix", " (editable)");
      } else if (providerId !== DYNAMIC_PROVIDER_ID) {
        providerText += t("modelSwitcher.readonlySuffix", " (read-only)");
      }
      el.textContent = providerText;
      Object.assign(el.style, { fontSize: "11px", opacity: "0.8" });
      return el;
    })()));
    editorWrap.appendChild(fieldRow(t("modelSwitcher.modelId", "Model ID"), inpId));
    editorWrap.appendChild(fieldRow(t("modelSwitcher.displayName", "Display Name"), inpLabel));
    editorWrap.appendChild(fieldRow(t("modelSwitcher.description", "Model Description"), inpDescription));
    editorWrap.appendChild(fieldRow(t("modelSwitcher.providerType", "Provider Type"), selProviderType));
    editorWrap.appendChild(fieldRow(t("modelSwitcher.baseUrl", "Base URL"), inpUrl));
    editorWrap.appendChild(fieldRow("API Key", inpKey));
    editorWrap.appendChild(fieldRow(t("modelSwitcher.modelOverride", "Model Override"), inpModelName));
    editorWrap.appendChild(fieldRow("Temperature", inpTemp));
    editorWrap.appendChild(fieldRow(t("modelSwitcher.contextWindow", "Context Window"), inpContextWindow));
    editorWrap.appendChild(fieldRow(t("modelSwitcher.maxInputTokens", "Max Input Tokens"), inpMaxInput));
    editorWrap.appendChild(fieldRow(t("modelSwitcher.maxOutputTokens", "Max Output Tokens"), inpMaxOutput));
    editorWrap.appendChild(fieldRow(t("modelSwitcher.defaultOutputTokens", "Default Output Tokens"), inpMaxTok));
    if (isDeepseekProvider) {
      const row = fieldRow(
        t("modelSwitcher.autoContinueOnColonMaxAttempts", "Abnormal-stop Continuations"),
        inpAutoContinueOnColon
      );
      row.title = t(
        "modelSwitcher.autoContinueOnColonMaxAttempts.description",
        "Maximum automatic continuations after an abnormal DeepSeek stop, including trailing-colon and reasoning-only responses; set to 0 to disable."
      );
      editorWrap.appendChild(row);
    }
    editorWrap.appendChild(fieldRow("Input $/1M Tokens", inpInputPrice));
    editorWrap.appendChild(fieldRow("Output $/1M Tokens", inpOutputPrice));
    editorWrap.appendChild(fieldRow(t("modelSwitcher.thinkingMode", "Thinking Mode"), selThinkingMode));
    editorWrap.appendChild(fieldRow(t("modelSwitcher.thinkingEffort", "Thinking Effort"), selThinkingEffort));

    const flagsRow = document.createElement("div");
    Object.assign(flagsRow.style, { display: "flex", gap: "12px", alignItems: "center", marginBottom: "2px", marginTop: "-2px" });
    flagsRow.appendChild(cbStreamWrap);
    flagsRow.appendChild(cbImgWrap);
    editorWrap.appendChild(flagsRow);

    const thinkingRow = document.createElement("div");
    Object.assign(thinkingRow.style, { display: "flex", gap: "12px", alignItems: "center", marginBottom: "2px" });
    THINKING_MODE_FIELDS.forEach((field) => {
      const control = thinkingControls[field.key];
      if (control?.wrap) {
        control.wrap.title = String(window.zion?.i18n?.getLocale?.() || "").startsWith("en") ? field.descriptionEn || field.description || "" : field.description || "";
        thinkingRow.appendChild(control.wrap);
      }
    });
    editorWrap.appendChild(thinkingRow);

    // 状态行（测试结果）
    const status = document.createElement("div");
    Object.assign(status.style, { fontSize: "10px", opacity: "0.8", minHeight: "14px" });
    editorWrap.appendChild(status);

    // 按钮
    const btnTest = secondaryButton(t("modelSwitcher.test", "Test"), t("modelSwitcher.testConnectivity", "Test connectivity"), svgBolt());
    btnTest.addEventListener("click", async () => {
      const cfg = {
        id: inpId.value.trim(),
        url: inpUrl.value.trim(),
        key: inpKey.value.trim(),
        modelName: inpModelName.value.trim() || undefined
      };
      await testConnectivity(cfg, status);
    });

    const btnSave = primaryButton(isNew ? t("modelSwitcher.save", "Save") : t("modelSwitcher.saveChanges", "Save Changes"), t("modelSwitcher.saveModel", "Save Model"), svgCheck());
    btnSave.disabled = (providerId !== DYNAMIC_PROVIDER_ID && !isDeepseekProvider) || readonly;
    btnSave.addEventListener("click", async () => {
      const id = inpId.value.trim();
      const url = inpUrl.value.trim();
      const key = inpKey.value.trim();
      if (!id) { status.textContent = t("modelSwitcher.missingModelId", "Missing Model ID"); status.style.color = "rgb(220,80,80)"; return; }
      if (!url) { status.textContent = t("modelSwitcher.missingBaseUrl", "Missing Base URL"); status.style.color = "rgb(220,80,80)"; return; }
      const credentialAlreadyConfigured = !!(spec?.cfg?._credentialConfigured);
      if (
        providerId === DYNAMIC_PROVIDER_ID
        && !key
        && !credentialAlreadyConfigured
      ) {
        status.textContent = t("modelSwitcher.missingApiKey", "Missing API Key");
        status.style.color = "rgb(220,80,80)";
        return;
      }

      // 对于 deepseek 提供者，保存所有参数到 localStorage
      if (isDeepseekProvider) {
        try {
          // 保存 API Key
          if (key) localStorage.setItem("zion.deepseek.apiKey", key);
          
          // 保存其他参数
          const previous = loadProviderConfig("zion.deepseek.config");
          const modelLimits = { ...(previous.modelLimits || {}) };
          const modelDescriptions = { ...(previous.modelDescriptions || {}) };
          const description = normalizeModelDescription(inpDescription.value);
          if (description) modelDescriptions[id] = description;
          else delete modelDescriptions[id];
          modelLimits[id] = {
            ...(modelLimits[id] || {}),
            contextWindowTokens: inpContextWindow.value === "" ? undefined : Number(inpContextWindow.value),
            maxInputTokens: inpMaxInput.value === "" ? undefined : Number(inpMaxInput.value),
            maxOutputTokens: inpMaxOutput.value === "" ? undefined : Number(inpMaxOutput.value),
            defaultOutputTokens: inpMaxTok.value === "" ? undefined : Number(inpMaxTok.value)
          };
          const deepseekConfig = {
            ...previous,
            label: inpLabel.value.trim() || undefined,
            modelName: inpModelName.value.trim() || undefined,
            temperature: inpTemp.value === "" ? undefined : Number(inpTemp.value),
            modelLimits,
            modelDescriptions: Object.keys(modelDescriptions).length ? modelDescriptions : undefined,
            autoContinueOnColonMaxAttempts: normalizeAutoContinueOnColonMaxAttempts(
              inpAutoContinueOnColon.value
            ),
            pricing: {
              inputPerMTok: inpInputPrice.value === "" ? undefined : Number(inpInputPrice.value),
              outputPerMTok: inpOutputPrice.value === "" ? undefined : Number(inpOutputPrice.value),
              currency: "USD"
            },
            stream: !!cbStream.checked,
            supportsImage: !!cbImg.checked,
            thinkingMode: normalizeThinkingMode(selThinkingMode.value),
            thinkingEffort: normalizeThinkingEffort(selThinkingEffort.value),
            preservedThinking: !!cbPreservedThinking.checked,
            interleavedThinking: !!cbInterleavedThinking.checked
          };
          saveProviderConfig("zion.deepseek.config", deepseekConfig);

          const active = getActive();
          if (active?.providerId === providerId && active?.modelId === id) {
            window.zion?.state?.set("chat.activeModel", {
              ...active,
              thinkingMode: deepseekConfig.thinkingMode,
              thinkingEffort: deepseekConfig.thinkingEffort
            });
          }
          
          status.textContent = t("modelSwitcher.deepseekSaved", "DeepSeek configuration saved");
          status.style.color = "rgb(60,180,90)";
          // 刷新模型目录以更新状态
          await refreshCatalog();
          try { window.zion?.events?.emit?.("models/configChanged", { providerId, modelId: id }); } catch {}
          // 刷新列表并关闭编辑器
          refresh();
          setTimeout(() => closeEditor(), 300);
          return;
        } catch (e) {
          status.textContent = t("modelSwitcher.failedSave", "Failed to save: {message}", { message: e?.message || String(e) });
          status.style.color = "rgb(220,80,80)";
          return;
        }
      }

      // 对于 user.dynamic 提供者，优先保存到 Runtime Host，离线时回落到 localStorage。
      const dict = loadDynamicStore();
      const existingInCatalog = catalog().some((item) =>
        item?.providerId === DYNAMIC_PROVIDER_ID && item?.id === id
      );
      if (isNew && (dict[id] || existingInCatalog)) {
        status.textContent = t("modelSwitcher.modelExists", "Model already exists: {id}", { id });
        status.style.color = "rgb(220,80,80)";
        return;
      }
      const cfg = {
        label: inpLabel.value.trim() || undefined,
        description: normalizeModelDescription(inpDescription.value) || undefined,
        url,
        ...(key ? { key } : {}),
        stream: !!cbStream.checked,
        temperature: inpTemp.value === "" ? undefined : Number(inpTemp.value),
        max_tokens: inpMaxTok.value === "" ? undefined : Number(inpMaxTok.value),
        contextWindowTokens: inpContextWindow.value === "" ? undefined : Number(inpContextWindow.value),
        maxInputTokens: inpMaxInput.value === "" ? undefined : Number(inpMaxInput.value),
        maxOutputTokens: inpMaxOutput.value === "" ? undefined : Number(inpMaxOutput.value),
        pricing: {
          inputPerMTok: inpInputPrice.value === "" ? undefined : Number(inpInputPrice.value),
          outputPerMTok: inpOutputPrice.value === "" ? undefined : Number(inpOutputPrice.value),
          currency: "USD"
        },
        supportsImage: !!cbImg.checked,
        thinkingMode: normalizeThinkingMode(selThinkingMode.value),
        thinkingEffort: normalizeThinkingEffort(selThinkingEffort.value),
        preservedThinking: !!cbPreservedThinking.checked,
        interleavedThinking: !!cbInterleavedThinking.checked,
        providerType: selProviderType.value || "openai"
      };
      const modelName = inpModelName.value.trim();
      if (modelName) {
        // 存两份，兼容不同后端期望字段
        cfg.modelName = modelName;
        cfg.model = modelName;
      }

      const saved = await upsertDynamicModel({ modelId: id, config: cfg });
      await refreshCatalog();
      try { window.zion?.events?.emit?.("models/configChanged", { providerId: DYNAMIC_PROVIDER_ID, modelId: id }); } catch {}
      const cat = catalog();
      const item = cat.find(x => x.providerId === DYNAMIC_PROVIDER_ID && x.id === id);
      setActive(DYNAMIC_PROVIDER_ID, id, item?.label || id);
      status.textContent = saved?.warning
        ? t("modelSwitcher.savedLocalFallback", "Saved locally; Runtime sync failed")
        : t("modelSwitcher.saved", "Saved");
      status.style.color = "rgb(60,180,90)";
      // 刷新列表并关闭编辑器
      refresh();
      setTimeout(() => closeEditor(), 300);
    });

    const btnCancel = secondaryButton(t("modelSwitcher.cancel", "Cancel"), t("modelSwitcher.cancel", "Cancel"), svgClose());
    btnCancel.addEventListener("click", () => closeEditor());

    const btnDelete = dangerButton(t("modelSwitcher.delete", "Delete"), t("modelSwitcher.delete", "Delete Model"), svgTrash());
    btnDelete.style.marginLeft = "auto";
    btnDelete.disabled = isNew || providerId !== DYNAMIC_PROVIDER_ID || readonly || isDeepseekProvider;
    btnDelete.addEventListener("click", async () => {
      if (isNew) return;
      await doDeleteModel({ providerId, id: inpId.value.trim(), label: inpLabel.value.trim() });
      closeEditor();
    });

    editorWrap.appendChild(buttonsRow(btnTest, btnSave, btnCancel, btnDelete));

    // 焦点
    if (isDeepseekProvider) {
      // 如果 API Key 为空，聚焦到 API Key 输入框；否则聚焦到 Label
      if (!inpKey.value.trim()) {
        inpKey.focus();
        inpKey.select();
      } else {
        inpLabel.focus();
        inpLabel.select();
      }
    } else {
      (isNew ? inpId : inpLabel).focus();
      (isNew ? inpId : inpLabel).select();
    }
  }

  function iconHtml(name) {
    try {
      const html = window.zionIcons?.htmlFromCodicon?.(name, "", 14);
      if (html) return html;
    } catch {}
    const raw = String(name || "").replace(/^codicon-/, "");
    return `<span class="codicon codicon-${raw}" aria-hidden="true" style="font-size:14px;"></span>`;
  }

  function svgPlus() {
    return iconHtml("add");
  }
  function svgEdit() {
    return iconHtml("edit");
  }
  function svgTrash() {
    return iconHtml("trash");
  }
  function svgBolt() {
    return iconHtml("zap");
  }
  function svgCheck() {
    return iconHtml("check");
  }
  function svgClose() {
    return iconHtml("close");
  }

  return { open, close, dispose };
}

function createHandle(root) {
  const panel = root.querySelector("div");
  const input = panel?.querySelector("input");
  const position = () => {
    if (!panel) return;
    const btn = document.querySelector('[data-zion-status-id="langchain.chat.model"]')
      || Array.from(document.querySelectorAll("#bottombar .status-item, #statusbar .status-item"))
        .find((b) => b.textContent?.includes("Model:"));
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
    const width = Math.min(360, Math.max(220, vw - pad * 2));
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
