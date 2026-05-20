import { Decoration, EditorView, WidgetType, ViewPlugin } from "@codemirror/view";
import { StateField, StateEffect, Transaction } from "@codemirror/state";
import { diffWordsWithSpace } from "diff";
import {
  buildRegexAnchors,
  filterDeletedItems,
  planAssistantMarkerInsertion,
  reconcileExactAnchors,
  reconcileMountedItems,
  reconcileNearestAnchors
} from "../../src/chat/restore";

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

function debugToolFieldStats(_view) {
  return {};
}

function scheduleRevealToolContent(view, { id, pos } = {}) {
  try {
    const sid = getViewSessionId(view);
    if (!sid) return;
    if (window?.zion?.state?.get?.(`chat.followLatest.${sid}`) === false) return;
    requestAnimationFrame(() => {
      try {
        const scrollDOM = view?.scrollDOM;
        if (!scrollDOM) return;
        const selectorId = String(id || "").replace(/"/g, '\\"');
        const toolEl = selectorId
          ? view.dom.querySelector(`.zion-tool-call-inline[data-tool-id="${selectorId}"], .zion-tool-call-card[data-tool-id="${selectorId}"]`)
          : null;
        const viewportRect = scrollDOM.getBoundingClientRect();
        const margin = 24;
        let nextScrollTop = null;

        if (toolEl) {
          const rect = toolEl.getBoundingClientRect();
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

function createSectionLabel(text) {
  const el = document.createElement("div");
  el.textContent = text;
  Object.assign(el.style, {
    fontSize: "10px",
    fontWeight: "600",
    marginBottom: "6px",
    opacity: "0.8"
  });
  return el;
}

function createCodeBlock(text, { max = 12000, background = "rgba(128,128,128,0.05)" } = {}) {
  const body = document.createElement("pre");
  body.textContent = fmt(text, max);
  Object.assign(body.style, {
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    lineHeight: "1.5",
    background,
    padding: "8px 10px",
    borderRadius: "6px",
    overflowX: "auto"
  });
  return body;
}

function normalizeToolName(name) {
  return String(name || "").trim().toLowerCase();
}

function parseMaybeJson(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (!(text.startsWith("{") || text.startsWith("["))) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function createMetaPill(text) {
  const el = document.createElement("span");
  el.textContent = text;
  Object.assign(el.style, {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 6px",
    borderRadius: "999px",
    fontSize: "10px",
    color: "var(--muted-fg, var(--fg))",
    background: "rgba(128,128,128,0.08)",
    border: "1px solid rgba(128,128,128,0.12)"
  });
  return el;
}

function createInfoText(text) {
  const el = document.createElement("div");
  el.textContent = text;
  Object.assign(el.style, {
    fontSize: "10px",
    color: "var(--muted-fg, var(--fg))",
    marginTop: "6px"
  });
  return el;
}

function createToolMetaRow(name, args) {
  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    marginBottom: "8px"
  });
  const n = normalizeToolName(name);
  const path = String(args?.path || args?.file_path || "").trim();
  if (path) row.appendChild(createMetaPill(path));
  if ((n === "edit" || n === "fsedit") && typeof args?.replace_all === "boolean") {
    row.appendChild(createMetaPill(args.replace_all ? "replace all" : "replace first"));
  }
  if ((n === "read" || n === "fsread") && typeof args?.offset === "number") {
    row.appendChild(createMetaPill(`offset ${args.offset}`));
  }
  if ((n === "read" || n === "fsread") && typeof args?.limit === "number") {
    row.appendChild(createMetaPill(`limit ${args.limit}`));
  }
  return row.childNodes.length ? row : null;
}

function createLineTable(lines, { maxRows = 220, showLineNumbers = true } = {}) {
  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    border: "1px solid rgba(128,128,128,0.12)",
    borderRadius: "8px",
    overflow: "hidden",
    background: "rgba(128,128,128,0.03)"
  });
  const rows = Array.isArray(lines) ? lines.slice(0, maxRows) : [];
  for (let i = 0; i < rows.length; i++) {
    const item = rows[i] || {};
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "grid",
      gridTemplateColumns: showLineNumbers ? "56px minmax(0,1fr)" : "minmax(0,1fr)",
      borderTop: i === 0 ? "none" : "1px solid rgba(128,128,128,0.06)"
    });
    if (showLineNumbers) {
      const gutter = document.createElement("div");
      gutter.textContent = item.no == null ? "" : String(item.no);
      Object.assign(gutter.style, {
        padding: "4px 8px",
        textAlign: "right",
        color: "var(--muted-fg, rgba(127,127,127,0.9))",
        fontFamily: "var(--font-mono)",
        fontSize: "10px",
        userSelect: "none",
        background: "rgba(128,128,128,0.06)"
      });
      row.appendChild(gutter);
    }
    const code = document.createElement("div");
    code.textContent = item.text == null ? "" : String(item.text);
    Object.assign(code.style, {
      padding: "4px 10px",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontFamily: "var(--font-mono)",
      fontSize: "11px",
      lineHeight: "1.5",
      minHeight: "22px"
    });
    row.appendChild(code);
    wrap.appendChild(row);
  }
  if (Array.isArray(lines) && lines.length > maxRows) {
    wrap.appendChild(createInfoText(`内容过长，已截断显示前 ${maxRows} 行`));
  }
  return wrap;
}

function createReadView(text) {
  const raw = String(text ?? "").replace(/\r/g, "");
  const lines = raw.split("\n");
  const header = lines[0] || "";
  const numbered = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*(\d+)\s+\|\s?(.*)$/);
    if (m) numbered.push({ no: Number(m[1]), text: m[2] || "" });
    else numbered.push({ no: null, text: line });
  }
  const section = document.createElement("div");
  if (header.startsWith("// File:")) {
    section.appendChild(createMetaPill(header.replace(/^\/\/\s*/, "")));
    section.firstChild.style.marginBottom = "8px";
  }
  section.appendChild(createLineTable(numbered.length ? numbered : lines.map((line, idx) => ({ no: idx + 1, text: line })), { maxRows: 260 }));
  return section;
}

function createSearchResultsView(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    display: "grid",
    gap: "8px"
  });
  results.slice(0, 8).forEach((item, idx) => {
    const card = document.createElement("div");
    Object.assign(card.style, {
      padding: "8px 10px",
      borderRadius: "8px",
      border: "1px solid rgba(128,128,128,0.12)",
      background: "rgba(128,128,128,0.03)"
    });
    const title = document.createElement("div");
    title.textContent = item?.title || item?.name || `结果 ${idx + 1}`;
    Object.assign(title.style, {
      fontSize: "11px",
      fontWeight: "600",
      marginBottom: "4px"
    });
    card.appendChild(title);
    if (item?.url) {
      const url = document.createElement("div");
      url.textContent = item.url;
      Object.assign(url.style, {
        fontSize: "10px",
        color: "var(--accent)",
        marginBottom: item?.snippet ? "4px" : "0",
        wordBreak: "break-all"
      });
      card.appendChild(url);
    }
    if (item?.snippet) {
      const snippet = document.createElement("div");
      snippet.textContent = item.snippet;
      Object.assign(snippet.style, {
        fontSize: "10px",
        lineHeight: "1.5",
        color: "var(--muted-fg, var(--fg))"
      });
      card.appendChild(snippet);
    }
    wrap.appendChild(card);
  });
  if (results.length > 8) wrap.appendChild(createInfoText(`共 ${results.length} 条结果，当前展示前 8 条`));
  return wrap;
}

function createPathListView(items, emptyText = "无结果") {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return createInfoText(emptyText);
  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    border: "1px solid rgba(128,128,128,0.12)",
    borderRadius: "8px",
    overflow: "hidden",
    background: "rgba(128,128,128,0.03)"
  });
  list.slice(0, 120).forEach((item, idx) => {
    const row = document.createElement("div");
    row.textContent = String(item);
    Object.assign(row.style, {
      padding: "5px 10px",
      borderTop: idx === 0 ? "none" : "1px solid rgba(128,128,128,0.06)",
      fontFamily: "var(--font-mono)",
      fontSize: "11px",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word"
    });
    wrap.appendChild(row);
  });
  if (list.length > 120) wrap.appendChild(createInfoText(`共 ${list.length} 项，当前展示前 120 项`));
  return wrap;
}

