import { workbenchStorage as localStorage } from "../../src/runtime/workbench-space.ts";
import {
  SERVICE_DEFS,
  DEFAULT_BASE_URL,
  loadServiceBaseUrlConfig,
  normalizeBaseUrl,
  saveServiceBaseUrlConfig,
  resetServiceBaseUrlConfig
} from "../../src/settings/serviceBaseUrl";

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === "style" && v && typeof v === "object") {
        Object.assign(el.style, v);
      } else if (k === "className") {
        el.className = String(v);
      } else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v != null) {
        el.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    if (typeof c === "string") el.appendChild(document.createTextNode(c));
    else el.appendChild(c);
  }
  return el;
}

function makeBadge(text, tone) {
  const bg =
    tone === "ok"
      ? "var(--role-user-bg, rgba(46,160,67,0.18))"
      : tone === "warn"
        ? "rgba(210,153,34,0.18)"
        : "rgba(248,81,73,0.18)";
  const fg =
    tone === "ok" ? "var(--ok, #50fa7b)" : tone === "warn" ? "#d29922" : "#f85149";
  return h(
    "span",
    {
      style: {
        fontSize: "11px",
        padding: "2px 8px",
        borderRadius: "999px",
        background: bg,
        color: fg,
        border: "1px solid var(--border)",
        whiteSpace: "nowrap",
        fontWeight: 500
      }
    },
    text
  );
}

function toast(host, msg, tone = "ok") {
  try {
    const el = h(
      "div",
      {
        style: {
          position: "sticky",
          top: "0",
          zIndex: "5",
          padding: "8px 10px",
          borderRadius: "8px",
          border: "1px solid var(--border)",
          background: "var(--panel)",
          color: "var(--fg)",
          fontSize: "12px",
          boxShadow: "0 6px 16px rgba(0,0,0,0.25)",
          display: "flex",
          gap: "8px",
          alignItems: "center",
          marginBottom: "10px"
        }
      },
      makeBadge(tone === "ok" ? "OK" : "!", tone === "ok" ? "ok" : "bad"),
      h("div", { style: { flex: "1 1 auto" } }, msg)
    );
    host.prepend(el);
    setTimeout(() => {
      try {
        el.remove();
      } catch {}
    }, 2200);
  } catch {}
}

function errorText(code) {
  if (!code) return "";
  if (code === "empty") return "请输入 baseUrl";
  if (code === "invalid_protocol") return "仅支持 http/https";
  if (code === "missing_host") return "缺少 hostname";
  return "URL 格式不正确";
}

