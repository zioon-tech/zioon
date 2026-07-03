import { Decoration, EditorView, WidgetType, ViewPlugin } from "@codemirror/view";
import { StateField, StateEffect, Transaction } from "@codemirror/state";
import {
  buildRegexAnchors,
  filterDeletedItems,
  mergeItemsFromAnchors,
  planAssistantMarkerInsertion,
  reconcileExactAnchors,
  reconcileNearestAnchors,
  stripCardMarkerIdComment,
  thinkingMarkerText
} from "../../src/chat/restore";
import { inlineWidgetSourceFacet } from "../../src/editor/inlineWidgets";

function t(key, fallback, values) {
  const fullKey = `dev.thinking.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

/**
 * Effects:
 * - addInline: 插入“思考”文本并替换为内联 widget
 * - toggleInline: 展开/收起卡片
 * - updateText: 更新卡片内容（思考文本）
 * - removeItem: 移除该思考条目
 */
const addInline = StateEffect.define();     // { from, to, id }
const toggleInline = StateEffect.define();  // { id }
const updateText = StateEffect.define();    // { id, text, replace? }
const removeItem = StateEffect.define();    // { id }
const clearAll = StateEffect.define();
const inlineWidgetLineClass = "zion-inline-widget-row";
const THINKING_ANCHOR_RE = /思考\s*<!--\s*zion-thinking:id=([^>\s]+)\s*-->/g;

function parseThinkingAnchorText(text) {
  const raw = String(text || "").trim();
  const match = /^思考(?:\s*<!--\s*zion-thinking:id=([^>\s]+)\s*-->)?$/.exec(raw);
  if (!match) return null;
  return {
    id: match[1] ? String(match[1]) : null,
    visibleText: stripCardMarkerIdComment(raw)
  };
}

function buildThinkingAnchors(docString) {
  return buildRegexAnchors(docString, THINKING_ANCHOR_RE, (match) => ({
    from: match.index,
    to: match.index + match[0].length,
    markerId: match[1] ? String(match[1]) : null
  }));
}

function isThinkingAnchorForItem(anchorText, id) {
  const parsed = parseThinkingAnchorText(anchorText);
  if (!parsed || parsed.visibleText !== "思考") return false;
  const expectedId = String(id || "");
  return !parsed.id || !expectedId || parsed.id === expectedId;
}

function migrateLegacyThinkingAnchors(view, items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return false;
  const allAnchors = buildThinkingAnchors(view.state.doc.toString());
  const anchors = allAnchors.filter((anchor) => !anchor.markerId);
  if (!anchors.length) return false;
  const used = new Set();
  const changes = [];
  for (const item of list) {
    const id = String(item?.id || "");
    if (!id) continue;
    let anchor = anchors.find((candidate) =>
      !used.has(candidate)
      && typeof item.from === "number"
      && typeof item.to === "number"
      && candidate.from === item.from
      && candidate.to === item.to
    );
    if (!anchor) anchor = anchors.find((candidate) => !used.has(candidate));
    if (!anchor) continue;
    used.add(anchor);
    const marker = thinkingMarkerText(id);
    changes.push({ from: anchor.from, to: anchor.to, insert: marker });
    item.from = anchor.from;
    item.to = anchor.from + marker.length;
  }
  if (!changes.length) return false;
  changes.sort((a, b) => a.from - b.from);
  view.dispatch({
    changes,
    annotations: Transaction.userEvent.of("zion.cardAnchorMigrate")
  });
  return true;
}

function mergeThinkingItemsFromAnchors(view, items, deletedIds) {
  return mergeItemsFromAnchors({
    items,
    deletedIds,
    anchors: buildThinkingAnchors(view.state.doc.toString()).filter((anchor) => anchor.markerId),
    createItem: (anchor) => ({
      id: String(anchor.markerId || ""),
      text: "",
      expanded: false,
      from: anchor.from,
      to: anchor.to
    })
  }).items;
}

  function reviveDeletedThinkingIdsForAnchors(sessionId, deletedIds, anchors) {
    const deleted = Array.isArray(deletedIds) ? deletedIds.map(String).filter(Boolean) : [];
    if (!sessionId || !deleted.length || !Array.isArray(anchors) || !anchors.length) return deleted;
    const anchorIds = new Set(anchors.map((anchor) => String(anchor?.markerId || "")).filter(Boolean));
    const remaining = deleted.filter((id) => !anchorIds.has(id));
    if (remaining.length === deleted.length) return deleted;
    try {
      updateSessionAnnotations(sessionId, (ann) => ({ ...ann, deletedThinkingIds: remaining }));
    } catch {}
    return remaining;
  }

  function mergeThinkingSnapshotItem(previous, current) {
    const prev = previous && typeof previous === "object" ? previous : {};
    const next = current && typeof current === "object" ? current : {};
    const merged = { ...prev, ...next };
    if (!next.text && prev.text) merged.text = prev.text;
    return merged;
  }

  function thinkingItemNeedsHydration(stored, mounted) {
    if (!stored || !mounted) return false;
    if (stored.text && !mounted.text) return true;
    return false;
  }

  function needsThinkingRestore(list, fieldVal) {
    const mounted = fieldVal?.items || new Map();
    for (const it of Array.isArray(list) ? list : []) {
      const id = String(it?.id || "");
      if (!id) continue;
      const current = mounted.get(id);
      if (!current || thinkingItemNeedsHydration(it, current)) return true;
    }
    return false;
  }

function repairDuplicateThinkingAnchorIds(view, items, deletedIds) {
  const sourceItems = Array.isArray(items) ? items.slice() : [];
  const deleted = new Set(Array.from(deletedIds || []).map((id) => String(id)));
  const anchors = buildThinkingAnchors(view.state.doc.toString()).filter((anchor) => anchor.markerId);
  if (anchors.length < 2) return { items: sourceItems, repaired: 0 };

  const seen = new Map();
  const usedIds = new Set(sourceItems.map((item) => String(item?.id || "")).filter(Boolean));
  anchors.forEach((anchor) => {
    const id = String(anchor.markerId || "");
    if (id) usedIds.add(id);
  });

  const changes = [];
  const clonedItems = [];
  for (const anchor of anchors) {
    const id = String(anchor.markerId || "");
    if (!id || deleted.has(id)) continue;
    const count = seen.get(id) || 0;
    seen.set(id, count + 1);
    if (count === 0) continue;

    let suffix = count + 1;
    let nextId = `${id}:dup${suffix}`;
    while (usedIds.has(nextId) || deleted.has(nextId)) {
      suffix += 1;
      nextId = `${id}:dup${suffix}`;
    }
    usedIds.add(nextId);
    const marker = thinkingMarkerText(nextId);
    changes.push({ from: anchor.from, to: anchor.to, insert: marker });
    const source = sourceItems.find((item) => String(item?.id || "") === id) || {};
    clonedItems.push({
      ...source,
      id: nextId,
      expanded: false,
      from: anchor.from,
      to: anchor.from + marker.length
    });
  }

  if (!changes.length) return { items: sourceItems, repaired: 0 };
  changes.sort((a, b) => a.from - b.from);
  view.dispatch({
    changes,
    annotations: Transaction.userEvent.of("zion.cardAnchorRepair")
  });
  return { items: sourceItems.concat(clonedItems), repaired: clonedItems.length };
}

function getSessionAnnotations(sessionId) {
  try {
    return window?.zion?.commands?.executeCommand?.("zion.chatCards.getSessionAnnotations", sessionId) || {};
  } catch {
    return {};
  }
}

function updateSessionAnnotations(sessionId, updater) {
  try {
    return window?.zion?.commands?.executeCommand?.("zion.chatCards.updateSessionAnnotations", { sessionId, updater }) || {};
  } catch {
    return {};
  }
}

function clearPendingRestore(sessionId, kind) {
  try {
    window?.zion?.commands?.executeCommand?.("zion.chatCards.clearPendingRestore", { sessionId, kind });
  } catch {}
}

function getViewSessionId(view) {
  try {
    return view?.dom?.getAttribute?.("data-session-id") || null;
  } catch {
    return null;
  }
}

function debugChatCards(event, payload) {
  void event;
  void payload;
}

function getRunAssistantAnchorHint(payload, sessionId) {
  if (typeof payload?.answerAnchorPos === "number") return payload.answerAnchorPos;
  return (sessionId ? window.zion?.state?.get(`chat.answerAnchorPos.${sessionId}`) : undefined)
    ?? window.zion?.state?.get("chat.answerAnchorPos");
}

function getRunAssistantHeadLineHint(payload, sessionId) {
  if (typeof payload?.answerHeadLine === "number") return payload.answerHeadLine;
  return (sessionId ? window.zion?.state?.get(`chat.answerHeadLine.${sessionId}`) : undefined)
    ?? window.zion?.state?.get("chat.answerHeadLine");
}

// #endregion

function scheduleRevealThinkingContent(view, { id, pos } = {}) {
  try {
    const sid = getViewSessionId(view);
    if (!sid) return;
    if (window?.zion?.state?.get?.(`chat.followLatest.${sid}`) === false) return;
    requestAnimationFrame(() => {
      try {
        const scrollDOM = view?.scrollDOM;
        if (!scrollDOM) return;
        const selectorId = String(id || "").replace(/"/g, '\\"');
        const thinkingEl = selectorId
          ? view.dom.querySelector(`.zion-thinking-inline[data-thinking-id="${selectorId}"], .zion-thinking-card[data-thinking-card-id="${selectorId}"]`)
          : null;
        const viewportRect = scrollDOM.getBoundingClientRect();
        const margin = 24;
        let nextScrollTop = null;
        if (thinkingEl) {
          const rect = thinkingEl.getBoundingClientRect();
          if (rect.bottom > viewportRect.bottom - margin) {
            nextScrollTop = scrollDOM.scrollTop + (rect.bottom - (viewportRect.bottom - margin));
          }
        } else if (typeof pos === "number") {
          const coords = view.coordsAtPos(Math.max(0, pos), 1);
          if (coords?.bottom > viewportRect.bottom - margin) {
            nextScrollTop = scrollDOM.scrollTop + (coords.bottom - (viewportRect.bottom - margin));
          }
        }
        if (nextScrollTop == null) return;
        window?.zion?.state?.set?.(`chat.followSuppressUntil.${sid}`, Date.now() + 80);
        scrollDOM.scrollTop = Math.max(0, nextScrollTop);
      } catch {}
    });
  } catch {}
}

function fmt(v, max = 1200) {
  let s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  if (s.length > max) s = s.slice(0, max) + "\n…";
  return s;
}

class ThinkingCardWidget extends WidgetType {
  constructor(id, text) {
    super();
    this.id = id + ":card";
    this.text = text || "";
  }
  eq(other) {
    return other.id === this.id && other.text === this.text;
  }
  updateDOM(dom) {
    try {
      const pre = dom?.querySelector?.("pre");
      if (pre) pre.textContent = fmt(this.text, 5000);
      return true;
    } catch {
      return false;
    }
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "zion-thinking-card";
    wrap.setAttribute("data-thinking-card-id", String(this.id).replace(/:card$/, ""));

    const body = document.createElement("pre");
    body.className = "zion-thinking-card-body";
    body.textContent = fmt(this.text, 5000);
    wrap.appendChild(body);
    return wrap;
  }
}

class ThinkingInlineWidget extends WidgetType {
  constructor(id) {
    super();
    this.id = id + ":inline";
  }
  eq(other) {
    return other.id === this.id;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "zion-thinking-inline";
    const thinkingId = String(this.id).replace(/:inline$/, "");
    span.setAttribute("data-thinking-id", thinkingId);
    span.title = t("ui.inlineTitle", "思考（点击展开/收起）");
    span.setAttribute("aria-label", t("ui.inlineAria", "思考（点击展开或收起卡片）"));

    const btn = document.createElement("button");
    btn.className = "zion-thinking-inline-toggle";
    btn.type = "button";
    btn.title = t("ui.toggleContent", "展开/收起思考内容");
    btn.setAttribute("aria-label", t("ui.toggleContent", "展开/收起思考内容"));
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M4.646 6.646a.5.5 0 0 1 .708 0L8 9.293l2.646-2.647a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 0 1 0-.708z"></path>
</svg>`;
    span.appendChild(btn);

    const txt = document.createElement("span");
    txt.className = "zion-thinking-inline-text";
    txt.textContent = t("ui.thinking", "思考");
    span.appendChild(txt);

    return span;
  }
  ignoreEvent() { return false; }
}

