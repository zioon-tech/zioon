import {
  getSessionRunIndicatorStatus,
  markSessionRunViewed
} from "../features/run-state.js";

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
    return String(fallback || "").replace(/\{(\w+)\}/g, (match, name) => {
      const value = values?.[name];
      return value === undefined || value === null ? match : String(value);
    });
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

  function sessionIconName(sessionId) {
    const sid = String(sessionId || "");
    if (sid.startsWith("comment:")) return "comment-discussion";
    if (sid.startsWith("agent-task:")) return "hubot";
    return "";
  }

  const COMMENTS_THREADS_KEY = "zion.comments.threads.v1";
  const AGENTS_TASKS_KEY = "zion.agents.tasks.v1";
  const SESSION_CHILDREN_COLLAPSED_KEY = "zion.sessions.relatedChildrenCollapsed.v1";

  function readJsonArray(key) {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function compactText(value, max = 64) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
  }

  function formatSessionCardTime(timestamp) {
    const value = Number(timestamp || 0);
    if (!Number.isFinite(value) || value <= 0) return "";
    const current = typeof now === "function" ? Number(now()) : Date.now();
    const elapsed = Math.max(0, current - value);
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (elapsed < minute) return t("ui.justNow", "Just now");
    if (elapsed < hour) {
      return t("ui.minutesAgo", "{count} min ago", {
        count: Math.max(1, Math.floor(elapsed / minute))
      });
    }
    if (elapsed < day) {
      return t("ui.hoursAgo", "{count} hr ago", {
        count: Math.max(1, Math.floor(elapsed / hour))
      });
    }
    if (elapsed < 7 * day) {
      return t("ui.daysAgo", "{count} days ago", {
        count: Math.max(1, Math.floor(elapsed / day))
      });
    }
    try {
      return new Date(value).toLocaleDateString();
    } catch {
      return "";
    }
  }

  function getThreadSessionId(thread) {
    if (thread?.threadSessionId) return String(thread.threadSessionId);
    return thread?.id ? `comment:${thread.id}` : "";
  }

  function getTaskSessionId(task) {
    if (task?.taskSessionId) return String(task.taskSessionId);
    return task?.id ? `agent-task:${task.id}` : "";
  }

  function readCollapsedSessionChildren() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SESSION_CHILDREN_COLLAPSED_KEY) || "[]");
      return new Set(Array.isArray(parsed) ? parsed.map((id) => String(id || "").trim()).filter(Boolean) : []);
    } catch {
      return new Set();
    }
  }

  function writeCollapsedSessionChildren(values) {
    try {
      localStorage.setItem(SESSION_CHILDREN_COLLAPSED_KEY, JSON.stringify(Array.from(values || [])));
    } catch {}
  }

  function getRelatedSessionChildren() {
    const map = new Map();
    const add = (sessionId, child) => {
      const sid = String(sessionId || "").trim();
      if (!sid || sid === "global") return;
      const list = map.get(sid) || [];
      list.push(child);
      map.set(sid, list);
    };

    for (const thread of readJsonArray(COMMENTS_THREADS_KEY)) {
      const sourceSessionId = String(thread?.parentSessionId || thread?.sessionId || "").trim();
      const id = String(thread?.id || "").trim();
      const childSessionId = getThreadSessionId(thread);
      if (!sourceSessionId || !id || !childSessionId) continue;
      const line = Number.isFinite(Number(thread?.startLine)) ? `L${Number(thread.startLine) + 1}` : "";
      const status = thread?.resolved ? t("ui.commentResolved", "已解决") : t("ui.commentOpen", "未解决");
      add(sourceSessionId, {
        type: "comment",
        id,
        sessionId: childSessionId,
          title: compactText(thread?.title || thread?.summary || thread?.quote || thread?.anchorText || id, 72) || t("ui.comment", "评论"),
        meta: [t("ui.comment", "评论"), status, line].filter(Boolean).join(" · "),
        order: Number.isFinite(Number(thread?.from)) ? Number(thread.from) : Number.MAX_SAFE_INTEGER,
          updatedAt: Number(thread?.titleUpdatedAt || thread?.summaryUpdatedAt || thread?.updatedAt || thread?.createdAt || 0)
      });
    }

    const taskSource = (() => {
      try {
        const stateTasks = window.zion?.state?.get?.("agents.tasks");
        if (Array.isArray(stateTasks)) return stateTasks;
      } catch {}
      return readJsonArray(AGENTS_TASKS_KEY);
    })();
    for (const task of taskSource) {
      const sourceSessionId = String(task?.sessionId || "").trim();
      const id = String(task?.id || "").trim();
      const childSessionId = getTaskSessionId(task);
      if (!sourceSessionId || sourceSessionId.startsWith("scratch:") || !id || !childSessionId) continue;
      const line = Number.isFinite(Number(task?.lineFrom)) ? `L${Number(task.lineFrom) + 1}` : "";
      const status = String(task?.status || "idle");
      add(sourceSessionId, {
        type: "agent",
        id,
        sessionId: childSessionId,
        title: compactText(task?.title || task?.anchorText || task?.prompt || id, 72) || t("ui.agentTask", "子 Agent"),
        meta: [t("ui.agentTask", "子 Agent"), status, line].filter(Boolean).join(" · "),
        order: Number.isFinite(Number(task?.from)) ? Number(task.from) : (Number.isFinite(Number(task?.lineFrom)) ? Number(task.lineFrom) * 1000000 : Number.MAX_SAFE_INTEGER),
        updatedAt: Number(task?.updatedAt || task?.createdAt || 0)
      });
    }

    for (const [sid, children] of map) {
      children.sort((a, b) => {
        const byOrder = Number(a.order) - Number(b.order);
        if (byOrder) return byOrder;
        const byUpdated = Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
        if (byUpdated) return byUpdated;
        return String(a.id || "").localeCompare(String(b.id || ""));
      });
      map.set(sid, children);
    }
    return map;
  }

  return function createSessionsListRenderer({
    listEl,
    hostElement,
    getQuery,
    getSort,
    getSessionFilter,
    getViewMode,
    getSessionTagRecords,
    onSwitchSession,
    onAfterChange,
    viewId = null
  }) {
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

    const getCardTags = (sessionId) => {
      const byPath = new Map();
      let records = [];
      try {
        records = typeof getSessionTagRecords === "function"
          ? (getSessionTagRecords(sessionId) || [])
          : [];
      } catch {}
      for (const record of records) {
        const path = String(record?.path || "").replace(/^#/, "").trim();
        if (!path) continue;
        const automatic = String(record?.sourceId || "") !== "document";
        const existing = byPath.get(path);
        if (!existing) {
          byPath.set(path, {
            path,
            automatic,
            sourceLabel: String(record?.sourceLabel || "").trim()
          });
        } else if (!automatic) {
          existing.automatic = false;
        }
      }
      return Array.from(byPath.values()).slice(0, 2);
    };

    const syncCardMetadata = (row, meta) => {
      const preview = row?.querySelector?.(".zion-session-card-preview");
      if (preview) {
        preview.textContent = String(meta?.documentPreview || "");
        preview.hidden = !preview.textContent;
      }
      const time = row?.querySelector?.(".zion-session-card-time");
      if (time) time.textContent = formatSessionCardTime(meta?.updatedAt);
    };

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
        const handled = window.zion?.commands?.executeCommand?.("zion.sessions.markViewed", id);
        if (handled !== undefined) return;
      } catch {}
      markSessionRunViewed(window.zion, id);
    };

      const getRunStatus = (sessionId) => {
        const sid = String(sessionId || "").trim();
        if (!sid) return "";
        try {
          const rs = window.zion?.state?.get?.(`chat.runs.${sid}`) || null;
          return getSessionRunIndicatorStatus(rs);
        } catch {}
        return "";
      };

      const runStatusTitle = (status) => {
        if (status === "streaming") return t("ui.modelGenerating", "Model generating…");
        if (status === "ready") return t("ui.answerReady", "Answer ready");
        if (status === "error") return t("ui.answerFailed", "Answer failed");
        if (status === "aborted") return t("ui.answerStopped", "Answer stopped");
        return "";
      };

      const updateStatusBadge = (badge, sessionId) => {
        if (!badge) return;
        const sid = String(sessionId || badge.dataset.sessionId || "").trim();
        const status = getRunStatus(sid);
        badge.dataset.sessionId = sid;
        badge.className = `zion-session-status-badge${status ? ` ${status}` : " idle"}`;
        badge.hidden = !status;
        badge.textContent = "●";
        const title = runStatusTitle(status);
        badge.title = title;
        if (title) badge.setAttribute("aria-label", title);
        else badge.removeAttribute("aria-label");
      };

      const createStatusBadge = (sessionId, extraClass = "") => {
        const badge = document.createElement("span");
        badge.className = ["zion-session-status-badge", extraClass].filter(Boolean).join(" ");
        badge.dataset.sessionId = String(sessionId || "");
        updateStatusBadge(badge, sessionId);
        return badge;
      };

      const statusRunDisposables = new Map();
      const disposeStatusSubscriptions = () => {
        for (const disposable of statusRunDisposables.values()) {
          try { disposable?.dispose?.(); } catch {}
        }
        statusRunDisposables.clear();
      };

      const updateVisibleStatusBadges = () => {
        try {
          if (!listEl?.isConnected) {
            disposeStatusSubscriptions();
            return;
          }
          listEl.querySelectorAll(".zion-session-status-badge[data-session-id]").forEach((badge) => {
            updateStatusBadge(badge, badge.dataset.sessionId);
          });
        } catch {}
      };

      const syncStatusSubscriptions = (sessionIds) => {
        const nextIds = new Set(Array.from(sessionIds || []).map((id) => String(id || "").trim()).filter(Boolean));
        for (const [sid, disposable] of statusRunDisposables.entries()) {
          if (!nextIds.has(sid)) {
            try { disposable?.dispose?.(); } catch {}
            statusRunDisposables.delete(sid);
          }
        }
        for (const sid of nextIds) {
          if (statusRunDisposables.has(sid)) continue;
          try {
            const disposable = window.zion?.state?.onDidChange?.(`chat.runs.${sid}`, updateVisibleStatusBadges);
            if (disposable) statusRunDisposables.set(sid, disposable);
          } catch {}
        }
      };

      const updateActiveCommentChildRows = () => {
        try {
          const activeCommentId = String(window.zion?.state?.get?.("comments.activeThreadId") || "");
            const currentId = String(getEffectiveCurrentSessionId() || "");
          listEl.querySelectorAll(".zion-session-child-row.is-comment[data-child-id]").forEach((row) => {
              const isActive = (activeCommentId && row.dataset.childId === activeCommentId)
                || (!!currentId && row.dataset.sessionId === currentId);
            row.classList.toggle("is-current", !!isActive);
          });
        } catch {}
      };

      let activeCommentDisposable = null;
      try {
        activeCommentDisposable = window.zion?.state?.onDidChange?.("comments.activeThreadId", updateActiveCommentChildRows) || null;
      } catch {
        activeCommentDisposable = null;
      }
        try { window.addEventListener("zion:comments-active-changed", updateActiveCommentChildRows); } catch {}

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
      const cardView = getViewMode?.() === "card";
      listEl.classList.toggle("is-card-view", cardView);
      listEl.closest(".zion-sessions-list")?.classList.toggle("is-card-view", cardView);

      try {
        document.querySelectorAll(".session-row-menu[data-zion-session-menu-portal='1']").forEach((menu) => menu.remove());
      } catch {}
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
        const relatedChildren = getRelatedSessionChildren();
        const collapsedSessionChildren = readCollapsedSessionChildren();
        const visibleOrder = [];
        const visibleStatusSessionIds = new Set();
      let rootContextMenu = null;
      let selectionContextMenu = null;

      const hideOpenMenus = () => {
        try {
          Array.from(listEl.querySelectorAll(".session-row-menu")).forEach((m) => {
            m.style.display = "none";
          });
          Array.from(document.querySelectorAll(".session-row-menu[data-zion-session-menu-portal='1']")).forEach((m) => {
            m.style.display = "none";
          });
        } catch {}
      };

      const portalMenu = (menu) => {
        try {
          if (menu.parentElement !== document.body) {
            menu.dataset.zionSessionMenuPortal = "1";
            document.body.appendChild(menu);
          }
        } catch {}
      };

      const installMenuAutoClose = (menu) => {
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

      const showAnchoredMenu = (menu, anchor) => {
        hideOpenMenus();
        portalMenu(menu);
        menu.style.position = "fixed";
        menu.style.right = "auto";
        menu.style.left = "auto";
        menu.style.top = "auto";
        menu.style.visibility = "hidden";
        menu.style.display = "block";
        requestAnimationFrame(() => {
          try {
            const anchorRect = anchor?.getBoundingClientRect?.();
            const menuRect = menu.getBoundingClientRect();
            const pad = 8;
            const baseLeft = anchorRect ? anchorRect.right - menuRect.width : window.innerWidth - menuRect.width - pad;
            const baseTop = anchorRect ? anchorRect.bottom + 4 : pad;
            const left = Math.max(pad, Math.min(baseLeft, window.innerWidth - menuRect.width - pad));
            const top = Math.max(pad, Math.min(baseTop, window.innerHeight - menuRect.height - pad));
            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
            menu.style.visibility = "visible";
          } catch {
            menu.style.visibility = "visible";
          }
        });
        installMenuAutoClose(menu);
      };

      const showContextMenu = (menu, ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        hideOpenMenus();
        portalMenu(menu);
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
        installMenuAutoClose(menu);
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

      const relatedChildMatchesQuery = (sessionId) => {
        if (!query) return false;
        const children = relatedChildren.get(String(sessionId || "")) || [];
        return children.some((child) => {
          const text = `${child.title || ""} ${child.meta || ""}`.toLowerCase();
          return text.includes(query);
        });
      };

        const isSessionChildrenCollapsed = (sessionId) => {
          const sid = String(sessionId || "").trim();
          return sid ? collapsedSessionChildren.has(sid) : false;
        };

        const setSessionChildrenCollapsed = (sessionId, collapsed) => {
          const sid = String(sessionId || "").trim();
          if (!sid) return;
          if (collapsed) collapsedSessionChildren.add(sid);
          else collapsedSessionChildren.delete(sid);
          writeCollapsedSessionChildren(collapsedSessionChildren);
        };

      const renderRelatedChild = (child, depth) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = `zion-session-row zion-session-child-row is-${child.type}`;
        row.dataset.depth = String(depth);
          row.dataset.sessionId = String(child.sessionId || "");
          row.dataset.childId = String(child.id || "");
          if (child.sessionId) visibleStatusSessionIds.add(String(child.sessionId));
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.justifyContent = "space-between";
        row.style.gap = "8px";
        row.style.padding = "5px 6px 5px 10px";
        row.style.paddingLeft = `${10 + (depth * 12)}px`;
        row.style.width = "100%";
        row.style.border = "none";
        row.style.background = "transparent";
        row.style.textAlign = "left";
        row.style.cursor = "pointer";
        row.style.position = "relative";
        row.style.whiteSpace = "nowrap";
        row.title = [child.title, child.meta].filter(Boolean).join(" · ");

        const currentId = getEffectiveCurrentSessionId();
        if (child.sessionId && String(child.sessionId) === String(currentId || "")) row.classList.add("is-current");
        try {
          const activeCommentId = String(window.zion?.state?.get?.("comments.activeThreadId") || "");
          if (child.type === "comment" && activeCommentId && activeCommentId === String(child.id || "")) {
            row.classList.add("is-current");
          }
        } catch {}

        const icon = document.createElement("span");
        icon.className = "zion-session-icon zion-session-child-icon";
        icon.innerHTML = iconHtml(child.type === "comment" ? "comment-discussion" : "hubot", 13);

        const main = document.createElement("span");
        main.className = "zion-session-child-main";
        main.style.display = "flex";
        main.style.alignItems = "center";
        main.style.minWidth = "0";
        main.style.flex = "1 1 auto";

        const title = document.createElement("span");
        title.className = "zion-session-name zion-session-child-title";
        title.textContent = child.title || (child.type === "comment" ? t("ui.comment", "评论") : t("ui.agentTask", "子 Agent"));

          main.append(title);
          const statusBadge = createStatusBadge(child.sessionId, "zion-session-child-status");
          row.append(icon, main, statusBadge);
        row.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          clearSelection();
          setLastSelectedId("");
            if (child.type === "comment") {
              window.zion?.commands?.executeCommand?.("comments.revealThread", child.id, { focus: false, smooth: false });
          } else {
            window.zion?.commands?.executeCommand?.("agents.revealTask", child.id, { focus: false });
          }
          markSessionViewed(child.sessionId);
          render();
        };
        row.onkeydown = (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          row.click();
        };
        listEl.appendChild(row);
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
        if (target.closest(".zion-sessions-tag-column")) return false;
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
          row.style.padding = "6px 6px 6px 10px";
        row.style.gap = "8px";
        row.style.borderRadius = "8px";
        row.style.transition = "background 120ms ease";
        row.style.position = "relative";
        row.className = "zion-session-row is-folder";
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
          labelWrap.style.paddingRight = "4px";

        const chevron = document.createElement("span");
        chevron.className = "zion-session-chevron";
        chevron.innerHTML = iconHtml(isFolderOpen(folder.id) ? "chevron-down" : "chevron-right", 14);
        chevron.style.opacity = "0.8";

        const folderIcon = document.createElement("span");
        folderIcon.className = "zion-session-icon zion-session-folder-icon";
        folderIcon.innerHTML = iconHtml(isFolderOpen(folder.id) ? "folder-opened" : "folder", 13);

        const ttl = document.createElement("span");
        ttl.className = "zion-session-folder-name";
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
        labelWrap.appendChild(folderIcon);
        labelWrap.appendChild(ttl);

        const btns = document.createElement("div");
        btns.style.display = "flex";
        btns.style.gap = "4px";
        btns.style.alignItems = "center";
        btns.style.position = "absolute";
          btns.style.right = "4px";
        btns.style.top = "50%";
        btns.style.transform = "translateY(-50%)";

        const bNewSession = mkIconBtn(
          iconHtml("add", 14),
          t("ui.newSessionHere", "New session here"),
          (ev) => {
            ev.stopPropagation();
            window.zion.commands.executeCommand("zion.sessions.new", { parentId: folder.id });
            if (typeof onAfterChange === "function") onAfterChange();
            render();
          }
        );
        const bNewFolder = mkIconBtn(
          iconHtml("new-folder", 14),
          t("ui.newFolderHere", "New folder here"),
          (ev) => {
            ev.stopPropagation();
            createFolderInline(folder.id);
          }
        );

        const bMore = mkIconBtn(
          iconHtml("ellipsis", 16),
          t("ui.folderActions", "Folder actions"),
          (ev) => {
            ev.stopPropagation();
            const isOpen = folderMenu.style.display === "block";
            if (isOpen) {
              folderMenu.style.display = "none";
            } else {
              showAnchoredMenu(folderMenu, ev.currentTarget);
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
            const reserve = (btns.offsetWidth || 0) + 4;
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
            const reserve = (btns.offsetWidth || 0) + 4;
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

          const getSessionDisplayTitle = (node) => {
            if (!node || node.type !== "session") return String(node?.title || "").trim();
            const meta = loadMeta(node.id);
            return String(meta?.title || node.title || node.id || "").trim() || String(node.id || "");
          };
          const matchNode = (n) => getSessionDisplayTitle(n).toLowerCase().includes(query);
          const filterTree = (nodes) => {
            const out = [];
            for (const n of nodes) {
              if (n.type === "folder") {
                const sub = filterTree(n.children || []);
                if (matchNode(n) || sub.length > 0) out.push({ ...n, children: sub });
              } else if (n.type === "session") {
                if ((matchNode(n) || relatedChildMatchesQuery(n.id)) && matchesSessionFilter(n)) out.push(n);
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
              }
              return getSessionDisplayTitle(a).localeCompare(getSessionDisplayTitle(b));
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
                srow.style.padding = "6px 6px 6px 10px";
              srow.style.gap = "8px";
              srow.style.borderRadius = "8px";
              srow.style.transition = "background 120ms ease";
              srow.tabIndex = 0;
              srow.style.position = "relative";
              srow.className = "zion-session-row is-session";
              if (cardView) srow.classList.add("is-card-layout");
              srow.style.whiteSpace = "nowrap";
              srow.style.paddingLeft = `${10 + ((depth + 1) * 12)}px`;
              srow.dataset.depth = String(depth + 1);
              srow.dataset.sessionId = String(ch.id || "");
              visibleOrder.push({ id: ch.id, type: "session" });
                if (ch.id) visibleStatusSessionIds.add(String(ch.id));

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
                  const label = count2 > 1 ? `移动 ${count2} 项` : `会话: ${truncate(getSessionDisplayTitle(ch), 16)}`;
                  setSmallDragImage(ev, label);
                } catch {}
              });

              const labelWrap2 = document.createElement("div");
              labelWrap2.style.display = "flex";
              labelWrap2.style.flexDirection = "column";
              labelWrap2.style.flex = "1 1 auto";
              labelWrap2.style.minWidth = "0";
                labelWrap2.style.paddingRight = "4px";

              const titleLine = document.createElement("span");
              titleLine.className = "zion-session-title-line";
              titleLine.style.fontSize = "12px";
              titleLine.style.display = "flex";
              titleLine.style.alignItems = "center";
              titleLine.style.gap = "6px";
              titleLine.style.fontWeight = "400";
              titleLine.style.flex = "1 1 auto";
              titleLine.style.minWidth = "0";

              const curId = getEffectiveCurrentSessionId();
              if (ch.id === curId) srow.classList.add("is-current");
              if (isSelected(ch.id)) srow.classList.add("is-selected");
              const sessionChildren = relatedChildren.get(String(ch.id || "")) || [];
              const hasSessionChildren = sessionChildren.length > 0;
              const childrenCollapsed = hasSessionChildren && isSessionChildrenCollapsed(ch.id);
              if (hasSessionChildren) {
                srow.setAttribute("aria-expanded", childrenCollapsed ? "false" : "true");
                const childToggle = document.createElement("button");
                childToggle.type = "button";
                childToggle.className = "zion-session-child-toggle";
                childToggle.innerHTML = iconHtml(childrenCollapsed ? "chevron-right" : "chevron-down", 11);
                childToggle.title = childrenCollapsed
                  ? t("ui.expandChildren", "展开评论和子 Agent")
                  : t("ui.collapseChildren", "折叠评论和子 Agent");
                childToggle.setAttribute("aria-label", childToggle.title);
                childToggle.onclick = (ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  setSessionChildrenCollapsed(ch.id, !childrenCollapsed);
                  render();
                };
                titleLine.appendChild(childToggle);
              }

              const meta = loadMeta(ch.id);
              const displayTitle = getSessionDisplayTitle(ch);

              const sessionIconNameValue = sessionIconName(ch.id);
              if (sessionIconNameValue) {
                const sessionIcon = document.createElement("span");
                sessionIcon.className = "zion-session-icon";
                sessionIcon.innerHTML = iconHtml(sessionIconNameValue, 13);
                titleLine.appendChild(sessionIcon);
              }

              const ttl2 = document.createElement("span");
              ttl2.className = "zion-session-name";
              ttl2.textContent = displayTitle;
              ttl2.style.flex = "1 1 auto";
              ttl2.style.minWidth = "0";
              ttl2.style.whiteSpace = "nowrap";
              ttl2.style.overflow = "hidden";
              ttl2.style.textOverflow = "ellipsis";
              titleLine.appendChild(ttl2);

              srow.title = `${t("ui.updated", "Updated")}: ${fmtTime(meta?.updatedAt || now())} · ${t("ui.chars", "{count} chars", { count: meta?.size || 0 })}`;

              labelWrap2.append(titleLine);
              if (cardView) {
                const previewText = String(meta?.documentPreview || "").trim();
                if (previewText) {
                  const preview = document.createElement("div");
                  preview.className = "zion-session-card-preview";
                  preview.textContent = previewText;
                  labelWrap2.appendChild(preview);
                }

                const tags = getCardTags(ch.id);
                const updated = formatSessionCardTime(meta?.updatedAt);
                if (tags.length || updated) {
                  const cardMeta = document.createElement("div");
                  cardMeta.className = "zion-session-card-meta";
                  const tagsWrap = document.createElement("div");
                  tagsWrap.className = "zion-session-card-tags";
                  for (const tag of tags) {
                    const tagEl = document.createElement("span");
                    tagEl.className = "zion-session-card-tag";
                    if (tag.automatic) tagEl.classList.add("is-automatic");
                    tagEl.textContent = `#${tag.path}`;
                    if (tag.sourceLabel) tagEl.title = tag.sourceLabel;
                    tagsWrap.appendChild(tagEl);
                  }
                  const time = document.createElement("span");
                  time.className = "zion-session-card-time";
                  time.textContent = updated;
                  cardMeta.append(tagsWrap, time);
                  labelWrap2.appendChild(cardMeta);
                }
              }

              const rightWrap = document.createElement("div");
              rightWrap.style.display = "flex";
              rightWrap.style.gap = "4px";
              rightWrap.style.alignItems = "center";
              rightWrap.style.position = "absolute";
              rightWrap.style.right = "4px";
              rightWrap.style.top = "50%";
              rightWrap.style.transform = "translateY(-50%)";

              const sMenu = mkRowMenu(ch, srow);
              sMenu.className = "session-row-menu";
              srow.appendChild(sMenu);
              srow.addEventListener("click", () => { sMenu.style.display = "none"; });

              const confirmSession = isConfirming(ch.id, "session");

              const bMore2 = mkIconBtn(
                iconHtml("ellipsis", 16),
                t("ui.moreActions", "More actions"),
                (ev) => {
                  ev.stopPropagation();
                  const isOpen = sMenu.style.display === "block";
                  if (isOpen) {
                    sMenu.style.display = "none";
                  } else {
                    showAnchoredMenu(sMenu, ev.currentTarget);
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

                const statusBadge = createStatusBadge(ch.id);
                try {
                  titleLine.style.maskImage = "linear-gradient(to right, black calc(100% - 44px), transparent 100%)";
                  titleLine.style.webkitMaskImage = "linear-gradient(to right, black calc(100% - 44px), transparent 100%)";
                } catch {}

              if (!confirmSession) {
                rightWrap.appendChild(bMore2);
                  rightWrap.appendChild(statusBadge);
              }

              if (!confirmSession) rightWrap.style.pointerEvents = "none";
              srow.addEventListener("mouseenter", () => {
                if (confirmSession) return;
                  const reserve = (rightWrap.offsetWidth || 0) + 4;
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
                  const reserve = (rightWrap.offsetWidth || 0) + 4;
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
                  if (hasSessionChildren && (ev.key === "ArrowLeft" || ev.key === "ArrowRight")) {
                    ev.preventDefault();
                    const nextCollapsed = ev.key === "ArrowLeft";
                    if (nextCollapsed !== childrenCollapsed) {
                      setSessionChildrenCollapsed(ch.id, nextCollapsed);
                      render();
                    }
                    return;
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
                if (hasSessionChildren && (!childrenCollapsed || query)) {
                  for (const child of sessionChildren) {
                    renderRelatedChild(child, depth + 2);
                  }
              }
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
          syncStatusSubscriptions(visibleStatusSessionIds);
          updateActiveCommentChildRows();
        return;
      }
      try { setFolderOpen(root.id || "root", true); } catch {}
      renderFolder(root, -1);
        syncStatusSubscriptions(visibleStatusSessionIds);
        updateVisibleStatusBadges();
        updateActiveCommentChildRows();
    };

      const syncCurrentSession = (sessionId = getEffectiveCurrentSessionId()) => {
        const currentId = String(sessionId || "");
        let currentRow = null;
        let activeCommentId = "";
        try {
          activeCommentId = String(window.zion?.state?.get?.("comments.activeThreadId") || "");
        } catch {}
        listEl.querySelectorAll(".zion-session-row[data-session-id]").forEach((row) => {
          const sessionActive = !!currentId && row.dataset.sessionId === currentId;
          const commentActive = row.classList.contains("is-comment")
            && !!activeCommentId
            && row.dataset.childId === activeCommentId;
          row.classList.toggle("is-current", sessionActive || commentActive);
          if (sessionActive) currentRow = row;
        });
        return currentRow;
      };

      const syncSessionIndex = (index) => {
        const entries = new Map(
          (Array.isArray(index) ? index : [])
            .filter((entry) => entry?.id)
            .map((entry) => [String(entry.id), entry])
        );
        listEl.querySelectorAll(".zion-session-row.is-session[data-session-id]").forEach((row) => {
          const id = String(row.dataset.sessionId || "");
          const entry = entries.get(id);
          if (!entry) return;
          const meta = loadMeta(id) || entry;
          const title = String(meta?.title || entry?.title || id);
          const titleEl = row.querySelector(".zion-session-name");
          if (titleEl && titleEl.textContent !== title) titleEl.textContent = title;
          row.title = `${t("ui.updated", "Updated")}: ${fmtTime(meta?.updatedAt || now())} · ${t("ui.chars", "{count} chars", { count: meta?.size || 0 })}`;
          syncCardMetadata(row, meta);
        });
      };

      render.syncCurrentSession = syncCurrentSession;
      render.syncSessionIndex = syncSessionIndex;
      render.dispose = () => {
        try { activeCommentDisposable?.dispose?.(); } catch {}
        try { window.removeEventListener("zion:comments-active-changed", updateActiveCommentChildRows); } catch {}
        disposeStatusSubscriptions();
      };

    return render;
  };
}
