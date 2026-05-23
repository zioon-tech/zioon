const DEFAULT_BASE_URL = "http://127.0.0.1:8765";

const I18N_NS = "dev.plugins";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.plugins": "插件",
    "cmd.show": "显示插件",
    "ui.plugins": "插件",
    "ui.reload": "重新加载插件",
    "ui.refresh": "刷新",
    "ui.reloadAll": "重新加载",
    "ui.search": "搜索插件",
    "ui.advancedTools": "高级工具",
    "ui.installPlugins": "安装插件",
    "ui.installDesc": "支持配置服务地址、搜索可安装插件，或直接拖拽 ZIP 包安装。",
    "ui.saveUrl": "保存 URL",
    "ui.dropZip": "拖拽 ZIP 插件包到此处进行安装",
    "ui.searchQuery": "搜索关键词",
    "ui.listAll": "列出全部",
    "ui.install": "安装",
    "ui.devMode": "开发模式",
    "ui.devDesc": "把本地插件目录映射成可热更新的开发会话，适合调试插件。",
    "ui.startDev": "启动开发",
    "ui.stopDev": "停止开发",
    "ui.statsUnavailable": "查看和切换已安装插件。",
    "ui.stats": "共 {total} 个插件，已启用 {enabled} 个，活跃 {active} 个，异常 {errors} 个。",
    "ui.systemUnavailable": "插件系统不可用",
    "ui.noMatching": "没有匹配的插件",
    "ui.noPlugins": "没有找到插件",
    "ui.managerUnavailable": "PluginManager 不可用",
    "ui.searchFailed": "搜索失败：{message}",
    "ui.searchError": "搜索出错",
    "ui.listFailed": "列表加载失败：{message}",
    "ui.listError": "列表加载出错",
    "msg.enabled": "插件已启用。",
    "msg.disabled": "插件已停用。",
    "msg.toggleFailed": "切换插件失败：{message}",
    "msg.installerUnavailable": "安装器不可用。",
    "msg.managerUnavailable": "插件管理器不可用。",
    "msg.installed": "已安装 {name}。",
    "msg.installFailed": "安装失败：{message}",
    "msg.installError": "安装过程中发生错误，请查看控制台。",
    "msg.enterDevPath": "请输入本地插件目录绝对路径。",
    "msg.hotReloadUnavailable": "Hot reload 不可用",
    "msg.installerDevUnavailable": "Installer 不可用",
    "msg.devInstallFailed": "开发模式安装失败",
    "msg.devStarted": "开发模式已启动。",
    "msg.devStopped": "开发模式已停止。",
    "msg.startDevFailed": "启动开发模式失败：{message}",
    "msg.stopDevFailed": "停止开发模式失败：{message}",
    "msg.devConnected": "开发连接已建立：{url}",
    "msg.devSessionStopped": "开发会话已停止：{id}",
    "msg.devClosed": "开发连接已关闭：{id}",
    "msg.devStartedStatus": "开发会话已启动：{id} ({plugin})",
    "msg.devStartFailedShort": "启动开发模式失败",
    "msg.devStoppedShort": "开发会话已停止。"
  },
  "en-US": {
    "category.plugins": "Plugins",
    "cmd.show": "Show Plugins",
    "ui.plugins": "Plugins",
    "ui.reload": "Reload plugins",
    "ui.refresh": "Refresh",
    "ui.reloadAll": "Reload",
    "ui.search": "Search plugins",
    "ui.advancedTools": "Advanced Tools",
    "ui.installPlugins": "Install Plugins",
    "ui.installDesc": "Configure the service URL, search installable plugins, or drag a ZIP package here.",
    "ui.saveUrl": "Save URL",
    "ui.dropZip": "Drop ZIP plugin package here to install",
    "ui.searchQuery": "Search query",
    "ui.listAll": "List All",
    "ui.install": "Install",
    "ui.devMode": "Development Mode",
    "ui.devDesc": "Map a local plugin directory into a hot-reload development session for debugging plugins.",
    "ui.startDev": "Start Dev",
    "ui.stopDev": "Stop Dev",
    "ui.statsUnavailable": "View and toggle installed plugins.",
    "ui.stats": "{total} plugins, {enabled} enabled, {active} active, {errors} errors.",
    "ui.systemUnavailable": "Plugin system not available",
    "ui.noMatching": "No matching plugins",
    "ui.noPlugins": "No plugins found",
    "ui.managerUnavailable": "PluginManager not available",
    "ui.searchFailed": "Search failed: {message}",
    "ui.searchError": "Search error",
    "ui.listFailed": "List failed: {message}",
    "ui.listError": "List error",
    "msg.enabled": "Plugin enabled.",
    "msg.disabled": "Plugin disabled.",
    "msg.toggleFailed": "Failed to toggle plugin: {message}",
    "msg.installerUnavailable": "Installer not available.",
    "msg.managerUnavailable": "Plugin manager not available.",
    "msg.installed": "Installed {name}.",
    "msg.installFailed": "Install failed: {message}",
    "msg.installError": "An error occurred during installation. Check the console.",
    "msg.enterDevPath": "Enter an absolute path to a local plugin directory.",
    "msg.hotReloadUnavailable": "Hot reload not available",
    "msg.installerDevUnavailable": "Installer not available",
    "msg.devInstallFailed": "Development mode installation failed",
    "msg.devStarted": "Development mode started.",
    "msg.devStopped": "Development mode stopped.",
    "msg.startDevFailed": "Failed to start development mode: {message}",
    "msg.stopDevFailed": "Failed to stop development mode: {message}",
    "msg.devConnected": "Development connection established: {url}",
    "msg.devSessionStopped": "Development session stopped: {id}",
    "msg.devClosed": "Development connection closed: {id}",
    "msg.devStartedStatus": "Development session started: {id} ({plugin})",
    "msg.devStartFailedShort": "Failed to start development mode",
    "msg.devStoppedShort": "Development session stopped."
  }
};