function buildThinkingDecorations(state, field) {
  const decorations = [];
  let fieldVal = null;
  try { fieldVal = state.field(field, false); } catch {}
  const items = fieldVal?.items || null;

  // Inline pills are driven directly by the document anchors (which carry the id),
  // not by the asynchronously-restored StateField items. A mirror/split panel renders
  // pills from its seeded document on first build, so the bare "思考 <!-- ... -->"
  // text can never leak through while restore is still pending.
  const docLen = state.doc.length;
  let anchors = [];
  try {
    anchors = buildThinkingAnchors(state.doc.toString()).filter((anchor) => anchor.markerId);
  } catch {}

  const addedLines = new Set();
  const renderedIds = new Set();
  for (const anchor of anchors) {
    if (typeof anchor.from !== "number" || typeof anchor.to !== "number") continue;
    if (anchor.from < 0 || anchor.to > docLen || anchor.from >= anchor.to) continue;
    const id = String(anchor.markerId);
    if (renderedIds.has(id)) continue;
    renderedIds.add(id);

    let line;
    try { line = state.doc.lineAt(anchor.from); } catch { continue; }
    if (!addedLines.has(line.number)) {
      addedLines.add(line.number);
      decorations.push(Decoration.line({ class: inlineWidgetLineClass }).range(line.from));
    }

    decorations.push(Decoration.replace({ widget: new ThinkingInlineWidget(id) }).range(anchor.from, anchor.to));

    const it = items?.get?.(id);
    if (it?.expanded) {
      decorations.push(Decoration.widget({ widget: new ThinkingCardWidget(id, it.text), side: 1 }).range(anchor.to));
    }
  }
  return decorations;
}

