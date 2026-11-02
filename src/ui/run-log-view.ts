import {
  filterRunLogGroups,
  projectRunLogGroups,
  type RunLogGroup,
  type RunLogLevel,
  type RunLogRow,
  type RunLogSourceKind
} from "../core/run-log-projection";
import type { RunRecord, RunSourceKindRegistration } from "../core/run-ledger";

export const RUN_LOG_VIEW_ID = "core.output";
export const RUN_LOG_VIEW_TITLE = "日志";

const CLEAR_CURSOR_KEY = "runLogs.clearedBefore";
const REFRESH_DELAY_MS = 100;
const COMMENTS_THREADS_KEY = "zion.comments.threads.v1";

type Listener = {
  target: EventTarget;
  type: string;
  handler: EventListener;
};

type SourceKindInfo = RunSourceKindRegistration;

const DEFAULT_SOURCE_KINDS: SourceKindInfo[] = [
  { kind: "project", label: "项目", color: "cyan", order: 10 },
  { kind: "agent-task", label: "Agent", color: "blue", order: 20 },
  { kind: "scheduled-task", label: "定时任务", color: "orange", order: 30 },
  { kind: "chat-session", label: "对话", color: "gray", order: 40 },
  { kind: "comment", label: "评论", color: "purple", order: 50 },
  { kind: "core", label: "Core", color: "gray", order: 1000 }
];

const SOURCE_COLOR_VALUES: Record<string, string> = {
  cyan: "var(--info, #0891b2)",
  blue: "var(--accent, #2563eb)",
  orange: "var(--warning, #d97706)",
  yellow: "var(--warning, #d97706)",
  red: "var(--danger, #dc2626)",
  green: "var(--success, #16a34a)",
  purple: "#7c3aed",
  gray: "var(--fg-secondary, var(--fg-muted))",
  neutral: "var(--fg-secondary, var(--fg-muted))"
};

function formatTime(timestamp: number): string {
  if (!timestamp) return "--:--:--";
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
  } catch {
    return "--:--:--";
  }
}

