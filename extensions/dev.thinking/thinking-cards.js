import { Decoration, EditorView, WidgetType, ViewPlugin } from "@codemirror/view";
import { StateField, StateEffect, Transaction } from "@codemirror/state";
import { ySyncAnnotation } from "y-codemirror.next";
import {
  buildRegexAnchors,
  filterDeletedItems,
  findAssistantBlockIdAtOffset,
  mergeItemsFromAnchors,
  planAssistantMarkerInsertionById,
  reconcileExactAnchors,
  reconcileNearestAnchors,
  stripCardMarkerIdComment,
  thinkingMarkerText
} from "../../src/chat/restore";
import {
  scheduleConversationViewportFollow
} from "../../src/chat/conversation-viewport.js";
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
const THINKING_ANCHOR_RE = /^思考(?:\s*<!--\s*zion-thinking:id=([^>\s]+)\s*-->)?$/gm;

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
  const text = String(docString || "");
  return buildRegexAnchors(text, THINKING_ANCHOR_RE, (match) => ({
    from: match.index,
    to: match.index + match[0].length,
    markerId: match[1] ? String(match[1]) : null,
    assistantBlockId: findAssistantBlockIdAtOffset(text, match.index)
  }));
}

function hasMatchingAssistantParent(item, anchor) {
  const expected = String(item?.assistantBlockId || "");
  return !expected || String(anchor?.assistantBlockId || "") === expected;
}

function isThinkingAnchorForItem(anchorText, id) {
  const parsed = parseThinkingAnchorText(anchorText);
  if (!parsed || parsed.visibleText !== "思考") return false;
  const expectedId = String(id || "");
  return !parsed.id || !expectedId || parsed.id === expectedId;
}

function migrateLegacyThinkingAnchors(view, items, knownAnchors = null) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return false;
  const allAnchors = Array.isArray(knownAnchors) ? knownAnchors : buildThinkingAnchors(view.state.doc.toString());
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