function createGrepResultsView(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const mode = String(data?.output_mode || "");
  if (!results.length) return createInfoText("无命中结果");
  if (mode === "files_with_matches") {
    return createPathListView(results, "无命中结果");
  }
  if (mode === "count") {
    const rows = results.map((item) => {
      if (typeof item === "string") return item;
      const path = item?.path || item?.file || item?.file_path || "";
      const count = item?.count ?? item?.matches ?? "";
      return path ? `${path}  ${count}` : JSON.stringify(item);
    });
    return createPathListView(rows, "无命中结果");
  }
  const wrap = document.createElement("div");
  Object.assign(wrap.style, { display: "grid", gap: "8px" });
  results.slice(0, 40).forEach((item) => {
    const card = document.createElement("div");
    Object.assign(card.style, {
      border: "1px solid rgba(128,128,128,0.12)",
      borderRadius: "8px",
      overflow: "hidden",
      background: "rgba(128,128,128,0.03)"
    });
    const path = document.createElement("div");
    path.textContent = item?.path || item?.file || item?.file_path || "match";
    Object.assign(path.style, {
      padding: "6px 10px",
      fontSize: "10px",
      fontWeight: "600",
      background: "rgba(128,128,128,0.06)"
    });
    card.appendChild(path);
    const chunks = Array.isArray(item?.lines)
      ? item.lines
      : Array.isArray(item?.matches)
        ? item.matches
        : [item];
    const lines = [];
    chunks.forEach((entry) => {
      if (typeof entry === "string") {
        lines.push({ no: null, text: entry });
        return;
      }
      const no = typeof entry?.line_number === "number" ? entry.line_number : (typeof entry?.line === "number" ? entry.line : null);
      const text = entry?.text ?? entry?.content ?? entry?.line_text ?? JSON.stringify(entry);
      lines.push({ no, text });
    });
    card.appendChild(createLineTable(lines, { maxRows: 40 }));
    wrap.appendChild(card);
  });
  if (results.length > 40) wrap.appendChild(createInfoText(`共 ${results.length} 项命中，当前展示前 40 项`));
  return wrap;
}

function createWritePreviewView(args) {
  const section = document.createElement("div");
  const content = String(args?.content ?? "");
  const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
  const lines = content.replace(/\r/g, "").split("\n").map((text, idx) => ({ no: idx + 1, text }));
  section.appendChild(createLineTable(lines, { maxRows: 220 }));
  if (prompt) section.appendChild(createInfoText(`prompt: ${prompt}`));
  return section;
}

function createEditDiffView(args) {
  const oldText = String(args?.old_string ?? "");
  const newText = String(args?.new_string ?? "");
  const renderDiffText = (side) => {
    const content = document.createElement("div");
    Object.assign(content.style, {
      padding: "10px 12px 12px",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontFamily: "var(--font-mono)",
      fontSize: "11px",
      lineHeight: "1.6",
      color: "var(--fg)"
    });
    const parts = diffWordsWithSpace(oldText, newText);
    let wrote = false;
    for (const part of parts) {
      const shouldShow = side === "search"
        ? !part.added
        : !part.removed;
      if (!shouldShow) continue;
      if ((side === "search" && part.removed) || (side === "replace" && part.added)) {
        const mark = document.createElement("span");
        mark.textContent = part.value;
        Object.assign(mark.style, {
          background: side === "search" ? "rgba(248, 81, 73, 0.16)" : "rgba(46, 160, 67, 0.16)",
          boxShadow: side === "search"
            ? "inset 0 0 0 1px rgba(248, 81, 73, 0.22)"
            : "inset 0 0 0 1px rgba(46, 160, 67, 0.22)",
          borderRadius: "4px"
        });
        content.appendChild(mark);
      } else {
        content.appendChild(document.createTextNode(part.value));
      }
      wrote = true;
    }
    if (!wrote) content.textContent = side === "search" ? oldText : newText;
    if (!content.textContent && !content.childNodes.length) content.textContent = " ";
    return content;
  };
  const makeBlock = (label, text, tone) => {
    const block = document.createElement("div");
    Object.assign(block.style, {
      border: tone === "search"
        ? "1px solid rgba(248, 81, 73, 0.18)"
        : "1px solid rgba(46, 160, 67, 0.18)",
      borderRadius: "10px",
      overflow: "hidden",
      background: "transparent",
      boxShadow: "none"
    });
    const head = document.createElement("div");
    head.textContent = label;
    Object.assign(head.style, {
      padding: "7px 10px",
      fontSize: "10px",
      fontWeight: "600",
      letterSpacing: "0.02em",
      textTransform: "uppercase",
      color: "var(--muted-fg, var(--fg))",
      background: tone === "search" ? "rgba(248, 81, 73, 0.10)" : "rgba(46, 160, 67, 0.10)",
      borderBottom: tone === "search"
        ? "1px solid rgba(248, 81, 73, 0.14)"
        : "1px solid rgba(46, 160, 67, 0.14)"
    });
    block.appendChild(head);
    const body = renderDiffText(tone);
    if (String(text ?? "").replace(/\r/g, "").split("\n").length > 160) {
      body.appendChild(createInfoText("内容过长，当前仅适合查看关键替换片段"));
    }
    block.appendChild(body);
    return block;
  };
  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    display: "grid",
    gap: "8px"
  });
  wrap.appendChild(makeBlock("Search", oldText, "search"));
  wrap.appendChild(makeBlock("Replace", newText, "replace"));
  return wrap;
}

function createPatchView(text) {
  const wrap = document.createElement("div");
  Object.assign(wrap.style, {
    border: "1px solid rgba(128,128,128,0.12)",
    borderRadius: "8px",
    overflow: "hidden",
    background: "rgba(128,128,128,0.03)"
  });
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const MAX_LINES = 280;
  const total = Math.min(lines.length, MAX_LINES);
  for (let i = 0; i < total; i++) {
    const line = lines[i];
    const row = document.createElement("div");
    const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "remove" : line.startsWith("@@") ? "hunk" : line.startsWith("***") ? "header" : "context";
    const palette = kind === "add"
      ? { bg: "rgba(46, 160, 67, 0.10)", fg: "inherit" }
      : kind === "remove"
        ? { bg: "rgba(248, 81, 73, 0.10)", fg: "inherit" }
        : kind === "hunk"
          ? { bg: "rgba(56, 139, 253, 0.10)", fg: "inherit" }
          : kind === "header"
            ? { bg: "rgba(128,128,128,0.08)", fg: "inherit" }
            : { bg: "transparent", fg: "inherit" };
    row.textContent = line || " ";
    Object.assign(row.style, {
      padding: "4px 10px",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      fontFamily: "var(--font-mono)",
      fontSize: "11px",
      lineHeight: "1.5",
      borderTop: i === 0 ? "none" : "1px solid rgba(128,128,128,0.06)",
      background: palette.bg,
      color: palette.fg
    });
    wrap.appendChild(row);
  }
  if (lines.length > MAX_LINES) {
    const more = document.createElement("div");
    more.textContent = `patch 过长，已截断显示前 ${MAX_LINES} 行`;
    Object.assign(more.style, {
      padding: "8px 10px",
      fontSize: "10px",
      color: "var(--muted-fg, var(--fg))",
      background: "rgba(128,128,128,0.05)",
      borderTop: "1px solid rgba(128,128,128,0.08)"
    });
    wrap.appendChild(more);
  }
  return wrap;
}

function createToolRequestRenderer(name, args) {
  const n = normalizeToolName(name);
  const section = document.createElement("div");
  section.style.marginBottom = "8px";
  section.appendChild(createSectionLabel("请求参数:"));
  const meta = createToolMetaRow(name, args);
  if (meta) section.appendChild(meta);
  if ((n === "edit" || n === "fsedit") && args && (typeof args.old_string === "string" || typeof args.new_string === "string")) {
    section.appendChild(createEditDiffView(args));
    return section;
  }
  if (n === "write" || n === "fswrite") {
    section.appendChild(createWritePreviewView(args || {}));
    return section;
  }
  if (n === "apply_patch") {
    const patchText = typeof args === "string" ? args : (typeof args?.patch === "string" ? args.patch : JSON.stringify(args, null, 2));
    section.appendChild(createPatchView(patchText));
    return section;
  }
  section.appendChild(createCodeBlock(args, { max: 4000 }));
  return section;
}