/**
 * Field value：{ items: Map<id, { from, to, expanded, text }> }
 */
const thinkingField = StateField.define({
  create() {
    return { items: new Map() };
  },
  update(val, tr) {
    const hasThinkingEffect = tr.effects.some((e) =>
      e.is(clearAll) ||
      e.is(addInline) ||
      e.is(toggleInline) ||
      e.is(updateText) ||
      e.is(removeItem)
    );
    if (!tr.docChanged && !hasThinkingEffect) return val;


    const items = new Map();
    val.items.forEach((it, id) => {
      const from = tr.changes.mapPos(it.from, 1);
      const to = tr.changes.mapPos(it.to, -1);
      items.set(id, { ...it, from, to });
    });

    for (const e of tr.effects) {
      if (e.is(clearAll)) {
        items.clear();
        continue;
      }
      if (e.is(addInline)) {
        const { from, to, id, sessionId, runId, segmentKey } = e.value;
        items.set(id, { from, to, expanded: false, text: "", sessionId: sessionId || null, runId: runId || null, segmentKey: segmentKey || null });
      }
      if (e.is(toggleInline)) {
        const id = e.value?.id;
        const it = id ? items.get(id) : null;
        if (!it) continue;
        if (it.expanded) {
          items.set(id, { ...it, expanded: false });
        } else {
          items.set(id, { ...it, expanded: true });
        }
      }
      if (e.is(updateText)) {
        const { id, text } = e.value || {};
        const replace = !!e.value?.replace;
        const it = id ? items.get(id) : null;
        if (!it) continue;
        const updated = replace
          ? { ...it, text: String(text || "") }
          : { ...it, text: (it.text || "") + String(text || "") };
        items.set(id, updated);
      }
      if (e.is(removeItem)) {
        const base = String(e.value?.id || "");
        const itemSessionId = items.get(base)?.sessionId || null;
        items.delete(base);

        try {
          const sid = e.value?.sessionId || itemSessionId || null;
          if (sid) {
            updateSessionAnnotations(sid, (ann) => {
              const del = Array.isArray(ann.deletedThinkingIds) ? ann.deletedThinkingIds.slice() : [];
              if (!del.includes(base)) del.push(base);
              return { ...ann, deletedThinkingIds: del };
            });
          }
        } catch {}
      }
    }

    try {
      const doc = tr.state.doc;
      const toRemove = [];
      items.forEach((it, id) => {
        const invalidPos = typeof it.from !== "number" || typeof it.to !== "number" || it.from < 0 || it.to > doc.length || it.from >= it.to;
        if (invalidPos) {
          toRemove.push(id);
          return;
        }
        const anchor = doc.sliceString(it.from, it.to);
        if (!isThinkingAnchorForItem(anchor, id)) {
          toRemove.push(id);
        }
      });
      if (toRemove.length) {
        const isSessionLoad = (() => {
          try {
            return tr?.annotation?.(Transaction.userEvent) === "zion.sessionLoad";
          } catch {
            return false;
          }
        })();
        const removedBySession = new Map();
        toRemove.forEach((id) => {
          const it = items.get(id);
          const sid = it?.sessionId || null;
          if (!sid) return;
          if (!removedBySession.has(sid)) removedBySession.set(sid, []);
          removedBySession.get(sid).push(String(id));
        });
        toRemove.forEach(id => items.delete(id));
        if (!isSessionLoad) {
          removedBySession.forEach((ids, sid) => {
            try {
              updateSessionAnnotations(sid, (ann) => {
                const del = Array.isArray(ann.deletedThinkingIds) ? ann.deletedThinkingIds.slice() : [];
                ids.forEach((id) => {
                  if (!del.includes(id)) del.push(id);
                });
                return { ...ann, deletedThinkingIds: del };
              });
            } catch {}
          });
        }
      }
    } catch {}

    return { items };
  },
  provide: f => inlineWidgetSourceFacet.of({
    id: "thinking",
    priority: 20,
    buildDecorations: (state) => buildThinkingDecorations(state, f)
  })
});