function t(key, fallback, values) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

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
    if (typeof c === "string") {
      el.appendChild(document.createTextNode(c));
    } else {
      el.appendChild(c);
    }
  }
  return el;
}

function mountPluginsSidebarViewInto(container) {
  const pluginManager = window.zion && window.zion.plugins;
  const pluginInstaller = window.zion && window.zion.pluginInstaller;

  const root = h(
    "div",
    {
      style: {
        padding: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        boxSizing: "border-box",
        width: "100%"
      }
    }
  );

  const header = h(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: "8px"
      }
    }
  );

  const heading = h(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: "4px"
      }
    }
  );

  const title = h(
    "div",
    {
      style: {
        fontSize: "15px",
        fontWeight: "600",
        letterSpacing: "0.01em"
      }
    },
    t("ui.plugins", "插件")
  );

  const statsText = h("div", {
    style: {
      fontSize: "11px",
      lineHeight: "1.5",
      opacity: "0.62"
    }
  });

  heading.appendChild(title);
  heading.appendChild(statsText);

  const actionsRow = h(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px",
        flexWrap: "wrap"
      }
    }
  );

  const actionButtons = h(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap"
      }
    }
  );

  const refreshBtn = h(
    "button",
    {
      style: {
        height: "28px",
        padding: "0 10px",
        borderRadius: "8px",
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--fg)",
        cursor: "pointer",
        fontSize: "12px"
      }
    },
    t("ui.refresh", "刷新")
  );

  const reloadAllBtn = h("button", {
    style: {
      height: "28px",
      padding: "0 10px",
      borderRadius: "8px",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--fg)",
      cursor: "pointer",
      fontSize: "12px"
    }
  }, t("ui.reloadAll", "重新加载"));

  actionButtons.appendChild(refreshBtn);
  actionButtons.appendChild(reloadAllBtn);
  actionsRow.appendChild(actionButtons);

  header.appendChild(heading);
  header.appendChild(actionsRow);
  root.appendChild(header);

  const searchRow = h("div", {
    style: {
      display: "flex",
      gap: "8px",
      alignItems: "center"
    }
  });

  const searchInput = h("input", {
    type: "text",
    placeholder: t("ui.search", "Search plugins"),
    style: {
      width: "100%",
      height: "28px",
      borderRadius: "8px",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--fg)",
      padding: "0 10px",
      outline: "none",
      boxSizing: "border-box",
      fontSize: "12px"
    }
  });

  searchRow.appendChild(searchInput);
  root.appendChild(searchRow);

  const message = h("div", {
    style: {
      display: "none",
      fontSize: "11px",
      lineHeight: "1.45",
      padding: "8px 10px",
      borderRadius: "8px",
      border: "1px solid color-mix(in srgb, var(--border) 36%, transparent)",
      background: "color-mix(in srgb, var(--panel) 82%, transparent)"
    }
  });
  root.appendChild(message);

  const list = h("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "0"
    }
  });
  root.appendChild(list);

  const toolsPanel = h("details", {
    style: {
      borderTop: "1px solid color-mix(in srgb, var(--border) 28%, transparent)",
      paddingTop: "12px"
    }
  });

  const toolsSummary = h("summary", {
    style: {
      cursor: "pointer",
      listStyle: "none",
      userSelect: "none",
      fontSize: "12px",
      fontWeight: "600",
      opacity: "0.88"
    }
  }, t("ui.advancedTools", "高级工具"));

  const toolsContent = h("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      marginTop: "10px"
    }
  });
  toolsPanel.appendChild(toolsSummary);
  toolsPanel.appendChild(toolsContent);

  const serviceBox = h("div", {
    style: {
      border: "1px solid color-mix(in srgb, var(--border) 32%, transparent)",
      borderRadius: "12px",
      padding: "12px",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      background: "color-mix(in srgb, var(--panel) 90%, transparent)"
    }
  });
  const serviceTitle = h("div", {
    style: {
      fontSize: "12px",
      fontWeight: "600"
    }
  }, t("ui.installPlugins", "安装插件"));

  const serviceDesc = h("div", {
    style: {
      fontSize: "11px",
      lineHeight: "1.5",
      opacity: "0.58"
    }
  }, t("ui.installDesc", "支持配置服务地址、搜索可安装插件，或直接拖拽 ZIP 包安装。"));

  const urlRow = h("div", {
    style: {
      display: "flex",
      gap: "6px"
    }
  });

  const urlInput = h("input", {
    type: "text",
    placeholder: DEFAULT_BASE_URL,
    style: {
      flex: "1",
      height: "28px",
      borderRadius: "8px",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--fg)",
      padding: "0 10px",
      outline: "none",
      boxSizing: "border-box",
      fontSize: "12px"
    }
  });

  const saveUrlBtn = h("button", {
    style: {
      height: "28px",
      padding: "0 10px",
      borderRadius: "8px",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--fg)",
      cursor: "pointer",
      fontSize: "12px"
    }
  }, t("ui.saveUrl", "Save URL"));

  urlRow.appendChild(urlInput);
  urlRow.appendChild(saveUrlBtn);

  const dropZone = h("div", {
    style: {
      border: "2px dashed var(--border)",
      borderRadius: "10px",
      padding: "12px",
      textAlign: "center",
      fontSize: "12px",
      opacity: "0.78"
    }
  }, t("ui.dropZip", "拖拽 ZIP 插件包到此处进行安装"));

  const actionRow = h("div", {
    style: {
      display: "flex",
      gap: "6px"
    }
  });

  const queryInput = h("input", {
    type: "text",
    placeholder: t("ui.searchQuery", "Search query"),
    style: {
      flex: "1",
      height: "28px",
      borderRadius: "8px",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--fg)",
      padding: "0 10px",
      outline: "none",
      boxSizing: "border-box",
      fontSize: "12px"
    }
  });

  const searchBtn = h("button", {
    style: {
      height: "28px",
      padding: "0 10px",
      borderRadius: "8px",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--fg)",
      cursor: "pointer",
      fontSize: "12px"
    }
  }, t("ui.search", "Search"));

  const listBtn = h("button", {
    style: {
      height: "28px",
      padding: "0 10px",
      borderRadius: "8px",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--fg)",
      cursor: "pointer",
      fontSize: "12px"
    }
  }, t("ui.listAll", "List All"));

  const resultsList = h("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "6px"
    }
  });

  actionRow.appendChild(queryInput);
  actionRow.appendChild(searchBtn);
  actionRow.appendChild(listBtn);

  serviceBox.appendChild(serviceTitle);
  serviceBox.appendChild(serviceDesc);
  serviceBox.appendChild(urlRow);
  serviceBox.appendChild(dropZone);
  serviceBox.appendChild(actionRow);
  serviceBox.appendChild(resultsList);

  const devBox = h("div", {
    style: {
      border: "1px solid color-mix(in srgb, var(--border) 32%, transparent)",
      borderRadius: "12px",
      padding: "12px",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      background: "color-mix(in srgb, var(--panel) 90%, transparent)"
    }
  });

  const devTitle = h("div", {
    style: {
      fontSize: "12px",
      fontWeight: "600"
    }
  }, t("ui.devMode", "开发模式"));

  const devDesc = h("div", {
    style: {
      fontSize: "11px",
      lineHeight: "1.5",
      opacity: "0.58"
    }
  }, t("ui.devDesc", "把本地插件目录映射成可热更新的开发会话，适合调试插件。"));

  const devRow = h("div", {
    style: {
      display: "flex",
      gap: "6px"
    }
  });

  const devPathInput = h("input", {
    type: "text",
    placeholder: "/absolute/path/to/your-plugin",
    style: {
      flex: "1",
      height: "28px",
      borderRadius: "8px",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--fg)",
      padding: "0 10px",
      outline: "none",
      boxSizing: "border-box",
      fontSize: "12px"
    }
  });

  const devStartBtn = h("button", {
    style: {
      height: "28px",
      padding: "0 10px",
      borderRadius: "8px",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--fg)",
      cursor: "pointer",
      fontSize: "12px"
    }
  }, t("ui.startDev", "Start Dev"));

  const devStopBtn = h("button", {
    style: {
      height: "28px",
      padding: "0 10px",
      borderRadius: "8px",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--fg)",
      cursor: "pointer",
      fontSize: "12px",
      opacity: "0.6"
    },
    disabled: true
  }, t("ui.stopDev", "Stop Dev"));

  devRow.appendChild(devPathInput);
  devRow.appendChild(devStartBtn);
  devRow.appendChild(devStopBtn);

  const devStatus = h("div", {
    style: {
      fontSize: "12px",
      opacity: "0.8",
      wordBreak: "break-word"
    }
  });

  devBox.appendChild(devTitle);
  devBox.appendChild(devDesc);
  devBox.appendChild(devRow);
  devBox.appendChild(devStatus);
  toolsContent.appendChild(serviceBox);
  toolsContent.appendChild(devBox);
  root.appendChild(toolsPanel);

  function showMessage(text, tone = "info") {
    const value = String(text || "").trim();
    if (!value) {
      message.style.display = "none";
      message.textContent = "";
      return;
    }
    message.style.display = "block";
    message.textContent = value;
    message.style.color = tone === "error" ? "#f2a7a7" : "var(--fg)";
    message.style.background = tone === "error"
      ? "rgba(190, 70, 70, 0.12)"
      : "color-mix(in srgb, var(--panel) 82%, transparent)";
  }

  function renderEmpty(text) {
    list.innerHTML = "";
    list.appendChild(
      h(
        "div",
        {
          style: {
            fontSize: "12px",
            lineHeight: "1.5",
            opacity: "0.72",
            padding: "8px 0"
          }
        },
        text
      )
    );
  }

  function renderStats() {
    if (!pluginManager || typeof pluginManager.getStats !== "function") {
      statsText.textContent = t("ui.statsUnavailable", "查看和切换已安装插件。");
      return;
    }
    const s = pluginManager.getStats();
    statsText.textContent = t("ui.stats", "共 {total} 个插件，已启用 {enabled} 个，活跃 {active} 个，异常 {errors} 个。", s);
  }

  function renderList() {
    if (!pluginManager || typeof pluginManager.list !== "function") {
      renderEmpty(t("ui.systemUnavailable", "Plugin system not available"));
      return;
    }

    const q = (searchInput.value || "").trim().toLowerCase();
    const plugins = pluginManager.list();
    const filtered = q
      ? plugins.filter((p) => {
          const id = String(p?.id || "").toLowerCase();
          const name = String(p?.name || "").toLowerCase();
          const desc = String(p?.description || "").toLowerCase();
          return id.includes(q) || name.includes(q) || desc.includes(q);
        })
      : plugins;

    list.innerHTML = "";

    if (!filtered.length) {
      renderEmpty(q ? t("ui.noMatching", "No matching plugins") : t("ui.noPlugins", "No plugins found"));
      return;
    }

    for (const plugin of filtered) {
      const row = h("div", {
        style: {
          display: "flex",
          gap: "12px",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 0",
          borderBottom: "1px solid color-mix(in srgb, var(--border) 18%, transparent)",
          boxSizing: "border-box"
        }
      });

      const left = h("div", { style: { flex: "1 1 auto", minWidth: "0" } });
      const title = h("div", {
        style: {
          fontSize: "12px",
          fontWeight: "600",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }
      }, String(plugin?.name || plugin?.id || "(unknown)"));
      const meta = h("div", {
        style: {
          fontSize: "10px",
          opacity: "0.48",
          fontFamily: "var(--font-mono)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }
      }, `${String(plugin?.id || "")} v${String(plugin?.version || "")}`);

      left.appendChild(title);
      left.appendChild(meta);

      if (plugin?.description) {
        left.appendChild(
          h(
            "div",
            {
              style: {
                fontSize: "11px",
                lineHeight: "1.5",
                opacity: "0.62",
                marginTop: "4px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                display: "-webkit-box",
                WebkitLineClamp: "2",
                WebkitBoxOrient: "vertical"
              }
            },
            String(plugin.description)
          )
        );
      }

      if (plugin?.error?.message) {
        left.appendChild(
          h(
            "div",
            {
              style: {
                fontSize: "11px",
                color: "var(--error)",
                marginTop: "4px",
                wordBreak: "break-word"
              }
            },
            String(plugin.error.message)
          )
        );
      }

      try {
        const sessionsState = (window.zion && window.zion.state && window.zion.state.get("plugins.devSessions")) || {};
        let devInfo = null;
        for (const k in sessionsState) {
          const s = sessionsState[k];
          if (s && s.pluginId === plugin.id) {
            devInfo = s;
            break;
          }
        }
        if (!devInfo) {
          try {
            const saved = JSON.parse(localStorage.getItem("zion.plugins.devSessionsInfo") || "{}");
            if (saved && saved[plugin.id]) devInfo = saved[plugin.id];
          } catch {}
        }
        if (devInfo && (devInfo.dir || devInfo.baseUrl)) {
          const devLine = h("div", {
            style: {
              fontSize: "11px",
              opacity: "0.52",
              fontFamily: "var(--font-mono)",
              marginTop: "4px",
              wordBreak: "break-word"
            }
          }, devInfo.dir ? `dev: ${String(devInfo.dir)}${devInfo.baseUrl ? ` (${String(devInfo.baseUrl)})` : ""}` : `dev:${String(devInfo.baseUrl)}`);
          left.appendChild(devLine);
        }
      } catch {}

      const right = h("div", { style: { display: "flex", gap: "10px", alignItems: "center", flex: "0 0 auto" } });

      const dot = h("div", {
        style: {
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background:
            plugin?.state === "error"
              ? "#f85149"
              : plugin?.state === "active"
                ? "#2ea043"
                : plugin?.enabled
                  ? "#d29922"
                  : "#6e7681",
          marginTop: "0"
        }
      });

      const toggle = h("input", { type: "checkbox" });
      toggle.checked = !!plugin?.enabled;
      toggle.onchange = async () => {
        if (!pluginManager) return;
        const next = !!toggle.checked;
        try {
          if (next) {
            await pluginManager.enable(String(plugin.id));
          } else {
            await pluginManager.disable(String(plugin.id));
          }
          showMessage(next ? t("msg.enabled", "插件已启用。") : t("msg.disabled", "插件已停用。"));
        } catch (e) {
          toggle.checked = !next;
          showMessage(t("msg.toggleFailed", "切换插件失败：{message}", { message: e?.message || "未知错误" }), "error");
        } finally {
          try {
            renderStats();
            renderList();
          } catch {}
        }
      };

      right.appendChild(dot);
      right.appendChild(toggle);

      row.appendChild(left);
      row.appendChild(right);

      list.appendChild(row);
    }
  }

  const doRefresh = () => {
    renderStats();
    renderList();
  };

  const readServiceUrl = () => {
    try {
      return localStorage.getItem("zion.pluginServiceUrl") || DEFAULT_BASE_URL;
    } catch {
      return DEFAULT_BASE_URL;
    }
  };

  const setServiceUrl = (value) => {
    const v = String(value || "").trim();
    const next = v || DEFAULT_BASE_URL;
    try {
      localStorage.setItem("zion.pluginServiceUrl", next);
    } catch {}
    try {
      if (pluginInstaller && typeof pluginInstaller.setBaseUrl === "function") {
        pluginInstaller.setBaseUrl(next);
      }
    } catch {}
    return next;
  };

  urlInput.value = readServiceUrl();
  saveUrlBtn.onclick = () => {
    setServiceUrl(urlInput.value);
  };

  dropZone.ondragover = (e) => {
    e.stopPropagation();
    e.preventDefault();
    dropZone.style.background = "rgba(0,0,0,0.08)";
  };
  dropZone.ondragleave = () => {
    dropZone.style.background = "transparent";
  };
  dropZone.ondrop = async (e) => {
    e.stopPropagation();
    e.preventDefault();
    dropZone.style.background = "transparent";
    try {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;
      if (!pluginInstaller || typeof pluginInstaller.installFromFile !== "function") {
        showMessage(t("msg.installerUnavailable", "安装器不可用。"), "error");
        return;
      }
      if (!pluginManager || typeof pluginManager.installFromInfo !== "function") {
        showMessage(t("msg.managerUnavailable", "插件管理器不可用。"), "error");
        return;
      }
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f.name.toLowerCase().endsWith(".zip")) continue;
        const ret = await pluginInstaller.installFromFile(f);
        if (ret.success && ret.plugin) {
          await pluginManager.installFromInfo(ret.plugin, { enabled: true });
          doRefresh();
          showMessage(t("msg.installed", "已安装 {name}。", { name: ret.plugin.name || ret.plugin.id }));
        } else {
          showMessage(t("msg.installFailed", "安装失败：{message}", { message: ret.error?.message || "未知错误" }), "error");
        }
      }
    } catch (err) {
      showMessage(t("msg.installError", "安装过程中发生错误，请查看控制台。"), "error");
    }
  };

    searchBtn.onclick = async () => {
    try {
      resultsList.innerHTML = "";
      if (!pluginInstaller || typeof pluginInstaller.searchPlugins !== "function") return;
      const res = await pluginInstaller.searchPlugins(queryInput.value.trim(), 50);
      if (!res.success) {
        resultsList.appendChild(
          h("div", { style: { color: "var(--error)", fontSize: "12px" } }, t("ui.searchFailed", "Search failed: {message}", { message: res.error?.message || "Unknown" }))
        );
        return;
      }
      if (!pluginManager || typeof pluginManager.installFromInfo !== "function") {
        resultsList.appendChild(h("div", { style: { opacity: "0.8", fontSize: "12px" } }, t("ui.managerUnavailable", "PluginManager 不可用")));
        return;
      }
      res.data.forEach((item) => {
        const row = h("div", {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "8px"
          }
        });
        const label = h("div", { style: { fontSize: "12px" } }, `${item.name} (${item.id}) v${item.version}`);
        const installBtn = h("button", {
          style: {
            height: "26px",
            padding: "0 10px",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--fg)",
            cursor: "pointer",
            fontSize: "12px"
          }
        }, t("ui.install", "Install"));
        installBtn.onclick = async () => {
          const ret = await pluginInstaller.installFromService(item.id);
          if (ret.success && ret.plugin) {
            await pluginManager.installFromInfo(ret.plugin, { enabled: true });
            doRefresh();
            showMessage(t("msg.installed", "已安装 {name}。", { name: ret.plugin.name || ret.plugin.id }));
          } else {
            showMessage(t("msg.installFailed", "安装失败：{message}", { message: ret.error?.message || "未知错误" }), "error");
          }
        };
        row.appendChild(label);
        row.appendChild(installBtn);
        resultsList.appendChild(row);
      });
      if (res.data.length === 0) {
        resultsList.appendChild(h("div", { style: { opacity: "0.8", fontSize: "12px" } }, t("ui.noMatching", "No plugins matched")));
      }
    } catch (e) {
      resultsList.appendChild(h("div", { style: { color: "var(--error)", fontSize: "12px" } }, t("ui.searchError", "Search error")));
    }
  };

  listBtn.onclick = async () => {
    try {
      resultsList.innerHTML = "";
      if (!pluginInstaller || typeof pluginInstaller.listPlugins !== "function") return;
      const res = await pluginInstaller.listPlugins(100, 0);
      if (!res.success) {
        resultsList.appendChild(
          h("div", { style: { color: "var(--error)", fontSize: "12px" } }, t("ui.listFailed", "List failed: {message}", { message: res.error?.message || "Unknown" }))
        );
        return;
      }
      if (!pluginManager || typeof pluginManager.installFromInfo !== "function") {
        resultsList.appendChild(h("div", { style: { opacity: "0.8", fontSize: "12px" } }, t("ui.managerUnavailable", "PluginManager 不可用")));
        return;
      }
      res.data.forEach((item) => {
        const row = h("div", {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "8px"
          }
        });
        const label = h("div", { style: { fontSize: "12px" } }, `${item.name} (${item.id}) v${item.version}`);
        const installBtn = h("button", {
          style: {
            height: "26px",
            padding: "0 10px",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--fg)",
            cursor: "pointer",
            fontSize: "12px"
          }
        }, t("ui.install", "Install"));
        installBtn.onclick = async () => {
          const ret = await pluginInstaller.installFromService(item.id);
          if (ret.success && ret.plugin) {
            await pluginManager.installFromInfo(ret.plugin, { enabled: true });
            doRefresh();
            showMessage(t("msg.installed", "已安装 {name}。", { name: ret.plugin.name || ret.plugin.id }));
          } else {
            showMessage(t("msg.installFailed", "安装失败：{message}", { message: ret.error?.message || "未知错误" }), "error");
          }
        };
        row.appendChild(label);
        row.appendChild(installBtn);
        resultsList.appendChild(row);
      });
      if (res.data.length === 0) {
        resultsList.appendChild(h("div", { style: { opacity: "0.8", fontSize: "12px" } }, t("ui.noPlugins", "No plugins found")));
      }
    } catch (e) {
      resultsList.appendChild(h("div", { style: { color: "var(--error)", fontSize: "12px" } }, t("ui.listError", "List error")));
    }
  };

  const activeDevSessions = new Map();

  const getServiceBaseUrl = () => readServiceUrl();

  const connectWebSocket = (serviceUrl, devId) => {
    const wsUrl = serviceUrl.replace(/^http/, "ws") + `/plugins/dev/ws/${devId}`;
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      devStatus.textContent = t("msg.devConnected", "开发连接已建立：{url}", { url: wsUrl });
    };
    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "dev:change" && msg.devId === devId) {
          const baseUrl = getServiceBaseUrl() + `/plugins/dev/${devId}`;
          if (!pluginInstaller || typeof pluginInstaller.installFromDevBase !== "function") return;
          if (!pluginManager || typeof pluginManager.hotReloadFromInfo !== "function") return;
          const ret = await pluginInstaller.installFromDevBase(baseUrl, devId);
          if (ret.success && ret.plugin) {
            try {
              await pluginManager.hotReloadFromInfo(ret.plugin, { enabled: true });
            } catch {}
          }
        } else if (msg.type === "dev:stop") {
          devStatus.textContent = t("msg.devSessionStopped", "开发会话已停止：{id}", { id: devId });
        }
      } catch {}
    };
    ws.onclose = () => {
      devStatus.textContent = t("msg.devClosed", "开发连接已关闭：{id}", { id: devId });
    };
    return ws;
  };

  devStartBtn.onclick = async () => {
    const p = devPathInput.value.trim();
    if (!p) {
      showMessage(t("msg.enterDevPath", "请输入本地插件目录绝对路径。"), "error");
      return;
    }
    const serviceUrl = getServiceBaseUrl();
    try {
      if (!pluginManager || typeof pluginManager.installFromInfo !== "function") {
        throw new Error(t("ui.managerUnavailable", "PluginManager 不可用"));
      }
      if (!pluginManager.hotReloadFromInfo) {
        throw new Error(t("msg.hotReloadUnavailable", "Hot reload 不可用"));
      }
      const res = await fetch(`${serviceUrl}/plugins/dev/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p })
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const devId = data?.data?.devId;
      const baseUrlRel = data?.data?.baseUrl;
      const devDir = data?.data?.dir;
      if (!devId || !baseUrlRel) {
        throw new Error("invalid dev start response");
      }
      const baseUrl = serviceUrl + baseUrlRel;

      if (!pluginInstaller || typeof pluginInstaller.installFromDevBase !== "function") {
        throw new Error(t("msg.installerDevUnavailable", "Installer 不可用"));
      }

      const ret = await pluginInstaller.installFromDevBase(baseUrl, devId);
      if (ret.success && ret.plugin) {
        await pluginManager.installFromInfo(ret.plugin, { enabled: true });
        devStatus.textContent = t("msg.devStartedStatus", "开发会话已启动：{id} ({plugin})", { id: devId, plugin: ret.plugin.id });
        const ws = connectWebSocket(serviceUrl, devId);
        activeDevSessions.set(devId, { ws, baseUrl, pluginId: ret.plugin.id, dir: devDir });
        try {
          const sessions = (window.zion.state.get("plugins.devSessions") || {});
          sessions[devId] = { ws, baseUrl, pluginId: ret.plugin.id, dir: devDir };
          window.zion.state.set("plugins.devSessions", sessions);
          const savedRaw = localStorage.getItem("zion.plugins.devSessionsInfo") || "{}";
          const saved = JSON.parse(savedRaw);
          saved[ret.plugin.id] = { devId, baseUrl, dir: devDir };
          localStorage.setItem("zion.plugins.devSessionsInfo", JSON.stringify(saved));
        } catch {}
        devStartBtn.disabled = true;
        devStopBtn.disabled = false;
        devStopBtn.style.opacity = "1";
        showMessage(t("msg.devStarted", "开发模式已启动。"));
      } else {
        throw new Error(ret.error?.message || t("msg.devInstallFailed", "开发模式安装失败"));
      }
    } catch (e) {
      devStatus.textContent = t("msg.devStartFailedShort", "启动开发模式失败");
      showMessage(t("msg.startDevFailed", "启动开发模式失败：{message}", { message: e?.message || e }), "error");
    }
  };

  devStopBtn.onclick = async () => {
    const serviceUrl = getServiceBaseUrl();
    try {
      for (const [devId, sess] of activeDevSessions.entries()) {
        try {
          await fetch(`${serviceUrl}/plugins/dev/stop`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ devId })
          });
          sess.ws.close();
        } catch {}
        try {
          const sessions = (window.zion.state.get("plugins.devSessions") || {});
          delete sessions[devId];
          window.zion.state.set("plugins.devSessions", sessions);
          const savedRaw = localStorage.getItem("zion.plugins.devSessionsInfo") || "{}";
          const saved = JSON.parse(savedRaw);
          if (sess.pluginId && saved[sess.pluginId]) {
            delete saved[sess.pluginId];
            localStorage.setItem("zion.plugins.devSessionsInfo", JSON.stringify(saved));
          }
        } catch {}
        activeDevSessions.delete(devId);
      }
      devStatus.textContent = t("msg.devStoppedShort", "开发会话已停止。");
      showMessage(t("msg.devStopped", "开发模式已停止。"));
    } catch (e) {
      showMessage(t("msg.stopDevFailed", "停止开发模式失败：{message}", { message: e?.message || e }), "error");
    }
    devStartBtn.disabled = false;
    devStopBtn.disabled = true;
    devStopBtn.style.opacity = "0.6";
  };

  refreshBtn.onclick = doRefresh;
  reloadAllBtn.onclick = () => {
    try {
      window.zion.commands.executeCommand("zion.reloadPlugins");
    } catch {
      location.reload();
    }
  };
  searchInput.addEventListener("input", () => {
    try {
      renderList();
    } catch {}
  });

  function refreshI18n() {
    title.textContent = t("ui.plugins", "插件");
    refreshBtn.textContent = t("ui.refresh", "刷新");
    reloadAllBtn.textContent = t("ui.reloadAll", "重新加载");
    searchInput.placeholder = t("ui.search", "Search plugins");
    toolsSummary.textContent = t("ui.advancedTools", "高级工具");
    serviceTitle.textContent = t("ui.installPlugins", "安装插件");
    serviceDesc.textContent = t("ui.installDesc", "支持配置服务地址、搜索可安装插件，或直接拖拽 ZIP 包安装。");
    saveUrlBtn.textContent = t("ui.saveUrl", "Save URL");
    dropZone.textContent = t("ui.dropZip", "拖拽 ZIP 插件包到此处进行安装");
    queryInput.placeholder = t("ui.searchQuery", "Search query");
    searchBtn.textContent = t("ui.search", "Search");
    listBtn.textContent = t("ui.listAll", "List All");
    devTitle.textContent = t("ui.devMode", "开发模式");
    devDesc.textContent = t("ui.devDesc", "把本地插件目录映射成可热更新的开发会话，适合调试插件。");
    devStartBtn.textContent = t("ui.startDev", "Start Dev");
    devStopBtn.textContent = t("ui.stopDev", "Stop Dev");
    doRefresh();
  }

  container.appendChild(root);
  doRefresh();

  const disposers = [];
  const i18nDisp = window.zion?.events?.on?.("i18n/changed", refreshI18n);
  if (i18nDisp) disposers.push(() => i18nDisp.dispose?.());
  if (pluginManager && typeof pluginManager.on === "function" && typeof pluginManager.off === "function") {
    const events = [
      "installed",
      "uninstalled",
      "enabled",
      "disabled",
      "activated",
      "deactivated",
      "updated",
      "hotReloaded",
      "error"
    ];
    const handler = () => {
      try {
        doRefresh();
      } catch {}
    };
    for (const ev of events) {
      try {
        pluginManager.on(ev, handler);
        disposers.push(() => {
          try {
            pluginManager.off(ev, handler);
          } catch {}
        });
      } catch {}
    }
  }

  return {
    dispose: () => {
      try {
        for (const d of disposers.splice(0)) {
          try {
            d();
          } catch {}
        }
      } catch {}
      try {
        root.remove();
      } catch {}
    }
  };
}

export async function activate(ctx) {
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  try {
    const dispCmd = window.zion.commands.registerCommand("zion.plugins.show", () => {
      try {
        window.zion.activityBar.activateItem("plugins.activity");
      } catch {}
    });
    ctx.subscriptions.push(dispCmd);
  } catch {}

  try {
    const dispItem = window.zion.activityBar.registerItem({
      id: "plugins.activity",
      pluginId: "dev.plugins",
      icon: "$(extensions)",
      tooltip: "Plugins",
      tooltipKey: "dev.plugins.ui.plugins",
      sideBarViewId: "plugins.manager",
      order: 20
    });
    const dispView = window.zion.sideBar.registerView({
      id: "plugins.manager",
      pluginId: "dev.plugins",
      title: "Plugins",
      titleKey: "dev.plugins.ui.plugins",
      icon: "🧩",
      order: 20,
      location: "sidebar",
      headerActions: [
        {
          id: "plugins.reload",
          title: "Reload plugins",
          titleKey: "dev.plugins.ui.reload",
          ariaLabel: "Reload plugins",
          ariaLabelKey: "dev.plugins.ui.reload",
          icon: "↻",
          onClick: () => {
            try {
              window.zion.commands.executeCommand("zion.reloadPlugins");
            } catch {}
          }
        }
      ],
      component: {
        render: (container) => mountPluginsSidebarViewInto(container)
      }
    });
    ctx.subscriptions.push(dispItem, dispView);
  } catch {}
}
