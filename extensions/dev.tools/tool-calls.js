import { Decoration, EditorView, WidgetType, ViewPlugin } from "@codemirror/view";
import { StateField, StateEffect, Transaction } from "@codemirror/state";
import { diffWordsWithSpace } from "diff";
import { buildArtifactFromTool, buildDiffRows } from "./artifact-model.js";
import { highlightLine, inferLanguageFromPath } from "./syntax-highlight.js";
import {
  buildRegexAnchors,
  filterDeletedItems,
  mergeItemsFromAnchors,
  planAssistantMarkerInsertion,
  reconcileExactAnchors,
  reconcileMountedItems,
  reconcileNearestAnchors,
  stripCardMarkerIdComment,
  toolMarkerText
} from "../../src/chat/restore";
import { inlineWidgetSourceFacet } from "../../src/editor/inlineWidgets";

function t(key, fallback, values) {
  const fullKey = `dev.tools.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

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
const updateAction = StateEffect.define(); // { id, action }
const removeTool = StateEffect.define();   // { id }
const clearAll = StateEffect.define();
const inlineWidgetLineClass = "zion-inline-widget-row";
const TOOL_ANCHOR_RE = /调用\s+([^\n<]{1,300}?)\s*<!--\s*zion-tool:id=([^>\s]+)\s*-->|调用\s+([^\n<]{1,300})/g;

function parseToolAnchorText(text) {
  const raw = String(text || "").trim();
  const match = /^调用\s+([^\n<]{1,300}?)(?:\s*<!--\s*zion-tool:id=([^>\s]+)\s*-->)?$/.exec(raw);
  if (!match) return null;
  return {
    name: String(match[1] || "").trim(),
    id: match[2] ? String(match[2]) : null,
    visibleText: stripCardMarkerIdComment(raw)
  };
}

function buildToolAnchors(docString) {
  return buildRegexAnchors(docString, TOOL_ANCHOR_RE, (match) => {
    const hasId = !!match[2];
    const name = String(hasId ? match[1] : match[3] || "").trim();
    if (!name || name.length > 300) return null;
    return {
      from: match.index,
      to: match.index + match[0].length,
      name,
      markerId: hasId ? String(match[2]) : null
    };
  });
}

function isToolAnchorForItem(anchorText, item, id) {
  const parsed = parseToolAnchorText(anchorText);
  if (!parsed) return false;
  const expectedId = String(id || "");
  if (parsed.id && expectedId && parsed.id !== expectedId) return false;
  return parsed.name === String(item?.name || "tool");
}

function migrateLegacyToolAnchors(view, items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return false;
  const anchors = buildToolAnchors(view.state.doc.toString()).filter((anchor) => !anchor.markerId);
  if (!anchors.length) return false;
  const used = new Set();
  const changes = [];
  for (const item of list) {
    const id = String(item?.id || "");
    const name = String(item?.name || "tool");
    if (!id || !name) continue;
    let anchor = anchors.find((candidate) =>
      !used.has(candidate)
      && candidate.name === name
      && typeof item.from === "number"
      && typeof item.to === "number"
      && candidate.from === item.from
      && candidate.to === item.to
    );
    if (!anchor) anchor = anchors.find((candidate) => !used.has(candidate) && candidate.name === name);
    if (!anchor) continue;
    used.add(anchor);
    const marker = toolMarkerText(name, id);
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

function mergeToolItemsFromAnchors(view, items, deletedIds) {
  return mergeItemsFromAnchors({
    items,
    deletedIds,
    anchors: buildToolAnchors(view.state.doc.toString()).filter((anchor) => anchor.markerId),
    createItem: (anchor) => ({
      id: String(anchor.markerId || ""),
      name: anchor.name || "tool",
      args: {},
      expanded: false,
      from: anchor.from,
      to: anchor.to
    })
  }).items;
}

  function reviveDeletedToolIdsForAnchors(sessionId, deletedIds, anchors) {
    const deleted = Array.isArray(deletedIds) ? deletedIds.map(String).filter(Boolean) : [];
    if (!sessionId || !deleted.length || !Array.isArray(anchors) || !anchors.length) return deleted;
    const anchorIds = new Set(anchors.map((anchor) => String(anchor?.markerId || "")).filter(Boolean));
    const remaining = deleted.filter((id) => !anchorIds.has(id));
    if (remaining.length === deleted.length) return deleted;
    try {
      updateSessionAnnotations(sessionId, (ann) => ({ ...ann, deletedToolIds: remaining }));
    } catch {}
    return remaining;
  }

  function isEmptyArgs(value) {
    if (value === undefined || value === null) return true;
    if (typeof value === "object") return Object.keys(value).length === 0;
    return false;
  }

  function mergeToolSnapshotItem(previous, current) {
    const prev = previous && typeof previous === "object" ? previous : {};
    const next = current && typeof current === "object" ? current : {};
    const merged = { ...prev, ...next };
    if (isEmptyArgs(next.args) && !isEmptyArgs(prev.args)) merged.args = prev.args;
    if (next.result == null && prev.result != null) {
      merged.result = prev.result;
      if (prev.ok !== undefined) merged.ok = prev.ok;
    }
    if (next.action == null && prev.action != null) merged.action = prev.action;
    if (next.userStartLine == null && prev.userStartLine != null) merged.userStartLine = prev.userStartLine;
    if (next.actionAt == null && prev.actionAt != null) merged.actionAt = prev.actionAt;
    return merged;
  }

  function toolItemNeedsHydration(stored, mounted) {
    if (!stored || !mounted) return false;
    if (stored.args !== undefined) {
      try {
        if (JSON.stringify(stored.args ?? null) !== JSON.stringify(mounted.args ?? null)) return true;
      } catch {
        if (mounted.args === undefined) return true;
      }
    }
    if (stored.result != null && mounted.result == null) return true;
    if (stored.name && mounted.name !== stored.name) return true;
    if (stored.action && !mounted.action) return true;
    if (typeof stored.userStartLine === "number" && mounted.userStartLine == null) return true;
    return false;
  }

  function needsToolRestore(list, fieldVal) {
    const mounted = fieldVal?.items || new Map();
    for (const it of Array.isArray(list) ? list : []) {
      const id = String(it?.id || "");
      if (!id) continue;
      const current = mounted.get(id);
      if (!current || toolItemNeedsHydration(it, current)) return true;
    }
    return false;
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

function isCommentPanelId(panelId) {
  return String(panelId || "").startsWith("comments:");
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
    return "";
}

function normalizeToolAction(action) {
  return action === "accept" || action === "revert" ? action : null;
}

function toolActionLabel(action) {
  if (action === "accept") return "accepted";
  if (action === "revert") return "reverted";
  return "";
}

function toolActionStatus(action) {
  if (action === "accept") return "accepted";
  if (action === "revert") return "reverted";
  return "";
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
  el.className = "zion-tool-meta-pill";
  el.textContent = text;
  el.title = String(text || "");
  Object.assign(el.style, {
    display: "inline-flex",
    alignItems: "center",
    minWidth: "0",
    maxWidth: "100%",
    padding: "0",
    borderRadius: "0",
    fontSize: "10px",
    lineHeight: "1.35",
    color: "var(--muted-fg, var(--fg))",
    background: "transparent",
    border: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  });
  return el;
}

function isContextOpenableTool(name) {
  const n = normalizeToolName(name);
  return n === "read" || n === "fsread" || n === "write" || n === "fswrite" || n === "edit" || n === "fsedit";
}

function getToolPrimaryPath(args = {}) {
  return String(args?.path || args?.file_path || args?.target_file || args?.absolute_path || "").trim();
}

function getToolContextSourceId(args = {}, context = {}) {
  const explicitSessionId = String(args?.session_id || "").trim();
  if (explicitSessionId) return `terminal:${explicitSessionId}`;
  const fallbackSessionId = String(context?.sessionId || "").trim();
  return fallbackSessionId ? `terminal:${fallbackSessionId}` : "";
}

function openToolInContext(name, args = {}, context = {}) {
  if (!isContextOpenableTool(name)) return false;
  const path = getToolPrimaryPath(args);
  if (!path) return false;
  try {
    window.zion?.commands?.executeCommand?.("tools.context.openFilePreview", {
      path,
      sourceId: getToolContextSourceId(args, context)
    });
    return true;
  } catch {
    return false;
  }
}

function createOpenInContextButton(name, args = {}, context = {}) {
  if (!isContextOpenableTool(name) || !getToolPrimaryPath(args)) return null;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "zion-tool-open-file-button";
  try {
      const icon = window.zionIcons?.createFromCodicon?.("eye", "zion-tool-open-file-icon", 12);
    if (icon) btn.appendChild(icon);
  } catch {}
    if (!btn.firstElementChild) btn.classList.add("codicon", "codicon-eye");
  btn.title = t("call.openInContext", "在 Context 中打开");
  btn.setAttribute("aria-label", t("call.openInContext", "在 Context 中打开"));
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openToolInContext(name, args, context);
  });
  return btn;
}

function getToolArtifactMeta(id, name, args, result = null, ok = null, action = null, sessionId = "") {
  try {
    return buildArtifactFromTool({
      id: String(id || "preview"),
      name,
      args,
      result,
      ok,
      action: normalizeToolAction(action)
    }, {}, sessionId || "") || null;
  } catch {
    return null;
  }
}

function createToolChangeStatsPill(artifact) {
  if (!artifact) return null;
  const stats = document.createElement("span");
  stats.className = "zion-tool-call-inline-stats";
  const added = Number(artifact.addedLines || 0);
  const removed = Number(artifact.removedLines || 0);
  const add = document.createElement("span");
  add.className = "is-add";
  add.textContent = `+${formatCompactCount(added)}`;
  stats.appendChild(add);
  if (artifact.kind !== "created" || removed > 0) {
    const remove = document.createElement("span");
    remove.className = "is-remove";
    remove.textContent = `-${formatCompactCount(removed)}`;
    stats.appendChild(remove);
  }
  stats.title = `Added ${added} line${added === 1 ? "" : "s"}${artifact.kind === "created" && !removed ? "" : `, removed ${removed} line${removed === 1 ? "" : "s"}`}`;
  return stats;
}

function createToolActionPill(action) {
  const normalized = normalizeToolAction(action);
  if (!normalized) return null;
  const label = toolActionLabel(normalized);
  const pill = document.createElement("span");
  pill.className = "zion-tool-call-action-status";
  pill.setAttribute("data-action", toolActionStatus(normalized));
  pill.textContent = label;
  pill.title = label;
  return pill;
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

function parseReadOutput(text, args = {}) {
  const raw = String(text ?? "").replace(/\r/g, "");
  const lines = raw.split("\n");
  const header = lines[0] || "";
  const pathFromHeader = header.startsWith("// File:") ? header.replace(/^\/\/\s*File:\s*/, "").trim() : "";
  const path = String(args?.path || args?.file_path || pathFromHeader || "").trim();
  const sourceLines = pathFromHeader ? lines.slice(1) : lines;
  const numbered = [];
  for (let i = 0; i < sourceLines.length; i++) {
    const line = sourceLines[i];
    const m = line.match(/^\s*(\d+)\s+\|\s?(.*)$/);
    if (m) numbered.push({ no: Number(m[1]), text: m[2] || "" });
    else numbered.push({ no: null, text: line });
  }
  return {
    path,
    lines: numbered.length ? numbered : lines.map((line, idx) => ({ no: idx + 1, text: line }))
  };
}

function createReadPreviewView(result, args = {}, context = {}) {
  const { path, lines } = parseReadOutput(result, args);
  const displayPath = path || String(args?.path || args?.file_path || "").trim() || "read result";
  const language = inferLanguageFromPath(displayPath);
  const offset = typeof args?.offset === "number" ? args.offset : null;
  const limit = typeof args?.limit === "number" ? args.limit : null;
  const maxRows = 300;
  const rows = lines.slice(0, maxRows);

  const wrap = document.createElement("div");
  wrap.className = "zion-tool-artifact-preview zion-tool-read-preview";

  const header = document.createElement("div");
  header.className = "zion-tool-artifact-preview-header";

  const title = document.createElement("div");
  title.className = "zion-tool-artifact-preview-title";
  const nameRow = document.createElement("div");
  nameRow.className = "zion-tool-artifact-preview-name-row";
  const basename = document.createElement("span");
  basename.className = "zion-tool-artifact-preview-name";
  basename.textContent = pathBasename(displayPath) || displayPath;
  basename.title = normalizePathForLabel(displayPath);
  nameRow.appendChild(basename);
  title.appendChild(nameRow);

  const dir = document.createElement("span");
  dir.className = "zion-tool-artifact-preview-dir";
  dir.textContent = pathParentTail(displayPath, 2);
  dir.title = normalizePathForLabel(displayPath);
  if (dir.textContent) title.appendChild(dir);
  appendArtifactTerminalScope(title, "read", args);

  const headerRight = document.createElement("div");
  headerRight.className = "zion-tool-artifact-preview-right";
  const openButton = createOpenInContextButton("read", args, context);
  if (openButton) headerRight.appendChild(openButton);
  if (offset != null) headerRight.appendChild(createMetaPill(`offset ${offset}`));
  if (limit != null) headerRight.appendChild(createMetaPill(`limit ${limit}`));
  headerRight.appendChild(createMetaPill(`${lines.length} lines`));

  header.appendChild(title);
  header.appendChild(headerRight);
  wrap.appendChild(header);

  const editor = document.createElement("div");
  editor.className = "zion-tool-read-editor";
  for (const item of rows) {
    const row = document.createElement("div");
    row.className = "zion-tool-read-row";
    const gutter = document.createElement("span");
    gutter.className = "zion-tool-read-gutter";
    gutter.textContent = item.no == null ? "" : String(item.no);
    const textEl = document.createElement("span");
    textEl.className = "zion-tool-read-text";
    renderHighlightedMiniText(textEl, item.text ?? "", language);
    row.appendChild(gutter);
    row.appendChild(textEl);
    editor.appendChild(row);
  }
  if (lines.length > maxRows) {
    const more = document.createElement("div");
    more.className = "zion-tool-read-more";
    more.textContent = `内容过长，已截断显示前 ${maxRows} 行`;
    editor.appendChild(more);
  }
  wrap.appendChild(editor);
  return wrap;
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

function createArtifactDiffPreview(name, args, { id = "preview", result = null, ok = null, action = null, getContext = null } = {}) {
  const artifact = buildArtifactFromTool({ id, name, args, result, ok, action: normalizeToolAction(action) }, {}, "");
  if (!artifact) return null;
  const isCreated = artifact.kind === "created";

  const wrap = document.createElement("div");
  wrap.className = `zion-tool-artifact-preview is-${artifact.kind}`;

  const header = document.createElement("div");
  header.className = "zion-tool-artifact-preview-header";
  const title = document.createElement("div");
  title.className = "zion-tool-artifact-preview-title";
  const nameRow = document.createElement("div");
  nameRow.className = "zion-tool-artifact-preview-name-row";
  const basename = document.createElement("span");
  basename.className = "zion-tool-artifact-preview-name";
  basename.textContent = artifact.basename || pathBasename(artifact.path) || artifact.path;
  nameRow.appendChild(basename);
  const dir = document.createElement("span");
  dir.className = "zion-tool-artifact-preview-dir";
  dir.textContent = pathParentTail(artifact.path, 2);
  dir.title = normalizePathForLabel(artifact.path);
  title.appendChild(nameRow);
  if (dir.textContent) title.appendChild(dir);
  appendArtifactTerminalScope(title, name, args);

  const headerRight = document.createElement("div");
  headerRight.className = "zion-tool-artifact-preview-right";
  const openButton = createOpenInContextButton(name, args, getContext?.() || {});
  if (openButton) headerRight.appendChild(openButton);
  if (canAcceptRevertTool(name, args)) {
    const actions = document.createElement("div");
    actions.className = "zion-tool-artifact-preview-actions";
    actions.appendChild(createArtifactPreviewAction("Accept", () => emitToolCardAction("accept", { id, name, args, getContext }), "primary"));
    actions.appendChild(createArtifactPreviewAction("Revert", () => emitToolCardAction("revert", { id, name, args, getContext }), "danger"));
    actions.appendChild(createArtifactPreviewAction("Changes", () => openChangesForTool({ id, name, args, getContext })));
    headerRight.appendChild(actions);
  }
  header.appendChild(title);
  header.appendChild(headerRight);
  wrap.appendChild(header);

  const diff = document.createElement("div");
  diff.className = "zion-tool-artifact-diff";
  const rows = buildDiffRows(artifact, isCreated ? 80 : 120);
  const gutter = computeMiniGutterWidths(rows);
  diff.style.setProperty("--tool-old-gutter", `${gutter.old}px`);
  diff.style.setProperty("--tool-new-gutter", `${gutter.new}px`);
  const language = inferLanguageFromPath(artifact.path);
  for (const row of rows) {
    diff.appendChild(renderMiniDiffRow(row, language));
  }
  wrap.appendChild(diff);
  return wrap;
}

function createArtifactPreviewAction(label, onClick, tone = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `zion-tool-artifact-preview-action${tone ? ` is-${tone}` : ""}`;
  btn.textContent = label;
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick?.();
  });
  return btn;
}

function renderMiniDiffRow(row, language) {
  const type = row?.type || "context";
  const el = document.createElement("div");
  el.className = `zion-tool-artifact-diff-row is-${type}`;

  const oldNo = document.createElement("span");
  oldNo.className = "zion-tool-artifact-gutter is-old";
  oldNo.textContent = row?.oldNo == null ? "" : String(row.oldNo);
  const newNo = document.createElement("span");
  newNo.className = "zion-tool-artifact-gutter is-new";
  newNo.textContent = row?.newNo == null ? "" : String(row.newNo);
  const sign = document.createElement("span");
  sign.className = "zion-tool-artifact-sign";
  sign.textContent = type === "add" ? "+" : type === "remove" ? "-" : type === "meta" ? "…" : " ";
  const text = document.createElement("span");
  text.className = "zion-tool-artifact-text";
  renderHighlightedMiniText(text, row?.text ?? "", language);

  el.appendChild(oldNo);
  el.appendChild(newNo);
  el.appendChild(sign);
  el.appendChild(text);
  return el;
}

function renderHighlightedMiniText(container, text, language) {
  const tokens = highlightLine(text, language);
  if (!tokens.length) {
    container.textContent = text || " ";
    return;
  }
  for (const token of tokens) {
    if (!token?.className) {
      container.appendChild(document.createTextNode(token.text));
      continue;
    }
    const span = document.createElement("span");
    span.className = `zion-syntax-token ${token.className}`;
    span.textContent = token.text;
    container.appendChild(span);
  }
}

function computeMiniGutterWidths(rows) {
  let oldMax = 0;
  let newMax = 0;
  for (const row of rows) {
    if (row?.oldNo != null) oldMax = Math.max(oldMax, Number(row.oldNo) || 0);
    if (row?.newNo != null) newMax = Math.max(newMax, Number(row.newNo) || 0);
  }
  const widthFor = (value) => {
    const digits = Math.max(1, String(value || 0).length);
    return Math.min(34, Math.max(18, digits * 7 + 10));
  };
  return { old: widthFor(oldMax), new: widthFor(newMax) };
}

function formatCompactCount(value) {
  try {
    return new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1
    }).format(Number(value || 0)).toLowerCase();
  } catch {
    return String(value || 0);
  }
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
    more.textContent = t("call.patchTruncated", "patch 过长，已截断显示前 {count} 行", { count: MAX_LINES });
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

function isTerminalCommandTool(name) {
  const n = normalizeToolName(name);
  return n === "bash" || n === "runcommand" || n === "run_command";
}

function isTreeTool(name) {
  return normalizeToolName(name) === "tree";
}

function isTerminalAwareTool(name) {
  const n = normalizeToolName(name);
  return n === "tree" || n === "read" || n === "write" || n === "edit" || n === "glob" || n === "grep" || isTerminalCommandTool(name);
}

function findTerminalSession(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  try {
    const sessions = window.zion?.state?.get?.("terminal.sessions");
    if (!Array.isArray(sessions)) return null;
    return sessions.find(session => String(session?.id || "").trim() === sid) || null;
  } catch {
    return null;
  }
}

function getTerminalMachineLabel(session) {
  if (!session) return "";
  const type = String(session?.type || "").trim().toLowerCase();
  const host = String(session?.ssh_host || session?.host || session?.hostname || session?.remote_host || "").trim();
  const user = String(session?.ssh_user || session?.user || session?.username || "").trim();
  const port = session?.ssh_port || session?.port;
  if (type === "ssh" || host) {
    const userHost = host ? `${user ? `${user}@` : ""}${host}` : (user || "SSH");
    const portText = port && Number(port) !== 22 ? `:${port}` : "";
    return `SSH ${userHost}${portText}`;
  }
  return "";
}

function getTerminalShortMachineLabel(session) {
  if (!session) return "";
  const type = String(session?.type || "").trim().toLowerCase();
  const host = String(session?.ssh_host || session?.host || session?.hostname || session?.remote_host || "").trim();
  if (type === "ssh" || host) return host || "SSH";
  return "Local";
}

function getToolTerminalContext(name, args = {}, fallbackSessionId = "") {
  if (!isTerminalAwareTool(name)) return null;
  const sessionId = String(args?.session_id || fallbackSessionId || "").trim();
  if (!sessionId) {
    return {
      inlineLabel: "Local",
      fullLabel: "Local default: no terminal session selected",
      sessionId: ""
    };
  }
  const session = findTerminalSession(sessionId);
  const machine = getTerminalMachineLabel(session);
  const shortMachine = getTerminalShortMachineLabel(session);
  const cwd = String(args?.cwd || session?.cwd || session?.initial_cwd || "").trim();
  const project = pathBasename(cwd);
  const isRemote = shortMachine && shortMachine !== "Local";
  const inlineLabel = isRemote
    ? `@${[shortMachine, project].filter(Boolean).join("/")}`
    : (project ? `@${project}` : "");
  const fullLabel = [machine || shortMachine, cwd].filter(Boolean).join(" · ");
  return inlineLabel ? { inlineLabel: clipMiddle(inlineLabel, 34), fullLabel: fullLabel || inlineLabel, sessionId } : null;
}

function getToolTerminalHeaderContext(name, args = {}, fallbackSessionId = "") {
  if (!isTerminalAwareTool(name)) return null;
  const sessionId = String(args?.session_id || fallbackSessionId || "").trim();
  if (!sessionId) {
    return {
      label: "Local default",
      tooltip: "Local default: no terminal session selected",
      sessionId: ""
    };
  }
  const session = findTerminalSession(sessionId);
  const machine = getTerminalMachineLabel(session);
  const shortMachine = getTerminalShortMachineLabel(session);
  const cwd = String(args?.cwd || session?.cwd || session?.initial_cwd || "").trim();
  const project = pathBasename(cwd);
  const label = [machine || shortMachine || "Local", project].filter(Boolean).join(" · ");
  const tooltip = [machine || shortMachine || "Local", cwd].filter(Boolean).join(" · ");
  return { label: clipMiddle(label, 42), tooltip: tooltip || label, sessionId };
}

function appendArtifactTerminalScope(parent, name, args = {}) {
  const context = getToolTerminalHeaderContext(name, args);
  if (!context?.label) return;
  const scope = document.createElement("span");
  scope.className = "zion-tool-artifact-preview-scope";
  scope.textContent = context.label;
  scope.title = context.tooltip || context.label;
  if (!context.sessionId) scope.setAttribute("data-scope", "local-default");
  parent.appendChild(scope);
}

function getTerminalHeaderLabels(sessionId, cwd) {
  const session = findTerminalSession(sessionId);
  const machine = getTerminalMachineLabel(session);
  const workingDir = String(cwd || session?.cwd || session?.initial_cwd || "").trim();
  const scope = sessionId ? (machine || "Local") : "Local default";
  return {
    title: [scope, workingDir].filter(Boolean).join(" · "),
    tooltip: [scope, workingDir || "No terminal session selected"].filter(Boolean).join("\n")
  };
}

function createTerminalCommandView(name, args = {}, result = null, ok = null) {
  const parsed = result == null ? null : parseMaybeJson(result);
  const command = String(args?.command || parsed?.command || "").trim();
  const cwd = String(parsed?.cwd || args?.cwd || "").trim();
  const sessionId = String(args?.session_id || parsed?.session_id || "").trim();
  const headerLabels = getTerminalHeaderLabels(sessionId, cwd);
  const exitCode = typeof parsed?.exit_code === "number" ? parsed.exit_code : null;
  const duration = typeof parsed?.duration_ms === "number" ? parsed.duration_ms : null;
  const timedOut = !!parsed?.timeout || (typeof parsed?.error === "string" && /timeout/i.test(parsed.error));
  const status = result == null
    ? "running"
    : (ok === false || parsed?.ok === false || exitCode != null && exitCode !== 0 || parsed?.error ? "failed" : "done");
  const stdout = typeof parsed?.stdout === "string" ? parsed.stdout : "";
  const stderr = typeof parsed?.stderr === "string" ? parsed.stderr : "";
  const userMessage = typeof parsed?.user_message === "string" ? parsed.user_message : "";
  const fallback = result != null && !parsed ? String(result ?? "") : "";
  const output = [
    stdout,
    stderr,
    userMessage || (!stdout && !stderr ? String(parsed?.error || "") : ""),
    fallback
  ].filter(Boolean).join((stdout && stderr) ? "\n" : "");

  const wrap = document.createElement("div");
  wrap.className = "zion-tool-terminal";
  wrap.setAttribute("data-status", status);

  const header = document.createElement("div");
  header.className = "zion-tool-terminal-header";
  const title = document.createElement("div");
  title.className = "zion-tool-terminal-title";
  title.textContent = headerLabels.title;
  title.title = headerLabels.tooltip || headerLabels.title;
  const meta = document.createElement("div");
  meta.className = "zion-tool-terminal-meta";
  const metaParts = [];
  if (exitCode != null) metaParts.push(`exit ${exitCode}`);
  if (duration != null) metaParts.push(`${duration}ms`);
  if (timedOut) metaParts.push("timeout");
  if (parsed?.truncated) metaParts.push("truncated");
  meta.textContent = status === "running" ? "running" : metaParts.join(" · ");
  header.appendChild(title);
  if (meta.textContent) header.appendChild(meta);
  wrap.appendChild(header);

  const body = document.createElement("div");
  body.className = "zion-tool-terminal-body";
  const prompt = document.createElement("div");
  prompt.className = "zion-tool-terminal-line is-command";
  const promptMark = document.createElement("span");
  promptMark.className = "zion-tool-terminal-prompt";
  promptMark.textContent = "$";
  const commandText = document.createElement("span");
  commandText.className = "zion-tool-terminal-command";
  commandText.textContent = command || String(name || "bash");
  prompt.appendChild(promptMark);
  prompt.appendChild(commandText);
  body.appendChild(prompt);

  const outputEl = document.createElement("pre");
  outputEl.className = "zion-tool-terminal-output";
  outputEl.textContent = result == null ? "" : (output || "(no output)");
  if (outputEl.textContent) body.appendChild(outputEl);
  if (result == null) {
    const pending = document.createElement("div");
    pending.className = "zion-tool-terminal-running";
    pending.textContent = "running...";
    body.appendChild(pending);
  }
  wrap.appendChild(body);
  return wrap;
}

function createTreeToolView(args = {}, result = null, ok = null) {
  const path = String(args?.path || "").trim();
  const sessionId = String(args?.session_id || "").trim();
  const depth = typeof args?.max_depth === "number" ? args.max_depth : null;
  const session = findTerminalSession(sessionId);
  const machine = getTerminalMachineLabel(session);
  const scope = sessionId ? (machine || "Local") : "Local default";
  const status = result == null
    ? "running"
    : (ok === false || /^(\s*(tree error|http \d+|missing path))/i.test(String(result || "")) ? "failed" : "done");

  const wrap = document.createElement("div");
  wrap.className = "zion-tool-tree";
  wrap.setAttribute("data-status", status);

  const header = document.createElement("div");
  header.className = "zion-tool-tree-header";
  const title = document.createElement("div");
  title.className = "zion-tool-tree-title";
  title.textContent = [scope, path].filter(Boolean).join(" · ");
  title.title = [scope, path || "No terminal session selected"].filter(Boolean).join("\n");
  const meta = document.createElement("div");
  meta.className = "zion-tool-tree-meta";
  meta.textContent = status === "running" ? "loading" : (depth != null ? `depth ${depth}` : "");
  header.appendChild(title);
  if (meta.textContent) header.appendChild(meta);
  wrap.appendChild(header);

  const body = document.createElement("pre");
  body.className = "zion-tool-tree-body";
  body.textContent = result == null ? "Loading tree..." : (String(result || "").trimEnd() || "(empty)");
  wrap.appendChild(body);
  return wrap;
}

function createToolRequestRenderer(name, args, context = {}) {
  const n = normalizeToolName(name);
  if (n === "read" || n === "fsread" || isTerminalCommandTool(name) || isTreeTool(name)) return null;
  const section = document.createElement("div");
  section.style.marginBottom = "8px";
  const isArtifactPreview = n === "edit" || n === "fsedit" || n === "write" || n === "fswrite";
  if (!isArtifactPreview) section.appendChild(createSectionLabel("请求参数:"));
  const meta = isArtifactPreview ? null : createToolMetaRow(name, args);
  if (meta) section.appendChild(meta);
  if ((n === "edit" || n === "fsedit") && args && (typeof args.old_string === "string" || typeof args.new_string === "string")) {
    const preview = createArtifactDiffPreview(name, args, context);
    if (preview) {
      section.appendChild(preview);
      return section;
    }
    section.appendChild(createEditDiffView(args));
    return section;
  }
  if (n === "write" || n === "fswrite") {
    const preview = createArtifactDiffPreview(name, args, context);
    if (preview) {
      section.appendChild(preview);
      return section;
    }
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

function isInlineArtifactTool(name, args) {
  return canAcceptRevertTool(name, args);
}

function renderLightMarkdown(text) {
  const raw = String(text ?? "");
  let html = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _lang, code) => {
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

function createToolResponseRenderer(name, result, args = {}, context = {}) {
  const n = normalizeToolName(name);
  if (n === "read" || n === "fsread") {
    return createReadPreviewView(result, args, context);
  }
  if (isTerminalCommandTool(name)) {
    return createTerminalCommandView(name, args, result);
  }
  if (isTreeTool(name)) {
    return createTreeToolView(args, result);
  }
  const section = document.createElement("div");
  section.appendChild(createSectionLabel("响应结果:"));
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

function isChangesArtifactTool(name) {
  const n = normalizeToolName(name);
  return n === "edit" || n === "fsedit" || n === "write" || n === "fswrite" || n === "apply_patch";
}

function createToolCardActionsMenu({ id, name, args, getContext }) {
  const details = document.createElement("details");
  details.className = "zion-tool-card-actions-menu";
  details.addEventListener("click", (event) => event.stopPropagation());
  details.addEventListener("toggle", () => closeSiblingToolMenus(details));

  const summary = document.createElement("summary");
  summary.className = "zion-tool-card-actions-trigger";
  summary.title = "Tool actions";
  summary.textContent = "⋯";
  details.appendChild(summary);

  const menu = document.createElement("div");
  menu.className = "zion-tool-card-actions-popover";
  if (canAcceptRevertTool(name, args)) {
    menu.appendChild(createToolMenuItem(t("call.accept", "Accept"), () => emitToolCardAction("accept", { id, name, args, getContext }), "primary"));
    menu.appendChild(createToolMenuItem(t("call.revert", "Revert"), () => emitToolCardAction("revert", { id, name, args, getContext }), "danger"));
  }
  menu.appendChild(createToolMenuItem("Open in Changes", () => openChangesForTool({ id, name, args, getContext })));
  details.appendChild(menu);
  return details;
}

function createToolMenuItem(label, onClick, tone = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `zion-tool-card-menu-item${tone ? ` is-${tone}` : ""}`;
  btn.textContent = label;
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const menu = btn.closest(".zion-tool-card-actions-menu");
    if (menu) menu.removeAttribute("open");
    onClick?.();
  });
  return btn;
}

function openChangesForTool({ id, name, args, getContext }) {
  try {
    const ctx = getContext?.() || {};
    window.zion?.commands?.executeCommand?.("tools.openChanges", {
      id,
      toolCallId: id,
      name,
      args,
      panelId: ctx.panelId || null,
      sessionId: ctx.sessionId || null
    });
  } catch {}
}

function canAcceptRevertTool(name, args) {
  const n = normalizeToolName(name);
  return !!args && (n === "edit" || n === "fsedit" || n === "write" || n === "fswrite");
}

function emitToolCardAction(action, { id, name, args, getContext }) {
  const n = normalizeToolName(name);
  const isEdit = n === "edit" || n === "fsedit";
  const isWrite = n === "write" || n === "fswrite";
  if (!isEdit && !isWrite) return;
  const eventName = `toolcards/${isEdit ? "edit" : "write"}${action === "accept" ? "Accept" : "Revert"}`;
  try {
    const ctx = getContext?.() || {};
    const payload = {
      id,
      path: args?.path || args?.file_path,
      panelId: ctx.panelId,
      sessionId: ctx.sessionId
    };
    if (isEdit) {
      payload.old_string = args?.old_string;
      payload.new_string = args?.new_string;
      payload.replace_all = args?.replace_all;
    } else {
      payload.content = args?.content;
    }
    window.zion?.events?.emit(eventName, payload);
  } catch (err) {
    console.error(`[${eventName}] error:`, err);
  }
}

function closeSiblingToolMenus(current) {
  if (!current.open) return;
  const root = current.closest(".zion-tool-call-card");
  if (!root) return;
  for (const menu of root.querySelectorAll(".zion-tool-card-actions-menu[open]")) {
    if (menu !== current) menu.removeAttribute("open");
  }
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
  constructor(id, name, args, result, ok, sessionId = null, action = null) {
    super();
    this.id = id + ":card";
    this.name = name;
    this.args = args;
    this.result = result;
    this.ok = ok;
    this.sessionId = sessionId || null;
    this.action = normalizeToolAction(action);
  }
  eq(other) {
    return other.id === this.id && other.name === this.name && other.result === this.result && other.ok === this.ok && other.sessionId === this.sessionId && other.action === this.action && JSON.stringify(other.args) === JSON.stringify(this.args);
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
    const ok = inferToolOkFromResult(this.name, this.result, this.ok);
    const normalizedName = normalizeToolName(this.name);
    const inlineArtifact = isInlineArtifactTool(this.name, this.args);
    const readArtifact = normalizedName === "read" || normalizedName === "fsread";
    const terminalArtifact = isTerminalCommandTool(this.name);
    const treeArtifact = isTreeTool(this.name);
    const terminalContext = getToolTerminalContext(this.name, this.args, this.sessionId || "");
    if (inlineArtifact || readArtifact || terminalArtifact || treeArtifact) wrap.classList.add("is-artifact");
    if (terminalArtifact) wrap.classList.add("is-terminal");
    if (treeArtifact) wrap.classList.add("is-tree");
    if (!inlineArtifact && !readArtifact && !terminalArtifact && !treeArtifact) {
      const header = document.createElement("div");
      header.className = "zion-tool-call-card-header";
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
      title.textContent = this.name;
      Object.assign(title.style, {
        fontSize: "11px",
          fontWeight: "400",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0
      });
      titleRow.appendChild(title);
      const badge = document.createElement("span");
      badge.className = "zion-tool-call-status";
      const status = toolStatusAttr(ok, this.result != null);
      const label = toolStatusLabel(ok, this.result != null);
      badge.setAttribute("data-status", status);
      badge.innerHTML = toolStatusIcon(status);
      badge.title = label;
      badge.setAttribute("aria-label", t("call.status", "工具调用状态：{label}", { label }));
      titleRow.appendChild(badge);
      headMain.appendChild(titleRow);
      const summary = summarizeToolArgsCompact(this.name, this.args, 90);
      const subtitleParts = [summary, terminalContext?.inlineLabel].filter(Boolean);
      if (subtitleParts.length) {
        const subtitle = document.createElement("div");
        subtitle.textContent = subtitleParts.join(" · ");
        subtitle.title = [summarizeToolArgs(this.name, this.args), terminalContext?.fullLabel].filter(Boolean).join("\n");
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
      if (isChangesArtifactTool(this.name)) {
        header.appendChild(createToolCardActionsMenu({
          id: String(this.id).replace(/:card$/, ""),
          name: this.name,
          args: this.args,
          getContext: getActionContext
        }));
      }
      wrap.appendChild(header);
    }

    if (terminalArtifact) {
      wrap.appendChild(createTerminalCommandView(this.name, this.args || {}, this.result, ok));
      return wrap;
    }
    if (treeArtifact) {
      wrap.appendChild(createTreeToolView(this.args || {}, this.result, ok));
      return wrap;
    }

    // 请求参数部分
    if (this.args) {
      const requestView = createToolRequestRenderer(this.name, this.args, {
        id: String(this.id).replace(/:card$/, ""),
        result: this.result,
        ok: this.ok,
        action: this.action,
        getContext: getActionContext
      });
      if (requestView) wrap.appendChild(requestView);
    }

    // 响应结果部分
    if (this.result && (!inlineArtifact || ok === false)) {
        wrap.appendChild(createToolResponseRenderer(this.name, this.result, this.args || {}, getActionContext()));
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
  constructor(id, name, args, ok, done, action = null, result = null, sessionId = null) {
    super();
    this.id = id + ":inline";
    this.name = name;
    this.args = args;
    this.ok = ok;
    this.done = !!done;
    this.action = normalizeToolAction(action);
    this.result = result;
    this.sessionId = sessionId || null;
  }
  eq(other) {
    return other.id === this.id && other.name === this.name && other.ok === this.ok && other.done === this.done && other.action === this.action && other.result === this.result && other.sessionId === this.sessionId && JSON.stringify(other.args) === JSON.stringify(this.args);
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "zion-tool-call-inline";
    span.setAttribute("data-tool-id", String(this.id).replace(/:inline$/, ""));
    // 可访问性提示：包含摘要更知情
    const summaryText = summarizeToolArgs(this.name, this.args);
    const compactSummary = summarizeToolArgsCompact(this.name, this.args, 68);
    const artifact = getToolArtifactMeta(String(this.id).replace(/:inline$/, ""), this.name, this.args, this.result, this.ok, this.action, this.sessionId || "");
    const terminalContext = getToolTerminalContext(this.name, this.args, this.sessionId || "");
    const titleSummary = [summaryText, terminalContext?.fullLabel ? `@ ${terminalContext.fullLabel}` : ""].filter(Boolean).join(" · ");
    span.title = summaryText
      ? t("call.inlineTitleWithSummary", "调用 {name}：{summary}（点击展开/收起）", { name: this.name, summary: titleSummary })
      : t("call.inlineTitle", "调用 {name}（点击展开/收起）", { name: this.name });
    span.setAttribute("aria-label", t("call.inlineAria", "调用 {name}（点击展开或收起工具调用卡片）", { name: this.name }));
    Object.assign(span.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      maxWidth: "min(760px, 96%)",
      minWidth: 0,
      whiteSpace: "nowrap",
      overflow: "hidden",
      verticalAlign: "baseline"
    });

    const btn = document.createElement("button");
    btn.className = "zion-tool-call-inline-toggle";
    btn.type = "button";
    btn.title = t("call.toggle", "展开/收起工具调用卡片");
    btn.setAttribute("aria-label", t("call.toggle", "展开/收起工具调用卡片"));
      btn.innerHTML = `<span class="codicon codicon-chevron-down" aria-hidden="true"></span>`;
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
    txt.textContent = t("call.title", "调用 {name}", { name: this.name });
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
    if (terminalContext?.inlineLabel) {
      const env = document.createElement("span");
      env.className = "zion-tool-call-inline-env";
      env.textContent = `· ${terminalContext.inlineLabel}`;
      env.title = terminalContext.fullLabel || terminalContext.inlineLabel;
      if (!terminalContext.sessionId) env.setAttribute("data-scope", "local-default");
      info.appendChild(env);
    }

    span.appendChild(info);

    const statsPill = createToolChangeStatsPill(artifact);
    if (statsPill) span.appendChild(statsPill);

    const actionPill = createToolActionPill(this.action);
    if (actionPill) span.appendChild(actionPill);

    const openBtn = createOpenInContextButton(this.name, this.args || {}, { sessionId: this.sessionId || "" });
    if (openBtn) span.appendChild(openBtn);

    const badge = document.createElement("span");
    badge.className = "zion-tool-call-status";
    const status = toolStatusAttr(this.ok, this.done);
    const label = toolStatusLabel(this.ok, this.done);
    badge.setAttribute("data-status", status);
    badge.innerHTML = toolStatusIcon(status);
    badge.title = label;
    badge.setAttribute("aria-label", t("call.status", "工具调用状态：{label}", { label }));
    Object.assign(badge.style, {
      flex: "0 0 auto"
    });
    span.appendChild(badge);

    return span;
  }
  ignoreEvent() { return false; }
}

function buildToolDecorations(state, field) {
  const decorations = [];
  let fieldVal = null;
  try { fieldVal = state.field(field, false); } catch {}
  const items = fieldVal?.items || null;

  // Inline pills are driven directly by the document anchors (which carry the tool
  // name + id). A mirror/split panel renders pills from its seeded document on first
  // build, so the bare "调用 xxx <!-- ... -->" text can never leak through while the
  // asynchronous restore is still pending. StateField items only enrich the pill
  // (args/result/status) and drive the expanded card.
  const docLen = state.doc.length;
  let anchors = [];
  try {
    anchors = buildToolAnchors(state.doc.toString()).filter((anchor) => anchor.markerId);
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

    const it = items?.get?.(id) || null;
    const name = it?.name || anchor.name || "tool";
    const done = it ? it.result != null : false;
    decorations.push(Decoration.replace({
      widget: new ToolInlineWidget(id, name, it?.args, it?.ok ?? null, done, it?.action || null, it?.result ?? null, it?.sessionId || null)
    }).range(anchor.from, anchor.to));

    if (it?.expanded) {
      decorations.push(Decoration.widget({
        widget: new ToolCallCardWidget(id, name, it.args, it.result, it.ok, it.sessionId || null, it.action || null),
        side: 1
      }).range(anchor.to));
    }
  }
  return decorations;
}

/**
 * Field value：{ items: Map<id, { from, to, name, args, result, expanded }> }
 */
const toolInlineField = StateField.define({
  create() {
    return { items: new Map() };
  },
  update(val, tr) {
    const hasToolEffect = tr.effects.some((e) =>
      e.is(clearAll) ||
      e.is(addInline) ||
      e.is(toggleInline) ||
      e.is(updateResult) ||
      e.is(updateAction) ||
      e.is(removeTool)
    );
    if (!tr.docChanged && !hasToolEffect) return val;

    // 1) 位置映射
    const items = new Map();
    const debugEffects = { clearAll: 0, addInline: 0, toggleInline: 0, updateResult: 0, updateAction: 0, removeTool: 0 };
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
        items.clear();
      }
      if (e.is(addInline)) {
        debugEffects.addInline += 1;
        const { from, to, id, name, args, userStartLine, sessionId, action } = e.value;
        items.set(id, { from, to, name, args, result: null, ok: null, action: normalizeToolAction(action), expanded: false, userStartLine: typeof userStartLine === "number" ? userStartLine : null, sessionId: sessionId || null });
      }
      if (e.is(toggleInline)) {
        debugEffects.toggleInline += 1;
        const id = e.value?.id;
        const it = id ? items.get(id) : null;
        if (!it) continue;
        if (it.expanded) {
          items.set(id, { ...it, expanded: false });
        } else {
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
      }
      if (e.is(updateAction)) {
        debugEffects.updateAction += 1;
        const { id, action } = e.value || {};
        const it = id ? items.get(id) : null;
        if (!it) continue;
        const updated = { ...it, action: normalizeToolAction(action) };
        items.set(id, updated);
      }
      if (e.is(removeTool)) {
        debugEffects.removeTool += 1;
        const base = String(e.value?.id || "");
        const itemSessionId = items.get(base)?.sessionId || null;
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
          if (!isToolAnchorForItem(anchor, it, id)) {
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

    return { items };
  },
  provide: f => inlineWidgetSourceFacet.of({
    id: "tools",
    priority: 10,
    buildDecorations: (state) => buildToolDecorations(state, f)
  })
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
            const rawList = Array.isArray(ann.tools) ? ann.tools : [];
              const anchors = buildToolAnchors(this.view.state.doc.toString()).filter((anchor) => anchor.markerId);
              const deletedIds = reviveDeletedToolIdsForAnchors(sid, Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : [], anchors);
            const list = mergeToolItemsFromAnchors(this.view, rawList, deletedIds);
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
              fieldVal = this.view.state.field(toolInlineField);
            if (fieldVal?.items) fieldVal.items.forEach((_it, id) => mountedIds.push(String(id)));
          } catch {}
          const wantIds = list.map(it => it?.id).filter(Boolean).map(String);
            const missing = wantIds.some(id => !mountedIds.includes(id)) || needsToolRestore(list, fieldVal);
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
          const rawList = Array.isArray(ann.tools) ? ann.tools : [];
            const anchors = buildToolAnchors(this.view.state.doc.toString()).filter((anchor) => anchor.markerId);
            const deletedIds = reviveDeletedToolIdsForAnchors(sid, Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : [], anchors);
          const list = mergeToolItemsFromAnchors(this.view, rawList, deletedIds);
        let mountedIds = [];
        try {
          const fieldVal = this.view.state.field(toolInlineField);
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
        try { fieldVal = this.view.state.field(toolInlineField); } catch {}
        const mountedSet = new Set(mountedIds);
        const listForAnchors = list.filter((it) => anchorIdSet.has(String(it?.id || "")));
        const missing = wantIds.some(id => !mountedSet.has(id)) || needsToolRestore(listForAnchors, fieldVal);
        debugChatCards("visibility.checkAndRestore", {
          panelId: this.panelId,
          sessionId: sid,
          annotations: list.length,
          anchors: anchorIds.length,
          mounted: mountedIds.length,
          missing,
          stats: debugToolFieldStats(this.view)
        });
        if (missing) {
          this.onRestore({ items: listForAnchors });
        }
      } catch (e) {
        console.error("[tool-calls] checkAndRestoreWidgets error:", e);
      }
    };

    update(update) {
      const isSessionLoad = (() => {
        try {
          return !!update.transactions?.some?.((tr) => tr?.annotation?.(Transaction.userEvent) === "zion.sessionLoad");
        } catch {
          return false;
        }
      })();
      const debugBeforeSessionId = this.sessionId;
      const debugBeforeVisibleSessionId = getViewSessionId(this.view);
      if (isSessionLoad) {
        setTimeout(() => this.checkAndRestoreWidgets(), 0);
      }
      if (update.docChanged) {
        // 将锚点映射到新文档位置
          const mappedAnchorPos = update.changes.mapPos(this.anchorPos, 1);
          this.anchorPos = mappedAnchorPos;
        if (this.runActive) {
            // 回答过程中，锚点只前进不回退，避免选择区跳动把后续 widget 拖回旧 assistant 块。
            let lastToB = mappedAnchorPos;
          update.changes.iterChanges((_fromA, _toA, _fromB, toB) => {
            if (toB > lastToB) lastToB = toB;
          });
            const selHead = update.state.selection?.main?.head;
            if (typeof selHead === "number" && selHead > lastToB) lastToB = selHead;
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
        if (update.docChanged && !this.runActive) {
          setTimeout(() => this.checkAndRestoreWidgets(), 0);
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
          const action = act?.action || it.action || null;
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
            action,
            actionAt: typeof act?.at === "number" ? act.at : null
          });
        });
        updateSessionAnnotations(id, (prev) => {
          const prevTools = Array.isArray(prev.tools) ? prev.tools : [];
          if (!arr.length && prevTools.length) {
            debugChatCards("snapshot.skipEmpty", {
              panelId: this.panelId,
              sessionId: id,
              prevCount: prevTools.length,
              docLength: this.view.state.doc.length
            });
            return prev;
          }
            const prevById = new Map(prevTools.map((it) => [String(it?.id || ""), it]).filter(([key]) => !!key));
            const nextTools = [];
            const seen = new Set();
            for (const it of arr) {
              const key = String(it?.id || "");
              if (!key) continue;
              seen.add(key);
              nextTools.push(mergeToolSnapshotItem(prevById.get(key), it));
            }
            for (const it of prevTools) {
              const key = String(it?.id || "");
              if (!key || seen.has(key)) continue;
              nextTools.push(it);
            }
            return { ...prev, tools: nextTools };
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
      if (payload?.panelId && payload.panelId !== this.panelId) return false;
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
    syncToolActionsToField = () => {
      try {
        const fieldVal = this.view.state.field(toolInlineField);
        const effects = [];
        fieldVal.items.forEach((it, id) => {
          const action = this.toolActions.get(String(id))?.action || null;
          if ((it?.action || null) !== action) effects.push(updateAction.of({ id: String(id), action }));
        });
        if (effects.length) this.view.dispatch({ effects });
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
        try { this.view.dispatch({ effects: [updateAction.of({ id: String(toolCallId), action })] }); } catch {}
        try { window.zion?.events?.emit("toolcards/toolsUpdated", { sessionId: sid }); } catch {}
      } catch {}
    };
    onRun = (payload) => {
      if (!this.shouldHandleScopedPayload(payload)) return;
      this.runActive = true;
      const sel = this.view.state.selection?.main?.head;
        this.anchorPos = typeof payload?.answerAnchorPos === "number"
          ? payload.answerAnchorPos
          : (typeof sel === "number" ? sel : this.view.state.doc.length);
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

      if (!this.isPrimaryWriterPayload(payload)) {
          const anchorCountBefore = buildToolAnchors(this.view.state.doc.toString()).length;
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

      try {
        const fieldVal = this.view.state.field(toolInlineField);
        if (fieldVal?.items?.has?.(String(tc.id))) return;
        const anchors = buildToolAnchors(this.view.state.doc.toString());
        const anchor = anchors.find((it) => String(it.markerId || "") === String(tc.id));
        if (anchor) {
          this.view.dispatch({ effects: [addInline.of({ from: anchor.from, to: anchor.to, id: tc.id, name, args: tc.args, sessionId: this.sessionId })] });
          return;
        }
      } catch {}

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
        const staticHint = getRunAssistantAnchorHint(payload, sid);
        const hintCandidates = [this.anchorPos, staticHint].filter((value) => typeof value === "number" && Number.isFinite(value));
        const hint = hintCandidates.length ? Math.max(...hintCandidates) : null;
        const hintLine = getRunAssistantHeadLineHint(payload, sid);
      const plan = planAssistantMarkerInsertion({
        docText: this.view.state.doc.toString(),
        markerText: toolMarkerText(name, tc.id),
        hintPos: typeof hint === "number" ? hint : null,
        hintLine: typeof hintLine === "number" ? hintLine : null,
        trailingNewlines: 1
      });
      const userStartLine = findPrevRoleStartLine(this.view.state.doc, plan.markerFrom, "user");

      // 对外暴露锚点：设置到换行后的位置，便于后续回答继续新起一行
      try { window.zion?.state?.set("chat.lastToolCallPos", plan.markerTo + 1); } catch {}
      this.view.dispatch({
        changes: { from: plan.replaceFrom ?? plan.insertPos, to: plan.replaceTo ?? plan.insertPos, insert: plan.insertText },
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
          const anchors = buildToolAnchors(docString);
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
              if (anchor.markerId && anchor.markerId !== id) continue;
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
          const payloadId = String(payload.id);
          const anchors = buildToolAnchors(this.view.state.doc.toString())
            .filter((anchor) =>
              anchor.name === payload.name
              && (!anchor.markerId || anchor.markerId === payloadId)
              && !anchor.occupied
              && !occupied.has(`${anchor.from}:${anchor.to}`)
            );
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
      if (!this.shouldHandleToolAction(payload)) return;
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
          this.loadToolActions();
          this.syncToolActionsToField();
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
            const rawList = Array.isArray(ann.tools) ? ann.tools : [];
              const anchors = buildToolAnchors(this.view.state.doc.toString()).filter((anchor) => anchor.markerId);
              const deletedIds = reviveDeletedToolIdsForAnchors(sid, Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : [], anchors);
            const list = mergeToolItemsFromAnchors(this.view, rawList, deletedIds);
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
      this.loadToolActions();
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

      let deletedIds = [];
      try {
        const sid = restoreSessionId;
        const ann = sid ? getSessionAnnotations(sid) : {};
          const anchorsForRevive = buildToolAnchors(this.view.state.doc.toString()).filter((anchor) => anchor.markerId);
          deletedIds = reviveDeletedToolIdsForAnchors(sid, Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : [], anchorsForRevive);
      } catch {}
      const mergedList = mergeToolItemsFromAnchors(this.view, list, deletedIds);
      const itemsToProcess = filterDeletedItems(mergedList, deletedIds);
      migrateLegacyToolAnchors(this.view, itemsToProcess);

      const doc = this.view.state.doc;
      const docLen = doc.length;
      const docString = doc.toString();
      const anchors = buildToolAnchors(docString);
      const batchedEffects = [];
      const batchedToggles = [];
      const actionFor = (it) => normalizeToolAction(it?.action) || this.toolActions.get(String(it?.id || ""))?.action || null;
      let skippedFallback = false;
      debugChatCards("restore.anchors", { panelId: this.panelId, sessionId: restoreSessionId, items: list.length, anchors: anchors.length });
      let existingItems = new Map();
      try {
        const fieldVal = this.view.state.field(toolInlineField);
        if (fieldVal?.items) fieldVal.items.forEach((it, id) => existingItems.set(String(id), it));
      } catch {}
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
            const needsHydration = toolItemNeedsHydration(it, mounted);
            if (needsHydration) {
              batchedEffects.push(addInline.of({
                from: mounted.from,
                to: mounted.to,
                id,
                name: it.name,
                args: it.args,
                action: actionFor(it),
                userStartLine: typeof it.userStartLine === "number" ? it.userStartLine : null,
                sessionId: restoreSessionId
              }));
            }
          if (it.result != null && (mounted.result !== it.result || mounted.ok !== it.ok)) {
            batchedEffects.push(updateResult.of({ id, result: it.result, ok: it.ok }));
          }
          const action = actionFor(it);
          if ((mounted.action || null) !== action) {
            batchedEffects.push(updateAction.of({ id, action }));
          }
            if (!!it.expanded && (!mounted.expanded || needsHydration)) {
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
          if (anchor.from !== it.from || anchor.to !== it.to) return false;
          if (anchor.markerId && anchor.markerId !== String(it.id || "")) return false;
          return isToolAnchorForItem(doc.sliceString(it.from, it.to), it, it.id);
        },
        onMatch: (it, anchor) => {
          batchedEffects.push(addInline.of({ from: anchor.from, to: anchor.to, id: it.id, name: it.name, args: it.args, action: actionFor(it), userStartLine: typeof it.userStartLine === "number" ? it.userStartLine : null, sessionId: restoreSessionId }));
          if (it.result != null) batchedEffects.push(updateResult.of({ id: it.id, result: it.result, ok: it.ok }));
          if (it.expanded) batchedToggles.push(it.id);
        }
      });

      // Phase 2: 模糊/最近位置匹配 (应对文本偏移)
      reconcileNearestAnchors({
        items: itemsToProcess,
        processedIds,
        anchors,
        canUseAnchor: (it, anchor) => anchor.name === it.name && (!anchor.markerId || anchor.markerId === String(it.id || "")),
        onMatch: (it, anchor) => {
          batchedEffects.push(addInline.of({ from: anchor.from, to: anchor.to, id: it.id, name: it.name, args: it.args, action: actionFor(it), userStartLine: typeof it.userStartLine === "number" ? it.userStartLine : null, sessionId: restoreSessionId }));
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
        if (isCommentPanelId(this.panelId)) {
          skippedFallback = true;
          debugChatCards("restore.skipFallbackInComments", {
            panelId: this.panelId,
            sessionId: restoreSessionId,
            id: it.id,
            name: it.name || "tool"
          });
          continue;
        }

        const name = it.name || "tool";
        // 重新获取 doc，因为前面的 dispatch 可能没改变 doc (effects only)，但在 Phase 3 循环中我们会修改 doc
        const plan = planAssistantMarkerInsertion({
          docText: this.view.state.doc.toString(),
          markerText: toolMarkerText(name, it.id),
          trailingNewlines: 1
        });
        const userStartLine = typeof it.userStartLine === "number"
          ? it.userStartLine
          : findPrevRoleStartLine(this.view.state.doc, plan.markerFrom, "user");

        this.view.dispatch({
          changes: { from: plan.replaceFrom ?? plan.insertPos, to: plan.replaceTo ?? plan.insertPos, insert: plan.insertText },
          annotations: Transaction.userEvent.of("zion.cardRestore"),
          effects: [addInline.of({ from: plan.markerFrom, to: plan.markerTo, id: it.id, name, args: it.args, action: actionFor(it), userStartLine, sessionId: restoreSessionId })]
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

      try {
        if (restoreSessionId) clearPendingRestore(restoreSessionId, "tools");
      } catch {}

      if (!skippedFallback) this.snapshot();
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
      ensureToolItemFromDoc(view, id);
      view.dispatch({ effects: [toggleInline.of({ id })] });
      event.preventDefault();
      return true;
    }
  });

  return [toolInlineField, plugin, handlers];
}

/**
 * Lazily materialise a tool item into the StateField from the document anchor.
 * Inline pills render straight from the document, so a mirror/split panel may not
 * have run restore yet; this lets expand/collapse work on first click there.
 */
function ensureToolItemFromDoc(view, id) {
  const wantId = String(id || "");
  if (!wantId) return false;
  try {
    const fieldVal = view.state.field(toolInlineField, false);
    if (fieldVal?.items?.has?.(wantId)) return true;
  } catch {}

  let anchor = null;
  try {
    anchor = buildToolAnchors(view.state.doc.toString())
      .find((a) => String(a.markerId || "") === wantId) || null;
  } catch {}
  if (!anchor) return false;

  const sid = getViewSessionId(view);
  let stored = null;
  try {
    const ann = sid ? getSessionAnnotations(sid) : {};
      reviveDeletedToolIdsForAnchors(sid, Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : [], [anchor]);
    const list = Array.isArray(ann.tools) ? ann.tools : [];
    stored = list.find((x) => String(x?.id || "") === wantId) || null;
  } catch {}

  try {
    const effects = [addInline.of({
      from: anchor.from,
      to: anchor.to,
      id: wantId,
      name: stored?.name || anchor.name || "tool",
      args: stored?.args,
      action: stored?.action || null,
      sessionId: sid
    })];
    if (stored && stored.result != null) {
      effects.push(updateResult.of({ id: wantId, result: stored.result, ok: stored.ok }));
    }
    view.dispatch({ effects });
    if (stored?.expanded) view.dispatch({ effects: [toggleInline.of({ id: wantId })] });
    return true;
  } catch {
    return false;
  }
}
