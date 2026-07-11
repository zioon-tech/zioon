export function createSessionsPanelManager(opts) {
  const zion = opts?.zion || window.zion;
  const getIndex = opts?.getIndex;
  const createSessionsListRenderer = opts?.createSessionsListRenderer;
  const refreshSessionsSidebarViewIfOpen = opts?.refreshSessionsSidebarViewIfOpen;

  function t(key, fallback, values) {
    const fullKey = `dev.session-manager.${key}`;
    try {
      const translated = zion?.i18n?.t?.(fullKey, values);
      if (translated && translated !== fullKey) return translated;
    } catch {}
    return fallback;
  }

  function open() {
    try {
      const existing = document.getElementById("zion-sessions-panel-overlay");
      if (existing) existing.remove();

      const overlay = document.createElement("div");
      overlay.id = "zion-sessions-panel-overlay";
      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.background = "rgba(0,0,0,0.35)";
      overlay.style.zIndex = "99998";
      overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

      const panel = document.createElement("div");
      panel.className = "zion-sessions-panel-content";
      panel.style.position = "fixed";
      panel.style.right = "20px";
      panel.style.top = "60px";
      panel.style.width = "380px";
      panel.style.maxHeight = "65vh";
      panel.style.overflow = "auto";
      panel.style.background = "var(--panel)";
      panel.style.border = "1px solid var(--border)";
      panel.style.borderRadius = "8px";
      panel.style.boxShadow = "0 8px 24px rgba(0,0,0,0.35)";
      panel.style.padding = "10px";
      panel.style.zIndex = "99999";
      panel.style.color = "var(--fg)";
      panel.onclick = (e) => e.stopPropagation();

      const header = document.createElement("div");
      header.style.display = "flex";
      header.style.alignItems = "center";
      header.style.justifyContent = "space-between";
      header.style.marginBottom = "8px";

      const titleWrap = document.createElement("div");
      titleWrap.style.display = "flex";
      titleWrap.style.alignItems = "center";
      titleWrap.style.gap = "8px";

      const title = document.createElement("div");
      title.textContent = t("ui.sessions", "Sessions");
      title.style.fontWeight = "500";
      title.style.fontSize = "12px";

      const count = document.createElement("span");
      const total = getIndex().length;
      count.textContent = `(${total})`;
      count.style.opacity = "0.8";
      count.style.fontSize = "12px";

      titleWrap.appendChild(title);
      titleWrap.appendChild(count);

      const closeBtn = document.createElement("button");
      closeBtn.setAttribute("aria-label", t("ui.closePanel", "Close sessions panel"));
      closeBtn.title = t("ui.close", "Close");
      closeBtn.textContent = "×";
      closeBtn.style.background = "transparent";
      closeBtn.style.color = "var(--fg)";
      closeBtn.style.border = "none";
      closeBtn.style.borderRadius = "6px";
      closeBtn.style.padding = "2px 6px";
      closeBtn.style.cursor = "pointer";
      closeBtn.style.fontSize = "14px";
      closeBtn.onmouseenter = () => { closeBtn.style.background = "var(--border)"; };
      closeBtn.onmouseleave = () => { closeBtn.style.background = "transparent"; };
      closeBtn.onclick = () => overlay.remove();

      header.appendChild(titleWrap);
      header.appendChild(closeBtn);
      panel.appendChild(header);

      const controls = document.createElement("div");
      controls.style.display = "grid";
      controls.style.gridTemplateColumns = "auto auto";
      controls.style.gap = "6px";
      controls.style.marginBottom = "8px";

      const sortSelect = document.createElement("select");
      sortSelect.setAttribute("aria-label", t("ui.sortSessions", "Sort sessions"));
      sortSelect.title = t("ui.sort", "Sort");
      sortSelect.style.background = "var(--panel)";
      sortSelect.style.color = "var(--fg)";
      sortSelect.style.border = "1px solid var(--border)";
      sortSelect.style.borderRadius = "4px";
      sortSelect.style.padding = "2px 6px";
      sortSelect.style.fontSize = "11px";
      sortSelect.style.minWidth = "48px";
      sortSelect.style.width = "auto";
      const optUpdated = document.createElement("option");
      optUpdated.value = "updated";
      optUpdated.textContent = "🕒";
      optUpdated.title = t("ui.sortUpdated", "Sort by updated (newest first)");
      const optTitle = document.createElement("option");
      optTitle.value = "title";
      optTitle.textContent = "Aa";
      optTitle.title = t("ui.sortTitle", "Sort by title (A to Z)");
      sortSelect.append(optUpdated, optTitle);

      const actions = document.createElement("div");
      actions.style.position = "relative";
      const actionBtn = document.createElement("button");
      actionBtn.innerHTML = "&#x22EE;";
      actionBtn.title = t("ui.moreActions", "More actions");
      actionBtn.setAttribute("aria-label", t("ui.moreActions", "More actions"));
      actionBtn.style.background = "transparent";
      actionBtn.style.color = "var(--fg)";
      actionBtn.style.border = "none";
      actionBtn.style.borderRadius = "6px";
      actionBtn.style.padding = "2px";
      actionBtn.style.cursor = "pointer";
      actionBtn.style.fontSize = "14px";
      actionBtn.style.width = "24px";
      actionBtn.style.height = "24px";
      actionBtn.style.display = "flex";
      actionBtn.style.alignItems = "center";
      actionBtn.style.justifyContent = "center";
      actionBtn.onmouseenter = () => { actionBtn.style.background = "var(--border)"; };
      actionBtn.onmouseleave = () => { actionBtn.style.background = "transparent"; };

      const menu = document.createElement("div");
      menu.style.position = "absolute";
      menu.style.top = "36px";
      menu.style.right = "0";
      menu.style.background = "var(--panel)";
      menu.style.border = "1px solid var(--border)";
      menu.style.borderRadius = "6px";
      menu.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
      menu.style.padding = "4px 0";
      menu.style.zIndex = "100000";
      menu.style.display = "none";
      menu.style.minWidth = "120px";

      const mkMenuItem = (text, onClick) => {
        const item = document.createElement("div");
        item.textContent = text;
        item.style.padding = "6px 16px";
        item.style.cursor = "pointer";
        item.style.fontSize = "13px";
        item.style.color = "var(--fg)";
        item.onmouseenter = () => { item.style.background = "var(--border)"; };
        item.onmouseleave = () => { item.style.background = "transparent"; };
        item.onclick = () => { menu.style.display = "none"; onClick(); };
        return item;
      };

      menu.appendChild(mkMenuItem(t("cmd.new", "New Session"), () => {
        const selFolder = zion.state.get("sessions.selectedFolderId") || "root";
        zion.commands.executeCommand("zion.sessions.new", { parentId: selFolder });
        setTimeout(() => { overlay.remove(); open(); }, 30);
      }));
      menu.appendChild(mkMenuItem(t("ui.newFolder", "New Folder"), () => {
        const selFolder = zion.state.get("sessions.selectedFolderId") || "root";
        zion.commands.executeCommand("zion.sessions.newFolder", { parentId: selFolder, targetView: "panel" });
        setTimeout(() => { overlay.remove(); open(); }, 30);
      }));
      menu.appendChild(mkMenuItem(t("ui.import", "Import Sessions"), () => {
        zion.commands.executeCommand("zion.sessions.import");
        setTimeout(() => { overlay.remove(); open(); }, 300);
      }));
      menu.appendChild(mkMenuItem(t("ui.exportAll", "Export All Sessions"), () => {
        zion.commands.executeCommand("zion.sessions.export");
      }));
      menu.appendChild(mkMenuItem(t("ui.exportSelected", "Export Selected"), () => {
        zion.commands.executeCommand("zion.sessions.exportSelected");
      }));
      menu.appendChild(mkMenuItem(t("dialog.deleteSelected", "Delete Selected"), () => {
        zion.commands.executeCommand("zion.sessions.deleteSelected");
        setTimeout(() => { overlay.remove(); open(); }, 30);
      }));

      actionBtn.onclick = (e) => {
        e.stopPropagation();
        menu.style.display = menu.style.display === "none" ? "block" : "none";
      };
      actions.appendChild(actionBtn);
      actions.appendChild(menu);

      panel.addEventListener("click", () => { menu.style.display = "none"; });

      controls.append(sortSelect, actions);
      panel.appendChild(controls);

      const list = document.createElement("div");
      panel.appendChild(list);

      const render = createSessionsListRenderer({
        listEl: list,
        hostElement: panel,
        viewId: "panel",
        getQuery: () => "",
        getSort: () => sortSelect.value || "updated",
        onSwitchSession: (id) => {
          const result = zion.commands.executeCommand("zion.sessions.switch", id);
          setTimeout(() => { overlay.remove(); }, 30);
          return result;
        },
        onAfterChange: () => {
          try { refreshSessionsSidebarViewIfOpen?.(); } catch {}
          count.textContent = `(${getIndex().length})`;
        }
      });

      sortSelect.addEventListener("change", () => render());
      render();

        const originalRemove = overlay.remove.bind(overlay);
        overlay.remove = () => {
          try { render?.dispose?.(); } catch {}
          originalRemove();
        };

      overlay.appendChild(panel);
      document.body.appendChild(overlay);
    } catch (e) {
      console.error("[sessions] open panel error:", e);
    }
  }

  function refreshIfOpen() {
    try {
      const overlay = document.getElementById("zion-sessions-panel-overlay");
      if (overlay) {
        overlay.remove();
        open();
      }
    } catch {}
  }

  return { open, refreshIfOpen };
}