export function installThinkingCards() {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.disps = [];
      this.sessionId = null;
      this.suspendSnapshot = false;
      this.currentId = null;
      this.currentRunId = "";
      this.currentSegmentKey = "";
      this.buffer = "";
      this.timer = null;
      this.selRaf = 0;
      this.reasoningSeq = new Map();

      try { this.panelId = this.view.dom.closest("[data-panel-id]")?.getAttribute("data-panel-id") || null; } catch { this.panelId = null; }
      try {
        this.sessionId = getViewSessionId(this.view);
      } catch {}
      debugChatCards("plugin.init", { panelId: this.panelId, sessionId: this.sessionId, docLength: this.view.state.doc.length });

      this.disps.push(window.zion.events.on("chat/runStarted", this.onRunStarted));
      this.disps.push(window.zion.events.on("chat/reasoningStart", this.onReasoningStart));
      this.disps.push(window.zion.events.on("chat/reasoningToken", this.onReasoningToken));
      this.disps.push(window.zion.events.on("chat/reasoningEnd", this.onReasoningEnd));
      this.disps.push(window.zion.events.on("thinking/remove", this.onRemove));
      this.disps.push(window.zion.events.on("thinking/restore", this.onRestore));
      this.disps.push(window.zion.events.on("thinking/clear", this.onClear));
      this.disps.push(window.zion.events.on("thinking/snapshot", this.onSnapshot));
      this.disps.push(window.zion.state.onDidChange("sessions.currentId", this.onSessionChanged));
      // 初始快照
      this.snapshot();

      Promise.resolve().then(() => {
        try {
          const sid = this.sessionId;
          const pending = sid ? window.zion?.commands?.executeCommand?.("zion.chatCards.getPendingRestore", { sessionId: sid, kind: "thinking" }) : null;
          const ann = sid ? getSessionAnnotations(sid) : {};
          const rawList = Array.isArray(ann.thinking) ? ann.thinking : [];
            const anchors = buildThinkingAnchors(this.view.state.doc.toString()).filter((anchor) => anchor.markerId);
            const deletedIds = reviveDeletedThinkingIdsForAnchors(sid, Array.isArray(ann.deletedThinkingIds) ? ann.deletedThinkingIds : [], anchors);
          const repair = repairDuplicateThinkingAnchorIds(this.view, rawList, deletedIds);
          const list = mergeThinkingItemsFromAnchors(this.view, repair.items, deletedIds);
          debugChatCards("plugin.initialRestoreCheck", {
            panelId: this.panelId,
            sessionId: sid,
            pending: Array.isArray(pending) ? pending.length : 0,
            annotations: list.length
          });
          if (Array.isArray(pending) && pending.length) {
            this.onRestore({ items: pending });
            return;
          }
          if (!list.length) return;
          // 基于 StateField 中的已挂载 id 判断是否需要恢复
          let mountedIds = [];
            let fieldVal = null;
          try {
              fieldVal = this.view.state.field(thinkingField);
            if (fieldVal?.items) fieldVal.items.forEach((_it, id) => mountedIds.push(String(id)));
          } catch {}
          const wantIds = list.map(it => it?.id).filter(Boolean).map(String);
            const missing = repair.repaired > 0 || wantIds.some(id => !mountedIds.includes(id)) || needsThinkingRestore(list, fieldVal);
          if (!missing) return;
          this.onRestore({ items: list });
        } catch {}
      });
      this.syncSelectionHighlight();

      // 页面可见性监听：休眠唤醒后自动恢复 widgets
      this.setupVisibilityRecovery();
    }

    // 页面休眠/唤醒后自动恢复丢失的 widgets
    setupVisibilityRecovery = () => {
      let wasHidden = document.hidden;
      const checkAndRestore = () => {
        const isHidden = document.hidden;
        if (wasHidden && !isHidden) {
          // 页面从休眠中唤醒，检查并恢复丢失的 widgets
          this.checkAndRestoreWidgets();
        }
        wasHidden = isHidden;
      };
      // 监听 visibilitychange 事件
      document.addEventListener("visibilitychange", checkAndRestore);
      this.disps.push({
        dispose: () => document.removeEventListener("visibilitychange", checkAndRestore)
      });
      // 也监听 window focus 事件作为备份
      const onFocus = () => {
        setTimeout(() => {
          this.checkAndRestoreWidgets();
        }, 100);
      };
      window.addEventListener("focus", onFocus);
      this.disps.push({
        dispose: () => window.removeEventListener("focus", onFocus)
      });
    };

    // 检查并恢复丢失的 widgets
    checkAndRestoreWidgets = () => {
      try {
        const sid = this.sessionId;
        if (!sid) return;
        const ann = getSessionAnnotations(sid);
        const rawList = Array.isArray(ann.thinking) ? ann.thinking : [];
          const anchors = buildThinkingAnchors(this.view.state.doc.toString()).filter((anchor) => anchor.markerId);
          const deletedIds = reviveDeletedThinkingIdsForAnchors(sid, Array.isArray(ann.deletedThinkingIds) ? ann.deletedThinkingIds : [], anchors);
        const repair = repairDuplicateThinkingAnchorIds(this.view, rawList, deletedIds);
        const list = mergeThinkingItemsFromAnchors(this.view, repair.items, deletedIds);
        let mountedIds = [];
        try {
          const fieldVal = this.view.state.field(thinkingField);
          if (fieldVal?.items) fieldVal.items.forEach((_it, id) => mountedIds.push(String(id)));
        } catch {}
        if (!list.length) return;

        // 基于文档锚点判断是否需要恢复。annotations 里可能保留历史 orphan id，
        // 这些 id 没有对应锚点时不应该触发反复 restore。
        const anchorIds = anchors.map((anchor) => anchor?.markerId).filter(Boolean).map(String);
        const anchorIdSet = new Set(anchorIds);
        const wantIds = list
          .map(it => it?.id)
          .filter(Boolean)
          .map(String)
          .filter(id => anchorIdSet.has(id));
          let fieldVal = null;
          try { fieldVal = this.view.state.field(thinkingField); } catch {}
          const mountedSet = new Set(mountedIds);
          const listForAnchors = list.filter((it) => anchorIdSet.has(String(it?.id || "")));
          const missing = repair.repaired > 0 || wantIds.some(id => !mountedSet.has(id)) || needsThinkingRestore(listForAnchors, fieldVal);
        if (missing) {
          this.onRestore({ items: listForAnchors });
        }
      } catch (e) {
        console.error("[thinking] checkAndRestoreWidgets error:", e);
      }
    };

    update(update) {
      if (this.suspendSnapshot) return;
      const isSessionLoad = (() => {
        try {
          return !!update.transactions?.some?.((tr) => tr?.annotation?.(Transaction.userEvent) === "zion.sessionLoad");
        } catch {
          return false;
        }
      })();
      if (isSessionLoad) {
        setTimeout(() => this.checkAndRestoreWidgets(), 0);
      } else {
          if (update.docChanged) {
            setTimeout(() => this.checkAndRestoreWidgets(), 0);
          }
        this.snapshot();
      }
      if (update.selectionSet || update.docChanged || update.viewportChanged) {
        this.syncSelectionHighlight();
      }
    }
    syncSelectionHighlight = () => {
      try {
        if (this.selRaf) window.cancelAnimationFrame(this.selRaf);
      } catch {}
      this.selRaf = window.requestAnimationFrame(() => {
        this.selRaf = 0;
        try {
          const view = this.view;
          const sel = view.state.selection;
          const hasSelection = sel.ranges.some(r => !r.empty);
          const all = view.dom.querySelectorAll(".zion-thinking-inline, .zion-thinking-card");
          try { all.forEach(el => el.classList.remove("zion-selected")); } catch {}
          if (!hasSelection) return;
          const fieldVal = view.state.field(thinkingField);
          const selected = new Set();
          fieldVal.items.forEach((it, id) => {
            for (const r of sel.ranges) {
              if (r.empty) continue;
              if (r.from < it.to && r.to > it.from) { selected.add(String(id)); break; }
            }
          });
          selected.forEach((id) => {
            try {
              const els = view.dom.querySelectorAll(`.zion-thinking-inline[data-thinking-id="${id}"], .zion-thinking-card[data-thinking-card-id="${id}"]`);
              els.forEach(el => el.classList.add("zion-selected"));
            } catch {}
          });
        } catch {}
      });
    };
    snapshot = () => {
      try {
        const id = this.sessionId;
        if (!id) return;
        const fieldVal = this.view.state.field(thinkingField);
        const arr = [];
        fieldVal.items.forEach((it, key) => {
          arr.push({
            id: key,
            text: it.text,
            expanded: it.expanded,
            from: it.from,
            to: it.to,
            runId: this.currentId === key ? this.currentRunId : it.runId,
            segmentKey: this.currentId === key ? this.currentSegmentKey : it.segmentKey
          });
        });
        updateSessionAnnotations(id, (prev) => {
          const prevThinking = Array.isArray(prev.thinking) ? prev.thinking : [];
          if (!arr.length && prevThinking.length) {
            debugChatCards("snapshot.skipEmpty", {
              panelId: this.panelId,
              sessionId: id,
              prevCount: prevThinking.length,
              docLength: this.view.state.doc.length
            });
            return prev;
          }
            const prevById = new Map(prevThinking.map((it) => [String(it?.id || ""), it]).filter(([key]) => !!key));
            const nextThinking = [];
            const seen = new Set();
            for (const it of arr) {
              const key = String(it?.id || "");
              if (!key) continue;
              seen.add(key);
              nextThinking.push(mergeThinkingSnapshotItem(prevById.get(key), it));
            }
            for (const it of prevThinking) {
              const key = String(it?.id || "");
              if (!key || seen.has(key)) continue;
              nextThinking.push(it);
            }
            return { ...prev, thinking: nextThinking };
        });
                debugChatCards("snapshot", { panelId: this.panelId, sessionId: id, count: arr.length, ids: arr.map(it => it.id) });
        // 同步当前挂载的 widget id 列表与计数，供生命周期判定使用（避免依赖 DOM 计数）
        try {
          const mountedIds = arr.map(it => it.id).filter(Boolean);
          window.zion?.state?.set(`sessions.widgets.thinking.${id}`, {
            ids: mountedIds,
            count: mountedIds.length,
            stamp: Date.now()
          });
        } catch {}
      } catch {}
    };
    flush() {
      if (!this.currentId) return;
      if (!this.buffer) return;
      const text = this.buffer;
      this.buffer = "";
      try {
        // 1) 更新状态（累加到 items 中）
        this.view.dispatch({ effects: [updateText.of({ id: this.currentId, text })] });
        // 持久化快照
        this.snapshot();
      } catch {}
    }
    seqKey(sid, runId) {
      return `thinking.seq.${sid}.${runId}`;
    }
    getSegmentKey(runId, payload = {}) {
      const rid = runId || payload?.runId || "run";
      return String(payload?.reasoningSegmentId || (payload?.stepIndex != null ? `${rid}:step:${payload.stepIndex}` : rid));
    }
    getVisibleSessionId = () => {
      return getViewSessionId(this.view);
    };
    shouldHandleScopedPayload = (payload) => {
      const visibleSessionId = this.getVisibleSessionId();
      if (!visibleSessionId) return false;
      if (payload?.sessionId && payload.sessionId !== visibleSessionId) return false;
      if (payload?.panelId && this.panelId && payload.panelId !== this.panelId) return false;
      if (!payload?.panelId && !payload?.sessionId) {
        const activePanelId = window.zion?.panels?.getActivePanelId?.() || null;
        if (this.panelId && activePanelId && this.panelId !== activePanelId) return false;
      }
      this.sessionId = visibleSessionId;
      return true;
    };
    isPrimaryWriterPayload = (payload) => {
      if (payload?.panelId && this.panelId) return payload.panelId === this.panelId;
      if (payload?.sessionId) {
        const activePanelId = window.zion?.panels?.getActivePanelId?.() || null;
        if (activePanelId && this.panelId && activePanelId !== this.panelId) return false;
      }
      return true;
    };
    getSeq(sid, runId) {
      try {
        const v = this.reasoningSeq.get(this.seqKey(sid, runId));
        const localSeq = typeof v === "number" && Number.isFinite(v) ? v : 0;
        const sharedSeq = Number(window.zion?.state?.get?.(this.seqKey(sid, runId)) || 0);
        return Math.max(localSeq, Number.isFinite(sharedSeq) ? sharedSeq : 0);
      } catch {
        return 0;
      }
    }
    setSeq(sid, runId, seq) {
      try {
        const key = this.seqKey(sid, runId);
        this.reasoningSeq.set(key, seq);
        window.zion?.state?.set?.(key, seq);
      } catch {}
    }
    getMaxExistingSeq(sid, runId) {
      const prefix = `thinking:${runId}:`;
      let maxSeq = 0;
      const acceptId = (id) => {
        const raw = String(id || "");
        if (!raw.startsWith(prefix)) return;
        const n = Number(raw.slice(prefix.length).split(":")[0]);
        if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
      };
      try {
        for (const anchor of buildThinkingAnchors(this.view.state.doc.toString())) {
          acceptId(anchor.markerId);
        }
      } catch {}
      try {
        const ann = sid ? getSessionAnnotations(sid) : {};
        for (const item of Array.isArray(ann.thinking) ? ann.thinking : []) {
          acceptId(item?.id);
        }
      } catch {}
      return maxSeq;
    }
      parseThinkingSeq(runId, id) {
        const raw = String(id || "");
        const prefix = `thinking:${runId}:`;
        if (!raw.startsWith(prefix)) return 0;
        const n = Number(raw.slice(prefix.length).split(":")[0]);
        return Number.isFinite(n) ? n : 0;
      }
      getExistingThinkingIdForSegment(sid, runId, segmentKey) {
        const prefix = `thinking:${runId}:`;
        let bestId = "";
        let bestSeq = 0;
        try {
          const ann = sid ? getSessionAnnotations(sid) : {};
          for (const item of Array.isArray(ann.thinking) ? ann.thinking : []) {
            const id = String(item?.id || "");
            if (!id.startsWith(prefix)) continue;
            const storedSegmentKey = String(item?.segmentKey || "");
            if (segmentKey && storedSegmentKey && storedSegmentKey !== String(segmentKey) && storedSegmentKey !== `${sid}:${segmentKey}`) continue;
            const seq = this.parseThinkingSeq(runId, id);
            if (seq > bestSeq) {
              bestSeq = seq;
              bestId = id;
            }
          }
        } catch {}
        return bestId;
      }
    ensureInlineForThinkingId(sid, id) {
      try {
        const fieldVal = this.view.state.field(thinkingField);
        if (fieldVal?.items?.has?.(id)) return true;
      } catch {}

      try {
        const ann = sid ? getSessionAnnotations(sid) : {};
        const list = Array.isArray(ann.thinking) ? ann.thinking : [];
        const it = list.find(x => x?.id === id);
        if (!it) return false;
        const docLen = this.view.state.doc.length;
        const hasRange = typeof it.from === "number" && typeof it.to === "number";
        const validRange = hasRange && it.from >= 0 && it.from < it.to && it.to <= docLen;
        if (!validRange) return false;
        this.view.dispatch({ effects: [addInline.of({ from: it.from, to: it.to, id, sessionId: sid, runId: it.runId, segmentKey: it.segmentKey })] });
        if (it.text) this.view.dispatch({ effects: [updateText.of({ id, text: it.text, replace: true })] });
        if (it.expanded) this.view.dispatch({ effects: [toggleInline.of({ id })] });
        return true;
      } catch {
        return false;
      }
    }
    onRunStarted = (payload) => {
      const visibleSessionId = this.getVisibleSessionId();
      if (payload?.sessionId && visibleSessionId && payload.sessionId !== visibleSessionId) return;
      if (!payload?.sessionId && payload?.panelId && payload.panelId !== this.panelId) return;
      if (payload?.sessionId) this.sessionId = payload.sessionId;
      try {
        const sid = this.sessionId;
        const runId = payload?.runId;
        if (sid && runId) this.setSeq(sid, runId, 0);
      } catch {}
      // 新一轮运行，清空缓冲（保留历史思考行）
      this.currentId = null;
      this.currentRunId = "";
      this.currentSegmentKey = "";
      this.buffer = "";
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    };
    ensureAssistantHead() {
      const docBefore = this.view.state.doc;
      const allText = docBefore.toString().replace(/\r/g, "");
      const lines = allText.split("\n");
      let hasAssistant = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/^(system|user|assistant|tool)\s+/);
        if (m && m[1] === "assistant") { hasAssistant = true; break; }
      }
      if (!hasAssistant) {
        const lastChar = docBefore.length > 0 ? docBefore.sliceString(docBefore.length - 1, docBefore.length) : "";
        const prefixH = lastChar === "\n" || docBefore.length === 0 ? "" : "\n";
        const header = `${prefixH}assistant \n`;
        this.view.dispatch({ changes: { from: docBefore.length, insert: header } });
      }
    }
    onReasoningStart = (payload) => {
      if (payload?.silentReasoning) return;
      const visible = !!window.zion.state.get("chat.thinkingVisible");
      if (!visible) return;
      if (!this.shouldHandleScopedPayload(payload)) return;
      this.suspendSnapshot = false;

      const runId = payload?.runId || Math.random().toString(36).slice(2);
      const segmentKey = this.getSegmentKey(runId, payload);
      if (payload?.sessionId) this.sessionId = payload.sessionId;
      const sid = this.sessionId;
      if (this.currentId && this.currentRunId === runId && this.currentSegmentKey === segmentKey) {
        return;
      }
      const existingId = sid ? this.getExistingThinkingIdForSegment(sid, runId, segmentKey) : "";
      const existingSeq = existingId ? this.parseThinkingSeq(runId, existingId) : 0;
      const seq = existingSeq || (sid ? (Math.max(this.getSeq(sid, runId), this.getMaxExistingSeq(sid, runId)) + 1) : 1);
      const id = existingId || `thinking:${runId}:${seq}`;

      if (!this.isPrimaryWriterPayload(payload)) {
        try {
          this.checkAndRestoreWidgets();
        } catch {}
        setTimeout(() => {
          try { this.ensureInlineForThinkingId(sid, id) || this.checkAndRestoreWidgets(); } catch {}
        }, 0);
        return;
      }

      if (sid) this.setSeq(sid, runId, seq);
      this.currentId = id;
      this.currentRunId = runId;
      this.currentSegmentKey = segmentKey;

      this.ensureAssistantHead();

      const hint = getRunAssistantAnchorHint(payload, sid);
      const hintLine = getRunAssistantHeadLineHint(payload, sid);
      const plan = planAssistantMarkerInsertion({
        docText: this.view.state.doc.toString(),
        markerText: thinkingMarkerText(id),
        hintPos: typeof hint === "number" ? hint : null,
        hintLine: typeof hintLine === "number" ? hintLine : null,
        trailingNewlines: 2
      });

      this.view.dispatch({
        changes: { from: plan.replaceFrom ?? plan.insertPos, to: plan.replaceTo ?? plan.insertPos, insert: plan.insertText },
        effects: [addInline.of({ from: plan.markerFrom, to: plan.markerTo, id, sessionId: sid, runId, segmentKey })]
      });
      scheduleRevealThinkingContent(this.view, { id, pos: plan.markerTo });
      this.snapshot();
    };
    onReasoningToken = (payload) => {
      if (payload?.silentReasoning) return;
      const visible = !!window.zion.state.get("chat.thinkingVisible");
      if (!visible) return;
      if (!this.shouldHandleScopedPayload(payload)) return;
      if (!this.isPrimaryWriterPayload(payload)) {
        try { this.checkAndRestoreWidgets(); } catch {}
        return;
      }

      const runId = payload?.runId;
      const segmentKey = this.getSegmentKey(runId, payload);
      if (payload?.sessionId) this.sessionId = payload.sessionId;
      const sid = this.sessionId;
      if (this.currentId && ((this.currentRunId && runId && this.currentRunId !== runId) || (this.currentSegmentKey && segmentKey && this.currentSegmentKey !== segmentKey))) {
        this.currentId = null;
        this.currentRunId = "";
        this.currentSegmentKey = "";
      }
      if (!this.currentId && sid && runId) {
        const existingId = this.getExistingThinkingIdForSegment(sid, runId, segmentKey);
        const seq = existingId ? this.parseThinkingSeq(runId, existingId) : 0;
        if (seq > 0) {
          const id = existingId || `thinking:${runId}:${seq}`;
          this.currentId = id;
          this.currentRunId = runId;
          this.currentSegmentKey = segmentKey;
          this.ensureInlineForThinkingId(sid, id);
        }
      }
      if (!this.currentId) this.onReasoningStart({ ...payload, runId: payload?.runId, sessionId: payload?.sessionId });

      const tk = String(payload?.token || "");
      if (!tk) return;

      this.buffer += tk;
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flush();
        }, 30);
      }
    };
    onReasoningEnd = (payload) => {
      if (payload?.silentReasoning) return;
      if (!this.shouldHandleScopedPayload(payload)) return;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.flush();
    };
    onRemove = (payload) => {
      if (!this.shouldHandleScopedPayload(payload)) return;
      const id = payload?.id || this.currentId;
      if (!id) return;
            this.view.dispatch({ effects: [removeItem.of({ id, sessionId: this.sessionId })] });
      if (this.currentId === id) this.currentId = null;
      this.snapshot();
    };
    onClear = (payload) => {
      if (!this.shouldHandleScopedPayload(payload)) return;
      this.view.dispatch({ effects: [clearAll.of({})] });
      this.snapshot();
    };
    onSnapshot = (payload = {}) => {
      if (!this.shouldHandleScopedPayload(payload)) return;
      const sid = payload?.sessionId || this.getVisibleSessionId();
      if (sid) this.sessionId = sid;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.flush();
      this.snapshot();
    };
    onSessionChanged = () => {
      const boundSessionId = getViewSessionId(this.view);
      if (boundSessionId) {
        this.sessionId = boundSessionId;
        return;
      }
      if (this.sessionId) {
        this.sessionId = null;
        this.suspendSnapshot = true;
        try { this.view.dispatch({ effects: [clearAll.of({})] }); } catch {}
        this.currentId = null;
        this.buffer = "";
        this.reasoningSeq.clear();
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        Promise.resolve().then(() => { this.suspendSnapshot = false; });
      }
    };
    onRestore = (payload) => {
      const list = payload?.items || payload;
      if (!Array.isArray(list) || list.length === 0) return;
      if (payload?.panelId && payload.panelId !== this.panelId) {
        debugChatCards("restore.skipPanel", { panelId: this.panelId, payloadPanelId: payload.panelId, sessionId: payload?.sessionId, count: list.length });
        return;
      }
      const visibleSessionId = this.getVisibleSessionId();
      if (!visibleSessionId) return;
      if (payload?.sessionId && payload.sessionId !== visibleSessionId) {
        debugChatCards("restore.skipSession", { panelId: this.panelId, visibleSessionId, payloadSessionId: payload.sessionId, count: list.length });
        return;
      }
      const restoreSessionId = visibleSessionId;
      this.sessionId = restoreSessionId;
      debugChatCards("restore.start", { panelId: this.panelId, sessionId: restoreSessionId, count: list.length, docLength: this.view.state.doc.length });

      this.suspendSnapshot = false;
      if (!String(this.view.state.doc.toString() || "").trim()) {
        return;
      }

      let deletedIds = [];
      try {
        const sid = restoreSessionId;
        const ann = sid ? getSessionAnnotations(sid) : {};
          const anchorsForRevive = buildThinkingAnchors(this.view.state.doc.toString()).filter((anchor) => anchor.markerId);
          deletedIds = reviveDeletedThinkingIdsForAnchors(sid, Array.isArray(ann.deletedThinkingIds) ? ann.deletedThinkingIds : [], anchorsForRevive);
      } catch {}
      const repair = repairDuplicateThinkingAnchorIds(this.view, list, deletedIds);
      const mergedList = mergeThinkingItemsFromAnchors(this.view, repair.items, deletedIds);
      const activeStreamingId = this.currentId && (this.buffer || this.timer) ? String(this.currentId) : "";
      const itemsToProcess = filterDeletedItems(mergedList, deletedIds).filter((it) => String(it?.id || "") !== activeStreamingId);
      migrateLegacyThinkingAnchors(this.view, itemsToProcess);

      const doc = this.view.state.doc;
      const docLen = doc.length;
      const docString = doc.toString();
      const anchors = buildThinkingAnchors(docString);
      const batchedEffects = [];
      const batchedToggles = [];
      const processedIds = new Set();

      // Phase 1: 精确位置匹配
      reconcileExactAnchors({
        items: itemsToProcess,
        processedIds,
        anchors,
        isExactMatch: (it, anchor) => {
          if (typeof it.from !== "number" || typeof it.to !== "number") return false;
          if (it.from < 0 || it.to > docLen || it.from >= it.to) return false;
          if (anchor.from !== it.from || anchor.to !== it.to) return false;
          if (anchor.markerId && anchor.markerId !== String(it.id || "")) return false;
          return isThinkingAnchorForItem(doc.sliceString(it.from, it.to), it.id);
        },
        onMatch: (it, anchor) => {
          batchedEffects.push(addInline.of({ from: anchor.from, to: anchor.to, id: it.id, sessionId: restoreSessionId, runId: it.runId, segmentKey: it.segmentKey }));
          if (it?.text) batchedEffects.push(updateText.of({ id: it.id, text: it.text, replace: true }));
          if (it.expanded) batchedToggles.push(it.id);
        }
      });

      // Phase 2: 模糊匹配 (Nearest Neighbor)
      reconcileNearestAnchors({
        items: itemsToProcess,
        processedIds,
        anchors,
        canUseAnchor: (it, anchor) => !anchor.markerId || anchor.markerId === String(it.id || ""),
        onMatch: (it, anchor) => {
          batchedEffects.push(addInline.of({ from: anchor.from, to: anchor.to, id: it.id, sessionId: restoreSessionId, runId: it.runId, segmentKey: it.segmentKey }));
          if (it?.text) batchedEffects.push(updateText.of({ id: it.id, text: it.text, replace: true }));
          if (it.expanded) batchedToggles.push(it.id);
          it.from = anchor.from;
          it.to = anchor.to;
        }
      });

      if (batchedEffects.length) {
        this.view.dispatch({ effects: batchedEffects });
      }
      if (batchedEffects.length) {
        const lastAddInline = [...batchedEffects].reverse().find((eff) => eff?.is?.(addInline));
        const lastPayload = lastAddInline?.value || null;
        if (lastPayload?.id) {
          scheduleRevealThinkingContent(this.view, {
            id: lastPayload.id,
            pos: lastPayload.to
          });
        }
      }
      if (batchedToggles.length) {
        const eff2 = batchedToggles.map(id => toggleInline.of({ id }));
        this.view.dispatch({ effects: eff2 });
        scheduleRevealThinkingContent(this.view, { id: batchedToggles[batchedToggles.length - 1] });
      }

      // Phase 3: 兜底
      for (const it of itemsToProcess) {
        if (processedIds.has(it.id)) continue;

        const plan = planAssistantMarkerInsertion({
          docText: this.view.state.doc.toString(),
          markerText: thinkingMarkerText(it.id),
          trailingNewlines: 2
        });

        this.view.dispatch({
          changes: { from: plan.replaceFrom ?? plan.insertPos, to: plan.replaceTo ?? plan.insertPos, insert: plan.insertText },
          annotations: Transaction.userEvent.of("zion.cardRestore"),
          effects: [addInline.of({ from: plan.markerFrom, to: plan.markerTo, id: it.id, sessionId: restoreSessionId, runId: it.runId, segmentKey: it.segmentKey })]
        });
        scheduleRevealThinkingContent(this.view, { id: it.id, pos: plan.markerTo });
        
        if (it?.text) {
          this.view.dispatch({ effects: [updateText.of({ id: it.id, text: it.text, replace: true })] });
        }
        if (it.expanded) {
          this.view.dispatch({ effects: [toggleInline.of({ id: it.id })] });
        }
        
        it.from = plan.markerFrom;
        it.to = plan.markerTo;
        processedIds.add(it.id);
      }

      try {
        if (restoreSessionId) clearPendingRestore(restoreSessionId, "thinking");
      } catch {}

      this.snapshot();
      debugChatCards("restore.done", { panelId: this.panelId, sessionId: restoreSessionId, processed: processedIds.size });
    };
    destroy() {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      try { this.reasoningSeq.clear(); } catch {}
      for (const d of this.disps) { try { d?.dispose?.(); } catch {} }
      try { if (this.selRaf) window.cancelAnimationFrame(this.selRaf); } catch {}
    }
  });

  const handlers = EditorView.domEventHandlers({
    click(event, view) {
      const el = event.target instanceof Element ? event.target.closest(".zion-thinking-inline") : null;
      if (!el) return false;
      const id = el.getAttribute("data-thinking-id");
      if (!id) return false;
      ensureThinkingItemFromDoc(view, id);
      view.dispatch({ effects: [toggleInline.of({ id })] });
      event.preventDefault();
      return true;
    }
  });

  return [thinkingField, plugin, handlers];
}

