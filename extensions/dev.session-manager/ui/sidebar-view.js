export function createSessionsSidebarViewManager(opts) {
  const zion = opts?.zion || window.zion;
  const createSessionsListRenderer = opts?.createSessionsListRenderer;
  const openAncestors = opts?.openAncestors;

  let current = null;

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

    headerMenu.appendChild(mkHeaderMenuItem("Import Sessions", () => zion.commands.executeCommand("zion.sessions.import")));
    headerMenu.appendChild(mkHeaderMenuItem("Export All Sessions", () => zion.commands.executeCommand("zion.sessions.export")));
    headerMenu.appendChild(mkHeaderMenuItem("Export Selected", () => zion.commands.executeCommand("zion.sessions.exportSelected")));
    headerMenu.appendChild(mkHeaderMenuItem("Delete Selected", () => zion.commands.executeCommand("zion.sessions.deleteSelected")));

    const controls = document.createElement("div");
    controls.style.display = "grid";
    controls.style.gridTemplateColumns = "1fr auto auto";
    controls.style.gap = "6px";
    controls.style.padding = "8px 10px";

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search by title…";
    searchInput.setAttribute("aria-label", "Search sessions by title");
    searchInput.style.background = "var(--panel)";
    searchInput.style.color = "var(--fg)";
    searchInput.style.border = "1px solid var(--border)";
    searchInput.style.borderRadius = "6px";
    searchInput.style.padding = "6px 8px";
    searchInput.style.fontSize = "12px";

    container.appendChild(headerMenu);
    container.addEventListener("click", () => { headerMenu.style.display = "none"; });

    controls.append(searchInput);
    container.appendChild(controls);

    const listWrap = document.createElement("div");
    listWrap.className = "zion-sessions-list";
    listWrap.style.flex = "1 1 auto";
    listWrap.style.overflow = "auto";
    listWrap.style.padding = "6px 0 6px 6px";
    const list = document.createElement("div");
    listWrap.appendChild(list);
    container.appendChild(listWrap);

    const innerRender = createSessionsListRenderer({
      listEl: list,
      hostElement: container,
      getQuery: () => (searchInput.value || "").trim().toLowerCase(),
      getSort: () => "updated",
      onSwitchSession: (id) => zion.commands.executeCommand("zion.sessions.switch", id),
      onAfterChange: () => {
        refreshIfOpen();
      }
    });

    const renderAll = () => {
      innerRender();
    };

    searchInput.addEventListener("input", () => renderAll());
    renderAll();
    try { listWrap.scrollTop = prevScroll; } catch {}

    const anchorToCurrent = () => {
      try {
        const cid = zion?.state?.get("sessions.currentId");
        if (!cid) return;
        try { openAncestors?.(cid); } catch {}
        try { searchInput.value = ""; } catch {}
        renderAll();
        try {
          const row = container.querySelector(".zion-session-row.is-current");
          if (row && listWrap) {
            row.scrollIntoView({ block: "center" });
            try {
              const prev = row.style.background;
              row.style.background = "var(--border)";
              setTimeout(() => { row.style.background = prev; }, 600);
            } catch {}
          }
        } catch {}
      } catch {}
    };

    const inst = {
      render: renderAll,
      anchorToCurrent,
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

  return { mountInto, refreshIfOpen, anchorToCurrentIfOpen, toggleMenuIfOpen };
}
