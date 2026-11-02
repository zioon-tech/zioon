import { getEditorCore } from "../dev.tools/editor-core.js";
import {
  hydrateLlmRequestWorkbenchEvent,
  llmRequestPayloadFromWorkbenchEvent,
  preferDetailedLlmRequestRecord
} from "../../src/runtime/llm-request-observability.ts";
import {
  DEFAULT_WORKBENCH_RUNTIME_BASE_URL,
  readWorkbenchRuntimeConfig
} from "../../src/runtime/workbench-runtime-config.ts";
import { extractRequestMessages } from "./request-messages.js";

const VIEW_ID = "dev.llm-payloads.panel";
const FILES_VIEW_ID = "dev.tools.files";
const MAX_RECORDS = 80;
const RECENT_EVENT_WINDOW = 5_000;
const RECENT_EVENT_LIMIT = 2_000;
const WORKBENCH_STATE_PROTOCOL = "5";
const MAX_PAYLOAD_CHARS = 500_000;
const MAX_INLINE_TEXT = 240;
const MAX_MESSAGE_TEXT = 8_000;
const SECRET_KEY_RE = /^(authorization|api[-_]?key|key|token|secret|password)$/i;
const I18N_NS = "dev.llm-payloads";

const I18N_MESSAGES = {
  "zh-CN": {
    "title": "LLM 请求",
    "description": "查看即将发出的 LLM 请求",
    "cmd.open": "打开 LLM 请求",
    "cmd.clear": "清空 LLM 请求",
    "category.developer": "开发者",
    "action.messages": "消息",
    "action.messages.title": "显示消息",
    "action.raw": "Raw",
    "action.raw.title": "显示 Raw JSON",
    "action.mock": "Mock",
    "action.mock.title": "按当前光标 Mock 消息",
    "action.openRaw": "在编辑器中打开 Raw JSON",
    "action.copy": "复制 Raw JSON",
    "action.clear": "清空请求",
    "list.count": "{count} 个请求",
    "filter.placeholder": "筛选...",
    "empty.noMatches": "没有匹配的请求。",
    "empty.noRequests": "还没有 LLM 请求。",
    "empty.select": "选择一个请求查看详情。",
    "empty.noMessages": "这个请求里没有消息。",
    "empty.summaryOnly": "完整消息详情未保留；这里只能显示请求摘要。",
    "mock.generated": "已生成 Mock 消息",
    "mock.noMessages": "没有生成 Mock 消息",
    "mock.label": "Mock",
    "meta.step": "step {value}",
    "meta.source": "来源 {value}",
    "meta.session": "session {value}",
    "meta.panel": "panel {value}",
    "meta.msg": "{count} msg",
    "meta.chars": "{count} chars",
    "meta.tools": "{count} tools",
    "meta.params": "{count} params",
    "meta.json": "{count} json",
    "meta.retry": "retry",
    "message.toggle": "展开或折叠消息",
    "message.truncated": "truncated",
    "message.empty": "(empty)",
    "raw.label": "Raw payload",
    "raw.mockLabel": "Mock raw payload",
    "raw.truncated": "已为 UI 安全截断",
    "copy.done": "Payload 已复制",
    "tool.fallback": "tool",
    "model.unknown": "Unknown model"
  },
  "en-US": {
    "title": "LLM Requests",
    "description": "Inspect outgoing LLM requests",
    "cmd.open": "Open LLM Requests",
    "cmd.clear": "Clear LLM Requests",
    "category.developer": "Developer",
    "action.messages": "Messages",
    "action.messages.title": "Show messages",
    "action.raw": "Raw",
    "action.raw.title": "Show raw JSON",
    "action.mock": "Mock",
    "action.mock.title": "Mock messages from current cursor",
    "action.openRaw": "Open raw JSON in editor",
    "action.copy": "Copy raw JSON",
    "action.clear": "Clear requests",
    "list.count": "{count} request{plural}",
    "filter.placeholder": "Filter...",
    "empty.noMatches": "No matching requests.",
    "empty.noRequests": "No LLM requests yet.",
    "empty.select": "Select a request to inspect.",
    "empty.noMessages": "No messages in this request.",
    "empty.summaryOnly": "Full message details were not retained; only the request summary is available.",
    "mock.generated": "Mock messages generated",
    "mock.noMessages": "No mock messages generated",
    "mock.label": "Mock",
    "meta.step": "step {value}",
    "meta.source": "source {value}",
    "meta.session": "session {value}",
    "meta.panel": "panel {value}",
    "meta.msg": "{count} msg",
    "meta.chars": "{count} chars",
    "meta.tools": "{count} tools",
    "meta.params": "{count} params",
    "meta.json": "{count} json",
    "meta.retry": "retry",
    "message.toggle": "Expand or collapse message",
    "message.truncated": "truncated",
    "message.empty": "(empty)",
    "raw.label": "Raw payload",
    "raw.mockLabel": "Mock raw payload",
    "raw.truncated": "truncated for UI safety",
    "copy.done": "Payload copied",
    "tool.fallback": "tool",
    "model.unknown": "Unknown model"
  }
};