export function mountSettingsViewInto(container) {
  // 添加自定义样式类，用于响应式
  const root = h("div", {
    className: "zion-settings-view",
    style: {
      padding: "10px",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      boxSizing: "border-box",
      minHeight: "100%",
      fontFamily: "var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif)"
    }
  });

  const header = h(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "10px",
        paddingBottom: "8px",
        borderBottom: "1px solid var(--border)"
      }
    },
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "4px", minWidth: "0" } },
      h("div", { 
        style: { 
          fontSize: "14px", 
          fontWeight: 600,
          color: "var(--fg)"
        } 
      }, "Settings"),
      h(
        "div", 
        { style: { fontSize: "12px", opacity: "0.7", lineHeight: "1.4" } },
        `默认 baseUrl 含 ${DEFAULT_BASE_URL}，保存后立即生效`
      )
    )
  );

  const badgeHost = h("div", { style: { flex: "0 0 auto" } });
  header.appendChild(badgeHost);
  root.appendChild(header);

  const section = h("div", {
    style: {
      border: "1px solid var(--border)",
      borderRadius: "8px",
      background: "var(--panel)",
      padding: "12px",
      display: "flex",
      flexDirection: "column",
      gap: "12px"
    }
  });

  const sectionHead = h(
    "div", 
    { 
      style: { 
        display: "flex", 
        alignItems: "center", 
        justifyContent: "space-between", 
        gap: "8px",
        paddingBottom: "8px",
        borderBottom: "1px solid var(--border)"
      } 
    },
    h("div", { style: { fontSize: "13px", fontWeight: 600, color: "var(--fg)" } }, "服务 BaseUrl 配置"),
    h("div", { style: { fontSize: "11px", opacity: "0.7" } }, "http/https URL")
  );
  section.appendChild(sectionHead);

  const form = h("div", { 
    style: { 
      display: "flex", 
      flexDirection: "column", 
      gap: "12px" 
    } 
  });
  section.appendChild(form);
  root.appendChild(section);

  const footer = h("div", {
    style: {
      position: "sticky",
      bottom: "0",
      zIndex: "3",
      marginTop: "auto",
      padding: "12px",
      borderRadius: "8px",
      border: "1px solid var(--border)",
      background: "var(--panel)",
      boxShadow: "0 -4px 12px rgba(0,0,0,0.15)",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      flexWrap: "wrap"
    }
  });

  const leftHint = h("div", { 
    style: { 
      fontSize: "11px", 
      opacity: "0.7",
      flex: "1 1 auto"
    } 
  }, "保存后写入 localStorage");
  
  const actions = h("div", { 
    style: { 
      display: "flex", 
      gap: "8px",
      flex: "0 0 auto"
    } 
  });
  
  const resetBtn = h(
    "button",
    {
      type: "button",
      style: {
        height: "28px",
        padding: "0 12px",
        borderRadius: "6px",
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--fg)",
        cursor: "pointer",
        fontSize: "12px",
        fontFamily: "var(--font-sans)",
        transition: "background 120ms ease"
      }
    },
    "重置为默认"
  );
  
  const saveBtn = h(
    "button",
    {
      type: "button",
      style: {
        height: "28px",
        padding: "0 14px",
        borderRadius: "6px",
        border: "1px solid var(--accent)",
        background: "var(--accent)",
        color: "var(--panel)",
        cursor: "pointer",
        fontSize: "12px",
        fontWeight: 600,
        fontFamily: "var(--font-sans)",
        transition: "opacity 120ms ease"
      }
    },
    "保存"
  );
  
  // 添加按钮悬停效果
  resetBtn.addEventListener("mouseenter", () => {
    resetBtn.style.background = "var(--border)";
  });
  resetBtn.addEventListener("mouseleave", () => {
    resetBtn.style.background = "transparent";
  });
  
  actions.appendChild(resetBtn);
  actions.appendChild(saveBtn);
  footer.appendChild(leftHint);
  footer.appendChild(actions);
  root.appendChild(footer);

  let saved = loadServiceBaseUrlConfig();
  let draft = Object.fromEntries(SERVICE_DEFS.map((d) => [d.id, saved.services[d.id].baseUrl]));
  let errors = Object.fromEntries(SERVICE_DEFS.map((d) => [d.id, ""]));

  const rowNodes = new Map();

  const updateBadge = () => {
    const dirty = SERVICE_DEFS.some((d) => (draft[d.id] || "") !== (saved.services[d.id]?.baseUrl || ""));
    const hasErr = SERVICE_DEFS.some((d) => !!errors[d.id]);
    badgeHost.innerHTML = "";
    if (hasErr) badgeHost.appendChild(makeBadge("存在校验错误", "bad"));
    else if (dirty) badgeHost.appendChild(makeBadge("未保存更改", "warn"));
    else badgeHost.appendChild(makeBadge("当前已生效", "ok"));

    saveBtn.disabled = hasErr || !dirty;
    saveBtn.style.opacity = saveBtn.disabled ? "0.5" : "1";
    saveBtn.style.cursor = saveBtn.disabled ? "not-allowed" : "pointer";
  };

  const validateOne = (id) => {
    const v = String(draft[id] || "");
    const norm = normalizeBaseUrl(v);
    errors[id] = norm.ok ? "" : norm.error;
    if (norm.ok) draft[id] = norm.value;
  };

  const renderRows = () => {
    form.innerHTML = "";
    rowNodes.clear();
    for (const def of SERVICE_DEFS) {
      const id = def.id;
      const card = h("div", {
        style: {
          border: "1px solid var(--border)",
          borderRadius: "8px",
          padding: "12px",
          background: "rgba(255,255,255,0.02)",
          display: "flex",
          flexDirection: "column",
          gap: "8px"
        }
      });
      
      const head = h(
        "div",
        { 
          style: { 
            display: "flex", 
            alignItems: "baseline", 
            justifyContent: "space-between", 
            gap: "8px",
            flexWrap: "wrap"
          } 
        },
        h("div", { 
          style: { 
            fontSize: "13px", 
            fontWeight: 600,
            color: "var(--fg)"
          } 
        }, def.name),
        h("div", { 
          style: { 
            fontSize: "11px", 
            opacity: "0.6", 
            fontFamily: "var(--font-mono, monospace)" 
          } 
        }, id)
      );

      const label = h("div", { 
        style: { 
          fontSize: "11px", 
          opacity: "0.8",
          color: "var(--fg)"
        } 
      }, "BaseUrl");
      
      const input = h("input", {
        type: "text",
        value: draft[id] || "",
        placeholder: def.defaultBaseUrl,
        style: {
          width: "100%",
          height: "32px",
          borderRadius: "6px",
          border: "1px solid var(--border)",
          background: "var(--bg)",
          color: "var(--fg)",
          padding: "0 10px",
          outline: "none",
          boxSizing: "border-box",
          fontSize: "12px",
          fontFamily: "var(--font-mono, monospace)",
          transition: "border-color 120ms ease"
        }
      });
      
      const err = h("div", { 
        style: { 
          fontSize: "11px", 
          color: "#f85149", 
          minHeight: "16px",
          lineHeight: "1.4"
        } 
      });

      input.addEventListener("input", () => {
        draft[id] = input.value;
        const norm = normalizeBaseUrl(String(draft[id] || ""));
        errors[id] = norm.ok ? "" : norm.error;
        input.style.borderColor = errors[id] ? "#f85149" : "var(--border)";
        err.textContent = errorText(errors[id]);
        updateBadge();
      });
      
      input.addEventListener("blur", () => {
        const norm = normalizeBaseUrl(String(draft[id] || ""));
        if (norm.ok) {
          draft[id] = norm.value;
          input.value = norm.value;
        }
        updateBadge();
      });
      
      // 添加 focus 样式
      input.addEventListener("focus", () => {
        input.style.borderColor = "var(--accent)";
        input.style.boxShadow = "0 0 0 2px rgba(98,114,164,0.2)";
      });
      
      input.addEventListener("blur", () => {
        input.style.boxShadow = "none";
        if (!errors[id]) {
          input.style.borderColor = "var(--border)";
        }
      });

      card.appendChild(head);
      card.appendChild(label);
      card.appendChild(input);
      card.appendChild(err);
      form.appendChild(card);
      rowNodes.set(id, { input, err });
    }
  };

  const resyncFromStorage = () => {
    saved = loadServiceBaseUrlConfig();
    draft = Object.fromEntries(SERVICE_DEFS.map((d) => [d.id, saved.services[d.id].baseUrl]));
    errors = Object.fromEntries(SERVICE_DEFS.map((d) => [d.id, ""]));
    renderRows();
    updateBadge();
  };

  resetBtn.onclick = () => {
    const cfg = resetServiceBaseUrlConfig();
    saved = cfg.config;
    draft = Object.fromEntries(SERVICE_DEFS.map((d) => [d.id, saved.services[d.id].baseUrl]));
    errors = Object.fromEntries(SERVICE_DEFS.map((d) => [d.id, ""]));
    renderRows();
    updateBadge();
    try {
      const installer = window.zion?.pluginInstaller;
      const next = saved.services.pluginService.baseUrl;
      if (installer && typeof installer.setBaseUrl === "function") installer.setBaseUrl(next);
    } catch {}
    toast(root, "已重置为默认（可继续修改后保存）", "ok");
  };

  saveBtn.onclick = () => {
    for (const def of SERVICE_DEFS) {
      validateOne(def.id);
      const node = rowNodes.get(def.id);
      if (node) {
        node.input.style.borderColor = errors[def.id] ? "#f85149" : "var(--border)";
        node.err.textContent = errorText(errors[def.id]);
      }
    }
    updateBadge();
    if (SERVICE_DEFS.some((d) => !!errors[d.id])) {
      toast(root, "请先修正校验错误后再保存", "bad");
      return;
    }
    const ret = saveServiceBaseUrlConfig(draft);
    if (!ret.ok) {
      toast(root, "保存失败：配置无效", "bad");
      return;
    }
    saved = ret.config;
    draft = Object.fromEntries(SERVICE_DEFS.map((d) => [d.id, saved.services[d.id].baseUrl]));
    renderRows();
    updateBadge();
    try {
      const installer = window.zion?.pluginInstaller;
      const next = saved.services.pluginService.baseUrl;
      if (installer && typeof installer.setBaseUrl === "function") installer.setBaseUrl(next);
    } catch {}
    toast(root, "已保存，配置已生效", "ok");
  };

  renderRows();
  updateBadge();

  let sub = null;
  try {
    sub = window.zion?.state?.onDidChange?.("settings.serviceBaseUrl", () => {
      try {
        resyncFromStorage();
      } catch {}
    });
  } catch {
    sub = null;
  }

  container.appendChild(root);
  return {
    dispose: () => {
      try {
        sub?.dispose?.();
      } catch {}
      try {
        root.remove();
      } catch {}
    }
  };
}
