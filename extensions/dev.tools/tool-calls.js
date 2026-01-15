import { Decoration, EditorView, WidgetType, ViewPlugin } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";

/**
 * Effects:
 * - addInline: 在文档中插入“调用 xxx”文本并为其加 mark 装饰
 * - toggleInline: 展开/收起该行末尾的卡片 widget
 * - updateResult: 更新卡片内容（args/result）
 * - removeTool: 移除该工具的文本装饰与卡片
 * - clearAll: 预留清空（当前不主动使用）
 */
const addInline = StateEffect.define();   // { from, to, id, name, args }
const toggleInline = StateEffect.define(); // { id }
const updateResult = StateEffect.define(); // { id, result }
const removeTool = StateEffect.define();   // { id }
const clearAll = StateEffect.define();

function fmt(v, max = 8000) {
  let s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  if (s.length > max) s = s.slice(0, max) + "\n…";
  return s;
}

function notify(message, options) {
  try {
    const fn = window.zion?.notification?.show;
    if (typeof fn === "function") return fn(String(message ?? ""), options || {});
  } catch {}
  try {
    if (typeof window.showToast === "function") return window.showToast(String(message ?? ""));
  } catch {}
  try {
    console.info("[notify]", message);
  } catch {}
  return null;
}

// 简要摘要：根据工具名称与参数，生成单行提示（便于用户无需展开卡片也能知情）
function clip(s, max = 80) {
  const t = String(s || "");
  return t.length > max ? t.slice(0, max) + "…" : t;
}
function summarizeToolArgs(name, args) {
  const n = String(name || "");
  const a = args || {};
  try {
    switch (n) {
      case "webSearch": {
        const q = String(a?.query || "").trim();
        return q ? `${clip(q, 100)}` : "";
      }
      case "localSearch": {
        const q = String(a?.query || "").trim();
        return q ? `${clip(q, 100)}` : "";
      }
      case "webFetch": {
        const url = String(a?.url || "").trim();
        return url ? `${clip(url, 120)}` : "";
      }
      case "fsTree": {
        const dir = String(a?.directory_path || "").trim();
        const md = typeof a?.max_depth === "number" ? a.max_depth : null;
        if (!dir) return "";
        return md ? `${clip(dir, 120)} (depth=${md})` : `${clip(dir, 120)}`;
      }
      case "fsRead": {
        const fp = String(a?.file_path || "").trim();
        const off = typeof a?.offset === "number" ? a.offset : null;
        const lim = typeof a?.limit === "number" ? a.limit : null;
        if (!fp) return "";
        let s = `${clip(fp, 120)}`;
        if (off != null || lim != null) {
          s += ` (offset=${off != null ? off : "-"}, limit=${lim != null ? lim : "-"})`;
        }
        return s;
      }
      case "glob": {
        const p = String(a?.pattern || "").trim();
        const dir = String(a?.path || "").trim();
        if (!p && !dir) return "";
        return dir ? `${clip(p, 60)} in ${clip(dir, 60)}` : `${clip(p, 100)}`;
      }
      case "grep": {
        const p = String(a?.pattern || "").trim();
        const dir = String(a?.path || "").trim();
        const mode = String(a?.output_mode || "").trim();
        const glb = Array.isArray(a?.glob) ? a.glob.join(",") : String(a?.glob || "");
        let s = p ? `${clip(p, 60)}` : "";
        if (dir) s = s ? `${s} in ${clip(dir, 60)}` : `in ${clip(dir, 60)}`;
        if (glb) s = s ? `${s} [${clip(glb, 40)}]` : `[${clip(glb, 40)}]`;
        if (mode) s = s ? `${s} (${mode})` : `(${mode})`;
        return s;
      }
      case "Bash": {
        const cmd = String(a?.command || "").trim();
        const tm = typeof a?.timeout === "number" ? a.timeout : null;
        if (!cmd) return "";
        return tm != null ? `${clip(cmd, 100)} (timeout=${tm}ms)` : `${clip(cmd, 120)}`;
      }
      case "fsEdit": {
        const fp = String(a?.file_path || "").trim();
        const os = String(a?.old_string ?? "");
        const ns = String(a?.new_string ?? "");
        const ra = !!a?.replace_all;
        if (!fp && !os && !ns) return "";
        let base = fp ? `${clip(fp, 120)}` : "";
        if (os && ns) {
          const rep = ` replace "${clip(os, 24)}" → "${clip(ns, 24)}"${ra ? " (all)" : ""}`;
          base = base ? `${base};${rep}` : rep;
        }
        return base;
      }
      case "fsWrite": {
        const fp = String(a?.file_path || "").trim();
        if (!fp) return "";
        const len = String(a?.content ?? "").length;
        return `${clip(fp, 120)} (content=${len} chars)`;
      }
      case "read": {
        const fp = String(a?.path || a?.file_path || "").trim();
        const off = typeof a?.offset === "number" ? a.offset : null;
        const lim = typeof a?.limit === "number" ? a.limit : null;
        if (!fp) return "";
        let s = `${clip(fp, 120)}`;
        if (off != null || lim != null) {
          s += ` (offset=${off != null ? off : "-"}, limit=${lim != null ? lim : "-"})`;
        }
        return s;
      }
      case "write": {
        const fp = String(a?.path || a?.file_path || "").trim();
        if (!fp) return "";
        const len = String(a?.content ?? "").length;
        return `${clip(fp, 120)} (content=${len} chars)`;
      }
      case "edit": {
        const fp = String(a?.path || a?.file_path || "").trim();
        const os = String(a?.old_string ?? "");
        const ns = String(a?.new_string ?? "");
        const ra = !!a?.replace_all;
        if (!fp && !os && !ns) return "";
        let base = fp ? `${clip(fp, 120)}` : "";
        if (os && ns) {
          const rep = ` replace "${clip(os, 24)}" → "${clip(ns, 24)}"${ra ? " (all)" : ""}`;
          base = base ? `${base};${rep}` : rep;
        }
        return base;
      }
      case "tree": {
        const dir = String(a?.path || "").trim();
        const md = typeof a?.max_depth === "number" ? a.max_depth : null;
        if (!dir) return "";
        return md ? `${clip(dir, 120)} (depth=${md})` : `${clip(dir, 120)}`;
      }
      case "todoWrite": {
        const cnt = Array.isArray(a?.todos) ? a.todos.length : 0;
        return `todos ${cnt} 项`;
      }
      case "sendMail": {
        const tos = Array.isArray(a?.to) ? a.to.filter(Boolean) : [];
        const subj = String(a?.subject || "").trim();
        const s1 = tos.length ? `to ${clip(tos.join(", "), 60)}` : "";
        const s2 = subj ? `subject ${clip(subj, 60)}` : "";
        return [s1, s2].filter(Boolean).join("; ");
      }
      default: {
        // 通用回退：优先挑选常见键的简短文本；否则输出压缩后的 JSON 片段
        const pickKeys = ["query", "url", "file_path", "directory_path", "text", "id", "name"];
        for (const k of pickKeys) {
          const v = a?.[k];
          if (typeof v === "string" && v.trim()) return `${k} ${clip(v.trim(), 120)}`;
        }
        // 找到第一个非空的字符串或基本类型
        for (const k of Object.keys(a || {})) {
          const v = a[k];
          if (v == null) continue;
          if (typeof v === "string" && v.trim()) return `${k} ${clip(v.trim(), 120)}`;
          if (typeof v === "number" || typeof v === "boolean") return `${k} ${String(v)}`;
        }
        // 最后回退：压缩 JSON（避免太长）
        const s = JSON.stringify(a);
        return s && s !== "{}" ? clip(s, 120) : "";
      }
    }
  } catch {
    return "";
  }
}

