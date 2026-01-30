import { Decoration, EditorView, WidgetType, ViewPlugin } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";

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
    header.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;";
    const title = document.createElement("span");
    title.textContent = "思考";
    Object.assign(title.style, { fontSize: "11px", fontWeight: "600" });
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "移除思考记录";
    Object.assign(close.style, {
      marginLeft: "auto",
      background: "transparent",
      border: "1px solid var(--border)",
      color: "var(--fg)",
      borderRadius: "4px",
      padding: "0 6px",
      lineHeight: "16px",
      fontSize: "11px",
      cursor: "pointer"
    });
    close.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      const baseId = String(this.id).replace(/:card$/, "");
      try { window.zion?.events?.emit("thinking/remove", { id: baseId }); } catch {}
    });
    header.appendChild(title);
    header.appendChild(close);
    wrap.appendChild(header);

    const body = document.createElement("pre");
    body.textContent = fmt(this.text, 5000);
    Object.assign(body.style, {
      margin: 0,
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontFamily: "var(--font-mono)",
      fontSize: "11px"
    });
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
    span.setAttribute("data-thinking-id", String(this.id).replace(/:inline$/, ""));
    span.title = "思考（点击展开/收起）";
    span.setAttribute("aria-label", "思考（点击展开或收起卡片）");

    const btn = document.createElement("button");
    btn.className = "zion-thinking-inline-toggle";
    btn.type = "button";
    btn.title = "展开/收起思考内容";
    btn.setAttribute("aria-label", "展开/收起思考内容");
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M4.646 6.646a.5.5 0 0 1 .708 0L8 9.293l2.646-2.647a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 0 1 0-.708z"></path>
</svg>`;
    span.appendChild(btn);

    const txt = document.createElement("span");
    txt.className = "zion-thinking-inline-text";
    txt.textContent = "思考";
    span.appendChild(txt);

    return span;
  }
  ignoreEvent() { return false; }
}

/**
 * Field value：{ deco: DecorationSet, items: Map<id, { from, to, expanded, text }> }
 */
const thinkingField = StateField.define({
  create() {
    return { deco: Decoration.none, items: new Map() };
  },
  update(val, tr) {
    let deco = val.deco.map(tr.changes);
    const items = new Map();
    val.items.forEach((it, id) => {
      const from = tr.changes.mapPos(it.from, 1);
      const to = tr.changes.mapPos(it.to, -1);
      items.set(id, { ...it, from, to });
    });

    for (const e of tr.effects) {
      if (e.is(clearAll)) {
        deco = Decoration.none;
        items.clear();
        continue;
      }
      if (e.is(addInline)) {
        const { from, to, id } = e.value;
        const widget = new ThinkingInlineWidget(id);
        const repl = Decoration.replace({ widget }).range(from, to);
        deco = deco.update({ add: [repl] });
        items.set(id, { from, to, expanded: false, text: "" });
      }
      if (e.is(toggleInline)) {
        const id = e.value?.id;
        const it = id ? items.get(id) : null;
        if (!it) continue;
        if (it.expanded) {
          deco = deco.update({
            filter: (_f, _t, value) => value?.spec?.widget?.id !== (id + ":card")
          });
          items.set(id, { ...it, expanded: false });
        } else {
          const widget = new ThinkingCardWidget(id, it.text);
          deco = deco.update({ add: [Decoration.widget({ widget, block: true }).range(it.to)] });
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
        // 若已展开，刷新卡片 widget（通过 updateDOM 原位更新，避免闪烁）
        if (updated.expanded) {
          deco = deco.update({
            filter: (_f, _t, value) => value?.spec?.widget?.id !== (id + ":card")
          });
          const widget = new ThinkingCardWidget(id, updated.text);
          deco = deco.update({ add: [Decoration.widget({ widget, block: true }).range(updated.to)] });
        }
      }
      if (e.is(removeItem)) {
        const base = String(e.value?.id || "");
        deco = deco.update({
          filter: (_f, _t, value) => {
            const wid = value?.spec?.widget?.id || "";
            return !(wid === (base + ":card") || wid === (base + ":inline"));
          }
        });
        items.delete(base);

        try {
          const sid = window?.zion?.state?.get("sessions.currentId");
          if (sid) {
            const ann = window?.zion?.state?.get(`sessions.annotations.${sid}`) || {};
            const del = Array.isArray(ann.deletedThinkingIds) ? ann.deletedThinkingIds.slice() : [];
            if (!del.includes(base)) del.push(base);
            window?.zion?.state?.set(`sessions.annotations.${sid}`, { ...ann, deletedThinkingIds: del });
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
        if (String(anchor).trim() !== "思考") {
          toRemove.push(id);
        }
      });
      if (toRemove.length) {
        deco = deco.update({
          filter: (_f, _t, value) => {
            const wid = value?.spec?.widget?.id || "";
            return !toRemove.some(id => wid === (id + ":inline") || wid === (id + ":card"));
          }
        });
        toRemove.forEach(id => items.delete(id));
      }
    } catch {}

    return { deco, items };
  },
  provide: f => EditorView.decorations.from(f, v => v.deco)
});

function findAssistantBlockEnd(view) {
  const { state } = view;
  const doc = state.doc;
  const lines = doc.toString().replace(/\r/g, "").split("\n");

  let headIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(system|user|assistant|tool)\s+/);
    if (m && m[1] === "assistant") { headIdx = i; break; }
  }
  if (headIdx < 0) return doc.length;

  let endIdx = headIdx;
  for (let i = headIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(system|user|assistant|tool)\s+/);
    if (m) break;
    endIdx = i;
  }
  return doc.line(endIdx + 1).to;
}

function findAssistantBlockEndNear(view, hintPos) {
  const { state } = view;
  const doc = state.doc;
  const txt = doc.toString().replace(/\r/g, "");
  const lines = txt.split("\n");

  const hint = typeof hintPos === "number" ? hintPos : (state.selection?.main?.head ?? doc.length);
  const hintLine = doc.lineAt(hint).number - 1;

  // 自 hintLine 向上查找最近的 assistant 头
  let headIdx = -1;
  for (let i = hintLine; i >= 0; i--) {
    const m = lines[i].match(/^(system|user|assistant|tool)\s+/);
    if (m && m[1] === "assistant") { headIdx = i; break; }
  }
  // 若未找到，回退到最后一个 assistant
  if (headIdx < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^(system|user|assistant|tool)\s+/);
      if (m && m[1] === "assistant") { headIdx = i; break; }
    }
  }
  if (headIdx < 0) return doc.length;

  // 从 headIdx 往下直到下一个角色头行，前一行为区块末尾
  let endIdx = headIdx;
  for (let i = headIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(system|user|assistant|tool)\s+/);
    if (m) break;
    endIdx = i;
  }
  return doc.line(endIdx + 1).to;
}

export function installThinkingCards() {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.disps = [];
      this.sessionId = null;
      this.suspendSnapshot = false;
      this.currentId = null;
      this.buffer = "";
      this.timer = null;

      try { this.sessionId = window.zion?.state?.get("sessions.currentId") || null; } catch {}

      this.disps.push(window.zion.events.on("chat/runStarted", this.onRunStarted));
      this.disps.push(window.zion.events.on("chat/reasoningStart", this.onReasoningStart));
      this.disps.push(window.zion.events.on("chat/reasoningToken", this.onReasoningToken));
      this.disps.push(window.zion.events.on("chat/reasoningEnd", this.onReasoningEnd));
      this.disps.push(window.zion.events.on("thinking/remove", this.onRemove));
      this.disps.push(window.zion.events.on("thinking/restore", this.onRestore));
      this.disps.push(window.zion.events.on("thinking/clear", this.onClear));
      // 清理与会话切换联动
      this.disps.push(window.zion.state.onDidChange("sessions.currentId", this.onSessionChanged));
      // 初始快照
      this.snapshot();

      Promise.resolve().then(() => {
        try {
          const sid = window.zion?.state?.get("sessions.currentId");
          const pending = sid ? window.zion?.state?.get(`sessions.pendingRestore.thinking.${sid}`) : null;
          if (Array.isArray(pending) && pending.length) {
            this.onRestore({ items: pending });
            return;
          }

          const ann = sid ? (window.zion?.state?.get(`sessions.annotations.${sid}`) || {}) : {};
          const list = Array.isArray(ann.thinking) ? ann.thinking : [];
          if (!list.length) return;
          let size = 0;
          try { size = this.view.state.field(thinkingField)?.items?.size || 0; } catch {}
          let domCount = 0;
          try { domCount = document.querySelectorAll(".zion-thinking-inline").length; } catch {}
          if (size >= list.length && domCount >= list.length) return;
          this.onRestore({ items: list });
        } catch {}
      });
    }
    update(update) {
      if (this.suspendSnapshot) return;
      this.snapshot();
    }
    snapshot = () => {
      try {
        const id = this.sessionId || window.zion?.state?.get("sessions.currentId");
        if (!id) return;
        const fieldVal = this.view.state.field(thinkingField);
        const arr = [];
        fieldVal.items.forEach((it, key) => {
          arr.push({
            id: key,
            text: it.text,
            expanded: it.expanded,
            from: it.from,
            to: it.to
          });
        });
        const prev = window.zion?.state?.get(`sessions.annotations.${id}`) || {};
        window.zion?.state?.set(`sessions.annotations.${id}`, { ...prev, thinking: arr });
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
    getSeq(sid, runId) {
      try {
        const v = window.zion?.state?.get(this.seqKey(sid, runId));
        return typeof v === "number" && Number.isFinite(v) ? v : 0;
      } catch {
        return 0;
      }
    }
    setSeq(sid, runId, seq) {
      try { window.zion?.state?.set(this.seqKey(sid, runId), seq); } catch {}
    }
    ensureInlineForThinkingId(sid, id) {
      try {
        const fieldVal = this.view.state.field(thinkingField);
        if (fieldVal?.items?.has?.(id)) return true;
      } catch {}

      try {
        const ann = sid ? (window.zion?.state?.get(`sessions.annotations.${sid}`) || {}) : {};
        const list = Array.isArray(ann.thinking) ? ann.thinking : [];
        const it = list.find(x => x?.id === id);
        if (!it) return false;
        const docLen = this.view.state.doc.length;
        const hasRange = typeof it.from === "number" && typeof it.to === "number";
        const validRange = hasRange && it.from >= 0 && it.from < it.to && it.to <= docLen;
        if (!validRange) return false;
        this.view.dispatch({ effects: [addInline.of({ from: it.from, to: it.to, id })] });
        if (it.text) this.view.dispatch({ effects: [updateText.of({ id, text: it.text, replace: true })] });
        if (it.expanded) this.view.dispatch({ effects: [toggleInline.of({ id })] });
        return true;
      } catch {
        return false;
      }
    }
    onRunStarted = (payload) => {
      const cur = window.zion?.state?.get("sessions.currentId");
      if (payload?.sessionId && payload.sessionId !== cur) return;
      this.sessionId = cur || this.sessionId;
      try {
        const sid = this.sessionId;
        const runId = payload?.runId;
        if (sid && runId) this.setSeq(sid, runId, 0);
      } catch {}
      // 新一轮运行，清空缓冲（保留历史思考行）
      this.currentId = null;
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
      const visible = !!window.zion.state.get("chat.thinkingVisible");
      if (!visible) return;
      const cur = window.zion?.state?.get("sessions.currentId");
      if (payload?.sessionId && payload.sessionId !== cur) return;
      this.sessionId = cur || this.sessionId;
      this.suspendSnapshot = false;

      const runId = payload?.runId || Math.random().toString(36).slice(2);
      const sid = this.sessionId;
      const seq = sid ? (this.getSeq(sid, runId) + 1) : 1;
      if (sid) this.setSeq(sid, runId, seq);
      const id = `thinking:${runId}:${seq}`;
      this.currentId = id;

      this.ensureAssistantHead();

      const hint = (sid ? window.zion?.state?.get(`chat.answerAnchorPos.${sid}`) : undefined) ?? window.zion?.state?.get("chat.answerAnchorPos");
      const doc = this.view.state.doc;
      const pos = typeof hint === "number" ? findAssistantBlockEndNear(this.view, hint) : findAssistantBlockEnd(this.view);
      const prevChar = pos > 0 ? doc.sliceString(pos - 1, pos) : "";
      const prefix = prevChar === "\n" || pos === 0 ? "" : "\n";
      const text = `${prefix}思考\n\n`;
      const start = pos + prefix.length;
      const end = start + "思考".length;

      this.view.dispatch({
        changes: { from: pos, insert: text },
        effects: [addInline.of({ from: start, to: end, id })]
      });
      this.snapshot();
    };
    onReasoningToken = (payload) => {
      const visible = !!window.zion.state.get("chat.thinkingVisible");
      if (!visible) return;
      const cur = window.zion?.state?.get("sessions.currentId");
      if (payload?.sessionId && payload.sessionId !== cur) return;
      this.sessionId = cur || this.sessionId;

      const runId = payload?.runId;
      const sid = this.sessionId;
      if (!this.currentId && sid && runId) {
        const seq = this.getSeq(sid, runId);
        if (seq > 0) {
          const id = `thinking:${runId}:${seq}`;
          this.currentId = id;
          this.ensureInlineForThinkingId(sid, id);
        }
      }
      if (!this.currentId) this.onReasoningStart({ runId: payload?.runId, sessionId: payload?.sessionId });

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
      const cur = window.zion?.state?.get("sessions.currentId");
      if (payload?.sessionId && payload.sessionId !== cur) return;
      this.sessionId = cur || this.sessionId;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.flush();
    };
    onRemove = (payload) => {
      const id = payload?.id || this.currentId;
      if (!id) return;
      this.view.dispatch({ effects: [removeItem.of({ id })] });
      if (this.currentId === id) this.currentId = null;
      this.snapshot();
    };
    onClear = () => {
      this.view.dispatch({ effects: [clearAll.of({})] });
      this.snapshot();
    };
    onSessionChanged = (nv) => {
      this.suspendSnapshot = true;
      try {
        if (typeof nv === "string") this.sessionId = nv || null;
        else this.sessionId = window.zion?.state?.get("sessions.currentId") || null;
      } catch {}
      // 在会话切换时清空当前思考卡片，避免跨会话污染
      try { this.view.dispatch({ effects: [clearAll.of({})] }); } catch {}
      // 重置状态与缓冲
      this.currentId = null;
      this.buffer = "";
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }

      Promise.resolve().then(() => {
        this.suspendSnapshot = false;
      });
    };
    onRestore = (payload) => {
      const list = payload?.items || payload;
      if (!Array.isArray(list) || list.length === 0) return;

      this.suspendSnapshot = false;

      try {
        const sid = window.zion?.state?.get("sessions.currentId");
        if (sid) window.zion?.state?.set(`sessions.pendingRestore.thinking.${sid}`, null);
      } catch {}

      let deletedSet = new Set();
      try {
        const sid = window.zion?.state?.get("sessions.currentId");
        const ann = sid ? (window.zion?.state?.get(`sessions.annotations.${sid}`) || {}) : {};
        const del = Array.isArray(ann.deletedThinkingIds) ? ann.deletedThinkingIds : [];
        deletedSet = new Set(del);
      } catch {}

      const docLen = this.view.state.doc.length;
      const batchedEffects = [];
      const batchedToggles = [];

      for (const it of list) {
        if (deletedSet.has(it?.id)) continue;
        const hasRange = typeof it?.from === "number" && typeof it?.to === "number";
        const validRange = hasRange && it.from >= 0 && it.from < it.to && it.to <= docLen;

        if (validRange) {
          batchedEffects.push(addInline.of({ from: it.from, to: it.to, id: it.id }));
          if (it?.text) batchedEffects.push(updateText.of({ id: it.id, text: it.text, replace: true }));
          if (it.expanded) batchedToggles.push(it.id);
        } else {
          // 回退：在 assistant 区块末尾插入“思考”并重建装饰
          const docNow = this.view.state.doc;
          const pos = findAssistantBlockEnd(this.view);
          const prevChar = pos > 0 ? docNow.sliceString(pos - 1, pos) : "";
          const prefix = prevChar === "\n" || pos === 0 ? "" : "\n";
          const text = `${prefix}思考\n\n`;
          const start = pos + prefix.length;
          const end = start + "思考".length;

          this.view.dispatch({
            changes: { from: pos, insert: text },
            effects: [addInline.of({ from: start, to: end, id: it.id })]
          });
          try {
            const sid = window.zion?.state?.get("sessions.currentId");
            const prev = sid ? (window.zion?.state?.get(`sessions.annotations.${sid}`) || {}) : {};
            const list2 = Array.isArray(prev.thinking)
              ? prev.thinking.map(x => x?.id === it.id ? { ...x, from: start, to: end } : x)
              : [{ id: it.id, text: it?.text || "", expanded: !!it?.expanded, from: start, to: end }];
            if (sid) window.zion?.state?.set(`sessions.annotations.${sid}`, { ...prev, thinking: list2 });
          } catch {}
          if (it?.text) {
            this.view.dispatch({ effects: [updateText.of({ id: it.id, text: it.text, replace: true })] });
          }
          if (it.expanded) {
            this.view.dispatch({ effects: [toggleInline.of({ id: it.id })] });
          }
          try {
            const sid = window.zion?.state?.get("sessions.currentId");
            const ok = this.ensureInlineForThinkingId(sid, it.id);
            if (!ok) {
              setTimeout(() => {
                try { this.ensureInlineForThinkingId(sid, it.id); } catch {}
              }, 30);
            }
          } catch {}
        }
      }

      if (batchedEffects.length) this.view.dispatch({ effects: batchedEffects });
      if (batchedToggles.length) {
        const eff2 = batchedToggles.map(id => toggleInline.of({ id }));
        this.view.dispatch({ effects: eff2 });
      }

      this.snapshot();
    };
    destroy() {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      for (const d of this.disps) { try { d?.dispose?.(); } catch {} }
    }
  });

  const handlers = EditorView.domEventHandlers({
    click(event, view) {
      const el = event.target instanceof Element ? event.target.closest(".zion-thinking-inline") : null;
      if (!el) return false;
      const id = el.getAttribute("data-thinking-id");
      if (!id) return false;
      view.dispatch({ effects: [toggleInline.of({ id })] });
      event.preventDefault();
      return true;
    }
  });

  return [thinkingField, plugin, handlers];
}