const records = [];
const listeners = new Set();
let selectedId = "";
let activeDetailTab = "messages";
let recentLoadPromise = null;

function t(key, fallback, values) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return interpolate(fallback || key, values);
}

function interpolate(text, values) {
  if (!values || typeof values !== "object") return String(text || "");
  return String(text || "").replace(/\{([^}]+)\}/g, (_, key) => String(values[key] ?? ""));
}

export async function activate(ctx) {
  
try {
    const disp = window.zion?.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  const onPayload = (payload = {}) => {
    addRecord(payload);
  };
  const dispPayload = window.zion?.events?.on?.("llm/requestPayload", onPayload);
  if (dispPayload) ctx.subscriptions.push(dispPayload);

  window.zion.llmPayloads = {
    list: () => records.slice(),
    get: (id) => records.find((item) => item.id === id) || null,
    add: addRecord,
    clear: clearRecords,
    open: openPanel
  };
  try {
    const queued = Array.isArray(window.zion.__llmPayloadQueue) ? window.zion.__llmPayloadQueue.splice(0) : [];
    for (const item of queued) addRecord(item);
  } catch {}
  void loadRecentRuntimeRequests();

  ctx.subscriptions.push(window.zion.commands.registerCommand("llmPayloads.open", openPanel));
  ctx.subscriptions.push(window.zion.commands.registerCommand("llmPayloads.clear", () => {
    clearRecords();
    return true;
  }));

  try {
    const view = window.zion.bottomPanel?.registerView?.({
      id: VIEW_ID,
      pluginId: "dev.llm-payloads",
      title: t("title", "LLM Requests"),
      titleKey: "dev.llm-payloads.title",
      icon: "$(debug-alt)",
      order: 80,
      location: "bottompanel",
      keepWhenActive: true,
      maximizable: true,
      headerActions: [
        {
          id: "llmPayloads.viewMessages",
          title: t("action.messages.title", "Show messages"),
          titleKey: "dev.llm-payloads.action.messages.title",
          icon: "$(list-tree)",
          text: t("action.messages", "Messages"),
          textKey: "dev.llm-payloads.action.messages",
          active: () => activeDetailTab === "messages",
          onClick: () => switchDetailTab("messages")
        },
        {
          id: "llmPayloads.viewRaw",
          title: t("action.raw.title", "Show raw JSON"),
          titleKey: "dev.llm-payloads.action.raw.title",
          icon: "$(json)",
          text: t("action.raw", "Raw"),
          textKey: "dev.llm-payloads.action.raw",
          active: () => activeDetailTab === "raw",
          onClick: () => switchDetailTab("raw")
        },
        {
          id: "llmPayloads.mock",
          title: t("action.mock.title", "Mock messages from current cursor"),
          titleKey: "dev.llm-payloads.action.mock.title",
          icon: "$(beaker)",
          text: t("action.mock", "Mock"),
          textKey: "dev.llm-payloads.action.mock",
          onClick: () => { void mockCurrentMessages(); }
        },
        {
          id: "llmPayloads.openRaw",
          title: t("action.openRaw", "Open raw JSON in editor"),
          titleKey: "dev.llm-payloads.action.openRaw",
          icon: "$(go-to-file)",
          onClick: () => {
            const item = getSelectedRecord();
            if (item) openRawInEditor(item);
          }
        },
        {
          id: "llmPayloads.copy",
          title: t("action.copy", "Copy raw JSON"),
          titleKey: "dev.llm-payloads.action.copy",
          icon: "$(copy)",
          onClick: () => {
            const item = getSelectedRecord();
            if (item) copyText(item.payloadText);
          }
        },
        {
          id: "llmPayloads.clear",
          title: t("action.clear", "Clear requests"),
          titleKey: "dev.llm-payloads.action.clear",
          icon: "$(clear-all)",
          onClick: clearRecords
        }
      ],
      component: { render: renderPanel }
    });
    if (view) ctx.subscriptions.push(view);
  } catch {}
  try {
    const item = window.zion.activityBar?.registerItem?.({
      id: "dev.llm-payloads.activity",
      pluginId: "dev.llm-payloads",
      icon: "$(debug-alt)",
      tooltip: t("title", "LLM Requests"),
      tooltipKey: "dev.llm-payloads.title",
      bottomPanelViewId: VIEW_ID,
      order: 82
    });
    if (item) ctx.subscriptions.push(item);
  } catch {}

  ctx.subscriptions.push({
    dispose() {
      try { if (window.zion?.llmPayloads?.list === window.zion.llmPayloads.list) delete window.zion.llmPayloads; } catch {}
    }
  });
}

function getSelectedRecord() {
  return records.find((item) => item.id === selectedId) || records[0] || null;
}

function switchDetailTab(tab) {
  activeDetailTab = tab === "raw" ? "raw" : "messages";
  emitChanged();
  try { window.zion?.bottomPanel?.activateView?.(VIEW_ID); } catch {}
}

async function mockCurrentMessages() {
  try {
    const mock = await window.zion?.commands?.executeCommand?.("chat.mockCurrentMessages", {});
    if (!mock?.payload?.messages?.length) throw new Error(t("mock.noMessages", "No mock messages generated"));
    activeDetailTab = "messages";
    const record = addRecord({ ...mock, mock: true });
    selectedId = record.id;
    openPanel();
    try { window.zion?.notification?.show?.(t("mock.generated", "Mock messages generated"), { type: "success", duration: 1200 }); } catch {}
  } catch (e) {
    try { window.zion?.notification?.show?.(e?.message || String(e), { type: "error", duration: 2000 }); } catch {}
  }
}

function openPanel() {
  void loadRecentRuntimeRequests();
  try { window.zion?.bottomPanel?.setHeight?.(320); } catch {}
  try { window.zion?.bottomPanel?.activateView?.(VIEW_ID); } catch {}
  try { window.zion?.bottomPanel?.show?.(); } catch {}
}

function addRecord(payload) {
  const record = normalizeRecord(payload);
  const existingIndex = records.findIndex((item) => item.id === record.id);
  if (existingIndex >= 0) {
    const existing = records[existingIndex];
    records.splice(existingIndex, 1);
    records.unshift(preferDetailedLlmRequestRecord(existing, record));
    emitChanged();
    return records[0];
  }
  records.unshift(record);
  if (!selectedId || record.mock) selectedId = record.id;
  while (records.length > MAX_RECORDS) records.pop();
  emitChanged();
  return record;
}

function clearRecords() {
  records.length = 0;
  selectedId = "";
  emitChanged();
}

function emitChanged() {
  for (const fn of Array.from(listeners)) {
    try { fn(); } catch {}
  }
  try { window.zion?.events?.emit?.("llmPayloads/changed", { count: records.length }); } catch {}
}

function subscribe(fn) {
  listeners.add(fn);
  return { dispose: () => listeners.delete(fn) };
}

async function runtimeJson(path) {
  const config = readWorkbenchRuntimeConfig({
    state: window.zion?.state,
    storage: globalThis.localStorage
  });
  const baseUrl = config.baseUrl || DEFAULT_WORKBENCH_RUNTIME_BASE_URL;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Zion-Workbench-Protocol": WORKBENCH_STATE_PROTOCOL
    }
  });
  if (!response.ok) throw new Error(`Runtime Workbench state HTTP ${response.status}`);
  return response.json();
}