class ToolCallCardWidget extends WidgetType {
  constructor(id, name, args, result) {
    super();
    this.id = id + ":card";
    this.name = name;
    this.args = args;
    this.result = result;
  }
  eq(other) {
    return other.id === this.id && other.name === this.name && other.result === this.result && JSON.stringify(other.args) === JSON.stringify(this.args);
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "zion-tool-call-card";
    // 头部：名称与移除按钮
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;";
    const title = document.createElement("span");
    title.textContent = `调用 ${this.name}`;
    Object.assign(title.style, { fontSize: "11px", fontWeight: "600" });
    const close = document.createElement("button");
    close.textContent = "×";
    close.title = "移除该工具记录";
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
      try { window.zion?.events?.emit("toolcards/remove", { id: baseId }); } catch {}
    });
    header.appendChild(title);
    header.appendChild(close);
    wrap.appendChild(header);

    // 请求参数部分
    if (this.args) {
      const requestSection = document.createElement("div");
      requestSection.style.marginBottom = "8px";
      
      const requestLabel = document.createElement("div");
      requestLabel.textContent = "请求参数:";
      Object.assign(requestLabel.style, {
        fontSize: "10px",
        fontWeight: "600",
        marginBottom: "4px",
        opacity: "0.8"
      });
      requestSection.appendChild(requestLabel);
      
      const requestBody = document.createElement("pre");
      requestBody.textContent = fmt(this.args, 4000);
      Object.assign(requestBody.style, {
        margin: 0,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "var(--font-mono)",
        fontSize: "11px",
        background: "rgba(128,128,128,0.05)",
        padding: "2px",
        borderRadius: "4px"
      });
      requestSection.appendChild(requestBody);
      wrap.appendChild(requestSection);
    }

    // 响应结果部分
    if (this.result) {
      const responseSection = document.createElement("div");

      const responseLabel = document.createElement("div");
      responseLabel.textContent = "响应结果:";
      Object.assign(responseLabel.style, {
        fontSize: "10px",
        fontWeight: "600",
        marginBottom: "4px",
        opacity: "0.8"
      });
      responseSection.appendChild(responseLabel);

      const responseBody = document.createElement("pre");
      responseBody.textContent = fmt(this.result, 12000);
      Object.assign(responseBody.style, {
        margin: 0,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "var(--font-mono)",
        fontSize: "11px",
        background: "rgba(128,128,128,0.05)",
        padding: "2px",
        borderRadius: "4px"
      });
      responseSection.appendChild(responseBody);

      // 为 edit 工具添加 Revert 和 Accept 按钮
      if (this.name === "edit" && this.args) {
        const actionButtons = document.createElement("div");
        actionButtons.style.cssText = "display:flex;gap:6px;margin-top:8px;";

        // Revert 按钮
        const revertBtn = document.createElement("button");
        revertBtn.textContent = "Revert";
        revertBtn.title = "回退编辑操作";
        Object.assign(revertBtn.style, {
          background: "rgba(255, 100, 100, 0.1)",
          border: "1px solid rgba(255, 100, 100, 0.3)",
          color: "var(--fg)",
          borderRadius: "4px",
          padding: "4px 10px",
          fontSize: "10px",
          cursor: "pointer",
          fontWeight: "500"
        });
        revertBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const baseId = String(this.id).replace(/:card$/, "");
          try {
            window.zion?.events?.emit("toolcards/editRevert", {
              id: baseId,
              path: this.args.path,
              old_string: this.args.old_string,
              new_string: this.args.new_string,
              replace_all: this.args.replace_all
            });
          } catch (err) {
            console.error("[toolcards/editRevert] error:", err);
          }
        });

        // Accept 按钮
        const acceptBtn = document.createElement("button");
        acceptBtn.textContent = "Accept";
        acceptBtn.title = "接受编辑操作";
        Object.assign(acceptBtn.style, {
          background: "rgba(100, 200, 100, 0.1)",
          border: "1px solid rgba(100, 200, 100, 0.3)",
          color: "var(--fg)",
          borderRadius: "4px",
          padding: "4px 10px",
          fontSize: "10px",
          cursor: "pointer",
          fontWeight: "500"
        });
        acceptBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const baseId = String(this.id).replace(/:card$/, "");
          try {
            window.zion?.events?.emit("toolcards/editAccept", {
              id: baseId,
              path: this.args.path,
              old_string: this.args.old_string,
              new_string: this.args.new_string,
              replace_all: this.args.replace_all
            });
          } catch (err) {
            console.error("[toolcards/editAccept] error:", err);
          }
        });

        actionButtons.appendChild(revertBtn);
        actionButtons.appendChild(acceptBtn);
        responseSection.appendChild(actionButtons);
      }

      wrap.appendChild(responseSection);
    }

    return wrap;
  }
}

