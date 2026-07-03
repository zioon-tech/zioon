export function createSessionsListRendererFactory(deps) {
  const {
    loadTree,
    ensureInitialTree,
    getIndex,
    loadMeta,
    buildSessionURL,
    truncate,
    setSmallDragImage,
    fmtTime,
    now,
    getSelection,
    setSelection,
    clearSelection,
    isSelected,
    toggleSelection,
    getLastSelectedId,
    setLastSelectedId,
    isFolderOpen,
    setFolderOpen,
    moveNode
  } = deps || {};

  function t(key, fallback, values) {
    const fullKey = `dev.session-manager.${key}`;
    try {
      const translated = window.zion?.i18n?.t?.(fullKey, values);
      if (translated && translated !== fullKey) return translated;
    } catch {}
    return fallback;
  }

  return function createSessionsListRenderer({ listEl, hostElement, getQuery, getSort, getSessionFilter, onSwitchSession, onAfterChange, viewId = null }) {
    const getEffectiveCurrentSessionId = () => {
      try {
        const panelId = window.zion?.panelManager?.getActivePanelId?.() || window.zion?.panels?.getActivePanelId?.() || null;
        if (panelId) {
          const panelSessionId = window.zion?.panelManager?.getPanel?.(panelId)?.activeTabId
            || window.zion?.panels?.list?.().find((panel) => panel.id === panelId)?.activeTabId
            || null;
          if (panelSessionId) return panelSessionId;
        }
      } catch {}
      return window.zion?.state?.get?.("sessions.currentId") || null;
    };

    // Small icon button
    const mkIconBtn = (icon, title, onClick) => {
      const b = document.createElement("button");
      b.innerHTML = icon;
      b.title = title;
      b.setAttribute("aria-label", title);
      b.style.background = "transparent";
      b.style.color = "var(--fg)";
      b.style.border = "none";
      b.style.borderRadius = "6px";
      b.style.padding = "2px";
      b.style.cursor = "pointer";
      b.style.fontSize = "14px";
      b.style.display = "flex";
      b.style.alignItems = "center";
      b.style.transition = "opacity 120ms ease";
      b.className = "zion-session-more-btn";
      b.onclick = onClick;
      return b;
    };

    const PENDING_INLINE_EDIT_KEY = "sessions.pendingInlineEdit";
    let pendingEdit = null; // { id, type: "session"|"folder", isNew?: boolean }
    let pendingConfirm = null; // { id, type: "session"|"folder" }

    const takePendingEdit = (id, type) => {
      if (pendingEdit && pendingEdit.id === id && pendingEdit.type === type) {
        const local = pendingEdit;
        pendingEdit = null;
        return local;
      }
      try {
        const queued = window.zion?.state?.get?.(PENDING_INLINE_EDIT_KEY) || null;
        const queuedTarget = String(queued?.targetView || "").trim() || null;
        const currentViewId = String(viewId || "").trim() || null;
        if (
          queued &&
          queued.id === id &&
          queued.type === type &&
          (!queuedTarget || !currentViewId || queuedTarget === currentViewId)
        ) {
          try { window.zion?.state?.set?.(PENDING_INLINE_EDIT_KEY, null); } catch {}
          return queued;
        }
      } catch {}
      return null;
    };

    const getPendingEditForView = () => {
      if (pendingEdit) return pendingEdit;
      try {
        const queued = window.zion?.state?.get?.(PENDING_INLINE_EDIT_KEY) || null;
        const queuedTarget = String(queued?.targetView || "").trim() || null;
        const currentViewId = String(viewId || "").trim() || null;
        if (!queued) return null;
        if (queuedTarget && currentViewId && queuedTarget !== currentViewId) return null;
        return queued;
      } catch {}
      return null;
    };

    const isConfirming = (id, type) => !!pendingConfirm && pendingConfirm.id === id && pendingConfirm.type === type;

    const markSessionViewed = (id) => {
      if (!id) return;
      try {
        window.zion?.state?.update?.(`chat.runs.${id}`, (rs) => rs ? { ...rs, awaiting: false } : rs);
      } catch {
        try {
          const key = `chat.runs.${id}`;
          const rs = window.zion?.state?.get?.(key) || null;
          if (rs) window.zion?.state?.set?.(key, { ...rs, awaiting: false });
        } catch {}
      }
      try {
        const rs = window.zion?.state?.get?.(`chat.runs.${id}`) || null;
        window.zion?.state?.set?.("chat.streaming", !!rs?.streaming);
      } catch {}
    };

    const switchSession = (id) => {
      if (typeof onSwitchSession !== "function") {
        markSessionViewed(id);
        render();
        return null;
      }
      const result = onSwitchSession(id);
      Promise.resolve(result).then((ok) => {
        if (ok === false) return;
        markSessionViewed(id);
        render();
      }).catch(() => {});
      return result;
    };

    const mountInlineConfirm = ({ row, label, onCancel, onConfirm }) => {
      try { row.querySelector(".zion-inline-confirm")?.remove?.(); } catch {}
      const wrap = document.createElement("div");
      wrap.className = "zion-inline-confirm";
      wrap.tabIndex = 0;
      wrap.onmousedown = (e) => { try { e.stopPropagation(); } catch {} };
      wrap.onclick = (e) => { try { e.stopPropagation(); } catch {} };
      wrap.onkeydown = (e) => {
        try { e.stopPropagation(); } catch {}
        if (e.key === "Escape") {
          e.preventDefault();
          if (typeof onCancel === "function") onCancel();
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (typeof onConfirm === "function") onConfirm();
        }
      };

      const lbl = document.createElement("span");
      lbl.className = "zion-inline-confirm-label";
      lbl.textContent = String(label || t("ui.deleteConfirm", "Delete?"));

      const actions = document.createElement("span");
      actions.className = "zion-inline-confirm-actions";

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "zion-inline-confirm-btn";
      cancel.textContent = t("ui.cancel", "Cancel");
      cancel.onclick = (e) => {
        try { e.stopPropagation(); } catch {}
        if (typeof onCancel === "function") onCancel();
      };

      const del = document.createElement("button");
      del.type = "button";
      del.className = "zion-inline-confirm-btn danger";
      del.textContent = t("ui.delete", "Delete");
      del.onclick = (e) => {
        try { e.stopPropagation(); } catch {}
        if (typeof onConfirm === "function") onConfirm();
      };

      actions.append(cancel, del);
      wrap.append(lbl, actions);
      row.appendChild(wrap);
      setTimeout(() => {
        try {
          wrap.focus();
        } catch {}
      }, 0);
      return wrap;
    };

    const startInlineEdit = ({ row, titleEl, initialValue, placeholder, onCommit, onCancel, commitOnBlur = true }) => {
      if (!row || !titleEl || row.querySelector("input[data-zion-inline-edit='1']")) return;

      const input = document.createElement("input");
      input.type = "text";
      input.value = String(initialValue || "");
      input.placeholder = placeholder || "";
      input.setAttribute("data-zion-inline-edit", "1");
      input.style.width = "min(320px, 100%)";
      input.style.maxWidth = "100%";
      input.style.boxSizing = "border-box";
      input.style.padding = "4px 8px";
      input.style.borderRadius = "8px";
      input.style.border = "1px solid var(--border)";
      input.style.background = "var(--bg)";
      input.style.color = "var(--fg)";
      input.style.outline = "none";
      input.style.fontSize = "12px";

      const parent = titleEl.parentElement;
      if (!parent) return;

      let finished = false;
      const cleanup = () => {
        try { input.remove(); } catch {}
        try { titleEl.style.display = ""; } catch {}
      };

      const commit = () => {
        if (finished) return;
        finished = true;
        const v = String(input.value || "").trim();
        cleanup();
        if (!v) {
          if (typeof onCancel === "function") onCancel({ reason: "empty" });
          return;
        }
        if (typeof onCommit === "function") onCommit(v);
      };

      const cancel = (reason = "cancel") => {
        if (finished) return;
        finished = true;
        cleanup();
        if (typeof onCancel === "function") onCancel({ reason });
        try { row.focus(); } catch {}
      };

      titleEl.style.display = "none";
      parent.insertBefore(input, titleEl);

      input.onmousedown = (e) => {
        try { e.stopPropagation(); } catch {}
      };
      input.onclick = (e) => {
        try { e.stopPropagation(); } catch {}
      };
      input.onkeydown = (e) => {
        try { e.stopPropagation(); } catch {}
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      };
      input.onkeyup = (e) => {
        try { e.stopPropagation(); } catch {}
      };
      input.onblur = () => {
        if (commitOnBlur) commit();
        else cancel();
      };

      setTimeout(() => {
        try {
          row.scrollIntoView({ block: "nearest" });
          input.focus();
          input.select();
        } catch {}
      }, 0);
    };

    const render = () => {
      // prevent flicker
      document.body.classList.add("zion-sessions-no-transitions");

      listEl.innerHTML = "";
      if (hostElement) {
        hostElement.classList.toggle("zion-selection-multiple", getSelection().length > 1);
      }
      const query = String(getQuery() || "").trim().toLowerCase();
      const sortBy = (getSort && getSort()) || "updated";
      const sessionFilter = typeof getSessionFilter === "function" ? getSessionFilter() : null;
      const matchesSessionFilter = (node) => {
        try {
          return typeof sessionFilter === "function" ? !!sessionFilter(node) : true;
        } catch {
          return true;
        }
      };

      const tree = loadTree() || ensureInitialTree();
      const visibleOrder = [];
      let rootContextMenu = null;
      let selectionContextMenu = null;

      const hideOpenMenus = () => {
        try {
          Array.from(listEl.querySelectorAll(".session-row-menu")).forEach((m) => {
            m.style.display = "none";
          });
        } catch {}
      };

      const showAnchoredMenu = (menu) => {
        hideOpenMenus();
        menu.style.position = "absolute";
        menu.style.top = "28px";
        menu.style.right = "0";
        menu.style.left = "auto";
        menu.style.display = "block";
      };

      const showContextMenu = (menu, ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        hideOpenMenus();
        menu.style.position = "fixed";
        menu.style.right = "auto";
        menu.style.left = `${ev.clientX}px`;
        menu.style.top = `${ev.clientY}px`;
        menu.style.display = "block";
        requestAnimationFrame(() => {
          try {
            const rect = menu.getBoundingClientRect();
            const pad = 8;
            const left = Math.min(ev.clientX, window.innerWidth - rect.width - pad);
            const top = Math.min(ev.clientY, window.innerHeight - rect.height - pad);
            menu.style.left = `${Math.max(pad, left)}px`;
            menu.style.top = `${Math.max(pad, top)}px`;
          } catch {}
        });
        const close = (e) => {
          try {
            if (e?.target && menu.contains(e.target)) return;
            menu.style.display = "none";
            document.removeEventListener("pointerdown", close, true);
            document.removeEventListener("keydown", onKeyDown, true);
          } catch {}
        };
        const onKeyDown = (e) => {
          if (e.key === "Escape") close(e);
        };
        setTimeout(() => {
          document.addEventListener("pointerdown", close, true);
          document.addEventListener("keydown", onKeyDown, true);
        }, 0);
      };

      const isInSelection = (id) => {
        try {
          return getSelection().some((it) => it && it.id === id);
        } catch {
          return false;
        }
      };

      const selectOnlyForContext = (id, type) => {
        try { setSelection([{ id, type }]); } catch {}
        try { setLastSelectedId(id); } catch {}
      };

      const createFolderInline = (parentId) => {
        const pid = String(parentId || "root");
        let id = "";
        try {
          try { setFolderOpen(pid, true); } catch {}
          id = String(window.zion.commands.executeCommand("zion.sessions.newFolder", { parentId: pid, targetView: viewId, skipRefresh: true }) || "");
          if (id) {
            pendingEdit = { id, type: "folder", isNew: true };
            try { window.zion?.state?.set?.(PENDING_INLINE_EDIT_KEY, null); } catch {}
          }
        } catch {}
        render();
      };

      const shouldUseRootContextMenu = (ev) => {
        const target = ev?.target;
        if (!target?.closest) return true;
        if (target.closest(".zion-session-row")) return false;
        if (target.closest(".session-row-menu")) return false;
        if (target.closest("button,input,select,textarea,a")) return false;
        return true;
      };

      const openRootContextMenu = (ev) => {
        if (!shouldUseRootContextMenu(ev)) return;
        try { window.zion.state.set("sessions.selectedFolderId", "root"); } catch {}
        try { clearSelection(); } catch {}
        if (rootContextMenu) showContextMenu(rootContextMenu, ev);
      };

      listEl.onclick = (ev) => {
        if (ev.target?.closest?.(".zion-session-row")) return;
        if (ev.target?.closest?.(".session-row-menu")) return;
        hideOpenMenus();
        try { window.zion.state.set("sessions.selectedFolderId", "root"); } catch {}
        try { clearSelection(); } catch {}
        render();
      };
      listEl.oncontextmenu = (ev) => {
        openRootContextMenu(ev);
      };
      if (hostElement) {
        hostElement.oncontextmenu = (ev) => {
          openRootContextMenu(ev);
        };
      }
      listEl.ondragover = (ev) => {
        if (ev.target?.closest?.(".zion-session-row")) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      };
      listEl.ondrop = (ev) => {
        if (ev.target?.closest?.(".zion-session-row")) return;
        ev.preventDefault();
        try {
          const rawMulti = ev.dataTransfer?.getData("application/zion-nodes") || "";
          const rawSingle = ev.dataTransfer?.getData("application/zion-node") || "";
          let items = [];
          if (rawMulti) {
            const payload = JSON.parse(rawMulti);
            items = Array.isArray(payload.items) ? payload.items : [];
          } else if (rawSingle) {
            const payload = JSON.parse(rawSingle);
            if (payload && payload.id) items = [{ id: payload.id, type: payload.type || "session" }];
          }
          let moved = false;
          for (const it of items) {
            if (it.id && it.id !== "root") {
              if (moveNode(it.id, "root")) moved = true;
            }
          }
          if (moved) {
            window.zion.state.set("sessions.catalog", getIndex());
            render();
            if (typeof onAfterChange === "function") onAfterChange();
          }
        } catch {}
      };

      // restore transitions in next frame
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.body.classList.remove("zion-sessions-no-transitions");
      }));

      const mkRowMenu = (item, row) => {
        // session row menu
        const menu = document.createElement("div");
        menu.style.position = "absolute";
        menu.style.top = "28px";
        menu.style.right = "0";
        menu.style.background = "var(--panel)";
        menu.style.border = "1px solid var(--border)";
        menu.style.borderRadius = "6px";
        menu.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
        menu.style.padding = "4px 0";
        menu.style.zIndex = "100001";
        menu.style.display = "none";
        menu.style.minWidth = "140px";

        const mkItem = (text, onClick) => {
          const it = document.createElement("div");
          it.textContent = text;
          it.style.padding = "6px 16px";
          it.style.cursor = "pointer";
          it.style.fontSize = "13px";
          it.style.color = "var(--fg)";
          it.onmouseenter = () => { it.style.background = "var(--border)"; };
          it.onmouseleave = () => { it.style.background = "transparent"; };
          it.onclick = () => { menu.style.display = "none"; onClick(); };
          return it;
        };

        menu.appendChild(mkItem(t("ui.openNewTab", "Open in New Tab"), () => {
          const u = buildSessionURL(item.id);
          const a = document.createElement("a");
          a.href = u;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.click();
        }));

        menu.appendChild(mkItem(t("ui.rename", "Rename"), () => {
          pendingEdit = { id: item.id, type: "session" };
          render();
        }));
        menu.appendChild(mkItem(t("ui.autoRename", "Auto Rename"), async () => {
          try { await window.zion.commands.executeCommand("zion.sessions.autoRename", { id: item.id }); } catch {}
          if (typeof onAfterChange === "function") onAfterChange();
          render();
        }));
        menu.appendChild(mkItem(t("ui.clone", "Clone"), () => {
          window.zion.commands.executeCommand("zion.sessions.clone", item.id);
          if (typeof onAfterChange === "function") onAfterChange();
          render();
        }));
        menu.appendChild(mkItem(t("ui.export", "Export"), () => {
          window.zion.commands.executeCommand("zion.sessions.export", item.id);
        }));
        menu.appendChild(mkItem(t("ui.delete", "Delete"), () => {
          pendingConfirm = { id: item.id, type: "session" };
          render();
        }));

        return menu;
      };

      const mkFolderMenu = (folder, row) => {
        const menu = document.createElement("div");
        menu.style.position = "absolute";
        menu.style.top = "28px";
        menu.style.right = "0";
        menu.style.background = "var(--panel)";
        menu.style.border = "1px solid var(--border)";
        menu.style.borderRadius = "6px";
        menu.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
        menu.style.padding = "4px 0";
        menu.style.zIndex = "100001";
        menu.style.display = "none";
        menu.style.minWidth = "160px";

        const mkItem = (text, onClick) => {
          const it = document.createElement("div");
          it.textContent = text;
          it.style.padding = "6px 16px";
          it.style.cursor = "pointer";
          it.style.fontSize = "13px";
          it.style.color = "var(--fg)";
          it.onmouseenter = () => { it.style.background = "var(--border)"; };
          it.onmouseleave = () => { it.style.background = "transparent"; };
          it.onclick = () => { menu.style.display = "none"; onClick(); };
          return it;
        };

        menu.appendChild(mkItem(t("cmd.new", "New Session"), () => {
          window.zion.commands.executeCommand("zion.sessions.new", { parentId: folder.id });
          if (typeof onAfterChange === "function") onAfterChange();
          render();
        }));
        menu.appendChild(mkItem(t("ui.newFolder", "New Folder"), () => {
          createFolderInline(folder.id);
        }));
        menu.appendChild(mkItem(t("ui.renameFolder", "Rename Folder"), () => {
          pendingEdit = { id: folder.id, type: "folder" };
          render();
        }));
        menu.appendChild(mkItem(t("ui.exportFolder", "Export Folder"), () => {
          window.zion.commands.executeCommand("zion.sessions.exportFolder", folder.id);
        }));
        menu.appendChild(mkItem(t("ui.deleteFolder", "Delete Folder"), () => {
          pendingConfirm = { id: folder.id, type: "folder" };
          render();
        }));

        return menu;
      };

      const mkRootMenu = () => {
        const menu = document.createElement("div");
        menu.style.position = "fixed";
        menu.style.background = "var(--panel)";
        menu.style.border = "1px solid var(--border)";
        menu.style.borderRadius = "6px";
        menu.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
        menu.style.padding = "4px 0";
        menu.style.zIndex = "100001";
        menu.style.display = "none";
        menu.style.minWidth = "160px";

        const mkItem = (text, onClick) => {
          const it = document.createElement("div");
          it.textContent = text;
          it.style.padding = "6px 16px";
          it.style.cursor = "pointer";
          it.style.fontSize = "13px";
          it.style.color = "var(--fg)";
          it.onmouseenter = () => { it.style.background = "var(--border)"; };
          it.onmouseleave = () => { it.style.background = "transparent"; };
          it.onclick = () => { menu.style.display = "none"; onClick(); };
          return it;
        };

        menu.appendChild(mkItem(t("cmd.new", "New Session"), () => {
          window.zion.commands.executeCommand("zion.sessions.new", { parentId: "root" });
          if (typeof onAfterChange === "function") onAfterChange();
          render();
        }));
        menu.appendChild(mkItem(t("ui.newFolder", "New Folder"), () => {
          createFolderInline("root");
        }));
        menu.appendChild(mkItem(t("ui.import", "Import Sessions"), () => {
          window.zion.commands.executeCommand("zion.sessions.import");
        }));
        menu.appendChild(mkItem(t("ui.exportAll", "Export All Sessions"), () => {
          window.zion.commands.executeCommand("zion.sessions.export");
        }));
        if (getSelection().length > 0) {
          menu.appendChild(mkItem(t("ui.exportSelected", "Export Selected"), () => {
            window.zion.commands.executeCommand("zion.sessions.exportSelected");
          }));
          menu.appendChild(mkItem(t("dialog.deleteSelected", "Delete Selected"), () => {
            window.zion.commands.executeCommand("zion.sessions.deleteSelected");
            if (typeof onAfterChange === "function") onAfterChange();
            render();
          }));
        }

        return menu;
      };

      const mkSelectionMenu = () => {
        const menu = document.createElement("div");
        menu.style.position = "fixed";
        menu.style.background = "var(--panel)";
        menu.style.border = "1px solid var(--border)";
        menu.style.borderRadius = "6px";
        menu.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
        menu.style.padding = "4px 0";
        menu.style.zIndex = "100001";
        menu.style.display = "none";
        menu.style.minWidth = "160px";

        const mkItem = (text, onClick) => {
          const it = document.createElement("div");
          it.textContent = text;
          it.style.padding = "6px 16px";
          it.style.cursor = "pointer";
          it.style.fontSize = "13px";
          it.style.color = "var(--fg)";
          it.onmouseenter = () => { it.style.background = "var(--border)"; };
          it.onmouseleave = () => { it.style.background = "transparent"; };
          it.onclick = () => { menu.style.display = "none"; onClick(); };
          return it;
        };

        const count = getSelection().length;
        const title = document.createElement("div");
        title.textContent = t("ui.selectedCount", "{count} Selected", { count });
        title.style.padding = "6px 16px";
        title.style.fontSize = "12px";
        title.style.opacity = "0.7";
        title.style.pointerEvents = "none";
        menu.appendChild(title);

        menu.appendChild(mkItem(t("ui.exportSelected", "Export Selected"), () => {
          window.zion.commands.executeCommand("zion.sessions.exportSelected");
        }));
        menu.appendChild(mkItem(t("dialog.deleteSelected", "Delete Selected"), () => {
          window.zion.commands.executeCommand("zion.sessions.deleteSelected");
          if (typeof onAfterChange === "function") onAfterChange();
          render();
        }));

        return menu;
      };

      const renderFolder = (folder, depth = 0) => {
        // folder row
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.justifyContent = "space-between";
        row.style.padding = "6px 10px";
        row.style.gap = "8px";
        row.style.borderRadius = "8px";
        row.style.transition = "background 120ms ease";
        row.style.position = "relative";
        row.className = "zion-session-row";
        row.style.whiteSpace = "nowrap";
        row.style.borderLeft = `${depth * 12}px solid transparent`;
        row.dataset.depth = String(depth);
        if (depth < 0) {
          row.style.display = "none";
          row.setAttribute("aria-hidden", "true");
        }
        if (depth >= 0) visibleOrder.push({ id: folder.id, type: "folder" });

        const labelWrap = document.createElement("div");
        labelWrap.style.display = "flex";
        labelWrap.style.alignItems = "center";
        labelWrap.style.gap = "8px";
        labelWrap.style.flex = "1 1 auto";
        labelWrap.style.minWidth = "0";
        labelWrap.style.paddingRight = "10px";

        const chevron = document.createElement("span");
        chevron.innerHTML = isFolderOpen(folder.id)
          ? '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>'
          : '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
        chevron.style.opacity = "0.8";

        const ttl = document.createElement("span");
        ttl.textContent = folder.title || "Folder";
        ttl.style.fontWeight = "500";
        ttl.style.fontSize = "12px";
        ttl.style.flex = "1 1 auto";
        ttl.style.minWidth = "0";
        ttl.style.whiteSpace = "nowrap";
        ttl.style.overflow = "hidden";
        ttl.style.textOverflow = "ellipsis";

        if (isSelected(folder.id)) row.classList.add("is-selected");

        labelWrap.appendChild(chevron);
        labelWrap.appendChild(ttl);

        const btns = document.createElement("div");
        btns.style.display = "flex";
        btns.style.gap = "4px";
        btns.style.alignItems = "center";
        btns.style.position = "absolute";
        btns.style.right = "8px";
        btns.style.top = "50%";
        btns.style.transform = "translateY(-50%)";

        const bNewSession = mkIconBtn(
          '<span class="codicon codicon-add" aria-hidden="true"></span>',
          t("ui.newSessionHere", "New session here"),
          (ev) => {
            ev.stopPropagation();
            window.zion.commands.executeCommand("zion.sessions.new", { parentId: folder.id });
            if (typeof onAfterChange === "function") onAfterChange();
            render();
          }
        );
        const bNewFolder = mkIconBtn(
          '<span class="codicon codicon-new-folder" aria-hidden="true"></span>',
          t("ui.newFolderHere", "New folder here"),
          (ev) => {
            ev.stopPropagation();
            createFolderInline(folder.id);
          }
        );

        const bMore = mkIconBtn(
          '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="4" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="12" cy="8" r="1.5" fill="currentColor"/></svg>',
          t("ui.folderActions", "Folder actions"),
          (ev) => {
            ev.stopPropagation();
            const isOpen = folderMenu.style.display === "block";
            if (isOpen) {
              folderMenu.style.display = "none";
            } else {
              showAnchoredMenu(folderMenu);
            }
          }
        );
        const folderMenu = mkFolderMenu(folder, row);
        folderMenu.className = "session-row-menu";
        row.appendChild(folderMenu);
        row.addEventListener("click", () => { folderMenu.style.display = "none"; });
        row.addEventListener("contextmenu", (ev) => {
          if (depth < 0) return;
          try { window.zion.state.set("sessions.selectedFolderId", folder.id); } catch {}
          if (getSelection().length > 1 && isInSelection(folder.id)) {
            if (selectionContextMenu) showContextMenu(selectionContextMenu, ev);
            return;
          }
          if (!isInSelection(folder.id)) {
            selectOnlyForContext(folder.id, "folder");
            row.classList.add("is-selected");
          }
          showContextMenu(folderMenu, ev);
        });

        // drag folder
        row.setAttribute("draggable", "true");
        row.addEventListener("dragstart", (ev) => {
          try {
            const sel = getSelection();
            let items = sel.length ? sel : [{ id: folder.id, type: "folder" }];
            if (!sel.find(it => it.id === folder.id)) items = [{ id: folder.id, type: "folder" }];
            ev.dataTransfer?.setData("application/zion-nodes", JSON.stringify({ items }));
            if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
            const count2 = Array.isArray(items) ? items.length : 1;
            const label = count2 > 1 ? `移动 ${count2} 项` : `文件夹: ${truncate(folder.title || "Folder", 16)}`;
            setSmallDragImage(ev, label);
          } catch {}
        });
        row.addEventListener("dragenter", (ev) => { ev.preventDefault(); row.classList.add("is-drop-target"); });
        row.addEventListener("dragover", (ev) => { ev.preventDefault(); row.classList.add("is-drop-target"); });
        row.addEventListener("dragleave", () => { row.classList.remove("is-drop-target"); });
        row.addEventListener("drop", (ev) => {
          ev.preventDefault();
          try {
            const rawMulti = ev.dataTransfer?.getData("application/zion-nodes") || "";
            const rawSingle = ev.dataTransfer?.getData("application/zion-node") || "";
            let items = [];
            if (rawMulti) {
              const payload = JSON.parse(rawMulti);
              items = Array.isArray(payload.items) ? payload.items : [];
            } else if (rawSingle) {
              const payload = JSON.parse(rawSingle);
              if (payload && payload.id) items = [{ id: payload.id, type: payload.type || "session" }];
            }
            let moved = false;
            for (const it of items) {
              if (it.id && it.id !== folder.id) {
                if (moveNode(it.id, folder.id)) moved = true;
              }
            }
            if (moved) {
              window.zion.state.set("sessions.catalog", getIndex());
              render();
              if (typeof onAfterChange === "function") onAfterChange();
            }
          } catch {}
          finally {
            row.classList.remove("is-drop-target");
          }
        });

        btns.appendChild(bNewSession);
        btns.appendChild(bNewFolder);
        btns.appendChild(bMore);
        btns.style.pointerEvents = "none";
        bNewSession.style.opacity = "0";
        bNewFolder.style.opacity = "0";
        bMore.style.opacity = "0";
        row.addEventListener("mouseenter", () => {
          if (isConfirming(folder.id, "folder")) return;
          const reserve = (btns.offsetWidth || 0) + 8;
          row.style.paddingRight = reserve + "px";
          btns.style.pointerEvents = "auto";
          bNewSession.style.opacity = "1";
          bNewFolder.style.opacity = "1";
          bMore.style.opacity = "1";
        });
        row.addEventListener("mouseleave", () => {
          if (isConfirming(folder.id, "folder")) return;
          row.style.paddingRight = "";
          btns.style.pointerEvents = "none";
          bNewSession.style.opacity = "0";
          bNewFolder.style.opacity = "0";
          bMore.style.opacity = "0";
        });
        row.addEventListener("focus", () => {
          if (isConfirming(folder.id, "folder")) return;
          const reserve = (btns.offsetWidth || 0) + 8;
          row.style.paddingRight = reserve + "px";
          btns.style.pointerEvents = "auto";
          bNewSession.style.opacity = "1";
          bNewFolder.style.opacity = "1";
          bMore.style.opacity = "1";
        });
        row.addEventListener("blur", () => {
          if (isConfirming(folder.id, "folder")) return;
          row.style.paddingRight = "";
          btns.style.pointerEvents = "none";
          bNewSession.style.opacity = "0";
          bNewFolder.style.opacity = "0";
          bMore.style.opacity = "0";
        });

        row.addEventListener("click", (ev) => {
          const t = ev.target;
          if (t && t.closest && t.closest("input[data-zion-inline-edit='1']")) return;
          if (t && btns.contains(t)) return;
          if (isConfirming(folder.id, "folder")) return;
          if (bMore.contains(ev.target) || folderMenu.contains(ev.target)) return;
          const anchorId = getLastSelectedId();
          if (ev.shiftKey) {
            if (anchorId) {
              const ids = visibleOrder.map(n => n.id);
              const a = ids.indexOf(anchorId);
              const b = ids.indexOf(folder.id);
              if (a !== -1 && b !== -1) {
                const [from, to] = a < b ? [a, b] : [b, a];
                const items = visibleOrder.slice(from, to + 1).map(n => ({ id: n.id, type: n.type || "session" }));
                setSelection(items);
                setLastSelectedId(folder.id);
                render();
                return;
              }
            }
            setSelection([{ id: folder.id, type: "folder" }]);
            setLastSelectedId(folder.id);
            render();
            return;
          }
          if (ev.metaKey || ev.ctrlKey) {
            toggleSelection({ id: folder.id, type: "folder" });
            setLastSelectedId(folder.id);
            render();
            return;
          }
          if (getSelection().length > 1) clearSelection();
          setLastSelectedId(folder.id);
          const open = isFolderOpen(folder.id);
          setFolderOpen(folder.id, !open);
          try { window.zion.state.set("sessions.selectedFolderId", folder.id); } catch {}
          render();
        });

        row.append(labelWrap, btns);
        listEl.appendChild(row);

        const folderPendingEdit = takePendingEdit(folder.id, "folder");
        if (folderPendingEdit) {
          startInlineEdit({
            row,
            titleEl: ttl,
            initialValue: folder.title || "Folder",
            placeholder: t("ui.folderName", "Folder name"),
            onCommit: (title) => {
              window.zion.commands.executeCommand("zion.sessions.renameFolder", { id: folderPendingEdit.id, title });
              if (typeof onAfterChange === "function") onAfterChange();
              render();
            },
            onCancel: () => {
              if (folderPendingEdit?.isNew) {
                window.zion.commands.executeCommand("zion.sessions.deleteFolder", folderPendingEdit.id);
                if (typeof onAfterChange === "function") onAfterChange();
                render();
              }
            }
          });
        }

        if (isConfirming(folder.id, "folder")) {
          try {
            btns.style.pointerEvents = "none";
            bNewSession.style.opacity = "0";
            bNewFolder.style.opacity = "0";
            bMore.style.opacity = "0";
            mountInlineConfirm({
              row,
              label: t("ui.deleteFolderConfirm", "Delete folder?"),
              onCancel: () => {
                pendingConfirm = null;
                render();
              },
              onConfirm: () => {
                pendingConfirm = null;
                window.zion.commands.executeCommand("zion.sessions.deleteFolder", folder.id);
                if (typeof onAfterChange === "function") onAfterChange();
                render();
              }
            });
          } catch {}
        }

        if (depth < 0 || isFolderOpen(folder.id)) {
          const children = (folder.children || []).slice();

          const matchNode = (n) => (n.title || "").toLowerCase().includes(query);
          const filterTree = (nodes) => {
            const out = [];
            for (const n of nodes) {
              if (n.type === "folder") {
                const sub = filterTree(n.children || []);
                if (matchNode(n) || sub.length > 0) out.push({ ...n, children: sub });
              } else if (n.type === "session") {
                if (matchNode(n) && matchesSessionFilter(n)) out.push(n);
              }
            }
            return out;
          };
          const nodes = (query || sessionFilter) ? filterTree(children) : children;

          const sortNodes = (nodes) => {
            const activePendingEdit = getPendingEditForView();
            const pendingNewFolderId = activePendingEdit?.type === "folder" && activePendingEdit?.isNew ? String(activePendingEdit.id || "") : "";
            const fs = nodes
              .filter(n => n.type === "folder" && String(n.id || "") !== pendingNewFolderId)
              .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
            const pendingFolder = pendingNewFolderId
              ? nodes.find(n => n.type === "folder" && String(n.id || "") === pendingNewFolderId)
              : null;
            const ss = nodes.filter(n => n.type === "session").sort((a, b) => {
              if (sortBy === "updated") {
                const am = loadMeta(a.id), bm = loadMeta(b.id);
                return (bm?.updatedAt || 0) - (am?.updatedAt || 0);
              } else {
                return (a.title || a.id).localeCompare(b.title || b.id);
              }
            });
            return [...(pendingFolder ? [pendingFolder] : []), ...fs, ...ss];
          };

          for (const ch of sortNodes(nodes)) {
            if (ch.type === "folder") {
              renderFolder(ch, depth + 1);
            } else {
              // session row
              const srow = document.createElement("div");
              srow.style.display = "flex";
              srow.style.alignItems = "center";
              srow.style.justifyContent = "space-between";
              srow.style.padding = "6px 10px";
              srow.style.gap = "8px";
              srow.style.borderRadius = "8px";
              srow.style.transition = "background 120ms ease";
              srow.tabIndex = 0;
              srow.style.position = "relative";
              srow.className = "zion-session-row";
              srow.style.whiteSpace = "nowrap";
              srow.style.paddingLeft = `${10 + ((depth + 1) * 12)}px`;
              srow.dataset.depth = String(depth + 1);
              srow.dataset.sessionId = String(ch.id || "");
              visibleOrder.push({ id: ch.id, type: "session" });

              // drag session
              srow.setAttribute("draggable", "true");
              srow.addEventListener("dragstart", (ev) => {
                try {
                  const sel = getSelection();
                  let items = sel.length ? sel : [{ id: ch.id, type: "session" }];
                  if (!sel.find(it => it.id === ch.id)) items = [{ id: ch.id, type: "session" }];
                  ev.dataTransfer?.setData("application/zion-nodes", JSON.stringify({ items }));
                  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
                  const count2 = Array.isArray(items) ? items.length : 1;
                  const label = count2 > 1 ? `移动 ${count2} 项` : `会话: ${truncate((ch.title || ch.id), 16)}`;
                  setSmallDragImage(ev, label);
                } catch {}
              });

              const labelWrap2 = document.createElement("div");
              labelWrap2.style.display = "flex";
              labelWrap2.style.flexDirection = "column";
              labelWrap2.style.flex = "1 1 auto";
              labelWrap2.style.minWidth = "0";
              labelWrap2.style.paddingRight = "10px";

              const titleLine = document.createElement("span");
              titleLine.style.fontSize = "12px";
              titleLine.style.display = "flex";
              titleLine.style.alignItems = "center";
              titleLine.style.gap = "6px";
              titleLine.style.fontWeight = "500";
              titleLine.style.flex = "1 1 auto";
              titleLine.style.minWidth = "0";

              const curId = getEffectiveCurrentSessionId();
              if (ch.id === curId) srow.classList.add("is-current");
              if (isSelected(ch.id)) srow.classList.add("is-selected");

              const ttl2 = document.createElement("span");
              ttl2.textContent = ch.title || ch.id;
              ttl2.style.flex = "1 1 auto";
              ttl2.style.minWidth = "0";
              ttl2.style.whiteSpace = "nowrap";
              ttl2.style.overflow = "hidden";
              ttl2.style.textOverflow = "ellipsis";
              titleLine.appendChild(ttl2);

              const meta = loadMeta(ch.id);
              srow.title = `${t("ui.updated", "Updated")}: ${fmtTime(meta?.updatedAt || now())} · ${t("ui.chars", "{count} chars", { count: meta?.size || 0 })}`;

              labelWrap2.append(titleLine);

              const rightWrap = document.createElement("div");
              rightWrap.style.display = "flex";
              rightWrap.style.gap = "4px";
              rightWrap.style.alignItems = "center";
              rightWrap.style.position = "absolute";
              rightWrap.style.right = "6px";
              rightWrap.style.top = "50%";
              rightWrap.style.transform = "translateY(-50%)";

              const sMenu = mkRowMenu(ch, srow);
              sMenu.className = "session-row-menu";
              srow.appendChild(sMenu);
              srow.addEventListener("click", () => { sMenu.style.display = "none"; });

              const confirmSession = isConfirming(ch.id, "session");

              const bMore2 = mkIconBtn(
                '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="4" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="12" cy="8" r="1.5" fill="currentColor"/></svg>',
                t("ui.moreActions", "More actions"),
                (ev) => {
                  ev.stopPropagation();
                  const isOpen = sMenu.style.display === "block";
                  if (isOpen) {
                    sMenu.style.display = "none";
                  } else {
                    showAnchoredMenu(sMenu);
                  }
                }
              );
              bMore2.style.opacity = "0";
              srow.addEventListener("contextmenu", (ev) => {
                if (getSelection().length > 1 && isInSelection(ch.id)) {
                  if (selectionContextMenu) showContextMenu(selectionContextMenu, ev);
                  return;
                }
                if (!isInSelection(ch.id)) {
                  selectOnlyForContext(ch.id, "session");
                  srow.classList.add("is-selected");
                }
                showContextMenu(sMenu, ev);
              });

              const rs = window.zion.state.get(`chat.runs.${ch.id}`) || null;
              let statusBadge = null;

              // Compute an opaque background color that visually matches the row background.
              // (Functionality removed in favor of masking title text)
              const applyBadgeBg = (el) => {
                // no-op
              };

              if (rs && (rs.streaming || rs.awaiting)) {
                statusBadge = document.createElement("span");
                statusBadge.className = `zion-session-status-badge ${rs.streaming ? "streaming" : "ready"}`;
                statusBadge.textContent = "●";
                statusBadge.title = rs.streaming ? "Model generating…" : "Answer ready";
                // Transparent background; text below is masked
                statusBadge.style.background = "transparent";

                // Apply mask to titleLine to prevent text overlap
                try {
                  titleLine.style.maskImage = "linear-gradient(to right, black calc(100% - 44px), transparent 100%)";
                  titleLine.style.webkitMaskImage = "linear-gradient(to right, black calc(100% - 44px), transparent 100%)";
                } catch {}
              }

              if (!confirmSession) {
                rightWrap.appendChild(bMore2);
                if (statusBadge) rightWrap.appendChild(statusBadge);
              }

              if (!confirmSession) rightWrap.style.pointerEvents = "none";
              srow.addEventListener("mouseenter", () => {
                if (confirmSession) return;
                const reserve = (rightWrap.offsetWidth || 0) + 8;
                srow.style.paddingRight = reserve + "px";
                rightWrap.style.pointerEvents = "auto";
                bMore2.style.opacity = "1";
              });
              srow.addEventListener("mouseleave", () => {
                if (confirmSession) return;
                srow.style.paddingRight = "";
                rightWrap.style.pointerEvents = "none";
                bMore2.style.opacity = "0";
              });
              srow.addEventListener("focus", () => {
                if (confirmSession) return;
                const reserve = (rightWrap.offsetWidth || 0) + 8;
                srow.style.paddingRight = reserve + "px";
                rightWrap.style.pointerEvents = "auto";
                bMore2.style.opacity = "1";
              });
              srow.addEventListener("blur", () => {
                if (confirmSession) return;
                srow.style.paddingRight = "";
                rightWrap.style.pointerEvents = "none";
                bMore2.style.opacity = "0";
              });

              srow.appendChild(rightWrap);
              if (confirmSession) {
                rightWrap.style.display = "none";
                mountInlineConfirm({
                  row: srow,
                  label: t("ui.deleteSessionConfirm", "Delete session?"),
                  onCancel: () => {
                    pendingConfirm = null;
                    render();
                  },
                  onConfirm: () => {
                    pendingConfirm = null;
                    window.zion.commands.executeCommand("zion.sessions.delete", ch.id);
                    if (typeof onAfterChange === "function") onAfterChange();
                    render();
                  }
                });
              }

              if (pendingEdit && pendingEdit.id === ch.id && pendingEdit.type === "session") {
                const pid = pendingEdit;
                pendingEdit = null;
                startInlineEdit({
                  row: srow,
                  titleEl: ttl2,
                  initialValue: ch.title || ch.id,
                  placeholder: t("ui.sessionTitle", "Session title"),
                  onCommit: (title) => {
                    window.zion.commands.executeCommand("zion.sessions.rename", { id: pid.id, title });
                    if (typeof onAfterChange === "function") onAfterChange();
                    render();
                  }
                });
              }

              srow.addEventListener("keydown", (ev) => {
                if (isConfirming(ch.id, "session")) {
                  if (ev.key === "Escape") {
                    ev.preventDefault();
                    pendingConfirm = null;
                    render();
                    return;
                  }
                  if (ev.key === "Enter") {
                    ev.preventDefault();
                    pendingConfirm = null;
                    window.zion.commands.executeCommand("zion.sessions.delete", ch.id);
                    if (typeof onAfterChange === "function") onAfterChange();
                    render();
                    return;
                  }
                }
                if (ev.key === "Enter") {
                  ev.preventDefault();
                  switchSession(ch.id);
                } else if (ev.key.toLowerCase() === "r") {
                  ev.preventDefault();
                  pendingEdit = { id: ch.id, type: "session" };
                  render();
                } else if (ev.key.toLowerCase() === "c") {
                  ev.preventDefault();
                  window.zion.commands.executeCommand("zion.sessions.clone", ch.id);
                  if (typeof onAfterChange === "function") onAfterChange();
                  render();
                } else if (ev.key.toLowerCase() === "e") {
                  ev.preventDefault();
                  window.zion.commands.executeCommand("zion.sessions.export", ch.id);
                } else if (ev.key === "Delete" || ev.key === "Backspace") {
                  ev.preventDefault();
                  const sel = getSelection();
                  if (sel.length > 1) {
                    window.zion.commands.executeCommand("zion.sessions.deleteSelected");
                  } else {
                    sMenu.children[3]?.click();
                  }
                  if (typeof onAfterChange === "function") onAfterChange();
                  render();
                }
              });

              srow.addEventListener("click", (ev) => {
                const t = ev.target;
                if (t && t.closest && t.closest("input[data-zion-inline-edit='1']")) return;
                if (t && rightWrap.contains(t)) return;
                if (isConfirming(ch.id, "session")) return;
                if (bMore2.contains(ev.target) || sMenu.contains(ev.target)) return;
                const anchorId = getLastSelectedId();
                if (ev.shiftKey) {
                  if (anchorId) {
                    const ids = visibleOrder.map(n => n.id);
                    const a = ids.indexOf(anchorId);
                    const b = ids.indexOf(ch.id);
                    if (a !== -1 && b !== -1) {
                      const [from, to] = a < b ? [a, b] : [b, a];
                      const items = visibleOrder.slice(from, to + 1).map(n => ({ id: n.id, type: n.type || "session" }));
                      setSelection(items);
                      setLastSelectedId(ch.id);
                      render();
                      return;
                    }
                  }
                  setSelection([{ id: ch.id, type: "session" }]);
                  setLastSelectedId(ch.id);
                  render();
                  return;
                }
                if (ev.metaKey || ev.ctrlKey) {
                  toggleSelection({ id: ch.id, type: "session" });
                  setLastSelectedId(ch.id);
                  render();
                  return;
                }
                clearSelection();
                setLastSelectedId(ch.id);
                try {
                  Array.from(listEl.querySelectorAll(".zion-session-row.is-selected")).forEach((row) => row.classList.remove("is-selected"));
                } catch {}
                switchSession(ch.id);
              });

              srow.append(labelWrap2);
              listEl.appendChild(srow);
              // 追加到 DOM 后再计算一次徽标背景，确保读取到最终的行背景（含选中/当前状态）
              try { if (statusBadge) requestAnimationFrame(() => requestAnimationFrame(() => applyBadgeBg(statusBadge))); } catch {}
            }
          }
        }
      };
      const root = tree;
      rootContextMenu = mkRootMenu();
      rootContextMenu.className = "session-row-menu";
      listEl.appendChild(rootContextMenu);
      selectionContextMenu = mkSelectionMenu();
      selectionContextMenu.className = "session-row-menu";
      listEl.appendChild(selectionContextMenu);
      if (!root || !Array.isArray(root.children) || root.children.length === 0) {
        const empty = document.createElement("div");
        empty.textContent = t("ui.noSessionsYet", "No sessions yet.");
        empty.style.opacity = "0.8";
        empty.style.fontSize = "12px";
        empty.style.padding = "8px 4px";
        listEl.appendChild(empty);
        return;
      }
      try { setFolderOpen(root.id || "root", true); } catch {}
      renderFolder(root, -1);
    };

    return render;
  };
}