async function loadRecentRuntimeRequests() {
  if (recentLoadPromise) return recentLoadPromise;
  recentLoadPromise = (async () => {
    try {
      const status = await runtimeJson("/v1/workbench-state/status");
      const latest = Math.max(0, Number(status?.event_cursor) || 0);
      if (!latest) return;
      const after = Math.max(0, latest - RECENT_EVENT_WINDOW);
      const query = new URLSearchParams({
        after: String(after),
        limit: String(RECENT_EVENT_LIMIT)
      });
      const feed = await runtimeJson(`/v1/workbench-state/events?${query}`);
      const events = Array.isArray(feed?.events) ? feed.events : [];
      const requestEvents = events
        .filter((event) => event?.type === "llm.request")
        .slice(-MAX_RECORDS);
      const hydratedEvents = await Promise.all(requestEvents.map(async (event) => {
        try {
          return await hydrateLlmRequestWorkbenchEvent(
            event,
            (runId, sequence) => runtimeJson(
              `/v1/runs/${encodeURIComponent(runId)}/events/${encodeURIComponent(sequence)}`
            )
          );
        } catch {
          return event;
        }
      }));
      for (const event of hydratedEvents) {
        const payload = llmRequestPayloadFromWorkbenchEvent(event);
        if (payload) addRecord(payload);
      }
    } catch (error) {
      console.warn("[dev.llm-payloads] failed to load recent Runtime requests:", error);
    }
  })().finally(() => {
    recentLoadPromise = null;
  });
  return recentLoadPromise;
}

