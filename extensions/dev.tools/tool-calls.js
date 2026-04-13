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
const updateResult = StateEffect.define(); // { id, result, ok? }
const removeTool = StateEffect.define();   // { id }
const clearAll = StateEffect.define();

function inferToolOkFromResult(toolName, result, ok) {
  const tn = String(toolName || "").toLowerCase();
  const isEdit = tn === "edit" || tn === "fsedit";
  const isWrite = tn === "write" || tn === "fswrite";
  const isRead = tn === "read" || tn === "fsread";

  let obj = null;
  if (result != null && typeof result === "object") obj = result;

  if (!obj) {
    try {
      const parsed = JSON.parse(String(result ?? ""));
      if (parsed && typeof parsed === "object") obj = parsed;
    } catch {}
  }

  if (isEdit) {
    if (obj && typeof obj.replaced === "number") return obj.replaced > 0;
    const head = String(result ?? "").slice(0, 240).toLowerCase().trim();
    if (head.startsWith("edit ok:")) return true;
    if (head.startsWith("edit failed:")) return false;
    if (head.startsWith("edit blocked:")) return false;
  }

  if (isWrite) {
    if (obj && typeof obj.ok === "boolean") return obj.ok;
    if (obj && typeof obj.success === "boolean") return obj.success;
    const head = String(result ?? "").slice(0, 240).toLowerCase().trim();
    if (head.startsWith("write blocked:")) return false;
    if (head.startsWith("write failed:")) return false;
    if (head.startsWith("write error:")) return false;
  }

  if (isRead) {
    const head = String(result ?? "").slice(0, 240).toLowerCase().trim();
    if (head.startsWith("read error:")) return false;
    if (head.startsWith("permission denied")) return false;
  }

  if (typeof ok === "boolean") return ok;
  if (ok === null) return null;
  if (result == null) return null;
  if (obj && typeof obj.ok === "boolean") return obj.ok;
  if (obj && typeof obj.success === "boolean") return obj.success;

  const head = String(result ?? "").slice(0, 240).toLowerCase().trim();

  if (!head) return true;
  if (head.startsWith("http ")) return false;
  if (head.startsWith("tool \"") && head.includes(" failed:")) return false;
  if (head.startsWith("tool \"") && head.includes(" error:")) return false;
  if (head.startsWith("read error:")) return false;
  if (head.startsWith("write error:")) return false;
  if (head.startsWith("edit error:")) return false;
  if (head.startsWith("edit failed:")) return false;
  if (head.startsWith("write failed:")) return false;
  if (head.startsWith("write blocked:")) return false;
  if (head.startsWith("webfetch error:")) return false;
  if (head.startsWith("websearch error:")) return false;
  if (head.startsWith("localsearch error:")) return false;
  if (head.startsWith("glob error:")) return false;
  if (head.startsWith("grep error:")) return false;
  if (head.startsWith("tree error:")) return false;
  if (head.startsWith("unknown tool:")) return false;
  if (head.startsWith("invalid args")) return false;
  if (head.startsWith("missing ")) return false;
  if (head.includes("permission denied")) return false;
  if (head.includes("blocked")) return false;
  if (head.includes("aborted")) return false;

  return true;
}

function toolStatusLabel(ok, done) {
  if (!done) return "执行中";
  if (ok === false) return "失败";
  if (ok === true) return "成功";
  return "完成";
}

function toolStatusAttr(ok, done) {
  if (!done) return "pending";
  if (ok === false) return "error";
  if (ok === true) return "ok";
  return "unknown";
}

