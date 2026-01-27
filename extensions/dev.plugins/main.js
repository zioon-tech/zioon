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

  const root = h(
    "div",
    {
      style: {
        padding: "10px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        boxSizing: "border-box"
      }
    }
  );

  const header = h(
    "div",
    {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "10px"
      }
    }
  );

  const statsText = h("div", {
    style: {
      fontSize: "12px",
      opacity: "0.8",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  });

  const refreshBtn = h(
    "button",
    {
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
    },
    "Refresh"
  );

  header.appendChild(statsText);
  header.appendChild(refreshBtn);
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
    placeholder: "Search plugins",
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

  const list = h("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "8px"
    }
  });
  root.appendChild(list);

  function renderEmpty(text) {
    list.innerHTML = "";
    list.appendChild(
      h(
        "div",
        {
          style: {
            fontSize: "12px",
            opacity: "0.8",
            padding: "6px 0"
          }
        },
        text
      )
    );
  }

  function renderStats() {
    if (!pluginManager || typeof pluginManager.getStats !== "function") {
      statsText.textContent = "Plugins";
      return;
    }
    const s = pluginManager.getStats();
    statsText.textContent = `Total ${s.total} · Enabled ${s.enabled} · Active ${s.active} · Errors ${s.errors}`;
  }

  function renderList() {
    if (!pluginManager || typeof pluginManager.list !== "function") {
      renderEmpty("Plugin system not available");
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
      renderEmpty(q ? "No matching plugins" : "No plugins found");
      return;
    }

    for (const plugin of filtered) {
      const row = h("div", {
        style: {
          display: "flex",
          gap: "10px",
          alignItems: "flex-start",
          justifyContent: "space-between",
          padding: "8px",
          border: "1px solid var(--border)",
          borderRadius: "10px",
          background: "rgba(255,255,255,0.02)",
          boxSizing: "border-box"
        }
      });

      const left = h("div", { style: { flex: "1 1 auto", minWidth: "0" } });
      const title = h("div", {
        style: {
          fontSize: "13px",
          fontWeight: "600",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        }
      }, String(plugin?.name || plugin?.id || "(unknown)"));
      const meta = h("div", {
        style: {
          fontSize: "11px",
          opacity: "0.75",
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
                opacity: "0.8",
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

      const right = h("div", { style: { display: "flex", gap: "10px", alignItems: "center" } });

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
          marginTop: "8px"
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
        } catch (e) {
          toggle.checked = !next;
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

  refreshBtn.onclick = doRefresh;
  searchInput.addEventListener("input", () => {
    try {
      renderList();
    } catch {}
  });

  container.appendChild(root);
  doRefresh();

  const disposers = [];
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
      icon: "🧩",
      tooltip: "Plugins",
      sideBarViewId: "plugins.manager",
      order: 20
    });
    const dispView = window.zion.sideBar.registerView({
      id: "plugins.manager",
      pluginId: "dev.plugins",
      title: "Plugins",
      icon: "🧩",
      order: 20,
      location: "sidebar",
      headerActions: [
        {
          id: "plugins.reload",
          title: "Reload plugins",
          ariaLabel: "Reload plugins",
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

