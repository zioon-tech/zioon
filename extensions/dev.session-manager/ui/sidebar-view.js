import { extractObsidianMetadata } from "../../shared/obsidian-metadata.js";
import {
  addCatalogEntry,
  buildTagTree,
  deleteCatalogPaths,
  normalizeTagPath,
  reconcileCatalog,
  renameCatalogPath,
  reorderCatalogEntry,
  setCatalogEntryPinned,
  tagPathSegments
} from "../model/tag-catalog.js";
import { rewriteDocTags } from "../features/tag-mutations.js";
import { loadTagCatalog, saveTagCatalog } from "../storage/tag-catalog.js";
import { createTagTreePanel } from "./tag-tree.js";

export function createSessionsSidebarViewManager(opts) {
  const zion = opts?.zion || window.zion;
  const createSessionsListRenderer = opts?.createSessionsListRenderer;
  const openAncestors = opts?.openAncestors;
  const getIndex = opts?.getIndex;
  const loadMeta = opts?.loadMeta;
  const loadDoc = opts?.loadDoc;
  const getAllSessionDocs = opts?.getAllSessionDocs || (async () => []);
  const writeSessionDoc = opts?.writeSessionDoc || (async () => {});
  const catalogDbName = opts?.dbName || "zion.sessions.db";
  const LS_SELECTED_DAY = "zion.sessions.sidebar.selectedDay";
  const LS_SELECTED_RANGE_DAYS = "zion.sessions.sidebar.selectedRangeDays";
  const LS_DAY_PANEL_COLLAPSED = "zion.sessions.sidebar.dayPanelCollapsed";
  const LS_DAY_PANEL_END_DAY = "zion.sessions.sidebar.dayPanelEndDay";
  const LS_TAG_PANEL_COLLAPSED = "zion.sessions.sidebar.tagPanelCollapsed";
  const LS_TAG_NODE_COLLAPSED = "zion.sessions.sidebar.tagNodeCollapsed";
  const LS_TAG_SPLIT = "zion.sessions.sidebar.tagSplit";
  const LS_TAG_COLUMN_WIDTH = "zion.sessions.sidebar.tagColumnWidth";
  const LS_PRE_SPLIT_WIDTH = "zion.sessions.sidebar.preSplitWidth";
  const TAG_SPLIT_MIN = 140;
  const TAG_SPLIT_MAX = 260;
  const TAG_SPLIT_DEFAULT = 180;
  const TAG_SPLIT_BODY_MIN = 380;
  const TAG_SPLIT_SIDEBAR_TARGET = 440;

  let tagSplitEnabled = (() => {
    try { return localStorage.getItem(LS_TAG_SPLIT) === "1"; } catch { return false; }
  })();
  let tagColumnWidth = (() => {
    try {
      const value = Number(localStorage.getItem(LS_TAG_COLUMN_WIDTH) || "0");
      return Number.isFinite(value) && value >= TAG_SPLIT_MIN && value <= TAG_SPLIT_MAX ? value : TAG_SPLIT_DEFAULT;
    } catch { return TAG_SPLIT_DEFAULT; }
  })();
  let catalogEntries = [];
  let catalogLoaded = false;

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

  function iconHtml(name, size) {
    try {
      const html = window.zionIcons?.htmlFromCodicon?.(name, "", size);
      if (html) return html;
    } catch {}
    const raw = String(name || "").replace(/^codicon-/, "");
    const style = typeof size === "number" ? ` style="font-size:${size}px;"` : "";
    return `<span class="codicon codicon-${raw}" aria-hidden="true"${style}></span>`;
  }

  let current = null;
  let revealRaf = 0;
  let heatmapTooltip = null;
  let selectedTag = "";
  const sessionTagsCache = new Map();
  const collapsedTagNodes = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_TAG_NODE_COLLAPSED) || "[]");
      return new Set(Array.isArray(raw) ? raw.map((tag) => String(tag || "").trim()).filter(Boolean) : []);
    } catch {
      return new Set();
    }
  })();

  function isTagNodeCollapsed(tag) {
    const key = String(tag || "").trim();
    return key ? collapsedTagNodes.has(key) : false;
  }

  function setTagNodeCollapsed(tag, collapsed) {
    const key = String(tag || "").trim();
    if (!key) return;
    if (collapsed) collapsedTagNodes.add(key);
    else collapsedTagNodes.delete(key);
    try { localStorage.setItem(LS_TAG_NODE_COLLAPSED, JSON.stringify(Array.from(collapsedTagNodes))); } catch {}
  }

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

  function dateFromDayKey(day) {
    const match = String(day || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return new Date();
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
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

  function dayFromTimestamp(value) {
    const ts = Number(value || 0);
    if (!Number.isFinite(ts) || ts <= 0) return "";
    return dayKey(ts);
  }

  function sessionActivityDays(session, meta) {
    const days = new Set();
    const updated = dayFromTimestamp(session?.updatedAt) || dayFromTimestamp(meta?.updatedAt);
    const created = dayFromTimestamp(session?.createdAt) || dayFromTimestamp(meta?.createdAt);
    if (updated) days.add(updated);
    if (created) days.add(created);
    if (!days.size && session?.id) days.add(dayKey());
    return days;
  }

  function shiftDay(day, delta) {
    const d = dateFromDayKey(day || dayKey());
    d.setDate(d.getDate() + Number(delta || 0));
    return dayKey(d.getTime());
  }

  function startOfWeek(day) {
    const d = dateFromDayKey(day || dayKey());
    const offset = (d.getDay() + 6) % 7; // Monday-first week columns.
    d.setDate(d.getDate() - offset);
    return dayKey(d.getTime());
  }

  function endOfWeek(day) {
    return shiftDay(startOfWeek(day), 6);
  }

  function recentDays(count, endDay = dayKey()) {
    const n = Math.max(1, Number(count || 1));
    const endDate = dateFromDayKey(endDay || dayKey());
    const days = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(endDate);
      d.setDate(endDate.getDate() - i);
      days.push(dayKey(d.getTime()));
    }
    return days;
  }

  function shortDayLabel(day) {
    const value = String(day || "");
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.slice(5) : value;
  }

  const HEATMAP_CELL_SIZE = 10;
  const HEATMAP_CELL_GAP = 3;
  const HEATMAP_PADDING_X = 16;
  const HEATMAP_MIN_WEEKS = 5;
  const HEATMAP_MAX_WEEKS = 26;

  function heatmapWeeksForWidth(width) {
    const usable = Math.max(0, Number(width || 0) - HEATMAP_PADDING_X);
    const columns = Math.floor((usable + HEATMAP_CELL_GAP) / (HEATMAP_CELL_SIZE + HEATMAP_CELL_GAP));
    return Math.max(HEATMAP_MIN_WEEKS, Math.min(HEATMAP_MAX_WEEKS, columns || HEATMAP_MIN_WEEKS));
  }

  function getUsageRecords() {
    try { return zion?.usage?.getRecords?.() || []; } catch { return []; }
  }

  function getSessionIndex() {
    try { return typeof getIndex === "function" ? (getIndex() || []) : []; } catch { return []; }
  }

  function hashText(text) {
    let h = 2166136261;
    const s = String(text || "");
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `${s.length}:${h >>> 0}`;
  }

  function tagDotColor(tag) {
    const palette = ["#5b7ff5", "#34c759", "#f5a623", "#ff9500", "#ff375f", "#af52de", "#5ac8fa", "#ff5c5c"];
    let h = 0;
    const s = String(tag || "");
    for (let i = 0; i < s.length; i += 1) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
    return palette[Math.abs(h) % palette.length];
  }

  function getSessionTags(sessionId) {
    const sid = String(sessionId || "");
    if (!sid || typeof loadDoc !== "function") return [];
    let text = "";
    try { text = String(loadDoc(sid) || ""); } catch { return []; }
    const cached = sessionTagsCache.get(sid);
    const signature = hashText(text);
    if (cached?.signature === signature) return cached.tags || [];
    const tags = extractObsidianMetadata(text).tags.map((tag) => tag.label).filter(Boolean);
    sessionTagsCache.set(sid, { signature, tags });
    return tags;
  }

  function tagMatchesFilter(tags, filter) {
    const selected = String(filter || "").trim();
    if (!selected) return true;
    return (Array.isArray(tags) ? tags : []).some((tag) => tag === selected || tag.startsWith(`${selected}/`));
  }

  function buildTagTreeForSessionIds(sessionIds) {
    const root = { children: new Map(), sessions: new Set(), tag: "", label: "" };
    const all = new Map();
    for (const sid of sessionIds || []) {
      for (const tag of getSessionTags(sid)) {
        const clean = String(tag || "").replace(/^#/, "").trim();
        if (!clean) continue;
        const parts = clean.split("/").map((part) => part.trim()).filter(Boolean);
        let node = root;
        let path = "";
        root.sessions.add(sid);
        for (const part of parts) {
          path = path ? `${path}/${part}` : part;
          const fullTag = `#${path}`;
          if (!node.children.has(part)) {
            node.children.set(part, {
              label: part,
              tag: fullTag,
              children: new Map(),
              sessions: new Set()
            });
          }
          node = node.children.get(part);
          node.sessions.add(sid);
          all.set(fullTag, node);
        }
      }
    }
    const sortNode = (node) => {
      node.children = new Map(
        Array.from(node.children.values())
          .sort((a, b) => b.sessions.size - a.sessions.size || a.label.localeCompare(b.label))
          .map((child) => {
            sortNode(child);
            return [child.label, child];
          })
      );
    };
    sortNode(root);
    return { root, count: all.size };
  }

  async function ensureCatalogLoaded() {
    if (catalogLoaded) return;
    catalogLoaded = true;
    try {
      catalogEntries = await loadTagCatalog(catalogDbName);
    } catch {
      catalogEntries = [];
    }
    refreshIfOpen();
  }

  async function persistCatalog() {
    try {
      catalogEntries = await saveTagCatalog(catalogDbName, catalogEntries);
    } catch (error) {
      try { console.warn("[session-manager] tag catalog persist failed", error); } catch {}
    }
  }

  function getSessionTagMap() {
    const sessions = getSessionIndex();
    const map = [];
    for (const session of sessions) {
      const sid = String(session?.id || "");
      if (!sid) continue;
      map.push([sid, getSessionTags(sid)]);
    }
    return map;
  }

  function buildSplitTagTree() {
    const sessionTags = getSessionTagMap();
    const scanned = new Set();
    for (const [, tags] of sessionTags) {
      for (const tag of Array.isArray(tags) ? tags : []) {
        const path = String(tag || "").replace(/^#/, "").trim();
        if (path) scanned.add(path);
      }
    }
    const merged = reconcileCatalog(catalogEntries, Array.from(scanned));
    return buildTagTree(merged, sessionTags);
  }

  async function handleTagCreate(path) {
    const { entries, added } = addCatalogEntry(catalogEntries, path);
    if (!added) return true;
    catalogEntries = entries;
    await persistCatalog();
    refreshIfOpen();
    return true;
  }

  async function handleTagRename(fromPath, toPath) {
    const docs = await getAllSessionDocs();
    for (const doc of Array.isArray(docs) ? docs : []) {
      const id = String(doc?.id || "");
      if (!id) continue;
      const { text, changed } = rewriteDocTags(String(doc?.text || ""), { renames: [{ from: fromPath, to: toPath }] });
      if (changed) await writeSessionDoc(id, text);
    }
    const { entries } = renameCatalogPath(catalogEntries, fromPath, toPath);
    catalogEntries = entries;
    await persistCatalog();
    if (selectedTag && (selectedTag === fromPath || selectedTag.startsWith(`${fromPath}/`))) {
      selectedTag = String(toPath || "");
    }
    refreshIfOpen();
    return true;
  }

  async function handleTagDelete(path) {
    const docs = await getAllSessionDocs();
    for (const doc of Array.isArray(docs) ? docs : []) {
      const id = String(doc?.id || "");
      if (!id) continue;
      const { text, changed } = rewriteDocTags(String(doc?.text || ""), { removals: [path] });
      if (changed) await writeSessionDoc(id, text);
    }
    const { entries } = deleteCatalogPaths(catalogEntries, [path]);
    catalogEntries = entries;
    await persistCatalog();
    if (selectedTag && (selectedTag === path || selectedTag.startsWith(`${path}/`))) {
      selectedTag = "";
    }
    refreshIfOpen();
    return true;
  }

  function handleTagReorder(path, referencePath, after) {
    catalogEntries = reorderCatalogEntry(catalogEntries, path, referencePath, { after });
    persistCatalog();
    refreshIfOpen();
  }

  function handleTagPin(path) {
    const target = normalizeTagPath(path);
    if (!target) return;
    const current = catalogEntries.find((entry) => entry.path === target);
    const pinned = !(current && current.pinned === true);
    const promoted = addCatalogEntry(catalogEntries, target).entries;
    catalogEntries = setCatalogEntryPinned(promoted, target, pinned);
    persistCatalog();
    refreshIfOpen();
  }

  async function handleTagReparent(path, newParentPath) {
    const segments = tagPathSegments(path);
    const name = segments[segments.length - 1];
    if (!name) return true;
    const target = [normalizeTagPath(newParentPath), name].filter(Boolean).join("/");
    if (!target || target === path) return true;
    return handleTagRename(path, target);
  }

  function refreshIfOpen(opts = {}) {
    try {
      current?.render?.(opts);
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
    let tagPanelCollapsed = (() => {
      try { return localStorage.getItem(LS_TAG_PANEL_COLLAPSED) === "1"; } catch { return false; }
    })();
    let tagPanelScrollTop = 0;
    let renderedTagsKey = "";
    let windowEndDay = (() => {
      try { return localStorage.getItem(LS_DAY_PANEL_END_DAY) || dayKey(); } catch { return dayKey(); }
    })();
    let renderedHeatmapWeeks = 0;
    let heatmapResizeRaf = 0;

    const tagsHost = document.createElement("div");
    tagsHost.className = "zion-sessions-tags-panel";
    tagsHost.style.flex = "0 0 auto";
    tagsHost.style.margin = "2px 8px 0 8px";
    tagsHost.style.padding = "6px 0 6px 0";
    tagsHost.style.borderTop = "1px solid color-mix(in srgb, var(--border) 72%, transparent)";

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
    listWrap.style.overflowAnchor = "none";
    listWrap.style.padding = "6px 0 6px 8px";
    const list = document.createElement("div");
    listWrap.appendChild(list);

    const disposables = [];
    const disposablesCleanupFns = [];

    const splitRow = document.createElement("div");
    splitRow.className = "zion-sessions-split-row";
    splitRow.style.display = "flex";
    splitRow.style.flex = "1 1 auto";
    splitRow.style.minHeight = "0";
    splitRow.style.overflow = "hidden";

    const tagColumn = document.createElement("div");
    tagColumn.className = "zion-sessions-tag-column";
    tagColumn.style.flex = `0 0 ${tagColumnWidth}px`;
    tagColumn.style.width = `${tagColumnWidth}px`;
    tagColumn.style.minWidth = `${TAG_SPLIT_MIN}px`;
    tagColumn.style.maxWidth = `${TAG_SPLIT_MAX}px`;
    tagColumn.style.overflow = "hidden";
    tagColumn.style.display = "flex";
    tagColumn.style.flexDirection = "column";
    tagColumn.style.minHeight = "0";
    tagColumn.style.borderRight = "1px solid color-mix(in srgb, var(--border) 72%, transparent)";

    const splitDivider = document.createElement("div");
    splitDivider.className = "zion-sessions-split-divider";
    splitDivider.style.flex = "0 0 3px";
    splitDivider.style.cursor = "col-resize";
    splitDivider.style.marginLeft = "-2px";

    const rightColumn = document.createElement("div");
    rightColumn.className = "zion-sessions-right-column";
    rightColumn.style.flex = "1 1 auto";
    rightColumn.style.minWidth = "220px";
    rightColumn.style.display = "flex";
    rightColumn.style.flexDirection = "column";
    rightColumn.style.minHeight = "0";
    rightColumn.style.overflow = "hidden";

    const tagTreePanel = createTagTreePanel({
      t,
      iconHtml,
      dotColor: tagDotColor,
      isCollapsed: isTagNodeCollapsed,
      setCollapsed: setTagNodeCollapsed,
      onSelect: (path) => {
        selectedTag = String(path || "");
        renderAll();
      },
      onCreate: handleTagCreate,
      onRename: handleTagRename,
      onDelete: handleTagDelete,
      onReorder: handleTagReorder,
      onReparent: handleTagReparent,
      onPin: handleTagPin
    });
    tagColumn.appendChild(tagTreePanel.el);

    let splitDragState = null;
    splitDivider.addEventListener("mousedown", (event) => {
      event.preventDefault();
      splitDragState = { startX: event.clientX, startWidth: tagColumnWidth };
    });
    const onSplitDragMove = (event) => {
      if (!splitDragState) return;
      const delta = event.clientX - splitDragState.startX;
      const next = Math.max(TAG_SPLIT_MIN, Math.min(TAG_SPLIT_MAX, splitDragState.startWidth + delta));
      if (next !== tagColumnWidth) {
        tagColumnWidth = next;
        tagColumn.style.flex = `0 0 ${tagColumnWidth}px`;
        tagColumn.style.width = `${tagColumnWidth}px`;
      }
    };
    const onSplitDragEnd = () => {
      if (!splitDragState) return;
      splitDragState = null;
      try { localStorage.setItem(LS_TAG_COLUMN_WIDTH, String(tagColumnWidth)); } catch {}
    };
    window.addEventListener("mousemove", onSplitDragMove);
    window.addEventListener("mouseup", onSplitDragEnd);
    disposablesCleanupFns.push(() => {
      window.removeEventListener("mousemove", onSplitDragMove);
      window.removeEventListener("mouseup", onSplitDragEnd);
    });

    let appliedSplitMode = null;
    const applySplitLayout = () => {
      const bodyWidth = container.clientWidth || 0;
      const wantSplit = tagSplitEnabled && bodyWidth >= TAG_SPLIT_BODY_MIN;
      const mode = wantSplit ? "split" : "stacked";
      if (mode === appliedSplitMode) return;
      appliedSplitMode = mode;
      if (wantSplit) {
        tagsHost.style.display = "none";
        splitRow.appendChild(tagColumn);
        splitRow.appendChild(splitDivider);
        rightColumn.appendChild(listWrap);
        rightColumn.appendChild(calendarHost);
        splitRow.appendChild(rightColumn);
        container.appendChild(splitRow);
      } else {
        if (splitRow.parentElement === container) container.removeChild(splitRow);
        tagsHost.style.display = "";
        container.appendChild(listWrap);
        container.appendChild(tagsHost);
        container.appendChild(calendarHost);
      }
    };

    const setTagSplitEnabled = (next) => {
      tagSplitEnabled = !!next;
      try { localStorage.setItem(LS_TAG_SPLIT, tagSplitEnabled ? "1" : "0"); } catch {}
      const sideBar = zion?.sideBar;
      if (tagSplitEnabled) {
        let current = Number(zion?.state?.get?.("ui.sideBar.width"));
        if (!Number.isFinite(current)) current = 0;
        if (current >= 240) {
          try { localStorage.setItem(LS_PRE_SPLIT_WIDTH, String(current)); } catch {}
        }
        if (sideBar?.setWidth && current < TAG_SPLIT_SIDEBAR_TARGET) {
          sideBar.setWidth(TAG_SPLIT_SIDEBAR_TARGET);
        }
      } else {
        let restore = 0;
        try { restore = Number(localStorage.getItem(LS_PRE_SPLIT_WIDTH) || "0"); } catch {}
        if (sideBar?.setWidth && restore >= 240) sideBar.setWidth(restore);
      }
      appliedSplitMode = null;
      applySplitLayout();
      renderAll();
    };

    const splitResizeObserver = typeof window.ResizeObserver !== "undefined"
      ? new window.ResizeObserver(() => {
          applySplitLayout();
          renderTagTreeIfSplit();
        })
      : null;
    if (splitResizeObserver) {
      splitResizeObserver.observe(container);
      disposables.push({ dispose: () => splitResizeObserver.disconnect() });
    }

    const renderTagTreeIfSplit = () => {
      if (appliedSplitMode !== "split") return;
      try {
        const tree = buildSplitTagTree();
        tagTreePanel.update({
          rows: tree.rows,
          nodeCount: tree.nodeCount,
          selection: selectedTag
        });
      } catch {}
    };

    container.appendChild(listWrap);
    container.appendChild(tagsHost);
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
        const tagFilter = String(selectedTag || "").trim();
        const hasDateFilter = !!(selectedDay || selectedRangeDays);
        if (!hasDateFilter && !tagFilter) return null;
        const filterDays = hasDateFilter ? (selectedRangeDays ? new Set(recentDays(selectedRangeDays)) : new Set([selectedDay])) : null;
        const usageSessionIds = filterDays
          ? new Set(getUsageRecords().filter(r => filterDays.has(r?.day) && r?.sessionId).map(r => String(r.sessionId)))
          : new Set();
        return (node) => {
          const sid = String(node?.id || "");
          if (!sid) return false;
          if (tagFilter && !tagMatchesFilter(getSessionTags(sid), tagFilter)) return false;
          if (!filterDays) return true;
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
    try { disposables.push(zion?.events?.on?.("chat/usageChanged", () => renderAll())); } catch {}
    try { disposables.push(zion?.state?.onDidChange?.("sessions.treeMem", () => renderAll())); } catch {}
    try {
      disposables.push(zion?.state?.onDidChange?.("sessions.indexMem", (index) => {
        innerRender?.syncSessionIndex?.(index);
      }));
    } catch {}
      try { disposables.push(zion?.state?.onDidChange?.("sessions.metaReady", () => renderAll())); } catch {}

    const captureTagsPanelScroll = () => {
      try {
        const body = tagsHost.querySelector(".zion-sessions-tags-body");
        tagPanelScrollTop = Math.max(0, Number(body?.scrollTop) || 0);
      } catch {}
    };

    const renderTagsPanel = () => {
      const sessions = getSessionIndex();
      const tagSignature = sessions
        .map((session) => {
          const sid = String(session?.id || "");
          return `${sid}:${getSessionTags(sid).join("\u0001")}`;
        })
        .join("\u0002");
      const collapsedSignature = Array.from(collapsedTagNodes).sort().join("\u0001");
      const nextTagsKey = `${tagSignature}\u0003${selectedTag}\u0003${tagPanelCollapsed ? "1" : "0"}\u0003${collapsedSignature}`;
      if (nextTagsKey === renderedTagsKey && tagsHost.childElementCount) return;
      renderedTagsKey = nextTagsKey;
      tagsHost.innerHTML = "";
      const tagTree = buildTagTreeForSessionIds(sessions.map((session) => String(session.id || "")).filter(Boolean));
      const header = document.createElement("div");
      header.className = "zion-sessions-section-header zion-sessions-tags-header";
      header.style.display = "flex";
      header.style.alignItems = "center";
      header.style.justifyContent = "space-between";
      header.style.gap = "8px";

      const leftHead = document.createElement("button");
      leftHead.className = "zion-sessions-section-title";
      leftHead.type = "button";
      leftHead.style.display = "inline-flex";
      leftHead.style.alignItems = "center";
      leftHead.style.gap = "4px";
      leftHead.style.minWidth = "0";
      leftHead.style.flex = "1 1 auto";
      leftHead.style.border = "0";
      leftHead.style.background = "transparent";
      leftHead.style.color = "var(--files-muted-fg, var(--muted-fg, var(--fg)))";
      leftHead.style.padding = "0";
      leftHead.style.cursor = "pointer";
      leftHead.title = tagPanelCollapsed ? t("tags.expand", "Expand tags") : t("tags.collapse", "Collapse tags");
      const chevron = document.createElement("span");
      chevron.innerHTML = iconHtml(tagPanelCollapsed ? "chevron-right" : "chevron-down", 12);
      chevron.style.fontSize = "12px";
      const title = document.createElement("span");
      title.textContent = t("tags.title", "Tags");
      title.style.fontSize = "11px";
      title.style.fontWeight = "500";
      title.style.overflow = "hidden";
      title.style.textOverflow = "ellipsis";
      title.style.whiteSpace = "nowrap";
      const count = document.createElement("span");
      count.textContent = String(tagTree.count);
      count.style.fontSize = "10px";
      count.style.opacity = "0.72";
      leftHead.append(chevron, title, count);
      leftHead.onclick = (ev) => {
        ev.stopPropagation();
        tagPanelCollapsed = !tagPanelCollapsed;
        try { localStorage.setItem(LS_TAG_PANEL_COLLAPSED, tagPanelCollapsed ? "1" : "0"); } catch {}
        renderAll();
      };
      header.appendChild(leftHead);

      if (selectedTag) {
        const clear = document.createElement("button");
        clear.className = "zion-sessions-clear-filter";
        clear.type = "button";
        clear.textContent = t("tags.clear", "Clear");
        clear.title = t("tags.clearTitle", "Clear tag filter");
        clear.style.border = "0";
        clear.style.borderRadius = "999px";
        clear.style.padding = "2px 6px";
        clear.style.fontSize = "10px";
        clear.style.cursor = "pointer";
        clear.style.color = "var(--files-muted-fg, var(--muted-fg, var(--fg)))";
        clear.style.background = "color-mix(in srgb, var(--fg) 5%, transparent)";
        clear.onclick = (ev) => {
          ev.stopPropagation();
          selectedTag = "";
          renderAll();
        };
        header.appendChild(clear);
      }

      tagsHost.appendChild(header);
      if (tagPanelCollapsed) return;

      const body = document.createElement("div");
      body.className = "zion-sessions-tags-body";
      body.style.marginTop = "7px";
      body.style.maxHeight = "148px";
      body.style.overflowY = "auto";
      const renderTagNode = (node, depth) => {
        const hasChildren = node.children.size > 0;
        const collapsed = hasChildren && isTagNodeCollapsed(node.tag);
        const row = document.createElement("button");
        row.className = "zion-sessions-tag-row";
        if (node.tag === selectedTag) row.classList.add("is-selected");
        row.type = "button";
        row.title = t("tags.filterTitle", "Filter sessions by {tag}", { tag: node.tag });
        if (hasChildren) row.setAttribute("aria-expanded", collapsed ? "false" : "true");
        row.style.width = "100%";
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "6px";
        row.style.border = "0";
        row.style.borderRadius = "7px";
        row.style.padding = "3px 7px";
        row.style.paddingLeft = `${7 + depth * 14}px`;
        row.style.margin = "1px 0";
        row.style.cursor = "pointer";
        row.style.textAlign = "left";
        row.style.color = node.tag === selectedTag ? "var(--accent)" : "var(--fg)";
        row.style.background = node.tag === selectedTag
          ? "color-mix(in srgb, var(--accent) 14%, transparent)"
          : "transparent";
        row.onmouseenter = () => {
          if (node.tag !== selectedTag) row.style.background = "color-mix(in srgb, var(--fg) 5%, transparent)";
        };
        row.onmouseleave = () => {
          if (node.tag !== selectedTag) row.style.background = "transparent";
        };
        row.onclick = (ev) => {
          ev.stopPropagation();
          selectedTag = selectedTag === node.tag ? "" : node.tag;
          renderAll();
        };
        row.onkeydown = (ev) => {
          if (!hasChildren) return;
          if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
          ev.preventDefault();
          ev.stopPropagation();
          const nextCollapsed = ev.key === "ArrowLeft";
          if (nextCollapsed === collapsed) return;
          setTagNodeCollapsed(node.tag, nextCollapsed);
          renderAll();
        };
        const marker = document.createElement("span");
        marker.className = "zion-sessions-tag-marker";
        if (hasChildren) {
          marker.innerHTML = iconHtml(collapsed ? "chevron-right" : "chevron-down", 10);
          marker.title = collapsed
            ? t("tags.expandNode", "Expand {tag}", { tag: node.tag })
            : t("tags.collapseNode", "Collapse {tag}", { tag: node.tag });
          marker.setAttribute("aria-label", marker.title);
          marker.onclick = (ev) => {
            ev.stopPropagation();
            setTagNodeCollapsed(node.tag, !collapsed);
            renderAll();
          };
        }
        marker.style.width = "10px";
        marker.style.flex = "0 0 auto";
        marker.style.fontSize = "10px";
        marker.style.color = "var(--files-muted-fg, var(--muted-fg, var(--fg)))";
        marker.style.cursor = hasChildren ? "pointer" : "default";
        const dot = document.createElement("span");
        dot.className = "zion-sessions-tag-dot";
        dot.style.background = tagDotColor(node.tag || node.label);
        const label = document.createElement("span");
        label.className = "zion-sessions-tag-label";
        label.textContent = depth === 0 ? `#${node.label}` : node.label;
        label.style.flex = "1 1 auto";
        label.style.minWidth = "0";
        label.style.overflow = "hidden";
        label.style.textOverflow = "ellipsis";
        label.style.whiteSpace = "nowrap";
        label.style.fontSize = "11px";
        const countEl = document.createElement("span");
        countEl.className = "zion-sessions-tag-count";
        countEl.textContent = String(node.sessions.size);
        countEl.style.flex = "0 0 auto";
        countEl.style.fontSize = "10px";
        countEl.style.color = "var(--files-muted-fg, var(--muted-fg, var(--fg)))";
        row.append(marker, dot, label, countEl);
        body.appendChild(row);
        if (!collapsed) {
          for (const child of node.children.values()) {
            renderTagNode(child, depth + 1);
          }
        }
      };
      if (tagTree.count) {
        for (const node of tagTree.root.children.values()) renderTagNode(node, 0);
      } else {
        const empty = document.createElement("span");
        empty.className = "zion-sessions-empty-note";
        empty.textContent = t("tags.empty", "No tags yet");
        empty.style.fontSize = "10px";
        empty.style.color = "var(--files-muted-fg, var(--muted-fg, var(--fg)))";
        empty.style.opacity = "0.72";
        body.appendChild(empty);
      }
      tagsHost.appendChild(body);
      try { body.scrollTop = Math.max(0, tagPanelScrollTop); } catch {}
    };

    const renderCalendar = () => {
      hideHeatmapTooltip();
      calendarHost.innerHTML = "";
      const records = getUsageRecords();
      const sessions = getSessionIndex();
      const days = [];
      const todayKey = dayKey();
      if (windowEndDay > todayKey) windowEndDay = todayKey;
      const heatmapWidth = calendarHost.getBoundingClientRect?.().width || calendarHost.clientWidth || container.clientWidth || 0;
      const heatmapWeeks = heatmapWeeksForWidth(heatmapWidth);
      renderedHeatmapWeeks = heatmapWeeks;
      const visibleDayCount = heatmapWeeks * 7;
      const endWeekStart = startOfWeek(windowEndDay || todayKey);
      const startDay = shiftDay(endWeekStart, -(heatmapWeeks - 1) * 7);
      const endDay = endWeekStart === startOfWeek(todayKey) ? todayKey : endOfWeek(windowEndDay || todayKey);
      for (let day = startDay; day <= endDay; day = shiftDay(day, 1)) {
        days.push(day);
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
        const meta = typeof loadMeta === "function" ? loadMeta(session.id) : null;
        const touched = sessionActivityDays(session, meta);
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
      const maxActivity = Math.max(1, ...Array.from(statsByDay.values()).map((s) => {
        const tokens = Number(s.tokens || 0);
        return tokens > 0 ? tokens : Number(s.sessionIds?.size || 0);
      }));
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
      header.className = "zion-sessions-section-header zion-sessions-heatmap-header";
      header.style.display = "flex";
      header.style.alignItems = "center";
      header.style.justifyContent = "space-between";
      header.style.gap = "8px";
      const leftHead = document.createElement("div");
      leftHead.className = "zion-sessions-section-title";
      leftHead.style.display = "inline-flex";
      leftHead.style.alignItems = "center";
      leftHead.style.gap = "4px";
      leftHead.style.minWidth = "0";
      leftHead.style.flex = "1 1 auto";
      leftHead.style.cursor = "pointer";
      leftHead.title = calendarCollapsed ? t("heatmap.expand", "Expand heatmap") : t("heatmap.collapse", "Collapse heatmap");
      const collapseBtn = document.createElement("button");
      collapseBtn.className = "zion-sessions-section-toggle";
      collapseBtn.innerHTML = iconHtml(calendarCollapsed ? "chevron-right" : "chevron-down", 12);
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
      title.className = "zion-sessions-section-title-text";
      title.textContent = t("heatmap.activity", "活动");
      title.style.fontSize = "11px";
      title.style.fontWeight = "500";
      title.style.color = "var(--files-muted-fg, var(--muted-fg, var(--fg)))";
      title.style.minWidth = "0";
      title.style.overflow = "hidden";
      title.style.textOverflow = "ellipsis";
      title.style.whiteSpace = "nowrap";
      leftHead.append(collapseBtn, title);
      const controls = document.createElement("div");
      controls.className = "zion-sessions-heatmap-controls";
      controls.style.display = "inline-flex";
      controls.style.alignItems = "center";
      controls.style.gap = "4px";
      const navBtn = (iconName, titleText, onClick) => {
        const btn = document.createElement("button");
        btn.className = "zion-sessions-heatmap-nav";
        btn.innerHTML = iconHtml(iconName, 12);
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
      const prevBtn = navBtn("chevron-left", t("heatmap.previousDays", "查看更早日期"), () => {
        windowEndDay = shiftDay(windowEndDay, -visibleDayCount);
        try { localStorage.setItem(LS_DAY_PANEL_END_DAY, windowEndDay); } catch {}
        renderAll();
      });
      const nextBtn = navBtn("chevron-right", t("heatmap.nextDays", "查看之后日期"), () => {
        windowEndDay = shiftDay(windowEndDay, visibleDayCount);
        if (windowEndDay > todayKey) windowEndDay = todayKey;
        try { localStorage.setItem(LS_DAY_PANEL_END_DAY, windowEndDay); } catch {}
        renderAll();
      });
      const rangeSelect = document.createElement("select");
      rangeSelect.className = "zion-sessions-heatmap-range";
      rangeSelect.title = t("heatmap.filterRange", "按日期范围筛选会话");
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
      const addRangeOption = (value, label, titleText) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        if (titleText) option.title = titleText;
        rangeSelect.appendChild(option);
      };
      addRangeOption("all", t("heatmap.all", "全部"));
      addRangeOption("today", t("heatmap.today", "今天"));
      addRangeOption("1", t("heatmap.last1Day", "1 天"));
      addRangeOption("3", t("heatmap.last3Days", "3 天"));
      addRangeOption("7", t("heatmap.last7Days", "7 天"));
      addRangeOption("14", t("heatmap.last14Days", "14 天"));
      addRangeOption("30", t("heatmap.last30Days", "30 天"));
      if (selectedDay && selectedDay !== todayKey && !selectedRangeDays) {
        addRangeOption("day", shortDayLabel(selectedDay), selectedDay);
        rangeSelect.title = selectedDay;
      }
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
      grid.className = "zion-sessions-heatmap-grid";
      grid.style.display = "grid";
      grid.style.setProperty("--zion-heatmap-weeks", String(heatmapWeeks));
      grid.style.marginTop = "8px";
      for (const day of days) {
        const stat = statsByDay.get(day);
        const btn = document.createElement("button");
        const tokens = Number(stat?.tokens || 0);
        const sessionCount = Number(stat?.sessionIds?.size || 0);
        const activityValue = tokens > 0 ? tokens : sessionCount;
        const intensity = activityValue > 0 ? Math.max(0.38, Math.min(1, activityValue / maxActivity)) : 0;
        const isSelectedDay = day === selectedDay;
        const isInSelectedRange = !!selectedRangeSet?.has(day);
        const isSelected = isSelectedDay || isInSelectedRange;
        btn.className = "zion-sessions-heatmap-day";
        if (isSelected) btn.classList.add("is-selected");
        if (selectedRangeSet && !isInSelectedRange) btn.classList.add("is-dimmed");
        const tooltipText = t("heatmap.dayTitleNoCost", "{day} · {sessions} sessions · {tokens} tok", {
          day,
          sessions: stat?.sessionIds?.size || 0,
          tokens: formatCompactNumber(stat?.tokens || 0)
        });
        btn.title = tooltipText;
        btn.setAttribute("aria-label", tooltipText);
        btn.style.border = "0";
        btn.style.cursor = "pointer";
        btn.style.padding = "0";
        const baseBg = intensity > 0
          ? `color-mix(in srgb, var(--accent) ${Math.round(18 + intensity * 58)}%, var(--panel))`
          : "var(--sessions-heatmap-empty, color-mix(in srgb, var(--fg) 7%, transparent))";
        btn.style.setProperty("--zion-heatmap-day-bg", baseBg);
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
      summary.className = "zion-sessions-heatmap-stats";
      summary.style.display = "grid";
      summary.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
      summary.style.gap = "6px";
      summary.style.marginTop = "8px";
      const metric = (label, value) => {
        const box = document.createElement("div");
        box.className = "zion-sessions-heatmap-stat";
        box.style.minWidth = "0";
        const v = document.createElement("div");
        v.className = "zion-sessions-heatmap-stat-value";
        v.textContent = value;
        v.style.fontSize = "12px";
        v.style.fontWeight = "600";
        v.style.overflow = "hidden";
        v.style.textOverflow = "ellipsis";
        v.style.whiteSpace = "nowrap";
        const l = document.createElement("div");
        l.className = "zion-sessions-heatmap-stat-label";
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
      models.className = "zion-sessions-heatmap-models";
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

    const renderAll = (opts = {}) => {
      const preserveListScroll = opts?.preserveListScroll !== false;
      const listScrollTop = preserveListScroll ? Math.max(0, Number(listWrap.scrollTop) || 0) : null;
      applySplitLayout();
      if (!opts?.listOnly) {
        captureTagsPanelScroll();
        if (appliedSplitMode !== "split") renderTagsPanel();
        renderTagTreeIfSplit();
        renderCalendar();
      }
      innerRender();
      if (preserveListScroll && listScrollTop != null) {
        try { listWrap.scrollTop = listScrollTop; } catch {}
        requestAnimationFrame(() => {
          try { listWrap.scrollTop = listScrollTop; } catch {}
        });
      }
    };

    if (typeof window.ResizeObserver !== "undefined") {
      const heatmapResizeObserver = new window.ResizeObserver(() => {
        if (calendarCollapsed) return;
        const width = calendarHost.getBoundingClientRect?.().width || calendarHost.clientWidth || container.clientWidth || 0;
        const nextWeeks = heatmapWeeksForWidth(width);
        if (!renderedHeatmapWeeks || nextWeeks === renderedHeatmapWeeks) return;
        if (heatmapResizeRaf) window.cancelAnimationFrame(heatmapResizeRaf);
        heatmapResizeRaf = window.requestAnimationFrame(() => {
          heatmapResizeRaf = 0;
          renderCalendar();
        });
      });
      heatmapResizeObserver.observe(calendarHost);
      disposables.push({ dispose: () => heatmapResizeObserver.disconnect() });
    }

    renderAll();
    try { listWrap.scrollTop = prevScroll; } catch {}

    const anchorToCurrent = () => {
      try {
        const cid = zion?.state?.get("sessions.currentId");
        if (!cid) return;
        const mountedRow = innerRender?.syncCurrentSession?.(cid);
        if (mountedRow && listWrap) {
          if (!isRowFullyVisible(mountedRow)) mountedRow.scrollIntoView({ block: "center" });
          const prev = mountedRow.style.background;
          mountedRow.style.background = "var(--border)";
          setTimeout(() => { mountedRow.style.background = prev; }, 600);
          return;
        }
        try { openAncestors?.(cid); } catch {}
        renderAll({ preserveListScroll: false });
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
      const mountedRow = innerRender?.syncCurrentSession?.(sid);
      if (mountedRow && listWrap) {
        if (!isRowFullyVisible(mountedRow)) mountedRow.scrollIntoView({ block });
        if (flash) {
          const prev = mountedRow.style.background;
          mountedRow.style.background = "var(--border)";
          setTimeout(() => { mountedRow.style.background = prev; }, 450);
        }
        return;
      }
      try { if (openParents) openAncestors?.(sid); } catch {}
      void clearSearch;
      renderAll({ preserveListScroll: false });
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
      toggleTagSplit: () => {
        setTagSplitEnabled(!tagSplitEnabled);
        return tagSplitEnabled;
      },
      isTagSplitEnabled: () => !!tagSplitEnabled,
      dispose: () => {
        if (current === inst) current = null;
          try { innerRender?.dispose?.(); } catch {}
        if (heatmapResizeRaf) {
          try { window.cancelAnimationFrame(heatmapResizeRaf); } catch {}
          heatmapResizeRaf = 0;
        }
        for (const fn of disposablesCleanupFns) { try { fn(); } catch {} }
        try { tagTreePanel.dispose?.(); } catch {}
        for (const d of disposables) { try { d?.dispose?.(); } catch {} }
        try { container.innerHTML = ""; } catch {}
      }
    };
    current = inst;
    ensureCatalogLoaded();
    return inst;
  }

  return { mountInto, refreshIfOpen, anchorToCurrentIfOpen, revealSessionIfOpen, toggleMenuIfOpen, toggleTagSplitIfOpen: () => current?.toggleTagSplit?.(), isTagSplitEnabled: () => !!current?.isTagSplitEnabled?.() };
}