function formatDuration(durationMs?: number): string {
  const value = Number(durationMs || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function fallbackSourceLabel(kind: RunLogSourceKind): string {
  if (kind === "project") return "项目";
  if (kind === "agent-task") return "Agent";
  if (kind === "scheduled-task") return "定时任务";
  if (kind === "chat-session") return "对话";
  if (kind === "comment") return "评论";
  if (kind === "core") return "Core";
  return String(kind || "Core");
}

function normalizeSourceKindInfo(value: any): SourceKindInfo | null {
  const kind = compactText(value?.kind, 80);
  const label = compactText(value?.label || kind, 80);
  if (!kind || !label) return null;
  const order = Number(value?.order);
  return {
    kind,
    label,
    color: compactText(value?.color, 40) || undefined,
    order: Number.isFinite(order) ? order : undefined,
    pluginId: compactText(value?.pluginId || value?.plugin, 120) || undefined
  };
}

function sourceColorValue(color?: string): string {
  const value = compactText(color, 40);
  if (!value) return "";
  if (SOURCE_COLOR_VALUES[value]) return SOURCE_COLOR_VALUES[value];
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  if (/^var\(--[a-z0-9_-]+\)$/i.test(value)) return value;
  return "";
}

function sourceLabel(kind: RunLogSourceKind, sourceKinds?: Map<string, SourceKindInfo>): string {
  return sourceKinds?.get(String(kind || ""))?.label || fallbackSourceLabel(kind);
}

function applySourceKindStyle(
  element: HTMLElement,
  kind: RunLogSourceKind,
  sourceKinds?: Map<string, SourceKindInfo>
) {
  const color = sourceColorValue(sourceKinds?.get(String(kind || ""))?.color);
  if (color) element.style.setProperty("--zion-run-log-source-color", color);
}

function buildSourceKindMap(zion: any, groups: RunLogGroup[] = []): Map<string, SourceKindInfo> {
  const map = new Map<string, SourceKindInfo>();
  const add = (value: any) => {
    const item = normalizeSourceKindInfo(value);
    if (item) map.set(item.kind, item);
  };
  for (const item of DEFAULT_SOURCE_KINDS) add(item);
  try {
    const registered = zion?.runs?.getSourceKinds?.();
    if (Array.isArray(registered)) {
      for (const item of registered) add(item);
    }
  } catch {}
  for (const group of groups) {
    if (!map.has(group.sourceKind)) {
      add({ kind: group.sourceKind, label: fallbackSourceLabel(group.sourceKind), color: "neutral", order: 500 });
    }
  }
  return new Map(Array.from(map.entries()).sort(([, a], [, b]) => {
    return Number(a.order ?? 500) - Number(b.order ?? 500) || a.label.localeCompare(b.label);
  }));
}

function compactText(value: unknown, max = 72): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function distinctTitle(value: unknown, fallbackId = "", max = 72): string {
  const text = compactText(value, max);
  return text && text !== fallbackId ? text : "";
}

function safeParseJson<T>(value: string | null, fallback: T): T {
  try {
    const parsed = value ? JSON.parse(value) : fallback;
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonArray(key: string): any[] {
  try {
    const parsed = safeParseJson<any[]>(localStorage.getItem(key), []);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function treeSessionTitle(node: any, sessionId: string): string {
  if (!node || typeof node !== "object") return "";
  if (String(node.id || "") === sessionId && node.type === "session") {
    return distinctTitle(node.title, sessionId);
  }
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const title = treeSessionTitle(child, sessionId);
    if (title) return title;
  }
  return "";
}

function resolveSessionTitle(zion: any, sessionId: string): string {
  const sid = String(sessionId || "").trim();
  if (!sid) return "";
  try {
    const meta = zion?.commands?.executeCommand?.("zion.sessions.getMeta", sid)
      || zion?.state?.get?.(`sessions.meta.${sid}`);
    const title = distinctTitle(meta?.title, sid);
    if (title) return title;
  } catch {}
  try {
    const catalog = zion?.state?.get?.("sessions.catalog");
    if (Array.isArray(catalog)) {
      const found = catalog.find((item) => String(item?.id || "") === sid);
      const title = distinctTitle(found?.title, sid);
      if (title) return title;
    }
  } catch {}
  try {
    const tree = zion?.state?.get?.("sessions.treeMem")
      || safeParseJson<any>(localStorage.getItem("zion.sessions.tree"), null);
    const title = treeSessionTitle(tree, sid);
    if (title) return title;
  } catch {}
  return "";
}

function commentThreadIdFor(run: RunRecord, sourceId: string): string {
  const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata : {};
  const direct = String(metadata.commentId || metadata.threadId || "").trim();
  if (direct) return direct.replace(/^comment:/, "");
  const sessionId = String(run.sessionId || "").trim();
  if (sessionId.startsWith("comment:")) return sessionId.slice("comment:".length);
  const sid = String(sourceId || "").trim();
  if (sid.startsWith("comment:")) return sid.slice("comment:".length);
  return sid;
}

function resolveCommentTitle(zion: any, run: RunRecord, sourceId: string): string {
  const threadId = commentThreadIdFor(run, sourceId);
  const sessionId = String(run.sessionId || (sourceId.startsWith("comment:") ? sourceId : "")).trim();
  const threads = readJsonArray(COMMENTS_THREADS_KEY);
  const thread = threads.find((item) => {
    const id = String(item?.id || "").trim();
    const threadSessionId = String(item?.threadSessionId || (id ? `comment:${id}` : "")).trim();
    return (!!threadId && id === threadId)
      || (!!sessionId && threadSessionId === sessionId)
      || (!!sourceId && threadSessionId === sourceId);
  });
  const title = distinctTitle(
    thread?.title
    || thread?.summary
    || thread?.quote
    || thread?.anchorText
    || thread?.sourceTitle,
    threadId || sessionId
  );
  return title || resolveSessionTitle(zion, sessionId);
}

function createSourceNameResolver(zion: any) {
  return (run: RunRecord, sourceKind: RunLogSourceKind, sourceId: string) => {
    if (sourceKind === "comment") return resolveCommentTitle(zion, run, sourceId);
    if (sourceKind === "chat-session") {
      const sessionId = String(run.sessionId || sourceId || "").trim();
      return resolveSessionTitle(zion, sessionId);
    }
    return "";
  };
}

function sourceCopyLabel(
  kind: RunLogSourceKind,
  id: string,
  name?: string,
  sourceKinds?: Map<string, SourceKindInfo>
): string {
  return `${sourceLabel(kind, sourceKinds)}:${name || id}`;
}

function sourceTooltip(
  kind: RunLogSourceKind,
  id: string,
  name?: string,
  sourceKinds?: Map<string, SourceKindInfo>
): string {
  return name
    ? `${sourceLabel(kind, sourceKinds)} · ${name}\n${kind}:${id}`
    : `${kind}:${id}`;
}

function statusLabel(status: string): string {
  if (status === "queued") return "排队中";
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "stopped") return "已停止";
  if (status === "interrupted") return "已中断";
  return status || "未知";
}

function levelLabel(level: RunLogLevel): string {
  if (level === "error") return "ERROR";
  if (level === "warn") return "WARN";
  if (level === "debug") return "DEBUG";
  return "INFO";
}

function groupMetaParts(group: RunLogGroup): string[] {
  const parts = [];
  if (group.modelSummary) parts.push(group.modelSummary);
  if (group.providerSummary) parts.push(group.providerSummary);
  if (group.executionModeLabel) parts.push(group.executionModeLabel);
  if (group.durationMs) parts.push(formatDuration(group.durationMs));
  if (group.tokenCount) parts.push(`${group.tokenCount.toLocaleString()} tokens`);
  return parts;
}

function groupMetaTitle(group: RunLogGroup): string {
  const lines = [];
  if (group.modelDetail || group.modelSummary) lines.push(`模型: ${group.modelDetail || group.modelSummary}`);
  if (group.providerSummary) lines.push(`Provider: ${group.providerSummary}`);
  if (group.executionModeLabel) lines.push(`执行模式: ${group.executionModeLabel}`);
  if (group.durationMs) lines.push(`耗时: ${formatDuration(group.durationMs)}`);
  if (group.tokenCount) lines.push(`Token: ${group.tokenCount.toLocaleString()}`);
  return lines.join("\n");
}

function createOption(value: string, label: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function appendIcon(zion: any, button: HTMLButtonElement, codicon: string, fallback: string) {
  try {
    const icon = zion?.icons?.createFromCodicon?.(codicon, "zion-run-log-icon", 14);
    if (icon) {
      button.appendChild(icon);
      return;
    }
  } catch {}
  const text = document.createElement("span");
  text.className = "zion-run-log-icon-fallback";
  text.textContent = fallback;
  button.appendChild(text);
}

function createIconButton(
  zion: any,
  action: string,
  title: string,
  codicon: string,
  fallback: string
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "zion-run-log-icon-button";
  button.dataset.action = action;
  button.title = title;
  button.setAttribute("aria-label", title);
  appendIcon(zion, button, codicon, fallback);
  return button;
}

function copyText(value: string): void {
  const text = String(value || "");
  if (!text) return;
  try {
    void navigator.clipboard?.writeText?.(text);
  } catch {}
}

function groupCopyText(group: RunLogGroup, sourceKinds?: Map<string, SourceKindInfo>): string {
  const header = [
    formatTime(group.timestamp),
    `[${sourceCopyLabel(group.sourceKind, group.sourceId, group.sourceName, sourceKinds)}]`,
    group.title,
    statusLabel(group.status),
    groupMetaParts(group).join(" · ")
  ].join(" ");
  const rows = group.rows.map((row) => [
    formatTime(row.timestamp),
    levelLabel(row.level),
    row.summary,
    row.detail || "",
    formatDuration(row.durationMs)
  ].filter(Boolean).join(" "));
  return [header, ...rows].join("\n");
}

function rowCopyText(row: RunLogRow, sourceKinds?: Map<string, SourceKindInfo>): string {
  return [
    formatTime(row.timestamp),
    levelLabel(row.level),
    `[${sourceCopyLabel(row.sourceKind, row.sourceId, row.sourceName, sourceKinds)}]`,
    row.summary,
    row.detail || "",
    formatDuration(row.durationMs)
  ].filter(Boolean).join(" ");
}

function createToolbar(zion: any) {
  const toolbar = document.createElement("div");
  toolbar.className = "zion-run-log-toolbar";

  const searchWrap = document.createElement("label");
  searchWrap.className = "zion-run-log-search";
  searchWrap.title = "搜索日志";
  const searchIcon = document.createElement("span");
  searchIcon.className = "zion-run-log-search-icon";
  try {
    searchIcon.appendChild(zion?.icons?.createFromCodicon?.("search", "", 13));
  } catch {}
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "搜索运行、会话、评论或错误";
  search.dataset.role = "run-log-search";
  search.setAttribute("aria-label", "搜索运行日志");
  searchWrap.append(searchIcon, search);

  const level = document.createElement("select");
  level.className = "zion-run-log-select";
  level.dataset.role = "run-log-level";
  level.setAttribute("aria-label", "日志级别");
  level.append(
    createOption("all", "全部级别"),
    createOption("info", "信息"),
    createOption("warn", "警告"),
    createOption("error", "错误")
  );

  const source = document.createElement("select");
  source.className = "zion-run-log-select";
  source.dataset.role = "run-log-source";
  source.setAttribute("aria-label", "日志来源");
  source.append(createOption("all", "全部来源"));

  const spacer = document.createElement("span");
  spacer.className = "zion-run-log-toolbar-spacer";

  const errorCount = document.createElement("span");
  errorCount.className = "zion-run-log-error-count";
  errorCount.dataset.role = "run-log-error-count";
  errorCount.hidden = true;

  const follow = createIconButton(zion, "toggle-follow", "自动跟随", "pin", "F");
  follow.setAttribute("aria-pressed", "true");
  const refresh = createIconButton(zion, "refresh", "刷新日志", "refresh", "R");
  const clear = createIconButton(zion, "clear-view", "清空当前视图", "clear-all", "C");

  toolbar.append(searchWrap, level, source, spacer, errorCount, follow, refresh, clear);
  return { toolbar, search, level, source, errorCount, follow, refresh, clear };
}

function syncSourceOptions(
  select: HTMLSelectElement,
  nextSourceKinds: Map<string, SourceKindInfo>,
  selected: "all" | RunLogSourceKind
): "all" | RunLogSourceKind {
  const previous = selected || "all";
  select.replaceChildren(createOption("all", "全部来源"));
  for (const item of nextSourceKinds.values()) {
    select.appendChild(createOption(item.kind, item.label));
  }
  const next = previous === "all" || nextSourceKinds.has(previous) ? previous : "all";
  select.value = next;
  return next;
}

function renderUnavailable(container: HTMLElement) {
  const unavailable = document.createElement("div");
  unavailable.className = "zion-run-log-state";
  unavailable.textContent = "运行账本不可用";
  container.replaceChildren(unavailable);
  return { dispose() { unavailable.remove(); } };
}

export function renderRunLogView(container: HTMLElement, zion: any) {
  const ledger = zion?.runs;
  if (!ledger?.getSnapshot || !ledger?.getEvents || !ledger?.subscribe) {
    return renderUnavailable(container);
  }

  const root = document.createElement("div");
  root.className = "zion-run-log";
  const toolbarParts = createToolbar(zion);
  const viewport = document.createElement("div");
  viewport.className = "zion-run-log-viewport";
  viewport.dataset.role = "run-log-viewport";
  const list = document.createElement("div");
  list.className = "zion-run-log-list";
  viewport.appendChild(list);
  root.append(toolbarParts.toolbar, viewport);
  container.replaceChildren(root);

  let disposed = false;
  let refreshTimer: number | null = null;
  let query = "";
  let level: "all" | "info" | "warn" | "error" = "all";
  let source: "all" | RunLogSourceKind = "all";
  let followEnabled = true;
  let followPaused = false;
  let selectedRowId = "";
  let clearedBefore = Number(zion?.state?.get?.(CLEAR_CURSOR_KEY) || 0);
  const expansion = new Map<string, boolean>();
  const listeners: Listener[] = [];
  const resolveSourceName = createSourceNameResolver(zion);
  let sourceKinds = buildSourceKindMap(zion);

  const listen = (
    target: EventTarget,
    type: string,
    handler: EventListener,
    track = true
  ) => {
    target.addEventListener(type, handler);
    if (track) listeners.push({ target, type, handler });
  };

  const updateFollowState = () => {
    const paused = followEnabled && followPaused;
    root.classList.toggle("is-follow-paused", paused);
    root.classList.toggle("is-follow-disabled", !followEnabled);
    toolbarParts.follow.classList.toggle("is-active", followEnabled);
    toolbarParts.follow.setAttribute("aria-pressed", followEnabled ? "true" : "false");
    toolbarParts.follow.title = !followEnabled
      ? "自动跟随已关闭"
      : paused
        ? "自动跟随已暂停，滚动到底部后恢复"
        : "自动跟随";
  };

  const scrollToBottom = () => {
    if (!followEnabled || followPaused) return;
    viewport.scrollTop = viewport.scrollHeight;
  };

  const openSession = (sessionId?: string) => {
    if (!sessionId) return;
    const panelId = zion?.panels?.getActivePanelId?.();
    if (!panelId || typeof zion?.panels?.openSession !== "function") return;
    void Promise.resolve(zion.panels.openSession(panelId, sessionId, { focus: true }));
  };

  const createRow = (row: RunLogRow): HTMLElement => {
    const element = document.createElement("div");
    element.className = `zion-run-log-row is-${row.level}`;
    element.dataset.logId = row.id;
    element.classList.toggle("is-selected", selectedRowId === row.id);
    element.tabIndex = 0;
    element.title = rowCopyText(row, sourceKinds);

    const time = document.createElement("time");
    time.className = "zion-run-log-time";
    time.dateTime = new Date(row.timestamp).toISOString();
    time.textContent = formatTime(row.timestamp);

    const sourceCell = document.createElement("span");
    sourceCell.className = "zion-run-log-source";
    applySourceKindStyle(sourceCell, row.sourceKind, sourceKinds);
    sourceCell.textContent = row.detail || row.sourceName || sourceLabel(row.sourceKind, sourceKinds);
    sourceCell.title = sourceTooltip(row.sourceKind, row.sourceId, row.sourceName, sourceKinds);

    const summary = document.createElement("span");
    summary.className = "zion-run-log-summary";
    summary.textContent = row.summary;

    const meta = document.createElement("span");
    meta.className = "zion-run-log-meta";
    const duration = formatDuration(row.durationMs);
    meta.textContent = duration || levelLabel(row.level);

    const copy = createIconButton(zion, "copy-row", "复制日志", "copy", "C");
    copy.classList.add("zion-run-log-row-action");
    listen(copy, "click", ((event: Event) => {
      event.stopPropagation();
      copyText(rowCopyText(row, sourceKinds));
    }) as EventListener, false);
    listen(element, "click", (() => {
      selectedRowId = row.id;
      list.querySelectorAll(".zion-run-log-row.is-selected").forEach((candidate) => {
        candidate.classList.toggle(
          "is-selected",
          (candidate as HTMLElement).dataset.logId === selectedRowId
        );
      });
      element.classList.add("is-selected");
    }) as EventListener, false);

    element.append(time, sourceCell, summary, meta, copy);
    return element;
  };

  const createGroup = (group: RunLogGroup): HTMLElement => {
    if (!expansion.has(group.runId)) {
      expansion.set(group.runId, group.expandedByDefault);
    }
    const expanded = expansion.get(group.runId) === true;
    const section = document.createElement("section");
    section.className = `zion-run-log-group is-${group.level}`;
    section.classList.toggle("is-expanded", expanded);
    section.dataset.runId = group.runId;

    const header = document.createElement("div");
    header.className = "zion-run-log-group-header";
    const toggle = createIconButton(
      zion,
      "toggle-run",
      expanded ? "折叠运行" : "展开运行",
      expanded ? "chevron-down" : "chevron-right",
      expanded ? "v" : ">"
    );
    toggle.classList.add("zion-run-log-toggle");

    const time = document.createElement("time");
    time.className = "zion-run-log-time";
    time.dateTime = new Date(group.timestamp).toISOString();
    time.textContent = formatTime(group.timestamp);

    const sourceCell = document.createElement("span");
    sourceCell.className = "zion-run-log-source";
    applySourceKindStyle(sourceCell, group.sourceKind, sourceKinds);
    sourceCell.textContent = sourceLabel(group.sourceKind, sourceKinds);
    sourceCell.title = sourceTooltip(group.sourceKind, group.sourceId, group.sourceName, sourceKinds);

    const title = document.createElement("span");
    title.className = "zion-run-log-title";
    title.textContent = group.title;
    title.title = `${group.title} (${group.runId})`;

    const status = document.createElement("span");
    status.className = `zion-run-log-status is-${group.status}`;
    status.textContent = statusLabel(group.status);

    const usage = document.createElement("span");
    usage.className = "zion-run-log-usage";
    usage.textContent = groupMetaParts(group).join(" · ");
    usage.title = groupMetaTitle(group);

    const copy = createIconButton(zion, "copy-run", "复制本次运行日志", "copy", "C");
    const open = createIconButton(zion, "open-session", "打开完整会话", "go-to-file", "O");
    open.hidden = !group.sessionId;

    const body = document.createElement("div");
    body.className = "zion-run-log-group-body";
    body.hidden = !expanded;
    for (const row of group.rows) body.appendChild(createRow(row));

    const setExpanded = (next: boolean) => {
      expansion.set(group.runId, next);
      section.classList.toggle("is-expanded", next);
      body.hidden = !next;
      toggle.title = next ? "折叠运行" : "展开运行";
      toggle.setAttribute("aria-label", toggle.title);
      toggle.replaceChildren();
      appendIcon(zion, toggle, next ? "chevron-down" : "chevron-right", next ? "v" : ">");
    };

    listen(toggle, "click", ((event: Event) => {
      event.stopPropagation();
      setExpanded(!section.classList.contains("is-expanded"));
    }) as EventListener, false);
    listen(
      title,
      "click",
      (() => setExpanded(!section.classList.contains("is-expanded"))) as EventListener,
      false
    );
    listen(copy, "click", ((event: Event) => {
      event.stopPropagation();
      copyText(groupCopyText(group, sourceKinds));
    }) as EventListener, false);
    listen(open, "click", ((event: Event) => {
      event.stopPropagation();
      openSession(group.sessionId);
    }) as EventListener, false);

    header.append(toggle, time, sourceCell, title, status, usage, copy, open);
    section.append(header, body);
    return section;
  };

  const render = () => {
    if (disposed) return;
    let groups: RunLogGroup[] = [];
    try {
      const snapshot = ledger.getSnapshot();
      const projectedGroups = projectRunLogGroups(
        Array.isArray(snapshot?.runs) ? snapshot.runs : [],
        (runId) => ledger.getEvents(runId),
        { after: clearedBefore, maxRows: 500, resolveSourceName }
      );
      sourceKinds = buildSourceKindMap(zion, projectedGroups);
      source = syncSourceOptions(toolbarParts.source, sourceKinds, source);
      groups = filterRunLogGroups(projectedGroups, { query, level, source });
    } catch {
      list.replaceChildren();
      const failed = document.createElement("div");
      failed.className = "zion-run-log-state is-error";
      failed.textContent = "无法读取运行日志";
      list.appendChild(failed);
      return;
    }

    list.replaceChildren();
    if (!groups.length) {
      const empty = document.createElement("div");
      empty.className = "zion-run-log-state";
      empty.textContent = "暂无运行日志";
      list.appendChild(empty);
    } else {
      for (const group of groups) list.appendChild(createGroup(group));
    }

    const errorCount = groups.reduce((count, group) => (
      count
      + (group.level === "error" ? 1 : 0)
      + group.rows.filter((row) => row.level === "error").length
    ), 0);
    toolbarParts.errorCount.hidden = errorCount === 0;
    toolbarParts.errorCount.textContent = errorCount ? `${errorCount} 错误` : "";
    scrollToBottom();
  };

  const scheduleRender = () => {
    if (disposed || refreshTimer != null) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      render();
    }, REFRESH_DELAY_MS);
  };

  listen(toolbarParts.search, "input", (() => {
    query = toolbarParts.search.value;
    render();
  }) as EventListener);
  listen(toolbarParts.level, "change", (() => {
    level = toolbarParts.level.value as typeof level;
    render();
  }) as EventListener);
  listen(toolbarParts.source, "change", (() => {
    source = toolbarParts.source.value as typeof source;
    render();
  }) as EventListener);
  listen(toolbarParts.follow, "click", (() => {
    followEnabled = !followEnabled;
    followPaused = false;
    updateFollowState();
    scrollToBottom();
  }) as EventListener);
  listen(toolbarParts.refresh, "click", (() => render()) as EventListener);
  listen(toolbarParts.clear, "click", (() => {
    clearedBefore = Date.now();
    try { zion?.state?.set?.(CLEAR_CURSOR_KEY, clearedBefore); } catch {}
    render();
  }) as EventListener);
  listen(viewport, "scroll", (() => {
    if (!followEnabled) return;
    const distance = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    followPaused = distance > 24;
    updateFollowState();
  }) as EventListener);

  const subscription = ledger.subscribe(() => scheduleRender());
  updateFollowState();
  render();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (refreshTimer != null) {
        window.clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      try { subscription?.dispose?.(); } catch {}
      for (const listener of listeners) {
        listener.target.removeEventListener(listener.type, listener.handler);
      }
      listeners.length = 0;
      root.remove();
    }
  };
}

export function createRunLogViewDefinition(zion: any) {
  return {
    id: RUN_LOG_VIEW_ID,
    pluginId: "core",
    title: RUN_LOG_VIEW_TITLE,
    icon: "$(output)",
    order: 10,
    keepWhenActive: true,
    maximizable: true,
    component: {
      render: (container: HTMLElement) => renderRunLogView(container, zion)
    }
  };
}
