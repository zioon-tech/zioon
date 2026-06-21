export function createSessionsSidebarViewManager(opts) {
  const zion = opts?.zion || window.zion;
  const createSessionsListRenderer = opts?.createSessionsListRenderer;
  const openAncestors = opts?.openAncestors;
  const getIndex = opts?.getIndex;
  const loadMeta = opts?.loadMeta;
  const LS_SELECTED_DAY = "zion.sessions.sidebar.selectedDay";
  const LS_SELECTED_RANGE_DAYS = "zion.sessions.sidebar.selectedRangeDays";
  const LS_DAY_PANEL_COLLAPSED = "zion.sessions.sidebar.dayPanelCollapsed";
  const LS_DAY_PANEL_END_DAY = "zion.sessions.sidebar.dayPanelEndDay";

  function t(key, fallback, values) {
    const fullKey = `dev.session-manager.${key}`;
    const interpolate = (input) => String(input || "").replace(/\{(\w+)\}/g, (match, name) => {
      const value = values?.[name];
      return value === undefined || value === null ? match : String(value);
    });
    try {
      const translated = zion?.i18n?.t?.(fullKey, values);
      if (translated && translated !== fullKey) return translated;
    } catch {}
    return interpolate(fallback);
  }

  let current = null;
  let revealRaf = 0;
  let heatmapTooltip = null;

  function hideHeatmapTooltip() {
    try {
      heatmapTooltip?.remove?.();
    } catch {}
    heatmapTooltip = null;
  }

  function moveHeatmapTooltip(x, y) {
    if (!heatmapTooltip) return;
    const pad = 10;
    const rect = heatmapTooltip.getBoundingClientRect();
    let left = x + 10;
    let top = y + 12;
    if (left + rect.width + pad > window.innerWidth) left = Math.max(pad, x - rect.width - 10);
    if (top + rect.height + pad > window.innerHeight) top = Math.max(pad, y - rect.height - 10);
    heatmapTooltip.style.left = `${left}px`;
    heatmapTooltip.style.top = `${top}px`;
  }

  function showHeatmapTooltip(text, x, y) {
    const value = String(text || "").trim();
    if (!value) return;
    hideHeatmapTooltip();
    const tip = document.createElement("div");
    tip.className = "zion-sessions-heatmap-tooltip";
    tip.textContent = value;
    tip.style.position = "fixed";
    tip.style.zIndex = "100000";
    tip.style.pointerEvents = "none";
    tip.style.maxWidth = "260px";
    tip.style.padding = "5px 7px";
    tip.style.borderRadius = "6px";
    tip.style.border = "1px solid var(--border)";
    tip.style.background = "var(--panel)";
    tip.style.color = "var(--fg)";
    tip.style.boxShadow = "0 6px 18px rgba(0, 0, 0, 0.22)";
    tip.style.fontSize = "11px";
    tip.style.lineHeight = "1.35";
    document.body.appendChild(tip);
    heatmapTooltip = tip;
    moveHeatmapTooltip(x, y);
  }

  function dayKey(ts = Date.now()) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function formatCompactNumber(value) {
    const n = Number(value || 0);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
    return String(Math.round(n));
  }

  function sessionTouchesDay(meta, day) {
    if (!meta || !day) return false;
    return dayKey(meta.updatedAt || 0) === day || dayKey(meta.createdAt || 0) === day;
  }

  function sessionTouchesAnyDay(meta, days) {
    if (!meta || !days?.size) return false;
    return days.has(dayKey(meta.updatedAt || 0)) || days.has(dayKey(meta.createdAt || 0));
  }

  function shiftDay(day, delta) {
    const d = new Date(`${day || dayKey()}T00:00:00`);
    d.setDate(d.getDate() + Number(delta || 0));
    return dayKey(d.getTime());
  }

  function recentDays(count, endDay = dayKey()) {
    const n = Math.max(1, Number(count || 1));
    const endDate = new Date(`${endDay || dayKey()}T00:00:00`);
    const days = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(endDate);
      d.setDate(endDate.getDate() - i);
      days.push(dayKey(d.getTime()));
    }
    return days;
  }

  function getUsageRecords() {
    try { return zion?.usage?.getRecords?.() || []; } catch { return []; }
  }

  function getSessionIndex() {
    try { return typeof getIndex === "function" ? (getIndex() || []) : []; } catch { return []; }
  }

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

    const menuItems = [];
    const mkHeaderMenuItem = (key, fallback, onClick) => {
      const item = document.createElement("div");
      item.textContent = t(key, fallback);
      item.style.padding = "6px 16px";
      item.style.cursor = "pointer";
      item.style.fontSize = "13px";
      item.style.color = "var(--fg)";
      item.onmouseenter = () => { item.style.background = "var(--border)"; };
      item.onmouseleave = () => { item.style.background = "transparent"; };
      item.onclick = () => { headerMenu.style.display = "none"; onClick(); };
      menuItems.push({ item, key, fallback });
      return item;
    };
    const refreshMenuText = () => {
      for (const m of menuItems) {
        try { m.item.textContent = t(m.key, m.fallback); } catch {}
      }
    };

    headerMenu.appendChild(mkHeaderMenuItem("ui.createNew", "New Session", () => {
      const selFolder = zion.state.get("sessions.selectedFolderId") || "root";
      zion.commands.executeCommand("zion.sessions.new", { parentId: selFolder });
      refreshIfOpen();
    }));
    headerMenu.appendChild(mkHeaderMenuItem("ui.newFolder", "New Folder", () => {
      const selFolder = zion.state.get("sessions.selectedFolderId") || "root";
      zion.commands.executeCommand("zion.sessions.newFolder", { parentId: selFolder, targetView: "sidebar" });
    }));
    headerMenu.appendChild(mkHeaderMenuItem("ui.import", "Import Sessions", () => zion.commands.executeCommand("zion.sessions.import")));
    headerMenu.appendChild(mkHeaderMenuItem("ui.exportAll", "Export All Sessions", () => zion.commands.executeCommand("zion.sessions.export")));
    headerMenu.appendChild(mkHeaderMenuItem("ui.exportSelected", "Export Selected", () => zion.commands.executeCommand("zion.sessions.exportSelected")));
    headerMenu.appendChild(mkHeaderMenuItem("dialog.deleteSelected", "Delete Selected", () => zion.commands.executeCommand("zion.sessions.deleteSelected")));

    container.appendChild(headerMenu);
    container.addEventListener("click", () => { headerMenu.style.display = "none"; });

    let selectedDay = (() => {
      try { return localStorage.getItem(LS_SELECTED_DAY) || dayKey(); } catch { return dayKey(); }
    })();
    let selectedRangeDays = (() => {
      try {
        const value = Number(localStorage.getItem(LS_SELECTED_RANGE_DAYS) || "0");
        return Number.isFinite(value) && value > 0 ? value : 0;
      } catch { return 0; }
    })();
    let calendarCollapsed = (() => {
      try { return localStorage.getItem(LS_DAY_PANEL_COLLAPSED) === "1"; } catch { return false; }
    })();
    let windowEndDay = (() => {
      try { return localStorage.getItem(LS_DAY_PANEL_END_DAY) || dayKey(); } catch { return dayKey(); }
    })();

    const calendarHost = document.createElement("div");
    calendarHost.className = "zion-sessions-day-panel";
    calendarHost.style.flex = "0 0 auto";
    calendarHost.style.margin = "2px 8px 8px 8px";
    calendarHost.style.padding = "6px 0 0 0";
    calendarHost.style.borderTop = "1px solid color-mix(in srgb, var(--border) 72%, transparent)";

    const listWrap = document.createElement("div");
    listWrap.className = "zion-sessions-list";
    listWrap.style.flex = "1 1 auto";
    listWrap.style.overflow = "auto";
    listWrap.style.padding = "6px 0 6px 8px";
    const list = document.createElement("div");
    listWrap.appendChild(list);
    container.appendChild(listWrap);
    container.appendChild(calendarHost);

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
      getSessionFilter: () => {
        if (!selectedDay && !selectedRangeDays) return null;
        const filterDays = selectedRangeDays ? new Set(recentDays(selectedRangeDays)) : new Set([selectedDay]);
        const usageSessionIds = new Set(getUsageRecords().filter(r => filterDays.has(r?.day) && r?.sessionId).map(r => String(r.sessionId)));
        return (node) => {
          const sid = String(node?.id || "");
          if (!sid) return false;
          if (usageSessionIds.has(sid)) return true;
          const meta = typeof loadMeta === "function" ? loadMeta(sid) : node;
          return selectedRangeDays ? sessionTouchesAnyDay(meta || node, filterDays) : sessionTouchesDay(meta || node, selectedDay);
        };
      },
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
    const disposables = [];
    try { disposables.push(zion?.events?.on?.("chat/usageChanged", () => renderAll())); } catch {}
    try { disposables.push(zion?.state?.onDidChange?.("sessions.treeMem", () => renderAll())); } catch {}
    try { disposables.push(zion?.state?.onDidChange?.("sessions.indexMem", () => renderAll())); } catch {}

    const renderCalendar = () => {
      hideHeatmapTooltip();
      calendarHost.innerHTML = "";
      const records = getUsageRecords();
      const sessions = getSessionIndex();
      const days = [];
      const todayKey = dayKey();
      if (windowEndDay > todayKey) windowEndDay = todayKey;
      const endDate = new Date(`${windowEndDay || todayKey}T00:00:00`);
      for (let i = 34; i >= 0; i--) {
        const d = new Date(endDate);
        d.setDate(endDate.getDate() - i);
        days.push(dayKey(d.getTime()));
      }
      const rangeLabel = `${days[0]?.slice(5) || ""}..${days[days.length - 1]?.slice(5) || ""}`;
      const statsByDay = new Map();
      for (const day of days) statsByDay.set(day, {
        day,
        sessionIds: new Set(),
        tokens: 0,
        cacheTokens: 0,
        cost: 0,
        hasKnownCost: false,
        currency: "USD",
        models: new Map()
      });
      for (const session of sessions) {
        const meta = typeof loadMeta === "function" ? loadMeta(session.id) : session;
        const touched = new Set([dayKey(meta?.createdAt || 0), dayKey(meta?.updatedAt || 0)]);
        for (const day of touched) {
          const stat = statsByDay.get(day);
          if (stat && session.id) stat.sessionIds.add(String(session.id));
        }
      }
      for (const record of records) {
        const stat = statsByDay.get(record?.day);
        if (!stat) continue;
        if (record.sessionId) stat.sessionIds.add(String(record.sessionId));
        stat.tokens += Number(record?.tokens?.total || 0);
        stat.cacheTokens += Number(record?.tokens?.cacheRead || 0) + Number(record?.tokens?.cacheWrite || 0);
        if (typeof record?.cost === "number" && Number.isFinite(record.cost)) {
          stat.cost += record.cost;
          stat.hasKnownCost = true;
          stat.currency = record.currency || stat.currency;
        }
        const label = record.label || record.modelName || record.modelId || "Unknown";
        const prev = stat.models.get(label) || { label, tokens: 0, calls: 0 };
        prev.tokens += Number(record?.tokens?.total || 0);
        prev.calls += 1;
        stat.models.set(label, prev);
      }
      const allSummary = {
        day: "",
        sessionIds: new Set(sessions.map(s => String(s.id || "")).filter(Boolean)),
        tokens: 0,
        cacheTokens: 0,
        models: new Map()
      };
      for (const record of records) {
        allSummary.tokens += Number(record?.tokens?.total || 0);
        allSummary.cacheTokens += Number(record?.tokens?.cacheRead || 0) + Number(record?.tokens?.cacheWrite || 0);
        const label = record.label || record.modelName || record.modelId || "Unknown";
        const prev = allSummary.models.get(label) || { label, tokens: 0, calls: 0 };
        prev.tokens += Number(record?.tokens?.total || 0);
        prev.calls += 1;
        allSummary.models.set(label, prev);
      }
      const selected = (() => {
        if (selectedRangeDays) {
          const summary = {
            day: "",
            sessionIds: new Set(),
            tokens: 0,
            cacheTokens: 0,
            models: new Map()
          };
          for (const day of recentDays(selectedRangeDays)) {
            const stat = statsByDay.get(day);
            if (!stat) continue;
            for (const sid of stat.sessionIds || []) summary.sessionIds.add(sid);
            summary.tokens += Number(stat.tokens || 0);
            summary.cacheTokens += Number(stat.cacheTokens || 0);
            for (const model of stat.models?.values?.() || []) {
              const prev = summary.models.get(model.label) || { label: model.label, tokens: 0, calls: 0 };
              prev.tokens += Number(model.tokens || 0);
              prev.calls += Number(model.calls || 0);
              summary.models.set(model.label, prev);
            }
          }
          return summary;
        }
        return selectedDay ? (statsByDay.get(selectedDay) || {
          day: selectedDay,
          sessionIds: new Set(),
          tokens: 0,
          cacheTokens: 0,
          models: new Map()
        }) : allSummary;
      })();
      const maxTokens = Math.max(1, ...Array.from(statsByDay.values()).map(s => Number(s.tokens || 0)));
      const selectedRangeSet = selectedRangeDays ? new Set(recentDays(selectedRangeDays)) : null;
      const setDateFilter = (day, rangeDays = 0) => {
        selectedDay = day || "";
        selectedRangeDays = Math.max(0, Number(rangeDays || 0));
        if (selectedRangeDays) windowEndDay = todayKey;
        try {
          localStorage.setItem(LS_DAY_PANEL_END_DAY, windowEndDay);
          if (selectedDay) localStorage.setItem(LS_SELECTED_DAY, selectedDay);
          else localStorage.removeItem(LS_SELECTED_DAY);
          if (selectedRangeDays) localStorage.setItem(LS_SELECTED_RANGE_DAYS, String(selectedRangeDays));
          else localStorage.removeItem(LS_SELECTED_RANGE_DAYS);
        } catch {}
        renderAll();
      };

      const header = document.createElement("div");
      header.style.display = "flex";
      header.style.alignItems = "center";
      header.style.justifyContent = "space-between";
      header.style.gap = "8px";
      const leftHead = document.createElement("div");
      leftHead.style.display = "inline-flex";
      leftHead.style.alignItems = "center";
      leftHead.style.gap = "4px";
      leftHead.style.minWidth = "0";
      leftHead.style.flex = "1 1 auto";
      leftHead.style.cursor = "pointer";
      leftHead.title = calendarCollapsed ? t("heatmap.expand", "Expand heatmap") : t("heatmap.collapse", "Collapse heatmap");
      const collapseBtn = document.createElement("button");
      collapseBtn.textContent = calendarCollapsed ? "▸" : "▾";
      collapseBtn.title = calendarCollapsed ? t("heatmap.expand", "Expand heatmap") : t("heatmap.collapse", "Collapse heatmap");
      collapseBtn.style.border = "0";
      collapseBtn.style.background = "transparent";
      collapseBtn.style.color = "var(--files-muted-fg, var(--muted-fg, var(--fg)))";
      collapseBtn.style.fontSize = "12px";
      collapseBtn.style.padding = "1px 2px";
      collapseBtn.style.cursor = "pointer";
      const toggleCollapsed = () => {
        calendarCollapsed = !calendarCollapsed;
        try { localStorage.setItem(LS_DAY_PANEL_COLLAPSED, calendarCollapsed ? "1" : "0"); } catch {}
        renderAll();
      };
      collapseBtn.onclick = (ev) => {
        ev.stopPropagation();
        toggleCollapsed();
      };
      leftHead.onclick = (ev) => {
        ev.stopPropagation();
        toggleCollapsed();
      };
      const title = document.createElement("div");
      title.textContent = t("heatmap.activity", "Activity");
      title.style.fontSize = "11px";
      title.style.fontWeight = "500";
      title.style.color = "var(--files-muted-fg, var(--muted-fg, var(--fg)))";
      title.style.minWidth = "0";
      title.style.overflow = "hidden";
      title.style.textOverflow = "ellipsis";
      title.style.whiteSpace = "nowrap";
      leftHead.append(collapseBtn, title);
      const controls = document.createElement("div");
      controls.style.display = "inline-flex";
      controls.style.alignItems = "center";
      controls.style.gap = "4px";
      const navBtn = (text, titleText, onClick) => {
        const btn = document.createElement("button");
        btn.textContent = text;
        btn.title = titleText;
        btn.style.border = "0";
        btn.style.background = "transparent";
        btn.style.color = "var(--files-muted-fg, var(--muted-fg, var(--fg)))";
        btn.style.fontSize = "11px";
        btn.style.padding = "1px 3px";
        btn.style.cursor = "pointer";
        btn.onclick = (ev) => {
          ev.stopPropagation();
          onClick?.();
        };
        return btn;
      };
      const prevBtn = navBtn("‹", t("heatmap.previous35Days", "View earlier 35 days"), () => {
        windowEndDay = shiftDay(windowEndDay, -35);
        try { localStorage.setItem(LS_DAY_PANEL_END_DAY, windowEndDay); } catch {}
        renderAll();
      });
      const nextBtn = navBtn("›", t("heatmap.next35Days", "View next 35 days"), () => {
        windowEndDay = shiftDay(windowEndDay, 35);
        if (windowEndDay > todayKey) windowEndDay = todayKey;
        try { localStorage.setItem(LS_DAY_PANEL_END_DAY, windowEndDay); } catch {}
        renderAll();
      });
      const rangeSelect = document.createElement("select");
      rangeSelect.title = t("heatmap.filterRange", "Filter sessions by date range");
      rangeSelect.style.minWidth = "88px";
      rangeSelect.style.maxWidth = "120px";
      rangeSelect.style.border = "0";
      rangeSelect.style.borderRadius = "6px";
      rangeSelect.style.background = "color-mix(in srgb, var(--fg) 5%, transparent)";
      rangeSelect.style.color = "var(--fg)";
      rangeSelect.style.fontSize = "11px";
      rangeSelect.style.padding = "2px 6px";
      rangeSelect.style.outline = "none";
      rangeSelect.style.cursor = "pointer";
      const addRangeOption = (value, label) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        rangeSelect.appendChild(option);
      };
      addRangeOption("all", t("heatmap.all", "All"));
      addRangeOption("today", t("heatmap.today", "Today"));
      addRangeOption("1", t("heatmap.last1Day", "1d"));
      addRangeOption("3", t("heatmap.last3Days", "3d"));
      addRangeOption("7", t("heatmap.last7Days", "7d"));
      addRangeOption("14", t("heatmap.last14Days", "14d"));
      addRangeOption("30", t("heatmap.last30Days", "30d"));
      if (selectedDay && selectedDay !== todayKey && !selectedRangeDays) addRangeOption("day", selectedDay);
      rangeSelect.value = selectedRangeDays ? String(selectedRangeDays) : selectedDay === todayKey ? "today" : selectedDay ? "day" : "all";
      rangeSelect.onchange = (ev) => {
        ev.stopPropagation();
        const value = rangeSelect.value;
        if (value === "all") setDateFilter("", 0);
        else if (value === "today") setDateFilter(dayKey(), 0);
        else setDateFilter("", Number(value || 0));
      };
      controls.append(prevBtn, nextBtn, rangeSelect);
      header.append(leftHead, controls);
      calendarHost.appendChild(header);

      if (calendarCollapsed) return;

      const grid = document.createElement("div");
      grid.style.display = "grid";
      grid.style.gridTemplateColumns = "repeat(7, 1fr)";
      grid.style.gap = "3px";
      grid.style.marginTop = "8px";
      for (const day of days) {
        const stat = statsByDay.get(day);
        const btn = document.createElement("button");
        const intensity = Math.min(1, Number(stat?.tokens || 0) / maxTokens);
        const isSelectedDay = day === selectedDay;
        const isInSelectedRange = !!selectedRangeSet?.has(day);
        const isSelected = isSelectedDay || isInSelectedRange;
        const tooltipText = t("heatmap.dayTitleNoCost", "{day} · {sessions} sessions · {tokens} tok", {
          day,
          sessions: stat?.sessionIds?.size || 0,
          tokens: formatCompactNumber(stat?.tokens || 0)
        });
        btn.title = tooltipText;
        btn.setAttribute("aria-label", tooltipText);
        btn.style.height = "14px";
        btn.style.border = "0";
        btn.style.borderRadius = "3px";
        btn.style.cursor = "pointer";
        btn.style.padding = "0";
        const baseBg = intensity > 0
          ? `color-mix(in srgb, var(--accent) ${Math.round(12 + intensity * 42)}%, var(--panel))`
          : "var(--sessions-heatmap-empty, color-mix(in srgb, var(--fg) 7%, transparent))";
        btn.style.background = isSelected
          ? `linear-gradient(color-mix(in srgb, var(--accent) ${isSelectedDay ? 18 : 10}%, transparent), color-mix(in srgb, var(--accent) ${isSelectedDay ? 18 : 10}%, transparent)), ${baseBg}`
          : baseBg;
        btn.style.boxShadow = "none";
        btn.style.opacity = selectedRangeSet && !isInSelectedRange ? "0.62" : "1";
        btn.addEventListener("mouseenter", (ev) => showHeatmapTooltip(tooltipText, ev.clientX, ev.clientY));
        btn.addEventListener("mousemove", (ev) => moveHeatmapTooltip(ev.clientX, ev.clientY));
        btn.addEventListener("mouseleave", hideHeatmapTooltip);
        btn.addEventListener("focus", () => {
          const rect = btn.getBoundingClientRect();
          showHeatmapTooltip(tooltipText, rect.left + rect.width / 2, rect.bottom);
        });
        btn.addEventListener("blur", hideHeatmapTooltip);
        btn.onclick = (ev) => {
          ev.stopPropagation();
          hideHeatmapTooltip();
          setDateFilter(day, 0);
        };
        grid.appendChild(btn);
      }
      calendarHost.appendChild(grid);

      const summary = document.createElement("div");
      summary.style.display = "grid";
      summary.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
      summary.style.gap = "6px";
      summary.style.marginTop = "8px";
      const metric = (label, value) => {
        const box = document.createElement("div");
        box.style.minWidth = "0";
        const v = document.createElement("div");
        v.textContent = value;
        v.style.fontSize = "12px";
        v.style.fontWeight = "600";
        v.style.overflow = "hidden";
        v.style.textOverflow = "ellipsis";
        v.style.whiteSpace = "nowrap";
        const l = document.createElement("div");
        l.textContent = label;
        l.style.fontSize = "10px";
        l.style.color = "var(--files-muted-fg, var(--muted-fg, var(--fg)))";
        box.append(v, l);
        return box;
      };
      summary.append(
        metric(t("heatmap.sessions", "sessions"), String(selected?.sessionIds?.size || 0)),
        metric(t("heatmap.tokens", "tokens"), formatCompactNumber(selected?.tokens || 0)),
        metric(t("heatmap.cache", "cache"), formatCompactNumber(selected?.cacheTokens || 0))
      );
      calendarHost.appendChild(summary);

      const topModels = Array.from(selected?.models?.values?.() || []).sort((a, b) => b.tokens - a.tokens).slice(0, 2);
      const models = document.createElement("div");
      models.style.marginTop = "7px";
      models.style.fontSize = "10px";
      models.style.color = "var(--files-muted-fg, var(--muted-fg, var(--fg)))";
      models.style.whiteSpace = "nowrap";
      models.style.overflow = "hidden";
      models.style.textOverflow = "ellipsis";
      models.textContent = topModels.length
        ? topModels.map(m => `${m.label} ${formatCompactNumber(m.tokens)}`).join(" · ")
        : t("heatmap.noModelUsage", "No model usage on this day");
      calendarHost.appendChild(models);
    };

    const renderAll = () => {
      renderCalendar();
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
        refreshMenuText();
        headerMenu.style.display = headerMenu.style.display === "none" ? "block" : "none";
      },
      dispose: () => {
        if (current === inst) current = null;
        for (const d of disposables) { try { d?.dispose?.(); } catch {} }
        try { container.innerHTML = ""; } catch {}
      }
    };
    current = inst;
    return inst;
  }

  return { mountInto, refreshIfOpen, anchorToCurrentIfOpen, revealSessionIfOpen, toggleMenuIfOpen };
}