function toolStatusIcon(status) {
  const s = String(status || "");
  if (s === "ok") {
    return `<svg class="zion-tool-call-status-icon" width="8" height="8" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 8.2l2.7 2.7L12.4 4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (s === "error") {
    return `<svg class="zion-tool-call-status-icon" width="8" height="8" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
  if (s === "pending") {
    return `<svg class="zion-tool-call-status-icon zion-tool-call-status-icon--pending" width="8" height="8" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="18 10"/></svg>`;
  }
  return `<svg class="zion-tool-call-status-icon" width="8" height="8" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>`;
}

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
        const pmt = String(a?.prompt || "").trim();
        const base = `${clip(fp, 120)} (content=${len} chars)`;
        return pmt ? `${base}; ${clip(pmt, 100)}` : base;
      }
      case "edit": {
        const fp = String(a?.path || a?.file_path || "").trim();
        if (!fp) return "";
        const pmt = String(a?.prompt || "").trim();
        const base = clip(fp, 120);
        return pmt ? `${base}; ${clip(pmt, 100)}` : base;
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
  constructor(id, name, args, result, ok) {
    super();
    this.id = id + ":card";
    this.name = name;
    this.args = args;
    this.result = result;
    this.ok = ok;
  }
  eq(other) {
    return other.id === this.id && other.name === this.name && other.result === this.result && other.ok === this.ok && JSON.stringify(other.args) === JSON.stringify(this.args);
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "zion-tool-call-card";
    wrap.setAttribute("data-tool-id", String(this.id).replace(/:card$/, ""));
    // 头部：名称与移除按钮
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;";
    const title = document.createElement("span");
    title.textContent = `调用 ${this.name}`;
    Object.assign(title.style, { fontSize: "11px", fontWeight: "600" });

    header.appendChild(title);

    const ok = inferToolOkFromResult(this.name, this.result, this.ok);
    const badge = document.createElement("span");
    badge.className = "zion-tool-call-status";
    const status = toolStatusAttr(ok, this.result != null);
    const label = toolStatusLabel(ok, this.result != null);
    badge.setAttribute("data-status", status);
    badge.innerHTML = toolStatusIcon(status);
    badge.title = label;
    badge.setAttribute("aria-label", `工具调用状态：${label}`);
    header.appendChild(badge);

    if (this.name === "edit" && this.args) {
      const actionButtons = document.createElement("div");
      actionButtons.style.cssText = "display:flex;gap:6px;";

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
      header.appendChild(actionButtons);
    }
    if (this.name === "write" && this.args) {
      const actionButtons = document.createElement("div");
      actionButtons.style.cssText = "display:flex;gap:6px;";

      const revertBtn = document.createElement("button");
      revertBtn.textContent = "Revert";
      revertBtn.title = "回退写入操作";
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
          window.zion?.events?.emit("toolcards/writeRevert", {
            id: baseId,
            path: this.args.path,
            content: this.args.content
          });
        } catch (err) {
          console.error("[toolcards/writeRevert] error:", err);
        }
      });

      const acceptBtn = document.createElement("button");
      acceptBtn.textContent = "Accept";
      acceptBtn.title = "接受写入操作";
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
          window.zion?.events?.emit("toolcards/writeAccept", {
            id: baseId,
            path: this.args.path,
            content: this.args.content
          });
        } catch (err) {
          console.error("[toolcards/writeAccept] error:", err);
        }
      });

      actionButtons.appendChild(revertBtn);
      actionButtons.appendChild(acceptBtn);
      header.appendChild(actionButtons);
    }

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
  constructor(id, name, args, ok, done) {
    super();
    this.id = id + ":inline";
    this.name = name;
    this.args = args;
    this.ok = ok;
    this.done = !!done;
  }
  eq(other) {
    return other.id === this.id && other.name === this.name && other.ok === this.ok && other.done === this.done && JSON.stringify(other.args) === JSON.stringify(this.args);
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

    const badge = document.createElement("span");
    badge.className = "zion-tool-call-status";
    const status = toolStatusAttr(this.ok, this.done);
    const label = toolStatusLabel(this.ok, this.done);
    badge.setAttribute("data-status", status);
    badge.innerHTML = toolStatusIcon(status);
    badge.title = label;
    badge.setAttribute("aria-label", `工具调用状态：${label}`);
    span.appendChild(badge);

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
        const { from, to, id, name, args, userStartLine } = e.value;
        // replace 原始文本为 inline widget（不可编辑、可定制样式）
        const widget = new ToolInlineWidget(id, name, args, null, false);
        const repl = Decoration.replace({ widget }).range(from, to);
        deco = deco.update({ add: [repl] });
        items.set(id, { from, to, name, args, result: null, ok: null, expanded: false, userStartLine: typeof userStartLine === "number" ? userStartLine : null });
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
          // 展开：插入卡片（行内，行末）
          const widget = new ToolCallCardWidget(id, it.name, it.args, it.result, it.ok);
          deco = deco.update({ add: [Decoration.widget({ widget, side: 1 }).range(it.to)] });
          items.set(id, { ...it, expanded: true });
        }
      }
      if (e.is(updateResult)) {
        const { id, result, ok } = e.value || {};
        const it = id ? items.get(id) : null;
        if (!it) continue;
        const inferredOk = inferToolOkFromResult(it.name, result, ok);
        const updated = { ...it, result, ok: inferredOk };
        items.set(id, updated);

        deco = deco.update({
          filter: (_f, _t, value) => value?.spec?.widget?.id !== (id + ":inline")
        });
        const inlineWidget = new ToolInlineWidget(id, updated.name, updated.args, updated.ok, true);
        const repl = Decoration.replace({ widget: inlineWidget }).range(updated.from, updated.to);
        deco = deco.update({ add: [repl] });

        // 若已展开，刷新卡片 widget
        if (updated.expanded) {
          deco = deco.update({
            filter: (_f, _t, value) => value?.spec?.widget?.id !== (id + ":card")
          });
          const widget = new ToolCallCardWidget(id, updated.name, updated.args, updated.result, updated.ok);
          deco = deco.update({ add: [Decoration.widget({ widget, side: 1 }).range(updated.to)] });
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
function findPrevRoleStartLine(doc, pos, role) {
  try {
    const startLine = doc.lineAt(Math.max(0, Math.min(doc.length, pos))).number;
    for (let ln = startLine; ln >= 1; ln--) {
      const line = doc.line(ln);
      const text = doc.sliceString(line.from, line.to);
      const m = text.match(/^(system|user|assistant|tool)\s+/);
      if (!m) continue;
      if (m[1] === role) return ln - 1;
    }
  } catch {}
  if (role === "user") return 0;
  return null;
}

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
      this.anchorPos = view.state.doc.length;
      this.sessionId = null;
      this.toolActions = new Map();
      this.selRaf = 0;
      try { this.panelId = this.view.dom.closest("[data-panel-id]")?.getAttribute("data-panel-id") || null; } catch { this.panelId = null; }
      try { this.sessionId = window.zion?.state?.get("sessions.currentId") || null; } catch {}
      this.disps.push(window.zion.events.on("chat/runStarted", this.onRun));
      this.disps.push(window.zion.events.on("chat/runFinished", this.onFinish));
      this.disps.push(window.zion.events.on("chat/toolCall", this.onCall));
      this.disps.push(window.zion.events.on("chat/toolResult", this.onRes));
      this.disps.push(window.zion.events.on("toolcards/remove", this.onRemove));
      this.disps.push(window.zion.events.on("toolcards/restore", this.onRestore));
      this.disps.push(window.zion.events.on("toolcards/clear", this.onClear));
      this.disps.push(window.zion.events.on("toolcards/editRevert", this.onEditRevert));
      this.disps.push(window.zion.events.on("toolcards/editAccept", this.onEditAccept));
      this.disps.push(window.zion.events.on("toolcards/writeRevert", this.onWriteRevert));
      this.disps.push(window.zion.events.on("toolcards/writeAccept", this.onWriteAccept));
      this.disps.push(window.zion.events.on("toolcards/batchRevert", this.onBatchRevert));
      this.disps.push(window.zion.events.on("toolcards/batchAccept", this.onBatchAccept));
      this.disps.push(window.zion.events.on("toolcards/toolsUpdated", this.onToolsUpdated));
      // 清理与会话切换联动
      this.disps.push(window.zion.state.onDidChange("sessions.currentId", this.onSessionChanged));
      // 初始快照
      this.loadToolActions();
      this.snapshot();

      Promise.resolve().then(() => {
        try {
          const sid = this.sessionId;
          const pending = sid ? window.zion?.state?.get(`sessions.pendingRestore.tools.${sid}`) : null;
          const ann = sid ? (window.zion?.state?.get(`sessions.annotations.${sid}`) || {}) : {};
          const list = Array.isArray(ann.tools) ? ann.tools : [];
          if (Array.isArray(pending) && pending.length) {
            if (sid && !list.length) {
              try { window.zion?.state?.set(`sessions.annotations.${sid}`, { ...ann, tools: pending }); } catch {}
            }
            this.onRestore({ items: pending });
            return;
          }
          if (!list.length) return;
          // 基于 StateField 中的已挂载 id 判断是否需要恢复
          let mountedIds = [];
          try {
            const fieldVal = this.view.state.field(toolInlineField);
            if (fieldVal?.items) fieldVal.items.forEach((_it, id) => mountedIds.push(String(id)));
          } catch {}
          const wantIds = list.map(it => it?.id).filter(Boolean).map(String);
          const missing = wantIds.some(id => !mountedIds.includes(id));
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
        // 延迟一点执行，确保 DOM 已完全恢复
        setTimeout(() => this.checkAndRestoreWidgets(), 100);
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
        const ann = window.zion?.state?.get(`sessions.annotations.${sid}`) || {};
        const list = Array.isArray(ann.tools) ? ann.tools : [];
        if (!list.length) return;

        // 基于 StateField 中的已挂载 id 判断是否需要恢复
        let mountedIds = [];
        try {
          const fieldVal = this.view.state.field(toolInlineField);
          if (fieldVal?.items) fieldVal.items.forEach((_it, id) => mountedIds.push(String(id)));
        } catch {}
        const wantIds = list.map(it => it?.id).filter(Boolean).map(String);
        const missing = wantIds.some(id => !mountedIds.includes(id));
        if (missing) {
          console.log("[tool-calls] restore needed (missing ids):", { missingIds: wantIds.filter(id => !mountedIds.includes(id)) });
          this.onRestore({ items: list });
        }
      } catch (e) {
        console.error("[tool-calls] checkAndRestoreWidgets error:", e);
      }
    };

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
          const all = view.dom.querySelectorAll(".zion-tool-call-inline, .zion-tool-call-card");
          try { all.forEach(el => el.classList.remove("zion-selected")); } catch {}
          if (!hasSelection) return;
          const fieldVal = view.state.field(toolInlineField);
          const selected = new Set();
          fieldVal.items.forEach((it, id) => {
            for (const r of sel.ranges) {
              if (r.empty) continue;
              if (r.from < it.to && r.to > it.from) { selected.add(String(id)); break; }
            }
          });
          selected.forEach((id) => {
            try {
              const els = view.dom.querySelectorAll(`.zion-tool-call-inline[data-tool-id="${id}"], .zion-tool-call-card[data-tool-id="${id}"]`);
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
        const fieldVal = this.view.state.field(toolInlineField);
        const arr = [];
        fieldVal.items.forEach((it, key) => {
          const act = this.toolActions.get(key);
          arr.push({
            id: key,
            name: it.name,
            args: it.args,
            result: it.result,
            ok: it.ok,
            expanded: it.expanded,
            from: it.from,
            to: it.to,
            userStartLine: typeof it.userStartLine === "number" ? it.userStartLine : null,
            action: act?.action || null,
            actionAt: typeof act?.at === "number" ? act.at : null
          });
        });
        const prev = window.zion?.state?.get(`sessions.annotations.${id}`) || {};
        // 将注解快照写回内存
        window.zion?.state?.set(`sessions.annotations.${id}`, { ...prev, tools: arr });
        // 同步当前挂载的 widget id 列表与计数，供生命周期判定使用（避免依赖 DOM 计数）
        try {
          const mountedIds = arr.map(it => it.id).filter(Boolean);
          window.zion?.state?.set(`sessions.widgets.tools.${id}`, {
            ids: mountedIds,
            count: mountedIds.length,
            stamp: Date.now()
          });
        } catch {}
      } catch {}
    };
    loadToolActions = () => {
      try {
        const sid = window.zion?.state?.get("sessions.currentId");
        if (!sid) return;
        const ann = window.zion?.state?.get(`sessions.annotations.${sid}`) || {};
        const ta = ann && typeof ann.toolActions === "object" ? ann.toolActions : {};
        const next = new Map();
        Object.keys(ta || {}).forEach((k) => {
          const v = ta[k];
          if (!v) return;
          const action = v.action;
          const at = v.at;
          if (action === "accept" || action === "revert") {
            next.set(k, { action, at: typeof at === "number" ? at : null });
          }
        });
        this.toolActions = next;
      } catch {}
    };
    setToolAction = (toolCallId, action) => {
      if (!toolCallId || (action !== "accept" && action !== "revert")) return;
      try {
        const sid = window.zion?.state?.get("sessions.currentId");
        if (!sid) return;
        const prev = window.zion?.state?.get(`sessions.annotations.${sid}`) || {};
        const taPrev = prev && typeof prev.toolActions === "object" ? prev.toolActions : {};
        const ta = { ...(taPrev || {}) };
        const at = Date.now();
        ta[String(toolCallId)] = { action, at };
        window.zion?.state?.set(`sessions.annotations.${sid}`, { ...prev, toolActions: ta });
        this.toolActions.set(String(toolCallId), { action, at });
        try { window.zion?.events?.emit("toolcards/toolsUpdated", { sessionId: sid }); } catch {}
      } catch {}
    };
    onRun = (payload) => {
      const visibleSessionId = window.zion?.panelManager?.getPanel(this.panelId)?.activeTabId || this.sessionId || null;
      if (payload?.sessionId && visibleSessionId && payload.sessionId !== visibleSessionId) return;
      if (!payload?.sessionId && payload?.panelId && payload.panelId !== this.panelId) return;
      if (payload?.sessionId) this.sessionId = payload.sessionId;
      this.runActive = true;
      const sel = this.view.state.selection?.main?.head;
      this.anchorPos = typeof sel === "number" ? sel : this.view.state.doc.length;
    };
    onFinish = (payload) => {
      const visibleSessionId = window.zion?.panelManager?.getPanel(this.panelId)?.activeTabId || this.sessionId || null;
      if (payload?.sessionId && visibleSessionId && payload.sessionId !== visibleSessionId) return;
      if (!payload?.sessionId && payload?.panelId && payload.panelId !== this.panelId) return;
      if (payload?.sessionId) this.sessionId = payload.sessionId;
      this.runActive = false;
    };
    onCall = (payload) => {
      const visibleSessionId = window.zion?.panelManager?.getPanel(this.panelId)?.activeTabId || this.sessionId || null;
      if (payload?.sessionId && visibleSessionId && payload.sessionId !== visibleSessionId) return;
      if (!payload?.sessionId && payload?.panelId && payload.panelId !== this.panelId) return;
      if (payload?.sessionId) this.sessionId = payload.sessionId;
      const tc = payload?.toolCall || payload;
      if (!tc?.id) return;
      const name = tc.name || "tool";

      const isMirrorPanel = !!(payload?.panelId && payload.panelId !== this.panelId);
      if (isMirrorPanel) {
        return;
      }

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
      const sid = this.sessionId;
      const hint = (sid ? window.zion?.state?.get(`chat.answerAnchorPos.${sid}`) : undefined) ?? window.zion?.state?.get("chat.answerAnchorPos");
      const doc = this.view.state.doc;
      const pos = typeof hint === "number" ? findAssistantBlockEndNear(this.view, hint) : findAssistantBlockEnd(this.view);
      const prevChar = pos > 0 ? doc.sliceString(pos - 1, pos) : "";
      const prefix = prevChar === "\n" || pos === 0 ? "" : "\n"; // 确保新起一行
      const text = `${prefix}调用 ${name}\n`; // 末尾也换行，避免与后续回答拼在一行
      const start = pos + prefix.length;
      const end = start + (`调用 ${name}`).length;
      const userStartLine = findPrevRoleStartLine(doc, start, "user");

      // 对外暴露锚点：设置到换行后的位置，便于后续回答继续新起一行
      try { window.zion?.state?.set("chat.lastToolCallPos", end + 1); } catch {}
      this.view.dispatch({
        changes: { from: pos, insert: text },
        effects: [addInline.of({ from: start, to: end, id: tc.id, name, args: tc.args, userStartLine })]
      });
      // 插入后，将锚点推进到换行之后
      this.anchorPos = end + 1;
      try {
        window.zion?.events?.emit("toolcards/toolsUpdated", { sessionId: this.sessionId });
      } catch {}
    };
    onRes = (payload) => {
      const visibleSessionId = window.zion?.panelManager?.getPanel(this.panelId)?.activeTabId || this.sessionId || null;
      if (payload?.sessionId && visibleSessionId && payload.sessionId !== visibleSessionId) return;
      if (!payload?.sessionId && payload?.panelId && payload.panelId !== this.panelId) return;
      if (payload?.sessionId) this.sessionId = payload.sessionId;
      const id = payload?.toolCallId || payload?.id;
      if (!id) return;
      const result = payload?.result;
      const ok = payload?.ok;
      this.view.dispatch({ effects: [updateResult.of({ id, result, ok })] });
      try {
        window.zion?.events?.emit("toolcards/toolsUpdated", { sessionId: this.sessionId });
      } catch {}
      try {
        const fieldVal = this.view.state.field(toolInlineField);
        const it = fieldVal.items.get(String(id));
        const nm = String(it?.name || "");
        if ((nm === "edit" || nm === "write" || nm === "fsedit" || nm === "fswrite") && it?.ok === true && !this.toolActions.get(String(id))) {
          this.setToolAction(String(id), "accept");
        }
      } catch {}
    };
    onRemove = (payload) => {
      const id = payload?.id || payload;
      if (!id) return;
      this.view.dispatch({ effects: [removeTool.of({ id })] });
      try {
        window.zion?.events?.emit("toolcards/toolsUpdated", { sessionId: this.sessionId });
      } catch {}
    };
    onEditRevert = async (payload) => {
      // 处理 edit 工具的 Revert 操作
      const { id, path, old_string, new_string, replace_all } = payload || {};
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
        const baseId = String(id || "").trim();
        if (baseId) this.setToolAction(baseId, "revert");
      } catch (e) {
        console.error("[onEditRevert] error:", e);
        notify("Revert 错误: " + (e?.message || String(e)), { type: "error", duration: 6000 });
      }
    };
    onEditAccept = async (payload) => {
      // 处理 edit 工具的 Accept 操作
      // Accept 执行正向编辑：old_string -> new_string
      const { id, path, old_string, new_string, replace_all } = payload || {};
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
        const baseId = String(id || "").trim();
        if (baseId) this.setToolAction(baseId, "accept");
      } catch (e) {
        console.error("[onEditAccept] error:", e);
        notify("Accept 错误: " + (e?.message || String(e)), { type: "error", duration: 6000 });
      }
    };
    onWriteRevert = async (payload) => {
      const { id, path } = payload || {};
      if (!path) {
        notify("Revert 参数缺失", { type: "error", duration: 3000 });
        return;
      }
      try {
        const sid = window.zion?.state?.get("sessions.currentId");
        const ann = sid ? (window.zion?.state?.get(`sessions.annotations.${sid}`) || {}) : {};
        const list = Array.isArray(ann.writeHistory) ? ann.writeHistory : [];
        const baseId = String(id || "");
        const contentHint = typeof payload?.content === "string" ? payload.content : null;
        const findById = (it) => !!(baseId && it?.toolCallId && String(it.toolCallId) === baseId);
        const findByContent = (it) => !!(path && contentHint != null && it?.path === path && it?.afterContent === contentHint);
        const findByPath = (it) => !!(path && it?.path === path);
        const byId = list.slice().reverse().find(findById);
        const byContent = list.slice().reverse().find(findByContent);
        const byPath = list.slice().reverse().find(findByPath);
        const item = byId || byContent || byPath;
        if (baseId && !byId) {
          if (!byContent) {
            notify("Revert 失败: 未找到对应的 write 记录（可能跨会话/已被清理）", { type: "error", duration: 6000 });
            return;
          }
        }
        const sid2 = window.zion?.state?.get("terminal.activeSessionId");
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
        if (item?.beforeExists === false) {
          const delUrl = `${base.replace(/\/$/, "")}/files/delete`;
          const res = await fetch(delUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              path,
              session_id: sid2 || undefined
            })
          });
          const raw = await res.text().catch(() => "");
          const data = (() => {
            try { return raw ? JSON.parse(raw) : null; } catch { return null; }
          })();
          if (!res.ok) {
            console.error("[onWriteRevert] delete failed:", raw || data?.error || "delete failed");
            notify("Revert 失败: " + (raw || data?.error || "未知错误"), { type: "error", duration: 6000 });
            return;
          }
          notify("Revert 成功！", { type: "success", duration: 3000 });
          if (id) this.setToolAction(String(id), "revert");
          return;
        }
        const beforeContent = item?.beforeContent;
        if (typeof beforeContent !== "string") {
          notify("Revert 失败: 未找到原内容", { type: "error", duration: 4000 });
          return;
        }
        const url = `${base.replace(/\/$/, "")}/files/write`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path,
            content: beforeContent,
            session_id: sid2 || undefined
          })
        });
        const raw = await res.text().catch(() => "");
        const data = (() => {
          try { return raw ? JSON.parse(raw) : null; } catch { return null; }
        })();
        if (!res.ok) {
          console.error("[onWriteRevert] failed:", raw || data?.error || "write failed");
          notify("Revert 失败: " + (raw || data?.error || "未知错误"), { type: "error", duration: 6000 });
          return;
        }
        notify("Revert 成功！", { type: "success", duration: 3000 });
        if (id) this.setToolAction(String(id), "revert");
      } catch (e) {
        console.error("[onWriteRevert] error:", e);
        notify("Revert 错误: " + (e?.message || String(e)), { type: "error", duration: 6000 });
      }
    };
    onWriteAccept = async (payload) => {
      const { id, path } = payload || {};
      if (!path) {
        notify("Accept 参数缺失", { type: "error", duration: 3000 });
        return;
      }
      try {
        const sid = window.zion?.state?.get("sessions.currentId");
        const ann = sid ? (window.zion?.state?.get(`sessions.annotations.${sid}`) || {}) : {};
        const list = Array.isArray(ann.writeHistory) ? ann.writeHistory : [];
        const baseId = String(id || "");
        const contentHint = typeof payload?.content === "string" ? payload.content : null;
        const findById = (it) => !!(baseId && it?.toolCallId && String(it.toolCallId) === baseId);
        const findByContent = (it) => !!(path && contentHint != null && it?.path === path && it?.afterContent === contentHint);
        const findByPath = (it) => !!(path && it?.path === path);
        const byId = list.slice().reverse().find(findById);
        const byContent = list.slice().reverse().find(findByContent);
        const byPath = list.slice().reverse().find(findByPath);
        const item = byId || byContent || byPath;
        const content = typeof payload?.content === "string" ? payload.content : item?.afterContent;
        if (baseId && !byId && typeof payload?.content !== "string") {
          if (!byContent) {
            notify("Accept 失败: 未找到对应的 write 记录（可能跨会话/已被清理）", { type: "error", duration: 6000 });
            return;
          }
        }
        if (typeof content !== "string") {
          notify("Accept 失败: 未找到写入内容", { type: "error", duration: 4000 });
          return;
        }
        const sid2 = window.zion?.state?.get("terminal.activeSessionId");
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
        const url = `${base.replace(/\/$/, "")}/files/write`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path,
            content,
            session_id: sid2 || undefined
          })
        });
        const raw = await res.text().catch(() => "");
        const data = (() => {
          try { return raw ? JSON.parse(raw) : null; } catch { return null; }
        })();
        if (!res.ok) {
          console.error("[onWriteAccept] failed:", raw || data?.error || "write failed");
          notify("Accept 失败: " + (raw || data?.error || "未知错误"), { type: "error", duration: 6000 });
          return;
        }
        notify("Accept 成功！", { type: "success", duration: 3000 });
        if (id) this.setToolAction(String(id), "accept");
      } catch (e) {
        console.error("[onWriteAccept] error:", e);
        notify("Accept 错误: " + (e?.message || String(e)), { type: "error", duration: 6000 });
      }
    };
    onBatchAccept = async (payload) => {
      const userStartLine = typeof payload?.userStartLine === "number" ? payload.userStartLine : null;
      const from = typeof payload?.from === "number" ? payload.from : 0;
      const to = typeof payload?.to === "number" ? payload.to : this.view.state.doc.length;
      if (userStartLine == null && to <= from) return;
      let items = [];
      try {
        const fieldVal = this.view.state.field(toolInlineField);
        fieldVal.items.forEach((it, id) => {
          if (!it) return;
          if (userStartLine != null) {
            if (it.userStartLine !== userStartLine) return;
          } else {
            if (it.from < from || it.from > to) return;
          }
          const name = String(it.name || "");
          if (name !== "edit" && name !== "write" && name !== "fsedit" && name !== "fswrite") return;
          items.push({ id, ...it });
        });
      } catch {}
      if (!items.length && userStartLine != null && to > from) {
        try {
          const fieldVal = this.view.state.field(toolInlineField);
          fieldVal.items.forEach((it, id) => {
            if (!it) return;
            if (it.from < from || it.from > to) return;
            const name = String(it.name || "");
            if (name !== "edit" && name !== "write" && name !== "fsedit" && name !== "fswrite") return;
            items.push({ id, ...it });
          });
        } catch {}
      }
      if (!items.length) {
        notify("当前消息没有可处理的工具调用", { type: "info", duration: 3000 });
        return;
      }
      items.sort((a, b) => a.from - b.from);
      for (const it of items) {
        if (it.name === "edit" || it.name === "fsedit") {
          await this.onEditAccept({
            id: it.id,
            path: it.args?.path,
            old_string: it.args?.old_string,
            new_string: it.args?.new_string,
            replace_all: it.args?.replace_all
          });
        } else if (it.name === "write" || it.name === "fswrite") {
          await this.onWriteAccept({
            id: it.id,
            path: it.args?.path,
            content: it.args?.content
          });
        }
      }
    };
    onBatchRevert = async (payload) => {
      const userStartLine = typeof payload?.userStartLine === "number" ? payload.userStartLine : null;
      const from = typeof payload?.from === "number" ? payload.from : 0;
      const to = typeof payload?.to === "number" ? payload.to : this.view.state.doc.length;
      if (userStartLine == null && to <= from) return;
      let items = [];
      try {
        const fieldVal = this.view.state.field(toolInlineField);
        fieldVal.items.forEach((it, id) => {
          if (!it) return;
          if (userStartLine != null) {
            if (it.userStartLine !== userStartLine) return;
          } else {
            if (it.from < from || it.from > to) return;
          }
          const name = String(it.name || "");
          if (name !== "edit" && name !== "write" && name !== "fsedit" && name !== "fswrite") return;
          items.push({ id, ...it });
        });
      } catch {}
      if (!items.length && userStartLine != null && to > from) {
        try {
          const fieldVal = this.view.state.field(toolInlineField);
          fieldVal.items.forEach((it, id) => {
            if (!it) return;
            if (it.from < from || it.from > to) return;
            const name = String(it.name || "");
            if (name !== "edit" && name !== "write" && name !== "fsedit" && name !== "fswrite") return;
            items.push({ id, ...it });
          });
        } catch {}
      }
      if (!items.length) {
        notify("当前消息没有可处理的工具调用", { type: "info", duration: 3000 });
        return;
      }
      items.sort((a, b) => b.from - a.from);
      for (const it of items) {
        if (it.name === "edit" || it.name === "fsedit") {
          await this.onEditRevert({
            id: it.id,
            path: it.args?.path,
            old_string: it.args?.old_string,
            new_string: it.args?.new_string,
            replace_all: it.args?.replace_all
          });
        } else if (it.name === "write" || it.name === "fswrite") {
          await this.onWriteRevert({
            id: it.id,
            path: it.args?.path,
            content: it.args?.content
          });
        }
      }
    };
    onClear = () => {
      this.view.dispatch({ effects: [clearAll.of({})] });
      this.snapshot();
    };
    onSessionChanged = () => {
      const panelMgr = window.zion?.panelManager;
      const mySessionId = panelMgr?.getPanel(this.panelId)?.activeTabId || null;
      if (mySessionId && mySessionId !== this.sessionId) {
        this.sessionId = mySessionId;
        try { this.view.dispatch({ effects: [clearAll.of({})] }); } catch {}
        this.runActive = false;
        this.anchorPos = this.view.state.doc.length;
        this.loadToolActions();
        this.snapshot();
      } else if (!mySessionId && this.sessionId) {
        this.sessionId = null;
        try { this.view.dispatch({ effects: [clearAll.of({})] }); } catch {}
        this.runActive = false;
        this.anchorPos = this.view.state.doc.length;
      }
    };
    onToolsUpdated = (payload) => {
      const sid = this.sessionId;
      if (!sid) return;
      if (payload?.sessionId && payload.sessionId !== sid) return;
      requestAnimationFrame(() => {
        try {
          const ann = window.zion?.state?.get(`sessions.annotations.${sid}`) || {};
          const list = Array.isArray(ann.tools) ? ann.tools : [];
          if (!list.length) return;
          this.onRestore({ items: list, panelId: this.panelId, __fromToolsUpdated: true });
        } catch {}
      });
    };
    onRestore = (payload) => {
      const list = payload?.items || payload;
      if (!Array.isArray(list) || list.length === 0) return;
      if (payload?.panelId && payload.panelId !== this.panelId) return;
      try {
        const sid = this.sessionId;
        if (sid) window.zion?.state?.set(`sessions.pendingRestore.tools.${sid}`, null);
      } catch {}

      let deletedSet = new Set();
      try {
        const sid = this.sessionId;
        const ann = sid ? (window.zion?.state?.get(`sessions.annotations.${sid}`) || {}) : {};
        const del = Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : [];
        deletedSet = new Set(del);
      } catch {}

      // 扫描文档寻找所有“调用 xxx”锚点，用于位置校准
      const doc = this.view.state.doc;
      const docLen = doc.length;
      const docString = doc.toString();
      const anchors = [];
      const regex = /调用\s+([^\n]+)/g;
      let match;
      while ((match = regex.exec(docString)) !== null) {
        if (match[0].length > 300) continue; // 忽略过长的异常行
        anchors.push({
          from: match.index,
          to: match.index + match[0].length,
          text: match[0],
          name: match[1].trim(),
          occupied: false
        });
      }

      const batchedEffects = [];
      const batchedToggles = [];
      const itemsToProcess = list.filter(it => !deletedSet.has(it?.id));
      const processedIds = new Set();

      // Phase 1: 精确位置匹配 (优先)
      for (const it of itemsToProcess) {
        const expected = `调用 ${it.name}`;
        if (typeof it.from === "number" && typeof it.to === "number" && it.from >= 0 && it.to <= docLen && it.from < it.to) {
          const text = doc.sliceString(it.from, it.to);
          if (text === expected) {
            // 标记锚点被占用
            const anchor = anchors.find(a => a.from === it.from && a.to === it.to && !a.occupied);
            if (anchor) anchor.occupied = true;
            
            batchedEffects.push(addInline.of({ from: it.from, to: it.to, id: it.id, name: it.name, args: it.args, userStartLine: typeof it.userStartLine === "number" ? it.userStartLine : null }));
            if (it.result != null) batchedEffects.push(updateResult.of({ id: it.id, result: it.result, ok: it.ok }));
            if (it.expanded) batchedToggles.push(it.id);
            processedIds.add(it.id);
          }
        }
      }

      // Phase 2: 模糊/最近位置匹配 (应对文本偏移)
      for (const it of itemsToProcess) {
        if (processedIds.has(it.id)) continue;

        let bestAnchor = null;
        let minDist = Infinity;
        // 寻找同名且未占用的最近锚点
        for (const anchor of anchors) {
          if (anchor.occupied) continue;
          if (anchor.name !== it.name) continue;
          const dist = Math.abs(anchor.from - (it.from || 0));
          if (dist < minDist) {
            minDist = dist;
            bestAnchor = anchor;
          }
        }

        if (bestAnchor) {
          bestAnchor.occupied = true;
          // 使用新发现的位置
          batchedEffects.push(addInline.of({ from: bestAnchor.from, to: bestAnchor.to, id: it.id, name: it.name, args: it.args, userStartLine: typeof it.userStartLine === "number" ? it.userStartLine : null }));
          if (it.result != null) batchedEffects.push(updateResult.of({ id: it.id, result: it.result, ok: it.ok }));
          if (it.expanded) batchedToggles.push(it.id);
          processedIds.add(it.id);
          
          // 更新 item 位置以便 snapshot
          it.from = bestAnchor.from;
          it.to = bestAnchor.to;
        }
      }

      // 批量应用 Phase 1 & 2 的效果
      if (batchedEffects.length) this.view.dispatch({ effects: batchedEffects });
      if (batchedToggles.length) {
        const eff2 = batchedToggles.map(id => toggleInline.of({ id }));
        this.view.dispatch({ effects: eff2 });
      }

      // Phase 3: 兜底 (创建新锚点)
      for (const it of itemsToProcess) {
        if (processedIds.has(it.id)) continue;

        const name = it.name || "tool";
        // 重新获取 doc，因为前面的 dispatch 可能没改变 doc (effects only)，但在 Phase 3 循环中我们会修改 doc
        const docNow = this.view.state.doc;
        const pos = findAssistantBlockEnd(this.view);
        const prevChar = pos > 0 ? docNow.sliceString(pos - 1, pos) : "";
        const prefix = prevChar === "\n" || pos === 0 ? "" : "\n";
        const text = `${prefix}调用 ${name}\n`;
        const start = pos + prefix.length;
        const end = start + (`调用 ${name}`).length;
        const userStartLine = typeof it.userStartLine === "number" ? it.userStartLine : findPrevRoleStartLine(docNow, start, "user");

        this.view.dispatch({
          changes: { from: pos, insert: text },
          effects: [addInline.of({ from: start, to: end, id: it.id, name, args: it.args, userStartLine })]
        });
        
        if (it.result != null) {
          this.view.dispatch({ effects: [updateResult.of({ id: it.id, result: it.result, ok: it.ok })] });
        }
        if (it.expanded) {
          this.view.dispatch({ effects: [toggleInline.of({ id: it.id })] });
        }
        
        // 更新 item 位置
        it.from = start;
        it.to = end;
        
        processedIds.add(it.id);
      }


      this.snapshot();
    };
    destroy() {
      for (const d of this.disps) { try { d?.dispose?.(); } catch {} }
      try { if (this.selRaf) window.cancelAnimationFrame(this.selRaf); } catch {}
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