/**
 * Lazily materialise a thinking item into the StateField from the document anchor.
 * Inline pills render straight from the document, so a mirror/split panel may not
 * have run restore yet; this lets expand/collapse work on first click there.
 */
function ensureThinkingItemFromDoc(view, id) {
  const wantId = String(id || "");
  if (!wantId) return false;
  try {
    const fieldVal = view.state.field(thinkingField, false);
    if (fieldVal?.items?.has?.(wantId)) return true;
  } catch {}

  let anchor = null;
  try {
    anchor = buildThinkingAnchors(view.state.doc.toString())
      .find((a) => String(a.markerId || "") === wantId) || null;
  } catch {}
  if (!anchor) return false;

  const sid = getViewSessionId(view);
  let text = "";
  let expanded = false;
  try {
    const ann = sid ? getSessionAnnotations(sid) : {};
      reviveDeletedThinkingIdsForAnchors(sid, Array.isArray(ann.deletedThinkingIds) ? ann.deletedThinkingIds : [], [anchor]);
    const list = Array.isArray(ann.thinking) ? ann.thinking : [];
    const stored = list.find((x) => String(x?.id || "") === wantId);
    if (stored) {
      text = typeof stored.text === "string" ? stored.text : "";
      expanded = !!stored.expanded;
    }
  } catch {}

  try {
    const effects = [addInline.of({ from: anchor.from, to: anchor.to, id: wantId, sessionId: sid })];
    if (text) effects.push(updateText.of({ id: wantId, text, replace: true }));
    view.dispatch({ effects });
    // The pill click toggles afterwards; align stored expanded state so the first
    // click produces the expected open/closed result.
    if (expanded) view.dispatch({ effects: [toggleInline.of({ id: wantId })] });
    return true;
  } catch {
    return false;
  }
}
