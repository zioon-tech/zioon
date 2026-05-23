export function createSessionsSidebarViewManager(opts) {
  const zion = opts?.zion || window.zion;
  const createSessionsListRenderer = opts?.createSessionsListRenderer;
  const openAncestors = opts?.openAncestors;

  let current = null;
  let revealRaf = 0;

  function refreshIfOpen() {
    try {
      current?.render?.();
    } catch {}
  }

  function anchorToCurrentIfOpen() {
    try {
      current?.anchorToCurrent?.();
    } catch {}
  }

  function revealSessionIfOpen(sessionId, options) {
    const sid = sessionId ? String(sessionId) : "";
    if (!sid) return;
    if (revealRaf) window.cancelAnimationFrame(revealRaf);
    revealRaf = requestAnimationFrame(() => {
      revealRaf = 0;
      try {
        current?.revealSession?.(sid, options);
      } catch {}
    });
  }

  function toggleMenuIfOpen() {
    try {
      current?.toggleMenu?.();
    } catch {}
  }

  function mountInto(container) {
    container.innerHTML = "";
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.height = "100%";
    container.style.overflow = "hidden";

    let prevScroll = 0;
    try {
      const prevList = container.querySelector(".zion-sessions-list");
      if (prevList) prevScroll = prevList.scrollTop || 0;
    } catch {}

    const headerMenu = document.createElement("div");
    headerMenu.style.position = "absolute";
    headerMenu.style.top = "30px";
    headerMenu.style.right = "4px";
    headerMenu.style.background = "var(--panel)";
    headerMenu.style.border = "1px solid var(--border)";
    headerMenu.style.borderRadius = "6px";
    headerMenu.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
    headerMenu.style.padding = "4px 0";
    headerMenu.style.zIndex = "100000";
    headerMenu.style.display = "none";
    headerMenu.style.minWidth = "140px";

    const mkHeaderMenuItem = (text, onClick) => {
      const item = document.createElement("div");
      item.textContent = text;
      item.style.padding = "6px 16px";
      item.style.cursor = "pointer";
      item.style.fontSize = "13px";
      item.style.color = "var(--fg)";
      item.onmouseenter = () => { item.style.background = "var(--border)"; };
      item.onmouseleave = () => { item.style.background = "transparent"; };
      item.onclick = () => { headerMenu.style.display = "none"; onClick(); };
      return item;
    };

    headerMenu.appendChild(mkHeaderMenuItem("New Session", () => {
      const selFolder = zion.state.get("sessions.selectedFolderId") || "root";
      zion.commands.executeCommand("zion.sessions.new", { parentId: selFolder });
      refreshIfOpen();
    }));
    headerMenu.appendChild(mkHeaderMenuItem("New Folder", () => {
      const selFolder = zion.state.get("sessions.selectedFolderId") || "root";
      zion.commands.executeCommand("zion.sessions.newFolder", { parentId: selFolder, targetView: "sidebar" });
    }));
    headerMenu.appendChild(mkHeaderMenuItem("Import Sessions", () => zion.commands.executeCommand("zion.sessions.import")));
    headerMenu.appendChild(mkHeaderMenuItem("Export All Sessions", () => zion.commands.executeCommand("zion.sessions.export")));
    headerMenu.appendChild(mkHeaderMenuItem("Export Selected", () => zion.commands.executeCommand("zion.sessions.exportSelected")));
    headerMenu.appendChild(mkHeaderMenuItem("Delete Selected", () => zion.commands.executeCommand("zion.sessions.deleteSelected")));

    container.appendChild(headerMenu);
    container.addEventListener("click", () => { headerMenu.style.display = "none"; });

    const listWrap = document.createElement("div");
    listWrap.className = "zion-sessions-list";
    listWrap.style.flex = "1 1 auto";
    listWrap.style.overflow = "auto";
    listWrap.style.padding = "6px 0 6px 8px";
    const list = document.createElement("div");
    listWrap.appendChild(list);
    container.appendChild(listWrap);

    const isRowFullyVisible = (row) => {
      try {
        if (!row || !listWrap) return false;
        const rowRect = row.getBoundingClientRect();
        const wrapRect = listWrap.getBoundingClientRect();
        const margin = 4;
        return rowRect.top >= wrapRect.top + margin && rowRect.bottom <= wrapRect.bottom - margin;
      } catch {
        return false;
      }
    };

    const innerRender = createSessionsListRenderer({
      listEl: list,
      hostElement: container,
      viewId: "sidebar",
      getQuery: () => "",
      getSort: () => "updated",
      onSwitchSession: (id) => {
        const panelId = zion?.panels?.getActivePanelId?.() || zion?.panelManager?.getActivePanelId?.() || null;
        const result = panelId && typeof zion?.panels?.openSession === "function"
          ? zion.panels.openSession(panelId, id, { focus: true })
          : zion.commands.executeCommand("zion.sessions.switch", id);
        Promise.resolve(result).then(() => refreshIfOpen()).catch(() => {});
        return result;
      },
      onAfterChange: () => {
        refreshIfOpen();
      }
    });

    const renderAll = () => {
      innerRender();
    };

    renderAll();
    try { listWrap.scrollTop = prevScroll; } catch {}

    const anchorToCurrent = () => {
      try {
        const cid = zion?.state?.get("sessions.currentId");
        if (!cid) return;
        try { openAncestors?.(cid); } catch {}
        renderAll();
        try {
          const row = container.querySelector(".zion-session-row.is-current");
          if (row && listWrap) {
            if (!isRowFullyVisible(row)) row.scrollIntoView({ block: "center" });
            try {
              const prev = row.style.background;
              row.style.background = "var(--border)";
              setTimeout(() => { row.style.background = prev; }, 600);
            } catch {}
          }
        } catch {}
      } catch {}
    };

    const revealSession = (sessionId, opts2) => {
      const sid = sessionId ? String(sessionId) : "";
      if (!sid) return;
      const opt = opts2 || {};
      const openParents = opt.openAncestors !== false;
      const clearSearch = !!opt.clearSearch;
      const flash = opt.flash !== false;
      const block = opt.block || "nearest";
      try { if (openParents) openAncestors?.(sid); } catch {}
      void clearSearch;
      renderAll();
      try {
        const row = Array.from(container.querySelectorAll("[data-session-id]")).find(el => el.dataset?.sessionId === sid) || container.querySelector(".zion-session-row.is-current");
        if (row && listWrap) {
          if (!isRowFullyVisible(row)) row.scrollIntoView({ block });
          if (flash) {
            try {
              const prev = row.style.background;
              row.style.background = "var(--border)";
              setTimeout(() => { row.style.background = prev; }, 450);
            } catch {}
          }
        }
      } catch {}
    };

    const inst = {
      render: renderAll,
      anchorToCurrent,
      revealSession,
      toggleMenu: () => {
        headerMenu.style.display = headerMenu.style.display === "none" ? "block" : "none";
      },
      dispose: () => {
        if (current === inst) current = null;
        try { container.innerHTML = ""; } catch {}
      }
    };
    current = inst;
    return inst;
  }

  return { mountInto, refreshIfOpen, anchorToCurrentIfOpen, revealSessionIfOpen, toggleMenuIfOpen };
}