/**
 * Inline widget: replace the raw "调用 xxx" text with a controlled inline widget
 * that shows small gray text and a collapse toggle. Click events bubble up and are
 * handled by the existing domEventHandlers to dispatch toggleInline.
 */
class ToolInlineWidget extends WidgetType {
  constructor(id, name, args) {
    super();
    this.id = id + ":inline";
    this.name = name;
    this.args = args;
  }
  eq(other) {
    return other.id === this.id && other.name === this.name && JSON.stringify(other.args) === JSON.stringify(this.args);
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "zion-tool-call-inline";
    span.setAttribute("data-tool-id", String(this.id).replace(/:inline$/, ""));
    // 可访问性提示：包含摘要更知情
    const summaryText = summarizeToolArgs(this.name, this.args);
    span.title = summaryText
      ? `调用 ${this.name}：${summaryText}（点击展开/收起）`
      : `调用 ${this.name}（点击展开/收起）`;
    span.setAttribute("aria-label", `调用 ${this.name}（点击展开或收起工具调用卡片）`);

    const btn = document.createElement("button");
    btn.className = "zion-tool-call-inline-toggle";
    btn.type = "button";
    btn.title = "展开/收起工具调用卡片";
    btn.setAttribute("aria-label", "展开/收起工具调用卡片");
    // 内联 SVG（chevron-down），主题跟随 currentColor
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M4.646 6.646a.5.5 0 0 1 .708 0L8 9.293l2.646-2.647a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 0 1 0-.708z"></path>
</svg>`;
    // 不阻止事件冒泡，交由全局 click handler 处理 toggle
    span.appendChild(btn);

    // 信息容器：将“调用 XX”与摘要作为一个整体参与换行
    const info = document.createElement("span");
    info.className = "zion-tool-call-inline-info";

    const txt = document.createElement("span");
    txt.className = "zion-tool-call-inline-text";
    txt.textContent = `调用 ${this.name}`;
    info.appendChild(txt);

    // 摘要：在行内补充关键参数（如 query/url/filepath 等）
    if (summaryText) {
      const sum = document.createElement("span");
      sum.className = "zion-tool-call-inline-summary";
      sum.textContent = `：${summaryText}`;
      info.appendChild(sum);
    }

    span.appendChild(info);

    return span;
  }
  ignoreEvent() { return false; }
}

/**
 * Field value：{ deco: DecorationSet, items: Map<id, { from, to, name, args, result, expanded }> }
 * - inline widget 用 Decoration.replace 将原始文本替换为可控 DOM
 * - card widget 在 expanded 时插入到该行末尾（to 位置）
 */
const toolInlineField = StateField.define({
  create() {
    return { deco: Decoration.none, items: new Map() };
  },
  update(val, tr) {
    // 1) 位置映射
    let deco = val.deco.map(tr.changes);
    const items = new Map();
    val.items.forEach((it, id) => {
      const mappedFrom = tr.changes.mapPos(it.from, 1);
      const mappedTo = tr.changes.mapPos(it.to, -1);
      items.set(id, { ...it, from: mappedFrom, to: mappedTo });
    });

    // 2) 处理 effects
    for (const e of tr.effects) {
      if (e.is(clearAll)) {
        deco = Decoration.none;
        items.clear();
      }
      if (e.is(addInline)) {
        const { from, to, id, name, args } = e.value;
        // replace 原始文本为 inline widget（不可编辑、可定制样式）
        const widget = new ToolInlineWidget(id, name, args);
        const repl = Decoration.replace({ widget }).range(from, to);
        deco = deco.update({ add: [repl] });
        items.set(id, { from, to, name, args, result: null, expanded: false });
      }
      if (e.is(toggleInline)) {
        const id = e.value?.id;
        const it = id ? items.get(id) : null;
        if (!it) continue;
        if (it.expanded) {
          // 收起：移除卡片
          deco = deco.update({
            filter: (_f, _t, value) => value?.spec?.widget?.id !== (id + ":card")
          });
          items.set(id, { ...it, expanded: false });
        } else {
          // 展开：插入卡片（块级，行内末尾）
          const widget = new ToolCallCardWidget(id, it.name, it.args, it.result);
          deco = deco.update({ add: [Decoration.widget({ widget, block: true }).range(it.to)] });
          items.set(id, { ...it, expanded: true });
        }
      }
      if (e.is(updateResult)) {
        const { id, result } = e.value || {};
        const it = id ? items.get(id) : null;
        if (!it) continue;
        // 更新记录
        const updated = { ...it, result };
        items.set(id, updated);
        // 若已展开，刷新卡片 widget
        if (updated.expanded) {
          deco = deco.update({
            filter: (_f, _t, value) => value?.spec?.widget?.id !== (id + ":card")
          });
          const widget = new ToolCallCardWidget(id, updated.name, updated.args, updated.result);
          deco = deco.update({ add: [Decoration.widget({ widget, block: true }).range(updated.to)] });
        }
      }
      if (e.is(removeTool)) {
        const base = String(e.value?.id || "");
        // 移除 inline widget 与 card widget（也兼容旧的 mark 情况）
        deco = deco.update({
          filter: (_f, _t, value) => {
            const wid = value?.spec?.widget?.id || "";
            const cls = value?.spec?.class || "";
            const attr = value?.spec?.attributes || {};
            const isCard = wid === (base + ":card");
            const isInline = wid === (base + ":inline");
            const isMark = cls === "zion-tool-call-inline" && attr?.["data-tool-id"] === base;
            return !(isCard || isInline || isMark);
          }
        });
        items.delete(base);
        // 标记该条目为已删除，防止在会话恢复时复活
        try {
          const sid = window?.zion?.state?.get("sessions.currentId");
          if (sid) {
            const ann = window?.zion?.state?.get(`sessions.annotations.${sid}`) || {};
            const del = Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds.slice() : [];
            if (!del.includes(base)) del.push(base);
            window?.zion?.state?.set(`sessions.annotations.${sid}`, { ...ann, deletedToolIds: del });
          }
        } catch {}
      }
    }
    // 3) 文本一致性校验：如果用户删除或修改了“调用 xxx”文本，则清理对应条目与装饰，并写入删除标记
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
        const expected = `调用 ${it.name}`;
        if (anchor !== expected) {
          toRemove.push(id);
        }
      });
      if (toRemove.length) {
        // 移除对应 inline/card 装饰
        deco = deco.update({
          filter: (_f, _t, value) => {
            const wid = value?.spec?.widget?.id || "";
            return !toRemove.some(id => wid === (id + ":inline") || wid === (id + ":card"));
          }
        });
        // 删除内存条目
        toRemove.forEach(id => items.delete(id));
        // 写删除标记，避免恢复时复活
        try {
          const sid = window?.zion?.state?.get("sessions.currentId");
          if (sid) {
            const ann = window?.zion?.state?.get(`sessions.annotations.${sid}`) || {};
            const del = Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds.slice() : [];
            toRemove.forEach(id => { if (!del.includes(id)) del.push(id); });
            window?.zion?.state?.set(`sessions.annotations.${sid}`, { ...ann, deletedToolIds: del });
          }
        } catch {}
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

  // 找最后一个 assistant 头行
  let headIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(system|user|assistant|tool)\s+/);
    if (m && m[1] === "assistant") { headIdx = i; break; }
  }
  if (headIdx < 0) return doc.length;

  // 往下直到下一个角色头行，取其前一行为区块末尾
  let endIdx = headIdx;
  for (let i = headIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(system|user|assistant|tool)\s+/);
    if (m) break;
    endIdx = i;
  }
  return doc.line(endIdx + 1).to;
}

/**
 * 根据 hintPos（当前回答锚点或光标）查找“距离最近的 assistant 区块末尾”
 */
function findAssistantBlockEndNear(view, hintPos) {
  const { state } = view;
  const doc = state.doc;
  const txt = doc.toString().replace(/\r/g, "");
  const lines = txt.split("\n");

  // hintPos 转为行索引
  const hint = typeof hintPos === "number" ? hintPos : (state.selection?.main?.head ?? doc.length);
  const hintLine = doc.lineAt(hint).number - 1;

  // 自 hintLine 向上查找最近的 assistant 头
  let headIdx = -1;
  for (let i = hintLine; i >= 0; i--) {
    const m = lines[i].match(/^(system|user|assistant|tool)\s+/);
    if (m && m[1] === "assistant") { headIdx = i; break; }
    if (m && m[1] !== "assistant") {
      // 在 hint 上方遇到别的角色头，继续向上直到找到 assistant 或越界
      continue;
    }
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

/**
 * 将扩展暴露出去：由 editor.addVisualExtension(ext) 注入
 * - chat/toolCall：在最新 assistant 区块末尾插入“调用 xxx”文本行并加装饰
 * - chat/toolResult：更新该工具的卡片内容，不再插入第二个结果卡片
 * - toolcards/remove：移除此工具的文本装饰与卡片
 * - 点击“调用 xxx”文本：展开/收起当前行末尾的卡片
 */
export function installToolCallCards() {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.disps = [];
      this.runActive = false;
      this.anchorPos = view.state.doc.length; // 当前回答插入锚点（随着变更映射）
      this.disps.push(window.zion.events.on("chat/runStarted", this.onRun));
      this.disps.push(window.zion.events.on("chat/runFinished", this.onFinish));
      this.disps.push(window.zion.events.on("chat/toolCall", this.onCall));
      this.disps.push(window.zion.events.on("chat/toolResult", this.onRes));
      this.disps.push(window.zion.events.on("toolcards/remove", this.onRemove));
      this.disps.push(window.zion.events.on("toolcards/restore", this.onRestore));
      this.disps.push(window.zion.events.on("toolcards/clear", this.onClear));
      this.disps.push(window.zion.events.on("toolcards/editRevert", this.onEditRevert));
      this.disps.push(window.zion.events.on("toolcards/editAccept", this.onEditAccept));
      // 清理与会话切换联动
      this.disps.push(window.zion.state.onDidChange("sessions.currentId", this.onSessionChanged));
      // 初始快照
      this.snapshot();

      Promise.resolve().then(() => {
        try {
          const sid = window.zion?.state?.get("sessions.currentId");
          const pending = sid ? window.zion?.state?.get(`sessions.pendingRestore.tools.${sid}`) : null;
          if (Array.isArray(pending) && pending.length) this.onRestore({ items: pending });
        } catch {}
      });
    }
    update(update) {
      if (update.docChanged) {
        // 将锚点映射到新文档位置
        this.anchorPos = update.changes.mapPos(this.anchorPos, 1);
        if (this.runActive) {
          // 优先使用当前选择的光标位置作为回答插入点
          const selHead = update.state.selection?.main?.head ?? this.anchorPos;
          this.anchorPos = selHead;
          // 回答过程中，锚点跟随最近一次插入的末尾（回退）
          let lastToB = this.anchorPos;
          update.changes.iterChanges((_fromA, _toA, _fromB, toB) => {
            if (toB > lastToB) lastToB = toB;
          });
          this.anchorPos = lastToB;
        }
      } else if (update.selectionSet && this.runActive) {
        // 文档未变化但选择变化时，也更新锚点
        this.anchorPos = update.state.selection?.main?.head ?? this.anchorPos;
      }
      // 每次更新后持久化快照（位置会被 StateField 自动映射）
      this.snapshot();
    }
    snapshot = () => {
      try {
        const id = window.zion?.state?.get("sessions.currentId");
        if (!id) return;
        const fieldVal = this.view.state.field(toolInlineField);
        const arr = [];
        fieldVal.items.forEach((it, key) => {
          arr.push({
            id: key,
            name: it.name,
            args: it.args,
            result: it.result,
            expanded: it.expanded,
            from: it.from,
            to: it.to
          });
        });
        const prev = window.zion?.state?.get(`sessions.annotations.${id}`) || {};
        window.zion?.state?.set(`sessions.annotations.${id}`, { ...prev, tools: arr });
      } catch {}
    };
    onRun = (payload) => {
      const cur = window.zion?.state?.get("sessions.currentId");
      if (payload?.sessionId && payload.sessionId !== cur) return;
      this.runActive = true;
      const sel = this.view.state.selection?.main?.head;
      this.anchorPos = typeof sel === "number" ? sel : this.view.state.doc.length;
    };
    onFinish = (payload) => {
      const cur = window.zion?.state?.get("sessions.currentId");
      if (payload?.sessionId && payload.sessionId !== cur) return;
      this.runActive = false;
    };
    onCall = (payload) => {
      const cur = window.zion?.state?.get("sessions.currentId");
      if (payload?.sessionId && payload.sessionId !== cur) return;
      const tc = payload?.toolCall || payload;
      if (!tc?.id) return;
      const name = tc.name || "tool";

      // 1) 若无 assistant 头，先补充一个（确保工具调用信息插入到 assistant 区块）
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

      // 2) 计算插入位置：基于当前会话锚点的 assistant 区块末尾
      const sid = window.zion?.state?.get("sessions.currentId");
      const hint = (sid ? window.zion?.state?.get(`chat.answerAnchorPos.${sid}`) : undefined) ?? window.zion?.state?.get("chat.answerAnchorPos");
      const doc = this.view.state.doc;
      const pos = typeof hint === "number" ? findAssistantBlockEndNear(this.view, hint) : findAssistantBlockEnd(this.view);
      const prevChar = pos > 0 ? doc.sliceString(pos - 1, pos) : "";
      const prefix = prevChar === "\n" || pos === 0 ? "" : "\n"; // 确保新起一行
      const text = `${prefix}调用 ${name}\n`; // 末尾也换行，避免与后续回答拼在一行
      const start = pos + prefix.length;
      const end = start + (`调用 ${name}`).length;

      // 对外暴露锚点：设置到换行后的位置，便于后续回答继续新起一行
      try { window.zion?.state?.set("chat.lastToolCallPos", end + 1); } catch {}
      this.view.dispatch({
        changes: { from: pos, insert: text },
        effects: [addInline.of({ from: start, to: end, id: tc.id, name, args: tc.args })]
      });
      // 插入后，将锚点推进到换行之后
      this.anchorPos = end + 1;
    };
    onRes = (payload) => {
      const cur = window.zion?.state?.get("sessions.currentId");
      if (payload?.sessionId && payload.sessionId !== cur) return;
      const id = payload?.toolCallId || payload?.id;
      if (!id) return;
      const result = payload?.result;
      this.view.dispatch({ effects: [updateResult.of({ id, result })] });
    };
    onRemove = (payload) => {
      const id = payload?.id || payload;
      if (!id) return;
      this.view.dispatch({ effects: [removeTool.of({ id })] });
    };
    onEditRevert = async (payload) => {
      // 处理 edit 工具的 Revert 操作
      const { path, old_string, new_string, replace_all } = payload || {};
      if (!path || typeof old_string !== "string" || typeof new_string !== "string") {
        notify("Revert 参数缺失", { type: "error", duration: 3000 });
        return;
      }

      try {
        // 调用 edit 工具处理器来执行回退操作
        // Revert 就是将 new_string 替换回 old_string
        const sid = window.zion?.state?.get("terminal.activeSessionId");
        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        const url = `${base.replace(/\/$/, "")}/files/edit`;

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path,
            old_string: new_string,
            new_string: old_string,
            replace_all,
            session_id: sid || undefined
          })
        });

        const raw = await res.text().catch(() => "");
        const data = (() => {
          try { return raw ? JSON.parse(raw) : null; } catch { return null; }
        })();
        if (!res.ok) {
          console.error("[onEditRevert] failed:", raw || data?.error || "edit failed");
          notify("Revert 失败: " + (raw || data?.error || "未知错误"), { type: "error", duration: 6000 });
          return;
        }

        // 根据 replaced 字段给出不同的反馈
        if (data && data.replaced === 0) {
          notify("Revert 未执行：未找到匹配的内容", { type: "warning", duration: 4000 });
        } else if (data && data.replaced === 1) {
          notify("Revert 成功！", { type: "success", duration: 3000 });
        } else {
          notify("Revert 完成（状态未知）", { type: "info", duration: 3000 });
        }
      } catch (e) {
        console.error("[onEditRevert] error:", e);
        notify("Revert 错误: " + (e?.message || String(e)), { type: "error", duration: 6000 });
      }
    };
    onEditAccept = async (payload) => {
      // 处理 edit 工具的 Accept 操作
      // Accept 执行正向编辑：old_string -> new_string
      const { path, old_string, new_string, replace_all } = payload || {};
      if (!path || typeof old_string !== "string" || typeof new_string !== "string") {
        notify("Accept 参数缺失", { type: "error", duration: 3000 });
        return;
      }

      try {
        const sid = window.zion?.state?.get("terminal.activeSessionId");
        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        const base = readBase();
        const url = `${base.replace(/\/$/, "")}/files/edit`;

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path,
            old_string,
            new_string,
            replace_all,
            session_id: sid || undefined
          })
        });

        const raw = await res.text().catch(() => "");
        const data = (() => {
          try { return raw ? JSON.parse(raw) : null; } catch { return null; }
        })();
        if (!res.ok) {
          console.error("[onEditAccept] failed:", raw || data?.error || "edit failed");
          notify("Accept 失败: " + (raw || data?.error || "未知错误"), { type: "error", duration: 6000 });
          return;
        }

        // 根据 replaced 字段给出不同的反馈
        if (data && data.replaced === 0) {
          notify("Accept 未执行：未找到匹配的内容", { type: "warning", duration: 4000 });
        } else if (data && data.replaced === 1) {
          notify("Accept 成功！", { type: "success", duration: 3000 });
        } else {
          notify("Accept 完成（状态未知）", { type: "info", duration: 3000 });
        }
      } catch (e) {
        console.error("[onEditAccept] error:", e);
        notify("Accept 错误: " + (e?.message || String(e)), { type: "error", duration: 6000 });
      }
    };
    onClear = () => {
      this.view.dispatch({ effects: [clearAll.of({})] });
      this.snapshot();
    };
    onSessionChanged = () => {
      // 在会话切换时清空当前工具卡片，避免跨会话污染
      try { this.view.dispatch({ effects: [clearAll.of({})] }); } catch {}
      // 重置运行状态与插入锚点
      this.runActive = false;
      this.anchorPos = this.view.state.doc.length;
      // 让快照与新会话对齐（将当前插件状态写空）
      this.snapshot();
    };
    onRestore = (payload) => {
      const list = payload?.items || payload;
      if (!Array.isArray(list) || list.length === 0) return;

      try {
        const sid = window.zion?.state?.get("sessions.currentId");
        if (sid) window.zion?.state?.set(`sessions.pendingRestore.tools.${sid}`, null);
      } catch {}

      // 从会话注解读取“已删除条目”，避免复活
      let deletedSet = new Set();
      try {
        const sid = window.zion?.state?.get("sessions.currentId");
        const ann = sid ? (window.zion?.state?.get(`sessions.annotations.${sid}`) || {}) : {};
        const del = Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : [];
        deletedSet = new Set(del);
      } catch {}

      // 先尝试批量恢复所有“范围合法”的条目；对非法范围条目采用逐条插入回退方案
      const docLen = this.view.state.doc.length;
      const batchedEffects = [];
      const batchedToggles = [];

      for (const it of list) {
        if (deletedSet.has(it?.id)) continue;

        const name = it?.name || "tool";
        const hasRange = typeof it?.from === "number" && typeof it?.to === "number";
        const validRange = hasRange && it.from >= 0 && it.from < it.to && it.to <= docLen;

        if (validRange) {
          batchedEffects.push(addInline.of({ from: it.from, to: it.to, id: it.id, name, args: it.args }));
          if (it?.result != null) batchedEffects.push(updateResult.of({ id: it.id, result: it.result }));
          if (it.expanded) batchedToggles.push(it.id);
        } else {
          // 回退：在当前 assistant 区块末尾插入“调用 name”并重建装饰
          const docNow = this.view.state.doc;
          const pos = findAssistantBlockEnd(this.view);
          const prevChar = pos > 0 ? docNow.sliceString(pos - 1, pos) : "";
          const prefix = prevChar === "\n" || pos === 0 ? "" : "\n";
          const text = `${prefix}调用 ${name}\n`;
          const start = pos + prefix.length;
          const end = start + (`调用 ${name}`).length;

          this.view.dispatch({
            changes: { from: pos, insert: text },
            effects: [addInline.of({ from: start, to: end, id: it.id, name, args: it.args })]
          });
          if (it?.result != null) {
            this.view.dispatch({ effects: [updateResult.of({ id: it.id, result: it.result })] });
          }
          if (it.expanded) {
            this.view.dispatch({ effects: [toggleInline.of({ id: it.id })] });
          }
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
      for (const d of this.disps) { try { d?.dispose?.(); } catch {} }
    }
  });

  // 点击“调用 xxx”文本时展开/收起
  const handlers = EditorView.domEventHandlers({
    click(event, view) {
      const el = event.target instanceof Element ? event.target.closest(".zion-tool-call-inline") : null;
      if (!el) return false;
      const id = el.getAttribute("data-tool-id");
      if (!id) return false;
      view.dispatch({ effects: [toggleInline.of({ id })] });
      event.preventDefault();
      return true;
    }
  });

  return [toolInlineField, plugin, handlers];
}