function normalizeRecord(payload) {
  const rawPayload = payload?.payload ?? {};
  const payloadText = safeStringify(rawPayload, MAX_PAYLOAD_CHARS);
  const messages = extractRequestMessages(rawPayload);
  const messageChars = messages.reduce((sum, msg) => sum + contentLength(msg?.content), 0);
  const id = String(payload?.id || `llm_payload_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  return {
    id,
    mock: !!payload?.mock || !!rawPayload?.mock,
    timestamp: Number(payload?.timestamp || Date.now()),
    runId: String(payload?.runId || ""),
    sessionId: String(payload?.sessionId || ""),
    panelId: String(payload?.panelId || ""),
    source: String(payload?.source || payload?.requestSource || inferSource(payload)),
    stepIndex: Number.isFinite(Number(payload?.stepIndex)) ? Number(payload.stepIndex) : null,
    providerId: String(payload?.providerId || ""),
    modelId: String(payload?.modelId || rawPayload?.model || ""),
    modelLabel: String(payload?.modelLabel || rawPayload?.model || payload?.modelId || t("model.unknown", "Unknown model")),
    providerType: String(payload?.providerType || ""),
    url: String(payload?.url || ""),
    stream: payload?.stream !== false,
    retryWithReasoningContent: !!payload?.retryWithReasoningContent,
    summaryOnly: payload?.summaryOnly === true,
    messageCount: Number(payload?.messageCount || messages.length || 0),
    toolCount: Number(payload?.toolCount || inferToolCount(rawPayload)),
    messageChars,
    payloadText,
    payloadTruncated: payloadText.endsWith("\n...<truncated>"),
    preview: summarizeMessages(messages),
    messages: normalizeMessages(messages),
    tools: summarizeTools(rawPayload),
    params: summarizeParams(rawPayload),
    createdAtLabel: formatTime(Number(payload?.timestamp || Date.now()))
  };
}

function inferSource(payload) {
  const panelId = String(payload?.panelId || "");
  const sessionId = String(payload?.sessionId || "");
  if (panelId.startsWith("comments:") || sessionId.startsWith("comment:")) return "comments";
  if (panelId.startsWith("agents:") || sessionId.startsWith("agent-task:")) return "agents";
  return "";
}

function inferToolCount(payload) {
  if (Array.isArray(payload?.tools)) return payload.tools.length;
  if (Array.isArray(payload?.functions)) return payload.functions.length;
  return 0;
}

function contentLength(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) return content.reduce((sum, item) => sum + contentLength(item?.text || item?.image_url?.url || ""), 0);
  if (content == null) return 0;
  return String(content).length;
}

function summarizeMessages(messages) {
  return messages.slice(0, 6).map((msg) => {
    const text = flattenContent(msg?.content).replace(/\s+/g, " ").trim();
    return {
      role: String(msg?.role || "unknown"),
      text: text.length > MAX_INLINE_TEXT ? `${text.slice(0, MAX_INLINE_TEXT)}...` : text
    };
  });
}

function normalizeMessages(messages) {
  return messages.map((msg, index) => {
    const rawText = flattenContent(msg?.content).replace(/\s+\n/g, "\n").trim();
    const text = rawText.length > MAX_MESSAGE_TEXT ? `${rawText.slice(0, MAX_MESSAGE_TEXT)}\n...<message truncated>` : rawText;
    const excerpt = rawText.replace(/\s+/g, " ").trim();
    return {
      index,
      role: String(msg?.role || "unknown"),
      name: String(msg?.name || ""),
      toolCallId: String(msg?.tool_call_id || ""),
      chars: rawText.length,
      text,
      excerpt: excerpt.length > 180 ? `${excerpt.slice(0, 180)}...` : excerpt,
      truncated: rawText.length > MAX_MESSAGE_TEXT,
      toolCalls: Array.isArray(msg?.tool_calls) ? msg.tool_calls.map((call) => ({
        id: String(call?.id || ""),
        name: String(call?.function?.name || call?.name || ""),
        args: typeof call?.function?.arguments === "string" ? call.function.arguments : safeStringify(call?.args || call?.function?.arguments || {}, 4_000)
      })) : []
    };
  });
}

function summarizeTools(payload) {
  const tools = Array.isArray(payload?.tools) ? payload.tools : Array.isArray(payload?.functions) ? payload.functions : [];
  return tools.slice(0, 24).map((tool) => ({
    name: String(tool?.function?.name || tool?.name || "unknown"),
    description: String(tool?.function?.description || tool?.description || "").replace(/\s+/g, " ").trim()
  }));
}

function summarizeParams(payload) {
  const keys = ["temperature", "top_p", "max_tokens", "max_completion_tokens", "presence_penalty", "frequency_penalty", "reasoning_effort", "stream"];
  return keys
    .filter((key) => Object.prototype.hasOwnProperty.call(payload || {}, key))
    .map((key) => ({ key, value: String(payload[key]) }));
}

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (!item || typeof item !== "object") return String(item || "");
      if (typeof item.text === "string") return item.text;
      if (item.image_url?.url) return `[image:${item.image_url.url}]`;
      if (item.inlineData?.mimeType || item.inline_data?.mime_type) {
        return `[image:${item.inlineData?.mimeType || item.inline_data?.mime_type}]`;
      }
      if (item.fileData?.fileUri || item.file_data?.file_uri) {
        return `[file:${item.fileData?.fileUri || item.file_data?.file_uri}]`;
      }
      if (item.functionCall?.name || item.function_call?.name) {
        return `[tool:${item.functionCall?.name || item.function_call?.name}]`;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  if (content == null) return "";
  return String(content);
}

function safeStringify(value, maxChars) {
  const seen = new WeakSet();
  let text = "";
  try {
    text = JSON.stringify(value, (key, val) => {
      if (SECRET_KEY_RE.test(String(key || ""))) return "<redacted>";
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    }, 2);
  } catch (e) {
    text = JSON.stringify({ error: e?.message || String(e), value: String(value) }, null, 2);
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...<truncated>`;
}

function renderPanel(container) {
  const root = document.createElement("div");
  root.className = "zion-llm-payloads";
  container.appendChild(root);
  let disposed = false;
  let filter = "";
  let renderTimer = 0;
  let filterSelectionStart = 0;
  let filterSelectionEnd = 0;
  const expandedMessages = new Set();
  let lastRenderedSelectedId = "";
  let lastRenderedDetailTab = activeDetailTab;

  const scheduleRender = () => {
    if (disposed || renderTimer) return;
    renderTimer = window.setTimeout(() => {
      renderTimer = 0;
      render();
    }, 40);
  };

  const sub = subscribe(scheduleRender);
  const i18nSub = (() => {
    try { return window.zion?.events?.on?.("i18n/changed", scheduleRender); } catch { return null; }
  })();

  function render() {
    const filtered = filterRecords(filter);
    if (!selectedId || !records.some((item) => item.id === selectedId)) selectedId = filtered[0]?.id || records[0]?.id || "";
    const selected = records.find((item) => item.id === selectedId) || null;
    const filterWasFocused = root.querySelector(".zion-llm-payloads-filter") === document.activeElement;
    const previousScroller = root.querySelector(".zion-llm-payloads-scroll, .zion-llm-payloads-raw-wrap");
    const previousDetailScrollTop = previousScroller?.scrollTop;

    const body = document.createElement("div");
    body.className = "zion-llm-payloads-body";
    body.appendChild(renderList(filtered));
    body.appendChild(renderDetail(selected));
    root.replaceChildren(body);
    const shouldRestoreDetailScroll =
      !!selected?.id &&
      lastRenderedSelectedId === selected.id &&
      lastRenderedDetailTab === activeDetailTab &&
      typeof previousDetailScrollTop === "number";
    if (shouldRestoreDetailScroll) {
      const nextScroller = root.querySelector(".zion-llm-payloads-scroll, .zion-llm-payloads-raw-wrap");
      try {
        nextScroller.scrollTop = Math.max(0, previousDetailScrollTop);
      } catch {}
    }
    lastRenderedSelectedId = selected?.id || "";
    lastRenderedDetailTab = activeDetailTab;
    if (filterWasFocused) {
      const nextInput = root.querySelector(".zion-llm-payloads-filter");
      try {
        nextInput?.focus?.();
        nextInput?.setSelectionRange?.(filterSelectionStart, filterSelectionEnd);
      } catch {}
    }
  }

  function renderList(items) {
    const list = document.createElement("div");
    list.className = "zion-llm-payloads-list";
    const header = document.createElement("div");
    header.className = "zion-llm-payloads-list-head";
    const title = document.createElement("div");
    title.className = "zion-llm-payloads-title";
    title.textContent = t("list.count", "{count} request{plural}", { count: records.length, plural: records.length === 1 ? "" : "s" });
    header.appendChild(title);
    const input = document.createElement("input");
    input.className = "zion-llm-payloads-filter";
    input.placeholder = t("filter.placeholder", "Filter...");
    input.value = filter;
    input.oninput = () => {
      filter = input.value;
      filterSelectionStart = input.selectionStart || 0;
      filterSelectionEnd = input.selectionEnd || filterSelectionStart;
      scheduleRender();
    };
    input.onselect = () => {
      filterSelectionStart = input.selectionStart || 0;
      filterSelectionEnd = input.selectionEnd || filterSelectionStart;
    };
    list.appendChild(header);
    list.appendChild(input);
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "zion-llm-payloads-empty";
      empty.textContent = records.length ? t("empty.noMatches", "No matching requests.") : t("empty.noRequests", "No LLM requests yet.");
      list.appendChild(empty);
      return list;
    }
    for (const item of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `zion-llm-payloads-row${item.id === selectedId ? " is-active" : ""}${item.mock ? " is-mock" : ""}`;
      row.onclick = () => {
        selectedId = item.id;
        scheduleRender();
      };
      const top = document.createElement("div");
      top.className = "zion-llm-payloads-row-top";
      const model = document.createElement("span");
      model.className = "zion-llm-payloads-model";
      model.textContent = item.mock ? `${t("mock.label", "Mock")} · ${item.modelLabel}` : item.modelLabel;
      const time = document.createElement("span");
      time.className = "zion-llm-payloads-time";
      time.textContent = item.createdAtLabel;
      top.appendChild(model);
      top.appendChild(time);
      const meta = document.createElement("div");
      meta.className = "zion-llm-payloads-meta";
      meta.textContent = [
        item.mock ? "MOCK" : "",
        item.stepIndex != null ? t("meta.step", "step {value}", { value: item.stepIndex + 1 }) : "",
        item.source ? t("meta.source", "source {value}", { value: item.source }) : "",
        item.sessionId ? t("meta.session", "session {value}", { value: shortId(item.sessionId) }) : "",
        item.panelId ? t("meta.panel", "panel {value}", { value: shortId(item.panelId) }) : "",
        t("meta.msg", "{count} msg", { count: item.messageCount }),
        t("meta.chars", "{count} chars", { count: formatNumber(item.messageChars) }),
        item.toolCount ? t("meta.tools", "{count} tools", { count: item.toolCount }) : "",
        item.retryWithReasoningContent ? t("meta.retry", "retry") : ""
      ].filter(Boolean).join(" · ");
      row.appendChild(top);
      row.appendChild(meta);
      list.appendChild(row);
    }
    return list;
  }

  function renderDetail(item) {
    const detail = document.createElement("div");
    detail.className = "zion-llm-payloads-detail";
    if (!item) {
      const empty = document.createElement("div");
      empty.className = "zion-llm-payloads-empty";
      empty.textContent = t("empty.select", "Select a request to inspect.");
      detail.appendChild(empty);
      return detail;
    }

    if (activeDetailTab === "messages") detail.appendChild(renderMessagesDetail(item));
    else if (activeDetailTab === "raw") detail.appendChild(renderRawDetail(item));
    else detail.appendChild(renderMessagesDetail(item));
    return detail;
  }

  function renderSummary(item) {
    const section = document.createElement("section");
    section.className = "zion-llm-payloads-summary";
    const chips = document.createElement("div");
    chips.className = "zion-llm-payloads-summary-chips";
    const values = [
      item.mock ? "MOCK" : "",
      new Date(item.timestamp).toLocaleTimeString(),
      item.stepIndex != null ? t("meta.step", "step {value}", { value: item.stepIndex + 1 }) : "",
      item.source ? t("meta.source", "source {value}", { value: item.source }) : "",
      item.sessionId ? t("meta.session", "session {value}", { value: shortId(item.sessionId) }) : "",
      item.panelId ? t("meta.panel", "panel {value}", { value: shortId(item.panelId) }) : "",
      t("meta.msg", "{count} msg", { count: item.messageCount }),
      t("meta.chars", "{count} chars", { count: formatNumber(item.messageChars) }),
      item.toolCount ? t("meta.tools", "{count} tools", { count: item.toolCount }) : "",
      item.params.length ? t("meta.params", "{count} params", { count: item.params.length }) : "",
      t("meta.json", "{count} json", { count: formatNumber(item.payloadText.length) }),
      item.retryWithReasoningContent ? t("meta.retry", "retry") : ""
    ].filter(Boolean);
    for (const value of values) {
      const chip = document.createElement("span");
      chip.className = "zion-llm-payloads-summary-chip";
      chip.textContent = value;
      chips.appendChild(chip);
    }
    const endpoint = document.createElement("div");
    endpoint.className = "zion-llm-payloads-endpoint";
    endpoint.title = item.url;
    endpoint.textContent = item.url || `${item.providerId}:${item.modelId}`;
    section.appendChild(chips);
    section.appendChild(endpoint);
    return section;
  }

  function renderMessagesDetail(item) {
    const wrap = document.createElement("div");
    wrap.className = "zion-llm-payloads-scroll";
    wrap.appendChild(renderSummary(item));
    if (!item.messages.length) {
      const empty = document.createElement("div");
      empty.className = "zion-llm-payloads-empty";
      empty.textContent = item.summaryOnly
        ? t("empty.summaryOnly", "Full message details were not retained; only the request summary is available.")
        : t("empty.noMessages", "No messages in this request.");
      wrap.appendChild(empty);
      return wrap;
    }
    for (const msg of item.messages) {
      const key = `${item.id}:${msg.index}`;
      const isOpen = expandedMessages.has(key);
      const card = document.createElement("article");
      card.className = `zion-llm-payloads-message${isOpen ? " is-open" : ""}`;
      const toggle = () => {
        if (expandedMessages.has(key)) expandedMessages.delete(key);
        else expandedMessages.add(key);
        const open = expandedMessages.has(key);
        card.classList.toggle("is-open", open);
        rail.setAttribute("aria-expanded", String(open));
      };
      const rail = document.createElement("button");
      rail.type = "button";
      rail.className = "zion-llm-payloads-message-rail";
      rail.title = t("message.toggle", "Expand or collapse message");
      rail.setAttribute("aria-label", t("message.toggle", "Expand or collapse message"));
      rail.setAttribute("aria-expanded", String(isOpen));
      rail.onclick = toggle;
      const head = document.createElement("div");
      head.className = "zion-llm-payloads-message-head";
      head.onclick = toggle;
      const meta = document.createElement("span");
      meta.className = "zion-llm-payloads-message-meta";
      meta.textContent = `${item.mock ? "MOCK · " : ""}#${msg.index + 1} ${msg.role}${msg.name ? ` · ${msg.name}` : ""}${msg.toolCallId ? ` · ${shortId(msg.toolCallId)}` : ""} · ${t("meta.chars", "{count} chars", { count: formatNumber(msg.chars) })}${msg.truncated ? ` · ${t("message.truncated", "truncated")}` : ""}`;
      const excerpt = document.createElement("span");
      excerpt.className = "zion-llm-payloads-message-excerpt";
      excerpt.textContent = msg.excerpt || t("message.empty", "(empty)");
      head.appendChild(meta);
      head.appendChild(excerpt);
      const pre = document.createElement("pre");
      pre.className = "zion-llm-payloads-message-text";
      pre.textContent = msg.text || t("message.empty", "(empty)");
      card.appendChild(rail);
      card.appendChild(head);
      card.appendChild(pre);
      if (msg.toolCalls.length) card.appendChild(renderToolCalls(msg.toolCalls));
      wrap.appendChild(card);
    }
    return wrap;
  }

  function renderRawDetail(item) {
    const wrap = document.createElement("div");
    wrap.className = "zion-llm-payloads-raw-wrap";
    const note = document.createElement("div");
    note.className = "zion-llm-payloads-raw-note";
    const label = document.createElement("span");
    label.textContent = `${item.mock ? t("raw.mockLabel", "Mock raw payload") : t("raw.label", "Raw payload")} · ${t("meta.chars", "{count} chars", { count: formatNumber(item.payloadText.length) })}${item.payloadTruncated ? ` · ${t("raw.truncated", "truncated for UI safety")}` : ""}`;
    note.appendChild(label);
    const pre = document.createElement("pre");
    pre.className = "zion-llm-payloads-json";
    pre.textContent = item.payloadText;
    wrap.appendChild(note);
    wrap.appendChild(pre);
    return wrap;
  }

  function renderToolCalls(toolCalls) {
    const wrap = document.createElement("div");
    wrap.className = "zion-llm-payloads-toolcalls";
    for (const call of toolCalls) {
      const row = document.createElement("div");
      row.className = "zion-llm-payloads-toolcall";
      row.textContent = `${call.name || t("tool.fallback", "tool")}(${call.args || ""})`;
      wrap.appendChild(row);
    }
    return wrap;
  }

  render();
  return {
    dispose() {
      disposed = true;
      if (renderTimer) window.clearTimeout(renderTimer);
      sub.dispose();
      try { i18nSub?.dispose?.(); } catch {}
      root.remove();
    }
  };
}