function mergeThinkingItemsFromAnchors(view, items, deletedIds, knownAnchors = null) {
  return mergeItemsFromAnchors({
    items,
    deletedIds,
    anchors: Array.isArray(knownAnchors)
      ? knownAnchors
      : buildThinkingAnchors(view.state.doc.toString()).filter((anchor) => anchor.markerId),
    createItem: (anchor) => ({
      id: String(anchor.markerId || ""),
      text: "",
      expanded: false,
      from: anchor.from,
      to: anchor.to,
      assistantBlockId: anchor.assistantBlockId || null
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

function repairDuplicateThinkingAnchorIds(view, items, deletedIds, knownAnchors = null) {
  const sourceItems = Array.isArray(items) ? items.slice() : [];
  const deleted = new Set(Array.from(deletedIds || []).map((id) => String(id)));
  const anchors = (Array.isArray(knownAnchors) ? knownAnchors : buildThinkingAnchors(view.state.doc.toString()))
    .filter((anchor) => anchor.markerId);
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

function setPendingRestore(sessionId, kind, items) {
  try {
    const previous = window?.zion?.commands?.executeCommand?.("zion.chatCards.getPendingRestore", {
      sessionId,
      kind
    }) || [];
    const nextById = new Map(previous.map((item) => [String(item?.id || ""), item]).filter(([id]) => !!id));
    for (const item of Array.isArray(items) ? items : []) {
      const id = String(item?.id || "");
      if (id) nextById.set(id, { ...(nextById.get(id) || {}), ...item });
    }
    window?.zion?.commands?.executeCommand?.("zion.chatCards.setPendingRestore", {
      sessionId,
      kind,
      items: [...nextById.values()]
    });
  } catch {}
}

function getViewSessionId(view) {
  try {
    return view?.dom?.getAttribute?.("data-session-id") || null;
  } catch {
    return null;
  }
}

function isCommentPanelId(panelId) {
  return String(panelId || "").startsWith("comments:");
}

function scheduleRevealThinkingContent(view, { id, pos } = {}) {
  try {
    const sid = getViewSessionId(view);
    if (!sid) return;
    const runId = window?.zion?.state?.get?.(`chat.runs.${sid}`)?.runId || "";
    scheduleConversationViewportFollow(view, {
      sessionId: sid,
      state: window?.zion?.state,
      cycleId: runId,
      reveal: () => {
        try {
          const scrollDOM = view?.scrollDOM;
          if (!scrollDOM) return false;
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
          if (nextScrollTop == null) return !!thinkingEl || typeof pos === "number";
          window?.zion?.state?.set?.(`chat.followSuppressUntil.${sid}`, Date.now() + 80);
          scrollDOM.__zionProgrammaticScrollUntil = Math.max(
            Number(scrollDOM.__zionProgrammaticScrollUntil) || 0,
            Date.now() + 80
          );
          scrollDOM.scrollTop = Math.max(0, nextScrollTop);
          return true;
        } catch {}
        return false;
      }
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

      const header = document.createElement("div");
      header.className = "zion-thinking-card-header";
      header.innerHTML = `<span class="codicon codicon-chevron-down" aria-hidden="true"></span><span>${t("ui.thinking", "思考")}</span>`;
      wrap.appendChild(header);

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
  toDOM(view) {
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
    btn.innerHTML = `<span class="codicon codicon-chevron-down" aria-hidden="true"></span>`;
    span.appendChild(btn);

    const txt = document.createElement("span");
    txt.className = "zion-thinking-inline-text";
    txt.textContent = t("ui.thinking", "思考");
    span.appendChild(txt);

    const renderedAt = Date.now();
    const sessionId = getViewSessionId(view);
    const state = window?.zion?.state;
    const latency = sessionId ? state?.get?.(`chat.latency.${sessionId}`) : null;
    if (latency?.runId && thinkingId.startsWith(`thinking:${latency.runId}:`)) {
      requestAnimationFrame(() => {
        if (!span.isConnected) return;
        const current = state?.get?.(`chat.latency.${sessionId}`);
        if (current?.runId !== latency.runId || current.stages?.firstThinkingCardVisible != null) return;
        state?.set?.(`chat.latency.${sessionId}`, {
          ...current,
          stages: {
            ...current.stages,
            firstThinkingCardRendered: renderedAt - current.submittedAt,
            firstThinkingCardVisible: Date.now() - current.submittedAt
          }
        });
      });
    }
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

    const it = items?.get?.(id);
    if (!it || !hasMatchingAssistantParent(it, anchor)) {
      decorations.push(Decoration.replace({}).range(anchor.from, anchor.to));
      continue;
    }
    decorations.push(Decoration.replace({ widget: new ThinkingInlineWidget(id) }).range(anchor.from, anchor.to));

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
        const {
          from,
          to,
          id,
          sessionId,
          runId,
          segmentKey,
          assistantBlockId,
          text,
          expanded
        } = e.value;
        const current = items.get(id);
        items.set(id, {
          ...current,
          from,
          to,
          expanded: current
            ? current.expanded === true
            : expanded === true,
          text: typeof text === "string" && text
            ? text
            : String(current?.text || ""),
          sessionId: sessionId || current?.sessionId || null,
          runId: runId || current?.runId || null,
          segmentKey: segmentKey || current?.segmentKey || null,
          assistantBlockId:
            assistantBlockId || current?.assistantBlockId || null
        });
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
            const userEvent = tr?.annotation?.(Transaction.userEvent);
            return userEvent === "zion.sessionLoad" || userEvent === "zion.sessionSeed";
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
    buildDecorations: (state) => buildThinkingDecorations(state, f),
    requiresRebuild: (tr) => tr.effects.some((effect) => {
      if (
        effect.is(clearAll)
        || effect.is(addInline)
        || effect.is(toggleInline)
        || effect.is(removeItem)
      ) {
        return true;
      }
      if (!effect.is(updateText)) return false;
      const id = String(effect.value?.id || "");
      try {
        return tr.startState.field(f, false)?.items?.get?.(id)?.expanded === true
          || tr.state.field(f, false)?.items?.get?.(id)?.expanded === true;
      } catch {
        return true;
      }
    })
  })
});

function updateContainsThinkingAnchor(update) {
  if (!update?.docChanged || !update?.changes) return false;
  let found = false;
  const doc = update.state.doc;
  update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (found) return;
    const startLine = doc.lineAt(Math.max(0, Math.min(doc.length, fromB))).number;
    const endLine = doc.lineAt(Math.max(0, Math.min(doc.length, toB))).number;
    for (let lineNo = startLine; lineNo <= endLine; lineNo++) {
      if (parseThinkingAnchorText(doc.line(lineNo).text)?.id) {
        found = true;
        return;
      }
    }
  });
  return found;
}

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
      this.currentDocumentWriter = false;
      this.assistantBlockId = "";
      this.buffer = "";
      this.timer = null;
      this.selRaf = 0;
      this.restoreCheckTimer = 0;
      this.snapshotTimer = 0;
      this.reasoningSeq = new Map();
      this.terminatedRunIds = new Set();

      try { this.panelId = this.view.dom.closest("[data-panel-id]")?.getAttribute("data-panel-id") || null; } catch { this.panelId = null; }
      try {
        this.sessionId = getViewSessionId(this.view);
      } catch {}

      this.disps.push(window.zion.events.on("chat/runStarted", this.onRunStarted));
      this.disps.push(window.zion.events.on("chat/reasoningStart", this.onReasoningStart));
      this.disps.push(window.zion.events.on("chat/reasoningToken", this.onReasoningToken));
      this.disps.push(window.zion.events.on("chat/reasoningEnd", this.onReasoningEnd));
      this.disps.push(window.zion.events.on("chat/runFinished", this.onRunTerminated));
      this.disps.push(window.zion.events.on("chat/runError", this.onRunTerminated));
      this.disps.push(window.zion.events.on("chat/aborted", this.onRunTerminated));
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
          const list = mergeThinkingItemsFromAnchors(
            this.view,
            repair.items,
            deletedIds,
            repair.repaired > 0 ? null : anchors
          );
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
        const list = mergeThinkingItemsFromAnchors(
          this.view,
          repair.items,
          deletedIds,
          repair.repaired > 0 ? null : anchors
        );
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
    scheduleRestoreCheck = (delay = 40) => {
      if (this.restoreCheckTimer > 0) window.clearTimeout(this.restoreCheckTimer);
      if (delay <= 0) {
        this.restoreCheckTimer = -1;
        Promise.resolve().then(() => {
          if (this.restoreCheckTimer !== -1) return;
          this.restoreCheckTimer = 0;
          this.checkAndRestoreWidgets();
        });
        return;
      }
      this.restoreCheckTimer = window.setTimeout(() => {
        this.restoreCheckTimer = 0;
        this.checkAndRestoreWidgets();
      }, delay);
    };
    scheduleSnapshot = () => {
      if (this.snapshotTimer) window.clearTimeout(this.snapshotTimer);
      this.snapshotTimer = window.setTimeout(() => {
        this.snapshotTimer = 0;
        this.snapshot();
      }, 120);
    };

    update(update) {
      if (this.suspendSnapshot) return;
      const sessionLoadEvent = (() => {
        try {
          return update.transactions
            ?.map?.((tr) => tr?.annotation?.(Transaction.userEvent))
            ?.find?.((event) => event === "zion.sessionLoad" || event === "zion.sessionSeed") || "";
        } catch {
          return "";
        }
      })();
      const isSessionReplace = !!sessionLoadEvent;
      const isRemoteCollaborationUpdate = update.transactions.some((tr) =>
        !!tr?.annotation?.(ySyncAnnotation)
      );
      if (sessionLoadEvent === "zion.sessionLoad") {
        this.scheduleRestoreCheck(0);
      } else {
          if (!isSessionReplace && update.docChanged && updateContainsThinkingAnchor(update)) {
            this.scheduleRestoreCheck();
          }
        const effects = update.transactions.flatMap((tr) => tr.effects);
        const hasEffects = effects.some((effect) =>
          effect.is(clearAll) ||
          effect.is(addInline) ||
          effect.is(toggleInline) ||
          effect.is(updateText) ||
          effect.is(removeItem)
        );
        const mirroredTextOnly = !this.currentDocumentWriter
          && effects.length > 0
          && effects.every((effect) => effect.is(updateText));
        if (!isRemoteCollaborationUpdate && (
          update.docChanged
          || (hasEffects && !mirroredTextOnly)
        )) {
          this.scheduleSnapshot();
        }
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
            segmentKey: this.currentId === key ? this.currentSegmentKey : it.segmentKey,
            assistantBlockId: it.assistantBlockId || null
          });
        });
        updateSessionAnnotations(id, (prev) => {
          const prevThinking = Array.isArray(prev.thinking) ? prev.thinking : [];
          if (!arr.length && prevThinking.length) {
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
      try {
        const fieldVal = this.view.state.field(thinkingField, false);
        if (!fieldVal?.items?.has?.(this.currentId)) {
          if (!this.timer) {
            this.timer = setTimeout(() => {
              this.timer = null;
              this.flush();
            }, 30);
          }
          return;
        }
      } catch {
        return;
      }
      let text = this.buffer;
      let replace = false;
      this.buffer = "";
      if (!this.currentDocumentWriter) {
        try {
          const annotations = getSessionAnnotations(this.sessionId);
          const mirrored = (Array.isArray(annotations.thinking)
            ? annotations.thinking
            : []
          ).find((item) => String(item?.id || "") === String(this.currentId));
          if (mirrored?.text) {
            text = String(mirrored.text);
            replace = true;
          }
        } catch {}
      }
      try {
        // 1) 更新状态（累加到 items 中）
        this.view.dispatch({
          effects: [updateText.of({ id: this.currentId, text, replace })]
        });
        // 持久化快照
        if (this.currentDocumentWriter) this.snapshot();
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
      if (!payload?.sessionId && payload?.panelId && this.panelId && payload.panelId !== this.panelId) return false;
      if (!payload?.panelId && !payload?.sessionId) {
        const activePanelId = window.zion?.panels?.getActivePanelId?.() || null;
        if (this.panelId && activePanelId && this.panelId !== activePanelId) return false;
      }
      this.sessionId = visibleSessionId;
      return true;
    };
    isPrimaryWriterPayload = (payload) => {
      if (payload?.documentWriter === false) return false;
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
        this.view.dispatch({
          effects: [addInline.of({
            from: it.from,
            to: it.to,
            id,
            sessionId: sid,
            runId: it.runId,
            segmentKey: it.segmentKey,
            assistantBlockId: it.assistantBlockId || null
          })]
        });
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
      const nextRunId = String(payload?.runId || "");
      if (this.currentRunId && nextRunId && this.currentRunId !== nextRunId) {
        this.terminatedRunIds.add(this.currentRunId);
      }
      if (nextRunId) this.terminatedRunIds.delete(nextRunId);
      this.assistantBlockId = String(payload?.assistantBlockId || "");
      try {
        const sid = this.sessionId;
        const runId = payload?.runId;
        if (sid && runId) this.setSeq(sid, runId, 0);
      } catch {}
      // 新一轮运行，清空缓冲（保留历史思考行）
      this.currentId = null;
      this.currentRunId = nextRunId;
      this.currentSegmentKey = "";
      this.currentDocumentWriter = false;
      this.buffer = "";
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    };
    acceptsRunEvent = (payload) => {
      const runId = String(payload?.runId || "");
      if (!runId) return true;
      if (this.terminatedRunIds.has(runId)) return false;
      return !this.currentRunId || runId === this.currentRunId;
    };
    onRunTerminated = (payload) => {
      if (!this.shouldHandleScopedPayload(payload)) return;
      const runId = String(payload?.runId || "");
      if (runId) {
        this.terminatedRunIds.add(runId);
        while (this.terminatedRunIds.size > 32) {
          this.terminatedRunIds.delete(this.terminatedRunIds.values().next().value);
        }
      }
      if (runId && this.currentRunId && runId !== this.currentRunId) return;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.currentId = null;
      this.currentRunId = "";
      this.currentSegmentKey = "";
      this.currentDocumentWriter = false;
      this.assistantBlockId = "";
      this.buffer = "";
    };
    onReasoningStart = (payload) => {
      if (payload?.silentReasoning) return;
      const visible = !!window.zion.state.get("chat.thinkingVisible");
      if (!visible) return;
      if (!this.shouldHandleScopedPayload(payload)) return;
      if (!this.acceptsRunEvent(payload)) return;
      this.suspendSnapshot = false;

      const runId = payload?.runId || Math.random().toString(36).slice(2);
      const assistantBlockId = String(
        payload?.assistantBlockId
        || (runId === this.currentRunId ? this.assistantBlockId : "")
      );
      if (!assistantBlockId) return;
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
      const documentWriter = this.isPrimaryWriterPayload(payload);
      this.currentId = id;
      this.currentRunId = runId;
      this.currentSegmentKey = segmentKey;
      this.currentDocumentWriter = documentWriter;
      this.assistantBlockId = assistantBlockId;

      if (!documentWriter) {
        try {
          this.checkAndRestoreWidgets();
        } catch {}
        setTimeout(() => {
          try { this.ensureInlineForThinkingId(sid, id) || this.checkAndRestoreWidgets(); } catch {}
        }, 0);
        return;
      }

      if (sid) this.setSeq(sid, runId, seq);

      const plan = planAssistantMarkerInsertionById({
        docText: this.view.state.doc.toString(),
        assistantBlockId,
        markerText: thinkingMarkerText(id),
        trailingNewlines: 2
      });
      if (!plan) {
        setPendingRestore(sid, "thinking", [{
          id,
          runId,
          segmentKey,
          assistantBlockId,
          text: "",
          expanded: false
        }]);
        return;
      }

      this.view.dispatch({
        changes: { from: plan.replaceFrom ?? plan.insertPos, to: plan.replaceTo ?? plan.insertPos, insert: plan.insertText },
        effects: [addInline.of({
          from: plan.markerFrom,
          to: plan.markerTo,
          id,
          sessionId: sid,
          runId,
          segmentKey,
          assistantBlockId
        })]
      });
      scheduleRevealThinkingContent(this.view, { id, pos: plan.markerTo });
      this.snapshot();
    };
    onReasoningToken = (payload) => {
      if (payload?.silentReasoning) return;
      const visible = !!window.zion.state.get("chat.thinkingVisible");
      if (!visible) return;
      if (!this.shouldHandleScopedPayload(payload)) return;
      if (!this.acceptsRunEvent(payload)) return;

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
          this.currentDocumentWriter = this.isPrimaryWriterPayload(payload);
          this.assistantBlockId = String(payload?.assistantBlockId || this.assistantBlockId || "");
          this.ensureInlineForThinkingId(sid, id);
        }
      }
      if (!this.currentId) this.onReasoningStart({ ...payload, runId: payload?.runId, sessionId: payload?.sessionId });
      if (!this.currentId) return;
      this.currentDocumentWriter = this.isPrimaryWriterPayload(payload);

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
      if (!this.acceptsRunEvent(payload)) return;
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
        this.currentRunId = "";
        this.currentSegmentKey = "";
        this.currentDocumentWriter = false;
        this.assistantBlockId = "";
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
        return;
      }
      const visibleSessionId = this.getVisibleSessionId();
      if (!visibleSessionId) return;
      if (payload?.sessionId && payload.sessionId !== visibleSessionId) {
        return;
      }
      const restoreSessionId = visibleSessionId;
      this.sessionId = restoreSessionId;

      this.suspendSnapshot = false;
      let docString = this.view.state.doc.toString();
      if (!docString.trim()) {
        return;
      }
      let anchors = buildThinkingAnchors(docString);
      let markerAnchors = anchors.filter((anchor) => anchor.markerId);

      let deletedIds = [];
      try {
        const sid = restoreSessionId;
        const ann = sid ? getSessionAnnotations(sid) : {};
          deletedIds = reviveDeletedThinkingIdsForAnchors(sid, Array.isArray(ann.deletedThinkingIds) ? ann.deletedThinkingIds : [], markerAnchors);
      } catch {}
      const repair = repairDuplicateThinkingAnchorIds(this.view, list, deletedIds, markerAnchors);
      if (repair.repaired > 0) {
        docString = this.view.state.doc.toString();
        anchors = buildThinkingAnchors(docString);
        markerAnchors = anchors.filter((anchor) => anchor.markerId);
      }
      const mergedList = mergeThinkingItemsFromAnchors(this.view, repair.items, deletedIds, markerAnchors);
      const activeStreamingId = this.currentDocumentWriter
        && this.currentId
        && (this.buffer || this.timer)
        ? String(this.currentId)
        : "";
      const itemsToProcess = filterDeletedItems(mergedList, deletedIds).filter((it) => String(it?.id || "") !== activeStreamingId);
      if (migrateLegacyThinkingAnchors(this.view, itemsToProcess, anchors)) {
        docString = this.view.state.doc.toString();
        anchors = buildThinkingAnchors(docString);
      }

      const doc = this.view.state.doc;
      const docLen = doc.length;
      const batchedEffects = [];
      const processedIds = new Set();
      let skippedFallback = false;

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
          if (!hasMatchingAssistantParent(it, anchor)) return false;
          return isThinkingAnchorForItem(doc.sliceString(it.from, it.to), it.id);
        },
        onMatch: (it, anchor) => {
          batchedEffects.push(addInline.of({
            from: anchor.from,
            to: anchor.to,
            id: it.id,
            sessionId: restoreSessionId,
            runId: it.runId,
            segmentKey: it.segmentKey,
            assistantBlockId: it.assistantBlockId || null,
            text: it.text,
            expanded: it.expanded === true
          }));
        }
      });

      // Phase 2: 模糊匹配 (Nearest Neighbor)
      reconcileNearestAnchors({
        items: itemsToProcess,
        processedIds,
        anchors,
        canUseAnchor: (it, anchor) =>
          (!anchor.markerId || anchor.markerId === String(it.id || ""))
          && hasMatchingAssistantParent(it, anchor),
        onMatch: (it, anchor) => {
          batchedEffects.push(addInline.of({
            from: anchor.from,
            to: anchor.to,
            id: it.id,
            sessionId: restoreSessionId,
            runId: it.runId,
            segmentKey: it.segmentKey,
            assistantBlockId: it.assistantBlockId || null,
            text: it.text,
            expanded: it.expanded === true
          }));
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

      // Phase 3: 兜底
      for (const it of itemsToProcess) {
        if (processedIds.has(it.id)) continue;
        if (it?.requiresDocumentAnchor === true) {
          skippedFallback = true;
          continue;
        }
        const sameIdAnchor = anchors.find((anchor) => String(anchor.markerId || "") === String(it.id || ""));
        if (sameIdAnchor && !hasMatchingAssistantParent(it, sameIdAnchor)) {
          skippedFallback = true;
          setPendingRestore(restoreSessionId, "thinking", [it]);
          continue;
        }
        if (isCommentPanelId(this.panelId)) {
          skippedFallback = true;
          continue;
        }

        const plan = planAssistantMarkerInsertionById({
          docText: this.view.state.doc.toString(),
          assistantBlockId: it.assistantBlockId,
          markerText: thinkingMarkerText(it.id),
          trailingNewlines: 2
        });
        if (!plan) {
          skippedFallback = true;
          setPendingRestore(restoreSessionId, "thinking", [it]);
          continue;
        }

        this.view.dispatch({
          changes: { from: plan.replaceFrom ?? plan.insertPos, to: plan.replaceTo ?? plan.insertPos, insert: plan.insertText },
          annotations: Transaction.userEvent.of("zion.cardRestore"),
          effects: [addInline.of({
            from: plan.markerFrom,
            to: plan.markerTo,
            id: it.id,
            sessionId: restoreSessionId,
            runId: it.runId,
            segmentKey: it.segmentKey,
            assistantBlockId: it.assistantBlockId || null,
            text: it.text,
            expanded: it.expanded === true
          })]
        });
        scheduleRevealThinkingContent(this.view, { id: it.id, pos: plan.markerTo });

        it.from = plan.markerFrom;
        it.to = plan.markerTo;
        processedIds.add(it.id);
      }

      try {
        if (restoreSessionId && processedIds.size >= itemsToProcess.length) {
          clearPendingRestore(restoreSessionId, "thinking");
        }
      } catch {}
      if (!skippedFallback) this.snapshot();
    };
    destroy() {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      try { this.reasoningSeq.clear(); } catch {}
      for (const d of this.disps) { try { d?.dispose?.(); } catch {} }
      try { if (this.selRaf) window.cancelAnimationFrame(this.selRaf); } catch {}
      try { if (this.restoreCheckTimer) window.clearTimeout(this.restoreCheckTimer); } catch {}
      try { if (this.snapshotTimer) window.clearTimeout(this.snapshotTimer); } catch {}
      this.restoreCheckTimer = 0;
      this.snapshotTimer = 0;
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
  let stored = null;
  try {
    const ann = sid ? getSessionAnnotations(sid) : {};
      reviveDeletedThinkingIdsForAnchors(sid, Array.isArray(ann.deletedThinkingIds) ? ann.deletedThinkingIds : [], [anchor]);
    const list = Array.isArray(ann.thinking) ? ann.thinking : [];
    stored = list.find((x) => String(x?.id || "") === wantId) || null;
    if (stored) {
      text = typeof stored.text === "string" ? stored.text : "";
      expanded = !!stored.expanded;
    }
  } catch {}

  try {
    const effects = [addInline.of({
      from: anchor.from,
      to: anchor.to,
      id: wantId,
      sessionId: sid,
      assistantBlockId: stored?.assistantBlockId || null,
      text,
      expanded
    })];
    view.dispatch({ effects });
    return true;
  } catch {
    return false;
  }
}