function renderLightMarkdown(text) {
  const raw = String(text ?? "");
  let html = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre style="margin:6px 0;padding:8px 10px;border-radius:6px;background:rgba(128,128,128,0.08);overflow-x:auto;font-size:11px;line-height:1.5;"><code>${code}</code></pre>`;
  });
  html = html.replace(/`([^`\n]+)`/g, '<code style="padding:1px 4px;border-radius:3px;background:rgba(128,128,128,0.12);font-size:11px;">$1</code>');
  html = html.replace(/^### (.+)$/gm, '<h4 style="margin:10px 0 4px;font-size:12px;font-weight:600;">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 style="margin:12px 0 4px;font-size:13px;font-weight:600;">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 style="margin:14px 0 6px;font-size:14px;font-weight:600;">$1</h2>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:underline;">$1</a>');
  html = html.replace(/^[-*] (.+)$/gm, '<li style="margin:2px 0 2px 16px;">$1</li>');
  html = html.replace(/^> (.+)$/gm, '<blockquote style="margin:4px 0;padding:4px 8px;border-left:3px solid var(--border);opacity:0.85;">$1</blockquote>');
  html = html.replace(/\n{2,}/g, '</p><p style="margin:6px 0;">');
  html = html.replace(/\n/g, '<br>');
  return `<div style="font-size:11px;line-height:1.6;max-height:400px;overflow-y:auto;padding:8px 10px;border-radius:6px;background:rgba(128,128,128,0.04);">${html}</div>`;
}

function createMarkdownView(text) {
  const wrap = document.createElement("div");
  wrap.innerHTML = renderLightMarkdown(text);
  return wrap;
}

function createToolResponseRenderer(name, result) {
  const n = normalizeToolName(name);
  const section = document.createElement("div");
  section.appendChild(createSectionLabel("响应结果:"));
  if (n === "read" || n === "fsread") {
    section.appendChild(createReadView(result));
    return section;
  }
  if (n === "webfetch" || n === "web_read" || n === "fetch") {
    section.appendChild(createMarkdownView(result));
    return section;
  }
  const parsed = parseMaybeJson(result);
  if ((n === "websearch" || n === "localsearch") && parsed?.results) {
    section.appendChild(createSearchResultsView(parsed));
    return section;
  }
  if (n === "glob" && parsed?.results) {
    section.appendChild(createPathListView(parsed.results, "无匹配文件"));
    return section;
  }
  if (n === "grep" && parsed?.results) {
    section.appendChild(createGrepResultsView(parsed));
    return section;
  }
  section.appendChild(createCodeBlock(result, { max: 12000 }));
  return section;
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

function getPanelEventContext(panelId) {
  const pid = typeof panelId === "string" && panelId ? panelId : null;
  let sessionId = null;
  try {
    if (pid) {
      sessionId = window.zion?.panelManager?.getPanel?.(pid)?.activeTabId
        || window.zion?.panels?.list?.().find((panel) => panel.id === pid)?.activeTabId
        || null;
    }
  } catch {}
  return { panelId: pid, sessionId };
}

// 简要摘要：根据工具名称与参数，生成单行提示（便于用户无需展开卡片也能知情）
function clip(s, max = 80) {
  const t = String(s || "");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function clipMiddle(s, max = 80) {
  const t = String(s || "");
  if (t.length <= max) return t;
  if (max <= 1) return "…";
  const keep = Math.max(1, max - 1);
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${t.slice(0, left)}…${t.slice(t.length - right)}`;
}

function normalizePathForLabel(path) {
  return String(path || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function pathBasename(path) {
  const p = normalizePathForLabel(path);
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function pathParentTail(path, segments = 2) {
  const p = normalizePathForLabel(path);
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).slice(-segments).join("/");
}

function formatPathForChip(path, max = 44) {
  const p = normalizePathForLabel(path);
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  const tailCount = max >= 70 ? 3 : 2;
  const tail = parts.slice(-tailCount).join("/") || pathBasename(p);
  return clipMiddle(tail, max);
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

function summarizeToolArgsCompact(name, args, max = 44) {
  const n = String(name || "");
  const a = args || {};
  try {
    switch (n) {
      case "fsRead":
      case "read": {
        const fp = String(a?.path || a?.file_path || "").trim();
        if (!fp) break;
        const off = typeof a?.offset === "number" ? a.offset : null;
        const lim = typeof a?.limit === "number" ? a.limit : null;
        const suffix = off != null || lim != null ? ` @${off != null ? off : "-"}+${lim != null ? lim : "-"}` : "";
        return `${formatPathForChip(fp, Math.max(12, max - suffix.length))}${suffix}`;
      }
      case "fsWrite":
      case "write": {
        const fp = String(a?.path || a?.file_path || "").trim();
        if (!fp) break;
        const len = String(a?.content ?? "").length;
        const suffix = len ? ` (${len} chars)` : "";
        return `${formatPathForChip(fp, Math.max(12, max - suffix.length))}${suffix}`;
      }
      case "fsEdit":
      case "edit": {
        const fp = String(a?.path || a?.file_path || "").trim();
        if (!fp) break;
        const suffix = a?.replace_all ? " (all)" : "";
        return `${formatPathForChip(fp, Math.max(12, max - suffix.length))}${suffix}`;
      }
      case "fsTree":
      case "tree": {
        const dir = String(a?.path || a?.directory_path || "").trim();
        if (!dir) break;
        const md = typeof a?.max_depth === "number" ? a.max_depth : null;
        const suffix = md != null ? ` (depth ${md})` : "";
        return `${formatPathForChip(dir, Math.max(12, max - suffix.length))}${suffix}`;
      }
      case "glob": {
        const pattern = String(a?.pattern || "").trim();
        const dir = String(a?.path || "").trim();
        if (!pattern && !dir) break;
        if (!dir) return clipMiddle(pattern, max);
        const where = formatPathForChip(dir, Math.max(12, Math.floor(max * 0.45)));
        return clipMiddle(`${pattern} in ${where}`, max);
      }
      case "grep": {
        const pattern = String(a?.pattern || "").trim();
        const dir = String(a?.path || "").trim();
        if (!pattern && !dir) break;
        if (!dir) return clipMiddle(pattern, max);
        const where = formatPathForChip(dir, Math.max(12, Math.floor(max * 0.45)));
        return clipMiddle(`${pattern} in ${where}`, max);
      }
      default:
        break;
    }
  } catch {}
  const summary = summarizeToolArgs(name, args);
  return summary ? clipMiddle(summary, max) : "";
}

class ToolCallCardWidget extends WidgetType {
  constructor(id, name, args, result, ok, sessionId = null) {
    super();
    this.id = id + ":card";
    this.name = name;
    this.args = args;
    this.result = result;
    this.ok = ok;
    this.sessionId = sessionId || null;
  }
  eq(other) {
    return other.id === this.id && other.name === this.name && other.result === this.result && other.ok === this.ok && other.sessionId === this.sessionId && JSON.stringify(other.args) === JSON.stringify(this.args);
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "zion-tool-call-card";
    wrap.setAttribute("data-tool-id", String(this.id).replace(/:card$/, ""));
    const getActionContext = () => {
      try {
        const panelId = wrap.closest?.("[data-panel-id]")?.getAttribute?.("data-panel-id") || null;
        const ctx = getPanelEventContext(panelId);
        return { ...ctx, sessionId: ctx.sessionId || this.sessionId || null };
      } catch {}
      return { panelId: null, sessionId: this.sessionId || null };
    };
    // 头部：名称与移除按钮
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:flex-start;gap:8px;margin-bottom:8px;min-width:0;";
    const headMain = document.createElement("div");
    Object.assign(headMain.style, {
      display: "grid",
      gap: "2px",
      minWidth: 0,
      flex: "1 1 auto"
    });
    const titleRow = document.createElement("div");
    Object.assign(titleRow.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      minWidth: 0
    });
    const title = document.createElement("span");
    title.textContent = `调用 ${this.name}`;
    Object.assign(title.style, {
      fontSize: "11px",
      fontWeight: "650",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      minWidth: 0
    });

    titleRow.appendChild(title);

    const ok = inferToolOkFromResult(this.name, this.result, this.ok);
    const badge = document.createElement("span");
    badge.className = "zion-tool-call-status";
    const status = toolStatusAttr(ok, this.result != null);
    const label = toolStatusLabel(ok, this.result != null);
    badge.setAttribute("data-status", status);
    badge.innerHTML = toolStatusIcon(status);
    badge.title = label;
    badge.setAttribute("aria-label", `工具调用状态：${label}`);
    titleRow.appendChild(badge);
    headMain.appendChild(titleRow);

    const summary = summarizeToolArgsCompact(this.name, this.args, 90);
    if (summary) {
      const subtitle = document.createElement("div");
      subtitle.textContent = summary;
      subtitle.title = summarizeToolArgs(this.name, this.args);
      Object.assign(subtitle.style, {
        color: "var(--muted-fg, rgba(127,127,127,0.92))",
        fontSize: "10px",
        lineHeight: "1.35",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0
      });
      headMain.appendChild(subtitle);
    }
    header.appendChild(headMain);

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
          const ctx = getActionContext();
          window.zion?.events?.emit("toolcards/editRevert", {
            id: baseId,
            path: this.args.path,
            old_string: this.args.old_string,
            new_string: this.args.new_string,
            replace_all: this.args.replace_all,
            panelId: ctx.panelId,
            sessionId: ctx.sessionId
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
          const ctx = getActionContext();
          window.zion?.events?.emit("toolcards/editAccept", {
            id: baseId,
            path: this.args.path,
            old_string: this.args.old_string,
            new_string: this.args.new_string,
            replace_all: this.args.replace_all,
            panelId: ctx.panelId,
            sessionId: ctx.sessionId
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
          const ctx = getActionContext();
          window.zion?.events?.emit("toolcards/writeRevert", {
            id: baseId,
            path: this.args.path,
            content: this.args.content,
            panelId: ctx.panelId,
            sessionId: ctx.sessionId
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
          const ctx = getActionContext();
          window.zion?.events?.emit("toolcards/writeAccept", {
            id: baseId,
            path: this.args.path,
            content: this.args.content,
            panelId: ctx.panelId,
            sessionId: ctx.sessionId
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
      const editorEl = close.closest("[data-editor-id]");
      const sessionId = editorEl?.getAttribute("data-session-id") || null;
      const panelId = editorEl?.closest("[data-panel-id]")?.getAttribute("data-panel-id") || close.closest("[data-panel-id]")?.getAttribute("data-panel-id") || null;
      try { window.zion?.events?.emit("toolcards/remove", { id: baseId, panelId, sessionId }); } catch {}
    });
    header.appendChild(close);
    wrap.appendChild(header);

    // 请求参数部分
    if (this.args) {
      wrap.appendChild(createToolRequestRenderer(this.name, this.args));
    }

    // 响应结果部分
    if (this.result) {
      wrap.appendChild(createToolResponseRenderer(this.name, this.result));
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
    const compactSummary = summarizeToolArgsCompact(this.name, this.args, 36);
    span.title = summaryText
      ? `调用 ${this.name}：${summaryText}（点击展开/收起）`
      : `调用 ${this.name}（点击展开/收起）`;
    span.setAttribute("aria-label", `调用 ${this.name}（点击展开或收起工具调用卡片）`);
    Object.assign(span.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      maxWidth: "min(520px, 75%)",
      minWidth: 0,
      whiteSpace: "nowrap",
      overflow: "hidden",
      verticalAlign: "baseline"
    });

    const btn = document.createElement("button");
    btn.className = "zion-tool-call-inline-toggle";
    btn.type = "button";
    btn.title = "展开/收起工具调用卡片";
    btn.setAttribute("aria-label", "展开/收起工具调用卡片");
    // 内联 SVG（chevron-down），主题跟随 currentColor
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
  <path d="M4.646 6.646a.5.5 0 0 1 .708 0L8 9.293l2.646-2.647a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 0 1 0-.708z"></path>
</svg>`;
    Object.assign(btn.style, {
      flex: "0 0 auto"
    });
    // 不阻止事件冒泡，交由全局 click handler 处理 toggle
    span.appendChild(btn);

    // 信息容器：保持单行省略，避免长参数把正文挤成多行。
    const info = document.createElement("span");
    info.className = "zion-tool-call-inline-info";
    Object.assign(info.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    });

    const txt = document.createElement("span");
    txt.className = "zion-tool-call-inline-text";
    txt.textContent = `调用 ${this.name}`;
    Object.assign(txt.style, {
      flex: "0 0 auto",
      whiteSpace: "nowrap"
    });
    info.appendChild(txt);

    // 只显示极短摘要；完整参数放 title 和展开卡片里。
    if (compactSummary) {
      const sum = document.createElement("span");
      sum.className = "zion-tool-call-inline-summary";
      sum.textContent = `· ${compactSummary}`;
      Object.assign(sum.style, {
        color: "var(--muted-fg, rgba(127,127,127,0.9))",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0
      });
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
    Object.assign(badge.style, {
      flex: "0 0 auto"
    });
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
    const debugEffects = { clearAll: 0, addInline: 0, toggleInline: 0, updateResult: 0, removeTool: 0 };
    let debugRemovedIds = [];
    let debugUserEvent = null;
    try { debugUserEvent = tr?.annotation?.(Transaction.userEvent) || null; } catch {}
    val.items.forEach((it, id) => {
      const mappedFrom = tr.changes.mapPos(it.from, 1);
      const mappedTo = tr.changes.mapPos(it.to, -1);
      items.set(id, { ...it, from: mappedFrom, to: mappedTo });
    });

    // 2) 处理 effects
    for (const e of tr.effects) {
      if (e.is(clearAll)) {
        debugEffects.clearAll += 1;
        deco = Decoration.none;
        items.clear();
      }
      if (e.is(addInline)) {
        debugEffects.addInline += 1;
        const { from, to, id, name, args, userStartLine, sessionId } = e.value;
        // replace 原始文本为 inline widget（不可编辑、可定制样式）
        const widget = new ToolInlineWidget(id, name, args, null, false);
        const repl = Decoration.replace({ widget }).range(from, to);
        deco = deco.update({ add: [repl] });
        items.set(id, { from, to, name, args, result: null, ok: null, expanded: false, userStartLine: typeof userStartLine === "number" ? userStartLine : null, sessionId: sessionId || null });
      }
      if (e.is(toggleInline)) {
        debugEffects.toggleInline += 1;
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
          const widget = new ToolCallCardWidget(id, it.name, it.args, it.result, it.ok, it.sessionId || null);
          deco = deco.update({ add: [Decoration.widget({ widget, side: 1 }).range(it.to)] });
          items.set(id, { ...it, expanded: true });
        }
      }
      if (e.is(updateResult)) {
        debugEffects.updateResult += 1;
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
          const widget = new ToolCallCardWidget(id, updated.name, updated.args, updated.result, updated.ok, updated.sessionId || null);
          deco = deco.update({ add: [Decoration.widget({ widget, side: 1 }).range(updated.to)] });
        }
      }
      if (e.is(removeTool)) {
        debugEffects.removeTool += 1;
        const base = String(e.value?.id || "");
        const itemSessionId = items.get(base)?.sessionId || null;
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
          const sid = e.value?.sessionId || itemSessionId || null;
          if (sid) {
            updateSessionAnnotations(sid, (ann) => {
              const del = Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds.slice() : [];
              if (!del.includes(base)) del.push(base);
              return { ...ann, deletedToolIds: del };
            });
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
        debugRemovedIds = toRemove.map(id => String(id));
        const isSessionLoad = (() => {
          try {
            return tr?.annotation?.(Transaction.userEvent) === "zion.sessionLoad";
          } catch {
            return false;
          }
        })();
        const removedSessionId = toRemove.map(id => items.get(id)?.sessionId).find(Boolean) || null;
        // 移除对应 inline/card 装饰
        deco = deco.update({
          filter: (_f, _t, value) => {
            const wid = value?.spec?.widget?.id || "";
            return !toRemove.some(id => wid === (id + ":inline") || wid === (id + ":card"));
          }
        });
        // 删除内存条目
        toRemove.forEach(id => items.delete(id));
        // 文档整体 session-load 时，旧锚点失效不代表用户删除，不应写 deleted 标记。
        if (!isSessionLoad) {
          try {
            const sid = removedSessionId || null;
            if (sid) {
              updateSessionAnnotations(sid, (ann) => {
                const del = Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds.slice() : [];
                toRemove.forEach(id => { if (!del.includes(id)) del.push(id); });
                return { ...ann, deletedToolIds: del };
              });
            }
          } catch {}
        }
      }
    } catch {}

    try {
      const effectCount = debugEffects.clearAll + debugEffects.addInline + debugEffects.toggleInline + debugEffects.updateResult + debugEffects.removeTool;
      if (effectCount || debugRemovedIds.length || debugUserEvent === "zion.sessionLoad") {
        debugChatCards("field.update", {
          prevCount: val.items?.size || 0,
          nextCount: items.size,
          effects: debugEffects,
          removedIds: debugRemovedIds,
          docChanged: !!tr.docChanged,
          userEvent: debugUserEvent,
          docLength: tr.state?.doc?.length || 0
        });
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
      this.mirrorToolCalls = new Map();
      try { this.panelId = this.view.dom.closest("[data-panel-id]")?.getAttribute("data-panel-id") || null; } catch { this.panelId = null; }
      try {
        this.sessionId = getViewSessionId(this.view);
      } catch {}
      debugChatCards("plugin.init", { panelId: this.panelId, sessionId: this.sessionId, docLength: this.view.state.doc.length });
      this.disps.push(window.zion.events.on("chat/runStarted", this.onRun));
      this.disps.push(window.zion.events.on("chat/runFinished", this.onFinish));
      this.disps.push(window.zion.events.on("chat/toolCall", this.onCall));
      this.disps.push(window.zion.events.on("toolcards/inlineInserted", this.onInlineInserted));
      this.disps.push(window.zion.events.on("chat/toolResult", this.onRes));
      this.disps.push(window.zion.events.on("toolcards/remove", this.onRemove));
      this.disps.push(window.zion.events.on("toolcards/restore", this.onRestore));
      this.disps.push(window.zion.events.on("toolcards/clear", this.onClear));
      this.disps.push(window.zion.events.on("toolcards/snapshot", this.onSnapshot));
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
          const pending = sid ? window.zion?.commands?.executeCommand?.("zion.chatCards.getPendingRestore", { sessionId: sid, kind: "tools" }) : null;
          const ann = sid ? getSessionAnnotations(sid) : {};
          const list = Array.isArray(ann.tools) ? ann.tools : [];
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
        const ann = getSessionAnnotations(sid);
        const list = Array.isArray(ann.tools) ? ann.tools : [];
        let mountedIds = [];
        try {
          const fieldVal = this.view.state.field(toolInlineField);
          if (fieldVal?.items) fieldVal.items.forEach((_it, id) => mountedIds.push(String(id)));
        } catch {}
        if (!list.length) return;

        // 基于 StateField 中的已挂载 id 判断是否需要恢复
        const wantIds = list.map(it => it?.id).filter(Boolean).map(String);
        const missing = wantIds.some(id => !mountedIds.includes(id));
        debugChatCards("visibility.checkAndRestore", {
          panelId: this.panelId,
          sessionId: sid,
          annotations: list.length,
          mounted: mountedIds.length,
          missing,
          stats: debugToolFieldStats(this.view)
        });
        if (missing) {
          this.onRestore({ items: list });
        }
      } catch (e) {
        console.error("[tool-calls] checkAndRestoreWidgets error:", e);
      }
    };

    update(update) {
      const debugBeforeSessionId = this.sessionId;
      const debugBeforeVisibleSessionId = getViewSessionId(this.view);
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
      if (this.mirrorToolCalls.size) {
        try { this.attachPendingMirrorToolCalls(); } catch {}
        if (this.mirrorToolCalls.size) {
          if (update.selectionSet || update.docChanged || update.viewportChanged) {
            this.syncSelectionHighlight();
          }
          return;
        }
      }
      this.snapshot();
      try {
        if (update.docChanged || update.viewportChanged) {
          const stats = debugToolFieldStats(this.view);
          const hasPlainToolText = /调用\s+([^\n]+)/.test(this.view.state.doc.toString());
          debugChatCards("view.update", {
            panelId: this.panelId,
            sessionId: this.sessionId,
            beforeSessionId: debugBeforeSessionId,
            beforeVisibleSessionId: debugBeforeVisibleSessionId,
            docChanged: !!update.docChanged,
            viewportChanged: !!update.viewportChanged,
            selectionSet: !!update.selectionSet,
            transactions: update.transactions?.length || 0,
            hasPlainToolText,
            stats
          });
        }
      } catch {}
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
        updateSessionAnnotations(id, (prev) => {
          const prevTools = Array.isArray(prev.tools) ? prev.tools : [];
          if (!arr.length && prevTools.length && /调用\s+([^\n]+)/.test(this.view.state.doc.toString())) {
            debugChatCards("snapshot.skipEmpty", {
              panelId: this.panelId,
              sessionId: id,
              prevCount: prevTools.length,
              docLength: this.view.state.doc.length
            });
            return prev;
          }
          return { ...prev, tools: arr };
        });
        debugChatCards("snapshot", {
          panelId: this.panelId,
          sessionId: id,
          count: arr.length,
          expanded: arr.filter(it => it.expanded).length,
          ids: arr.map(it => it.id)
        });
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
    getVisibleSessionId = () => {
      return getViewSessionId(this.view);
    };
    shouldHandleScopedPayload = (payload) => {
      const visibleSessionId = this.getVisibleSessionId();
      if (!visibleSessionId) return false;
      if (payload?.sessionId && payload.sessionId !== visibleSessionId) return false;
      if (!payload?.sessionId && payload?.panelId && payload.panelId !== this.panelId) return false;
      if (!payload?.panelId && !payload?.sessionId) {
        const activePanelId = window.zion?.panels?.getActivePanelId?.() || null;
        if (this.panelId && activePanelId && this.panelId !== activePanelId) return false;
      }
      this.sessionId = visibleSessionId;
      return true;
    };
    loadToolActions = () => {
      try {
        const sid = this.getVisibleSessionId();
        if (!sid) return;
        const ann = getSessionAnnotations(sid);
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
    setToolAction = (toolCallId, action, sessionId) => {
      if (!toolCallId || (action !== "accept" && action !== "revert")) return;
      try {
        const sid = sessionId || this.getVisibleSessionId();
        if (!sid) return;
        const at = Date.now();
        updateSessionAnnotations(sid, (prev) => {
          const taPrev = prev && typeof prev.toolActions === "object" ? prev.toolActions : {};
          return { ...prev, toolActions: { ...(taPrev || {}), [String(toolCallId)]: { action, at } } };
        });
        this.toolActions.set(String(toolCallId), { action, at });
        try { window.zion?.events?.emit("toolcards/toolsUpdated", { sessionId: sid }); } catch {}
      } catch {}
    };
    onRun = (payload) => {
      if (!this.shouldHandleScopedPayload(payload)) return;
      this.runActive = true;
      const sel = this.view.state.selection?.main?.head;
      this.anchorPos = typeof sel === "number" ? sel : this.view.state.doc.length;
    };
    onFinish = (payload) => {
      if (!this.shouldHandleScopedPayload(payload)) return;
      this.runActive = false;
    };
    onCall = (payload) => {
      if (!this.shouldHandleScopedPayload(payload)) return;
      const tc = payload?.toolCall || payload;
      if (!tc?.id) return;
      const name = tc.name || "tool";

      const isMirrorPanel = !!(payload?.panelId && payload.panelId !== this.panelId);
      if (isMirrorPanel) {
        const anchorCountBefore = buildRegexAnchors(this.view.state.doc.toString(), /调用\s+([^\n]+)/g, (match) => {
          if (match[0].length > 300) return null;
          return { from: match.index, to: match.index + match[0].length, name: match[1].trim() };
        }).length;
        debugChatCards("toolCall.mirrorPending", { panelId: this.panelId, sourcePanelId: payload?.panelId, sessionId: this.sessionId, id: tc.id, name, anchorCountBefore });
        this.mirrorToolCalls.set(String(tc.id), { ...tc, name, sessionId: this.sessionId, anchorCountBefore, attempts: 0 });
        if (this.attachPendingMirrorToolCalls(String(tc.id))) return;
        try {
          requestAnimationFrame(() => {
            try { this.attachPendingMirrorToolCalls(String(tc.id)); } catch {}
          });
        } catch {}
        [30, 120, 300].forEach((delay) => setTimeout(() => {
          try { this.attachPendingMirrorToolCalls(String(tc.id)); } catch {}
        }, delay));
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
      const plan = planAssistantMarkerInsertion({
        docText: this.view.state.doc.toString(),
        markerText: `调用 ${name}`,
        hintPos: typeof hint === "number" ? hint : null,
        trailingNewlines: 1
      });
      const userStartLine = findPrevRoleStartLine(this.view.state.doc, plan.markerFrom, "user");

      // 对外暴露锚点：设置到换行后的位置，便于后续回答继续新起一行
      try { window.zion?.state?.set("chat.lastToolCallPos", plan.markerTo + 1); } catch {}
      this.view.dispatch({
        changes: { from: plan.insertPos, insert: plan.insertText },
        effects: [addInline.of({ from: plan.markerFrom, to: plan.markerTo, id: tc.id, name, args: tc.args, userStartLine, sessionId: this.sessionId })]
      });
      debugChatCards("toolCall.inserted", { panelId: this.panelId, sessionId: this.sessionId, id: tc.id, name, from: plan.markerFrom, to: plan.markerTo });
      try {
        window.zion?.events?.emit("toolcards/inlineInserted", {
          panelId: this.panelId,
          sessionId: this.sessionId,
          id: tc.id,
          name,
          args: tc.args,
          from: plan.markerFrom,
          to: plan.markerTo
        });
      } catch {}
      scheduleRevealToolContent(this.view, { id: tc.id, pos: plan.markerTo, reason: "onTool-insert" });
      // 插入后，将锚点推进到换行之后
      this.anchorPos = plan.markerTo + 1;
      try {
        window.zion?.events?.emit("toolcards/toolsUpdated", { sessionId: this.sessionId });
      } catch {}
    };
    attachPendingMirrorToolCalls = (onlyId) => {
      if (!this.mirrorToolCalls.size) return false;
      let attachedAny = false;
      try {
        const fieldVal = this.view.state.field(toolInlineField);
        const occupied = new Set();
        try { fieldVal?.items?.forEach?.((it) => occupied.add(`${it.from}:${it.to}`)); } catch {}
        const doc = this.view.state.doc;
        const docString = doc.toString();
        const anchors = buildRegexAnchors(docString, /调用\s+([^\n]+)/g, (match) => {
          if (match[0].length > 300) return null;
          return {
            from: match.index,
            to: match.index + match[0].length,
            name: match[1].trim()
          };
        });
        const entries = Array.from(this.mirrorToolCalls.entries());
        debugChatCards("mirror.attach.scan", {
          panelId: this.panelId,
          sessionId: this.sessionId,
          pending: entries.length,
          anchors: anchors.length,
          onlyId
        });
        for (const [id, tc] of entries) {
          if (onlyId && id !== onlyId) continue;
          if (fieldVal?.items?.has?.(id)) {
            this.mirrorToolCalls.delete(id);
            continue;
          }
          tc.attempts = Number(tc.attempts || 0) + 1;
          const anchorCountBefore = Math.max(0, Number(tc.anchorCountBefore || 0));
          const newAnchors = anchors.slice(anchorCountBefore);
          const candidates = newAnchors;
          debugChatCards("mirror.attach.candidates", {
            panelId: this.panelId,
            sessionId: this.sessionId,
            id,
            name: tc.name,
            attempts: tc.attempts,
            anchorCountBefore,
            totalAnchors: anchors.length,
            candidateAnchors: candidates.length
          });
          if (!candidates.length) continue;
          for (let i = candidates.length - 1; i >= 0; i--) {
            const anchor = candidates[i];
            if (anchor.occupied) continue;
            if (anchor.name !== tc.name) continue;
            if (occupied.has(`${anchor.from}:${anchor.to}`)) continue;
            anchor.occupied = true;
            occupied.add(`${anchor.from}:${anchor.to}`);
            const userStartLine = findPrevRoleStartLine(doc, anchor.from, "user");
            this.view.dispatch({
              effects: [addInline.of({ from: anchor.from, to: anchor.to, id, name: tc.name, args: tc.args, userStartLine, sessionId: this.sessionId })]
            });
            debugChatCards("mirror.attach.matched", { panelId: this.panelId, sessionId: this.sessionId, id, name: tc.name, from: anchor.from, to: anchor.to });
            this.mirrorToolCalls.delete(id);
            attachedAny = true;
            break;
          }
        }
        if (attachedAny) this.snapshot();
      } catch {}
      return attachedAny;
    };
    attachMirrorToolByHint = (payload) => {
      if (!payload?.id || !payload?.name) return false;
      const visibleSessionId = this.getVisibleSessionId();
      if (!visibleSessionId) return false;
      if (payload?.sessionId && payload.sessionId !== visibleSessionId) return false;
      if (payload?.panelId && payload.panelId === this.panelId) return false;
      try {
        const fieldVal = this.view.state.field(toolInlineField);
        if (fieldVal?.items?.has?.(String(payload.id))) return true;
        const occupied = new Set();
        try { fieldVal?.items?.forEach?.((it) => occupied.add(`${it.from}:${it.to}`)); } catch {}
        const anchors = buildRegexAnchors(this.view.state.doc.toString(), /调用\s+([^\n]+)/g, (match) => {
          if (match[0].length > 300) return null;
          return { from: match.index, to: match.index + match[0].length, name: match[1].trim() };
        }).filter((anchor) => anchor.name === payload.name && !anchor.occupied && !occupied.has(`${anchor.from}:${anchor.to}`));
        const hintFrom = typeof payload.from === "number" ? payload.from : null;
        const ranked = anchors
          .map((anchor) => ({ anchor, score: hintFrom == null ? 0 : Math.abs(anchor.from - hintFrom) }))
          .sort((a, b) => a.score - b.score);
        debugChatCards("inlineInserted.hintScan", {
          panelId: this.panelId,
          sourcePanelId: payload.panelId,
          sessionId: payload.sessionId,
          id: payload.id,
          name: payload.name,
          hintFrom,
          candidates: ranked.length,
          bestScore: ranked[0]?.score ?? null
        });
        const best = ranked[0]?.anchor;
        if (!best) return false;
        const userStartLine = findPrevRoleStartLine(this.view.state.doc, best.from, "user");
        this.view.dispatch({
          effects: [addInline.of({ from: best.from, to: best.to, id: payload.id, name: payload.name, args: payload.args, userStartLine, sessionId: visibleSessionId || this.sessionId || payload.sessionId || null })]
        });
        this.mirrorToolCalls.delete(String(payload.id));
        debugChatCards("inlineInserted.hintMatched", {
          panelId: this.panelId,
          sourcePanelId: payload.panelId,
          sessionId: payload.sessionId,
          id: payload.id,
          name: payload.name,
          from: best.from,
          to: best.to
        });
        this.snapshot();
        return true;
      } catch {
        return false;
      }
    };
    onInlineInserted = (payload) => {
      if (this.attachMirrorToolByHint(payload)) return;
      requestAnimationFrame(() => {
        try { this.attachMirrorToolByHint(payload); } catch {}
      });
      setTimeout(() => {
        try { this.attachMirrorToolByHint(payload); } catch {}
      }, 80);
    };
    onRes = (payload) => {
      if (!this.shouldHandleScopedPayload(payload)) return;
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
          this.setToolAction(String(id), "accept", this.sessionId);
        }
      } catch {}
    };
    onRemove = (payload) => {
      const scopedPayload = payload && typeof payload === "object" ? payload : { id: payload };
      if (!this.shouldHandleToolAction(scopedPayload)) return;
      const id = scopedPayload?.id;
      if (!id) return;
      const sessionId = scopedPayload?.sessionId || this.getVisibleSessionId();
      this.view.dispatch({ effects: [removeTool.of({ id, sessionId })] });
      try {
        window.zion?.events?.emit("toolcards/toolsUpdated", { sessionId });
      } catch {}
    };
    shouldHandleToolAction = (payload) => {
      return this.shouldHandleScopedPayload(payload);
    };
    onEditRevert = async (payload) => {
      if (!this.shouldHandleToolAction(payload)) return;
      // 处理 edit 工具的 Revert 操作
      const { id, path, old_string, new_string, replace_all } = payload || {};
      // #region debug-point D:edit-revert-entry
      fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"D",location:"extensions/dev.tools/tool-calls.js:2162",msg:"[DEBUG] onEditRevert entered",data:{id:id ?? null,path:path ?? null,replace_all:!!replace_all,panelId:this.panelId,visibleSessionId:this.getVisibleSessionId?.() || null},ts:Date.now()})}).catch(()=>{});
      // #endregion
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
      if (!this.shouldHandleToolAction(payload)) return;
      // 处理 edit 工具的 Accept 操作
      // Accept 执行正向编辑：old_string -> new_string
      const { id, path, old_string, new_string, replace_all } = payload || {};
      // #region debug-point D:edit-accept-entry
      fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"D",location:"extensions/dev.tools/tool-calls.js:2224",msg:"[DEBUG] onEditAccept entered",data:{id:id ?? null,path:path ?? null,replace_all:!!replace_all,panelId:this.panelId,visibleSessionId:this.getVisibleSessionId?.() || null},ts:Date.now()})}).catch(()=>{});
      // #endregion
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
      if (!this.shouldHandleToolAction(payload)) return;
      const { id, path } = payload || {};
      // #region debug-point D:write-revert-entry
      fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"D",location:"extensions/dev.tools/tool-calls.js:2285",msg:"[DEBUG] onWriteRevert entered",data:{id:id ?? null,path:path ?? null,panelId:this.panelId,visibleSessionId:this.getVisibleSessionId?.() || null},ts:Date.now()})}).catch(()=>{});
      // #endregion
      if (!path) {
        notify("Revert 参数缺失", { type: "error", duration: 3000 });
        return;
      }
      try {
        const sid = payload?.sessionId || this.getVisibleSessionId();
        const ann = sid ? getSessionAnnotations(sid) : {};
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
        // #region debug-point E:write-revert-history
        fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"E",location:"extensions/dev.tools/tool-calls.js:2313",msg:"[DEBUG] onWriteRevert writeHistory lookup",data:{sid,historyCount:list.length,baseId,matchedById:!!byId,matchedByContent:!!byContent,matchedByPath:!!byPath,hasItem:!!item,beforeExists:item?.beforeExists ?? null,hasBeforeContent:typeof item?.beforeContent === "string"},ts:Date.now()})}).catch(()=>{});
        // #endregion
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
          // #region debug-point E:write-revert-delete-result
          fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"E",location:"extensions/dev.tools/tool-calls.js:2345",msg:"[DEBUG] onWriteRevert delete request finished",data:{ok:res.ok,status:res.status,raw:raw?.slice?.(0,300) ?? ""},ts:Date.now()})}).catch(()=>{});
          // #endregion
          if (!res.ok) {
            console.error("[onWriteRevert] delete failed:", raw || data?.error || "delete failed");
            notify("Revert 失败: " + (raw || data?.error || "未知错误"), { type: "error", duration: 6000 });
            return;
          }
          notify("Revert 成功！", { type: "success", duration: 3000 });
          if (id) this.setToolAction(String(id), "revert", sid);
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
        // #region debug-point E:write-revert-write-result
        fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"E",location:"extensions/dev.tools/tool-calls.js:2373",msg:"[DEBUG] onWriteRevert write request finished",data:{ok:res.ok,status:res.status,raw:raw?.slice?.(0,300) ?? ""},ts:Date.now()})}).catch(()=>{});
        // #endregion
        if (!res.ok) {
          console.error("[onWriteRevert] failed:", raw || data?.error || "write failed");
          notify("Revert 失败: " + (raw || data?.error || "未知错误"), { type: "error", duration: 6000 });
          return;
        }
        notify("Revert 成功！", { type: "success", duration: 3000 });
        if (id) this.setToolAction(String(id), "revert", sid);
      } catch (e) {
        console.error("[onWriteRevert] error:", e);
        notify("Revert 错误: " + (e?.message || String(e)), { type: "error", duration: 6000 });
      }
    };
    onWriteAccept = async (payload) => {
      if (!this.shouldHandleToolAction(payload)) return;
      const { id, path } = payload || {};
      // #region debug-point D:write-accept-entry
      fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"D",location:"extensions/dev.tools/tool-calls.js:2376",msg:"[DEBUG] onWriteAccept entered",data:{id:id ?? null,path:path ?? null,panelId:this.panelId,visibleSessionId:this.getVisibleSessionId?.() || null},ts:Date.now()})}).catch(()=>{});
      // #endregion
      if (!path) {
        notify("Accept 参数缺失", { type: "error", duration: 3000 });
        return;
      }
      try {
        const sid = payload?.sessionId || this.getVisibleSessionId();
        const ann = sid ? getSessionAnnotations(sid) : {};
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
        // #region debug-point E:write-accept-history
        fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"E",location:"extensions/dev.tools/tool-calls.js:2408",msg:"[DEBUG] onWriteAccept writeHistory lookup",data:{sid,historyCount:list.length,baseId,matchedById:!!byId,matchedByContent:!!byContent,matchedByPath:!!byPath,hasItem:!!item,hasPayloadContent:typeof payload?.content === "string",hasResolvedContent:typeof content === "string"},ts:Date.now()})}).catch(()=>{});
        // #endregion
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
        // #region debug-point E:write-accept-result
        fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"E",location:"extensions/dev.tools/tool-calls.js:2444",msg:"[DEBUG] onWriteAccept write request finished",data:{ok:res.ok,status:res.status,raw:raw?.slice?.(0,300) ?? ""},ts:Date.now()})}).catch(()=>{});
        // #endregion
        if (!res.ok) {
          console.error("[onWriteAccept] failed:", raw || data?.error || "write failed");
          notify("Accept 失败: " + (raw || data?.error || "未知错误"), { type: "error", duration: 6000 });
          return;
        }
        notify("Accept 成功！", { type: "success", duration: 3000 });
        if (id) this.setToolAction(String(id), "accept", sid);
      } catch (e) {
        console.error("[onWriteAccept] error:", e);
        notify("Accept 错误: " + (e?.message || String(e)), { type: "error", duration: 6000 });
      }
    };
    onBatchAccept = async (payload) => {
      if (!this.shouldHandleToolAction(payload)) return;
      const userStartLine = typeof payload?.userStartLine === "number" ? payload.userStartLine : null;
      const from = typeof payload?.from === "number" ? payload.from : 0;
      const to = typeof payload?.to === "number" ? payload.to : this.view.state.doc.length;
      if (userStartLine == null && to <= from) return;
      // #region debug-point B:batch-accept-entry
      fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"B",location:"extensions/dev.tools/tool-calls.js:2444",msg:"[DEBUG] onBatchAccept entered",data:{panelId:this.panelId,visibleSessionId:this.getVisibleSessionId?.() || null,payloadSessionId:payload?.sessionId || null,payloadPanelId:payload?.panelId || null,userStartLine,from,to},ts:Date.now()})}).catch(()=>{});
      // #endregion
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
        // #region debug-point C:batch-accept-empty
        fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"C",location:"extensions/dev.tools/tool-calls.js:2477",msg:"[DEBUG] onBatchAccept found no matching items",data:{userStartLine,from,to,panelId:this.panelId,visibleSessionId:this.getVisibleSessionId?.() || null},ts:Date.now()})}).catch(()=>{});
        // #endregion
        notify("当前消息没有可处理的工具调用", { type: "info", duration: 3000 });
        return;
      }
      items.sort((a, b) => a.from - b.from);
      // #region debug-point C:batch-accept-items
      fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"C",location:"extensions/dev.tools/tool-calls.js:2481",msg:"[DEBUG] onBatchAccept matched items",data:{count:items.length,items:items.map(it=>({id:String(it.id||""),name:it.name,from:it.from,to:it.to,userStartLine:it.userStartLine ?? null,path:it.args?.path ?? null}))},ts:Date.now()})}).catch(()=>{});
      // #endregion
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
      if (!this.shouldHandleToolAction(payload)) return;
      const userStartLine = typeof payload?.userStartLine === "number" ? payload.userStartLine : null;
      const from = typeof payload?.from === "number" ? payload.from : 0;
      const to = typeof payload?.to === "number" ? payload.to : this.view.state.doc.length;
      if (userStartLine == null && to <= from) return;
      // #region debug-point B:batch-revert-entry
      fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"B",location:"extensions/dev.tools/tool-calls.js:2500",msg:"[DEBUG] onBatchRevert entered",data:{panelId:this.panelId,visibleSessionId:this.getVisibleSessionId?.() || null,payloadSessionId:payload?.sessionId || null,payloadPanelId:payload?.panelId || null,userStartLine,from,to},ts:Date.now()})}).catch(()=>{});
      // #endregion
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
        // #region debug-point C:batch-revert-empty
        fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"C",location:"extensions/dev.tools/tool-calls.js:2533",msg:"[DEBUG] onBatchRevert found no matching items",data:{userStartLine,from,to,panelId:this.panelId,visibleSessionId:this.getVisibleSessionId?.() || null},ts:Date.now()})}).catch(()=>{});
        // #endregion
        notify("当前消息没有可处理的工具调用", { type: "info", duration: 3000 });
        return;
      }
      items.sort((a, b) => b.from - a.from);
      // #region debug-point C:batch-revert-items
      fetch("http://127.0.0.1:7777/event",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:"batch-accept-revert",runId:"pre-fix",hypothesisId:"C",location:"extensions/dev.tools/tool-calls.js:2537",msg:"[DEBUG] onBatchRevert matched items",data:{count:items.length,items:items.map(it=>({id:String(it.id||""),name:it.name,from:it.from,to:it.to,userStartLine:it.userStartLine ?? null,path:it.args?.path ?? null}))},ts:Date.now()})}).catch(()=>{});
      // #endregion
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
    onClear = (payload) => {
      if (payload?.panelId && payload.panelId !== this.panelId) {
        debugChatCards("clear.skipPanel", {
          panelId: this.panelId,
          payloadPanelId: payload.panelId,
          sessionId: payload?.sessionId,
          stats: debugToolFieldStats(this.view)
        });
        return;
      }
      if (!this.shouldHandleScopedPayload(payload)) return;
      this.view.dispatch({ effects: [clearAll.of({})] });
      this.snapshot();
    };
    onSnapshot = (payload = {}) => {
      if (payload?.panelId && payload.panelId !== this.panelId) {
        debugChatCards("snapshot.skipPanel", {
          panelId: this.panelId,
          payloadPanelId: payload.panelId,
          sessionId: payload?.sessionId,
          stats: debugToolFieldStats(this.view)
        });
        return;
      }
      if (!this.shouldHandleScopedPayload(payload)) return;
      this.snapshot();
    };
    onSessionChanged = () => {
      const boundSessionId = getViewSessionId(this.view);
      debugChatCards("session.changed", {
        panelId: this.panelId,
        prevSessionId: this.sessionId,
        boundSessionId,
        stats: debugToolFieldStats(this.view)
      });
      if (boundSessionId) {
        this.sessionId = boundSessionId;
        this.loadToolActions();
        return;
      }
      if (this.sessionId) {
        this.sessionId = null;
        this.mirrorToolCalls.clear();
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
          if (this.mirrorToolCalls.size) {
            this.attachPendingMirrorToolCalls();
            if (this.mirrorToolCalls.size) {
              debugChatCards("toolsUpdated.deferRestoreForPendingMirror", {
                panelId: this.panelId,
                sessionId: sid,
                pending: this.mirrorToolCalls.size
              });
              return;
            }
          }
          const ann = getSessionAnnotations(sid);
          const list = Array.isArray(ann.tools) ? ann.tools : [];
          if (!list.length) return;
          this.onRestore({ items: list, panelId: this.panelId, __fromToolsUpdated: true });
        } catch {}
      });
    };
    onRestore = (payload) => {
      const list = payload?.items || payload;
      if (!Array.isArray(list) || list.length === 0) return;
      if (payload?.panelId && payload.panelId !== this.panelId) {
        debugChatCards("restore.skipPanel", { panelId: this.panelId, payloadPanelId: payload.panelId, sessionId: payload?.sessionId, count: list.length });
        return;
      }
      const visibleSessionId = this.getVisibleSessionId();
      if (!visibleSessionId) {
        debugChatCards("restore.skipNoVisibleSession", {
          panelId: this.panelId,
          payloadPanelId: payload?.panelId,
          payloadSessionId: payload?.sessionId,
          count: list.length,
          stats: debugToolFieldStats(this.view)
        });
        return;
      }
      if (payload?.sessionId && payload.sessionId !== visibleSessionId) {
        debugChatCards("restore.skipSession", { panelId: this.panelId, visibleSessionId, payloadSessionId: payload.sessionId, count: list.length });
        return;
      }
      const restoreSessionId = visibleSessionId;
      this.sessionId = restoreSessionId;
      debugChatCards("restore.start", { panelId: this.panelId, sessionId: restoreSessionId, count: list.length, docLength: this.view.state.doc.length, fromToolsUpdated: !!payload?.__fromToolsUpdated, stats: debugToolFieldStats(this.view) });
      if (!String(this.view.state.doc.toString() || "").trim()) {
        debugChatCards("restore.skipEmptyDoc", {
          panelId: this.panelId,
          sessionId: restoreSessionId,
          count: list.length,
          stats: debugToolFieldStats(this.view)
        });
        return;
      }
      try {
        const sid = restoreSessionId;
        if (sid) clearPendingRestore(sid, "tools");
      } catch {}

      const doc = this.view.state.doc;
      const docLen = doc.length;
      const docString = doc.toString();
      let deletedIds = [];
      try {
        const sid = restoreSessionId;
        const ann = sid ? getSessionAnnotations(sid) : {};
        deletedIds = Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : [];
      } catch {}
      const anchors = buildRegexAnchors(docString, /调用\s+([^\n]+)/g, (match) => {
        if (match[0].length > 300) return null;
        return {
          from: match.index,
          to: match.index + match[0].length,
          text: match[0],
          name: match[1].trim()
        };
      });

      const batchedEffects = [];
      const batchedToggles = [];
      debugChatCards("restore.anchors", { panelId: this.panelId, sessionId: restoreSessionId, items: list.length, anchors: anchors.length });
      let existingItems = new Map();
      try {
        const fieldVal = this.view.state.field(toolInlineField);
        if (fieldVal?.items) fieldVal.items.forEach((it, id) => existingItems.set(String(id), it));
      } catch {}
      const itemsToProcess = filterDeletedItems(list, deletedIds);
      debugChatCards("restore.inputs", {
        panelId: this.panelId,
        sessionId: restoreSessionId,
        incomingIds: list.map(it => it?.id).filter(Boolean).map(String),
        deletedIds,
        itemsToProcess: itemsToProcess.length,
        existingIds: [...existingItems.keys()],
        anchorPreview: anchors.slice(0, 8).map(a => ({ from: a.from, to: a.to, name: a.name }))
      });

      // Phase 0: reconcile already-mounted items, avoid restoring or toggling them twice
      const processedIds = reconcileMountedItems({
        items: itemsToProcess,
        existingItems,
        onMounted: (it, mounted) => {
          const id = String(it?.id || "");
          if (it.result != null && (mounted.result !== it.result || mounted.ok !== it.ok)) {
            batchedEffects.push(updateResult.of({ id, result: it.result, ok: it.ok }));
          }
          if (!!it.expanded && !mounted.expanded) {
            batchedToggles.push(id);
          }
        }
      });

      // Phase 1: 精确位置匹配 (优先)
      reconcileExactAnchors({
        items: itemsToProcess,
        processedIds,
        anchors,
        isExactMatch: (it, anchor) => {
          if (typeof it.from !== "number" || typeof it.to !== "number") return false;
          if (it.from < 0 || it.to > docLen || it.from >= it.to) return false;
          return anchor.from === it.from && anchor.to === it.to && doc.sliceString(it.from, it.to) === `调用 ${it.name}`;
        },
        onMatch: (it, anchor) => {
          batchedEffects.push(addInline.of({ from: anchor.from, to: anchor.to, id: it.id, name: it.name, args: it.args, userStartLine: typeof it.userStartLine === "number" ? it.userStartLine : null, sessionId: restoreSessionId }));
          if (it.result != null) batchedEffects.push(updateResult.of({ id: it.id, result: it.result, ok: it.ok }));
          if (it.expanded) batchedToggles.push(it.id);
        }
      });

      // Phase 2: 模糊/最近位置匹配 (应对文本偏移)
      reconcileNearestAnchors({
        items: itemsToProcess,
        processedIds,
        anchors,
        canUseAnchor: (it, anchor) => anchor.name === it.name,
        onMatch: (it, anchor) => {
          batchedEffects.push(addInline.of({ from: anchor.from, to: anchor.to, id: it.id, name: it.name, args: it.args, userStartLine: typeof it.userStartLine === "number" ? it.userStartLine : null, sessionId: restoreSessionId }));
          if (it.result != null) batchedEffects.push(updateResult.of({ id: it.id, result: it.result, ok: it.ok }));
          if (it.expanded) batchedToggles.push(it.id);
          it.from = anchor.from;
          it.to = anchor.to;
        }
      });

      // 批量应用 Phase 1 & 2 的效果
      debugChatCards("restore.plan", {
        panelId: this.panelId,
        sessionId: restoreSessionId,
        processedBeforeFallback: processedIds.size,
        batchedEffects: batchedEffects.length,
        batchedToggles: batchedToggles.length,
        needFallback: itemsToProcess.filter(it => !processedIds.has(it.id)).map(it => String(it?.id || ""))
      });
      if (batchedEffects.length) this.view.dispatch({ effects: batchedEffects });
      if (batchedEffects.length) {
        const lastAddInline = [...batchedEffects].reverse().find((eff) => eff?.is?.(addInline));
        const lastPayload = lastAddInline?.value || null;
        if (lastPayload?.id) {
          scheduleRevealToolContent(this.view, {
            id: lastPayload.id,
            pos: lastPayload.to
          });
        }
      }
      if (batchedToggles.length) {
        const eff2 = batchedToggles.map(id => toggleInline.of({ id }));
        this.view.dispatch({ effects: eff2 });
        scheduleRevealToolContent(this.view, { id: batchedToggles[batchedToggles.length - 1] });
      }

      // Phase 3: 兜底 (创建新锚点)
      for (const it of itemsToProcess) {
        if (processedIds.has(it.id)) continue;

        const name = it.name || "tool";
        // 重新获取 doc，因为前面的 dispatch 可能没改变 doc (effects only)，但在 Phase 3 循环中我们会修改 doc
        const plan = planAssistantMarkerInsertion({
          docText: this.view.state.doc.toString(),
          markerText: `调用 ${name}`,
          trailingNewlines: 1
        });
        const userStartLine = typeof it.userStartLine === "number"
          ? it.userStartLine
          : findPrevRoleStartLine(this.view.state.doc, plan.markerFrom, "user");

        this.view.dispatch({
          changes: { from: plan.insertPos, insert: plan.insertText },
          annotations: Transaction.userEvent.of("zion.cardRestore"),
          effects: [addInline.of({ from: plan.markerFrom, to: plan.markerTo, id: it.id, name, args: it.args, userStartLine, sessionId: restoreSessionId })]
        });
        scheduleRevealToolContent(this.view, { id: it.id, pos: plan.markerTo });
        
        if (it.result != null) {
          this.view.dispatch({ effects: [updateResult.of({ id: it.id, result: it.result, ok: it.ok })] });
        }
        if (it.expanded) {
          this.view.dispatch({ effects: [toggleInline.of({ id: it.id })] });
        }
        
        // 更新 item 位置
        it.from = plan.markerFrom;
        it.to = plan.markerTo;
        
        processedIds.add(it.id);
      }


      this.snapshot();
      debugChatCards("restore.done", { panelId: this.panelId, sessionId: restoreSessionId, processed: processedIds.size });
      requestAnimationFrame(() => {
        try {
          const fieldVal = this.view.state.field(toolInlineField);
          let fieldCount = 0;
          let expandedCount = 0;
          fieldVal?.items?.forEach?.((it) => {
            fieldCount += 1;
            if (it?.expanded) expandedCount += 1;
          });
          debugChatCards("restore.domCheck", {
            panelId: this.panelId,
            sessionId: restoreSessionId,
            fieldCount,
            expandedCount,
            inlineDom: this.view.dom.querySelectorAll(".zion-tool-call-inline").length,
            cardDom: this.view.dom.querySelectorAll(".zion-tool-call-card").length,
            viewportFrom: this.view.viewport?.from,
            viewportTo: this.view.viewport?.to
          });
        } catch {}
      });
    };
    destroy() {
      try { this.mirrorToolCalls.clear(); } catch {}
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