function filterRecords(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return records.slice();
  return records.filter((item) => [
    item.modelLabel,
    item.providerId,
    item.modelId,
    item.runId,
    item.sessionId,
    item.panelId,
    item.url
  ].join(" ").toLowerCase().includes(q));
}

function copyText(text) {
  try {
    navigator.clipboard?.writeText?.(String(text || ""));
    window.zion?.notification?.show?.(t("copy.done", "Payload copied"), { type: "success", duration: 1200 });
  } catch {}
}

function openRawInEditor(item) {
  try {
    const editorCore = getEditorCore(FILES_VIEW_ID);
    const title = `payload-${item.createdAtLabel.replace(/:/g, "")}.json`;
    editorCore.openTab({
      id: `llm-payload:${item.id}`,
      kind: "llm-payload",
      title,
      path: title,
      displayPath: `${t("title", "LLM Requests")} / ${item.modelLabel} / ${title}`,
      language: "json",
      size: item.payloadText.length,
      markdownPreview: false,
      file: { kind: "text", content: item.payloadText }
    });
    try { window.zion?.auxiliaryBar?.setWidth?.(Math.max(520, window.zion.state?.get?.("ui.auxiliaryBar.width") || 0)); } catch {}
    try { window.zion?.auxiliaryBar?.activateView?.(FILES_VIEW_ID); } catch {}
    try { window.zion?.commands?.executeCommand?.("tools.openFiles"); } catch {}
  } catch (e) {
    try { window.zion?.notification?.show?.(e?.message || String(e), { type: "error", duration: 2000 }); } catch {}
  }
}

function shortId(value) {
  const text = String(value || "");
  if (text.length <= 10) return text;
  return `${text.slice(0, 6)}...${text.slice(-3)}`;
}

function formatNumber(n) {
  return new Intl.NumberFormat().format(Number(n || 0));
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}
