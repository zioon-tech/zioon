import { createElement } from "react";
import { runStream } from "./chat-service.js";
import {
  DEFAULT_REASONING_CONTENT_PLACEHOLDER,
  normalizeToolCallsReasoningContentMode,
  shouldForceReasoningContentWithToolCalls
} from "./reasoning-policy.js";
import { deepseekProvider } from "./deepseek-provider.js";
import { claudeProvider } from "./claude-provider.js";
import { geminiProvider } from "./gemini-provider.js";
import { userModelsProvider } from "./user-models-provider.js";
import { installModelSwitcher } from "./model-switcher.js";
import { registerModelsTools } from "./models-tools.js";
import { createChatOverviewRail } from "./overview-rail.js";
import { ModelsSettingsPage } from "./ModelsSettingsPage.jsx";
import {
  appendAssistantToken as appendAssistantTokenToEditor,
  ensureTrailingUserPromptInDocText,
  finalizeAssistantBlock,
  insertAssistantBlock,
  parseMessages
} from "../../src/chat/doc";
import { createChatRuntime } from "../../src/chat/runtime";

const I18N_NS = "dev.langchain-chat";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.chat": "聊天",
    "category.models": "模型",
    "cmd.runSelection": "运行聊天（选中内容）",
    "cmd.run": "运行聊天",
    "cmd.stop": "停止聊天",
    "cmd.retry": "重试聊天",
    "settings.models.title": "模型",
    "settings.models.description": "管理模型提供商与默认模型",
    "settings.models.section": "模型",
    "settings.models.label": "模型",
    "slash.chat.title": "聊天",
    "slash.chat.description": "使用当前上下文运行聊天",
    "slash.chatSelection.title": "聊天（选中内容）",
    "slash.chatSelection.description": "使用当前选中内容运行聊天",
    "slash.stop.title": "停止聊天",
    "slash.stop.description": "中止当前流式运行",
    "slash.retry.title": "重试聊天",
    "slash.retry.description": "使用上一次提示重新运行",
    "slash.selectModel.title": "选择模型",
    "slash.selectModel.description": "选择一个模型",
    "slash.openModelSwitcher.title": "打开模型切换器",
    "slash.openModelSwitcher.description": "打开模型切换面板",
    "slash.setActiveModel.title": "设置当前模型",
    "slash.model.label": "模型",
    "status.model": "模型：{label}",
    "status.runFinishedSound": "结束提示音",
    "modelSwitcher.title": "选择模型",
    "modelSwitcher.add": "添加",
    "modelSwitcher.addModel": "添加模型",
    "modelSwitcher.search": "搜索模型...",
    "modelSwitcher.footer": "Enter：选择 • Esc：关闭 • ↑↓：导航",
    "modelSwitcher.noModels": "未找到模型",
    "modelSwitcher.createFirst": "创建第一个模型",
    "modelSwitcher.edit": "编辑模型",
    "modelSwitcher.view": "查看模型（只读）",
    "modelSwitcher.delete": "删除模型",
    "modelSwitcher.missingUrlOrKey": "缺少 URL 或 Key",
    "modelSwitcher.testing": "测试中...",
    "modelSwitcher.timeout": "超时",
    "modelSwitcher.viewModel": "查看模型",
    "modelSwitcher.saveChanges": "保存更改",
    "modelSwitcher.saveModel": "保存模型",
    "modelSwitcher.test": "测试",
    "modelSwitcher.testConnectivity": "测试连通性",
    "modelSwitcher.save": "保存",
    "modelSwitcher.cancel": "取消",
    "modelSwitcher.missingModelId": "缺少 Model ID",
    "modelSwitcher.missingBaseUrl": "缺少 Base URL",
    "modelSwitcher.missingApiKey": "缺少 API Key",
    "modelSwitcher.deepseekSaved": "DeepSeek 配置已保存",
    "modelSwitcher.failedSave": "保存失败：{message}",
    "modelSwitcher.modelExists": "模型已存在：{id}",
    "modelSwitcher.saved": "已保存"
  },
  "en-US": {
    "category.chat": "Chat",
    "category.models": "Models",
    "cmd.runSelection": "Run Chat (Selection)",
    "cmd.run": "Run Chat",
    "cmd.stop": "Stop Chat",
    "cmd.retry": "Retry Chat",
    "settings.models.title": "Models",
    "settings.models.description": "Manage model providers and default model",
    "settings.models.section": "Models",
    "settings.models.label": "Models",
    "slash.chat.title": "Chat",
    "slash.chat.description": "Run chat with current context",
    "slash.chatSelection.title": "Chat (Selection)",
    "slash.chatSelection.description": "Run chat using current selection",
    "slash.stop.title": "Stop Chat",
    "slash.stop.description": "Abort current streaming run",
    "slash.retry.title": "Retry Chat",
    "slash.retry.description": "Re-run chat with the last prompt",
    "slash.selectModel.title": "Select Model",
    "slash.selectModel.description": "Pick a model",
    "slash.openModelSwitcher.title": "Open Model Switcher",
    "slash.openModelSwitcher.description": "Open the model switcher panel",
    "slash.setActiveModel.title": "Set Active Model",
    "slash.model.label": "Model",
    "status.model": "Model: {label}",
    "status.runFinishedSound": "Run Finished Sound",
    "modelSwitcher.title": "Select Model",
    "modelSwitcher.add": "Add",
    "modelSwitcher.addModel": "Add Model",
    "modelSwitcher.search": "Search models...",
    "modelSwitcher.footer": "Enter: select • Esc: close • ↑↓: navigate",
    "modelSwitcher.noModels": "No models found",
    "modelSwitcher.createFirst": "Create your first model",
    "modelSwitcher.edit": "Edit Model",
    "modelSwitcher.view": "View Model (read-only)",
    "modelSwitcher.delete": "Delete Model",
    "modelSwitcher.missingUrlOrKey": "Missing url or key",
    "modelSwitcher.testing": "Testing...",
    "modelSwitcher.timeout": "Timeout",
    "modelSwitcher.viewModel": "View Model",
    "modelSwitcher.saveChanges": "Save Changes",
    "modelSwitcher.saveModel": "Save Model",
    "modelSwitcher.test": "Test",
    "modelSwitcher.testConnectivity": "Test connectivity",
    "modelSwitcher.save": "Save",
    "modelSwitcher.cancel": "Cancel",
    "modelSwitcher.missingModelId": "Missing Model ID",
    "modelSwitcher.missingBaseUrl": "Missing Base URL",
    "modelSwitcher.missingApiKey": "Missing API Key",
    "modelSwitcher.deepseekSaved": "DeepSeek configuration saved",
    "modelSwitcher.failedSave": "Failed to save: {message}",
    "modelSwitcher.modelExists": "Model already exists: {id}",
    "modelSwitcher.saved": "Saved"
  }
};

function t(key, fallback, values) {
  try {
    const translated = window.zion?.i18n?.t?.(`${I18N_NS}.${key}`, values);
    if (translated && translated !== `${I18N_NS}.${key}`) return translated;
  } catch {}
  return fallback;
}

function findAssistantEndLineFromDoc(text, startLineHint = 0) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const roleHeadRe = /^\s*(system|user|assistant|tool)\s+/;
  let assistantLine = -1;
  for (let i = Math.max(0, startLineHint || 0); i < lines.length; i++) {
    if (/^\s*assistant\s+/.test(lines[i] || "")) {
      assistantLine = i;
      break;
    }
  }
  if (assistantLine < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*assistant\s+/.test(lines[i] || "")) {
        assistantLine = i;
        break;
      }
    }
  }
  if (assistantLine < 0) return null;
  let endLine = assistantLine;
  for (let i = assistantLine + 1; i < lines.length; i++) {
    if (roleHeadRe.test(lines[i] || "")) break;
    endLine = i;
  }
  return { assistantLine, endLine };
}

function ensureAssistantLatestVisible(editor, opts = {}) {
  try {
    const view = editor?.getView?.();
    const scrollDOM = view?.scrollDOM;
    const doc = view?.state?.doc;
    if (!view || !scrollDOM || !doc) return false;
    const range = findAssistantEndLineFromDoc(doc.toString(), opts.startLineHint || 0);
    if (!range) return false;
    const line = doc.line(Math.max(1, Math.min(doc.lines, range.endLine + 1)));
    const block = view.lineBlockAt(line.to);
    const margin = 24;
    const visibleBottom = scrollDOM.scrollTop + scrollDOM.clientHeight - margin;
    if (block.bottom <= visibleBottom) return false;
    const nextScrollTop = Math.max(0, block.bottom - scrollDOM.clientHeight + margin);
    try {
      const sessionId = opts.sessionId || null;
      if (sessionId) {
        window.zion?.state?.set?.(`chat.followSuppressUntil.${sessionId}`, Date.now() + 80);
      }
    } catch {}
    scrollDOM.scrollTop = nextScrollTop;
    return true;
  } catch {}
  return false;
}

function findTrailingUserPromptLineFromDoc(text, startLineHint = 0) {
  const assistantRange = findAssistantEndLineFromDoc(text, startLineHint);
  if (!assistantRange) return null;
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const targetLine = assistantRange.endLine + 1;
  if (targetLine < lines.length && /^\s*user\s+/.test(lines[targetLine] || "")) {
    return targetLine;
  }
  for (let i = targetLine; i < lines.length; i++) {
    if (/^\s*user\s+/.test(lines[i] || "")) return i;
    if (/^\s*(system|assistant|tool)\s+/.test(lines[i] || "")) break;
  }
  return null;
}

function ensureDocLineVisible(editor, lineIndex, opts = {}) {
  try {
    if (typeof lineIndex !== "number" || lineIndex < 0) return false;
    const view = editor?.getView?.();
    const scrollDOM = view?.scrollDOM;
    const doc = view?.state?.doc;
    if (!view || !scrollDOM || !doc) return false;
    const line = doc.line(Math.max(1, Math.min(doc.lines, lineIndex + 1)));
    const block = view.lineBlockAt(line.from);
    const margin = 24;
    const visibleTop = scrollDOM.scrollTop + margin;
    const visibleBottom = scrollDOM.scrollTop + scrollDOM.clientHeight - margin;
    let nextScrollTop = null;
    if (block.bottom > visibleBottom) {
      nextScrollTop = Math.max(0, block.bottom - scrollDOM.clientHeight + margin);
    } else if (block.top < visibleTop) {
      nextScrollTop = Math.max(0, block.top - margin);
    }
    if (nextScrollTop == null) return false;
    try {
      const sessionId = opts.sessionId || null;
      if (sessionId) {
        window.zion?.state?.set?.(`chat.followSuppressUntil.${sessionId}`, Date.now() + 80);
      }
    } catch {}
    scrollDOM.scrollTop = nextScrollTop;
    return true;
  } catch {}
  return false;
}

function ensureTrailingUserPromptVisible(editor, opts = {}) {
  try {
    const view = editor?.getView?.();
    const doc = view?.state?.doc;
    if (!view || !doc) return false;
    const userLine = findTrailingUserPromptLineFromDoc(doc.toString(), opts.startLineHint || 0);
    if (userLine == null) return false;
    return ensureDocLineVisible(editor, userLine, opts);
  } catch {}
  return false;
}

export async function activate(ctx) {
  try {
    const disp = window.zion.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  const RUN_FINISHED_SOUND_STATE_KEY = "chat.runFinishedSoundEnabled";
  const RUN_FINISHED_SOUND_LS_KEY = "zion.chat.runFinishedSoundEnabled";
  const llm = window.zion.llm || (window.zion.llm = {});
  const prevChatApi = window.zion.chat ? { ...window.zion.chat } : null;
  const prevRunStream = llm.runStream;
  llm.runStream = runStream;
  ctx.subscriptions.push({
    dispose() {
      try {
        if (window.zion?.llm?.runStream === runStream) {
          if (prevRunStream) window.zion.llm.runStream = prevRunStream;
          else delete window.zion.llm.runStream;
        }
      } catch {}
    }
  });

  // 注册模型提供者
  const dispProv = window.zion.models.registerProvider(deepseekProvider);
  ctx.subscriptions.push(dispProv);

  const dispClaudeProv = window.zion.models.registerProvider(claudeProvider);
  ctx.subscriptions.push(dispClaudeProv);

  const dispGeminiProv = window.zion.models.registerProvider(geminiProvider);
  ctx.subscriptions.push(dispGeminiProv);

  const dispUserProv = window.zion.models.registerProvider(userModelsProvider);
  ctx.subscriptions.push(dispUserProv);

  // 模型目录与激活模型状态
  async function refreshCatalog() {
    try {
      const ids = window.zion.models.listProviders() || [];
      const models = [];
      for (const pid of ids) {
        const prov = window.zion.models.getProvider(pid);
        if (!prov) continue;
        const list = await prov.list();
        for (const m of (list || [])) {
          // 检查是否需要配置
          let requiresConfig = false;
          let configHint = "";
          try {
            const cfg = await prov.resolve(m.id);
            if (cfg?._requiresConfig && (!cfg.key || !cfg.key.trim())) {
              requiresConfig = true;
              configHint = cfg._configHint || "需要配置 API key";
            }
          } catch {}
          
          models.push({ 
            providerId: pid, 
            id: m.id, 
            label: m.label || m.id,
            requiresConfig,
            configHint
          });
        }
      }
      window.zion.state.set("models.catalog", models);
    } catch (e) {
      console.warn("[langchain-chat] refreshCatalog error", e);
    }
  }
  function getResolvedModelSnapshot(source) {
    const active = source || window.zion?.state?.get?.("chat.activeModel") || { providerId: "deepseek", modelId: "deepseek-chat" };
    const providerId = String(active?.providerId || "deepseek");
    const modelId = String(active?.modelId || "deepseek-chat");
    const catalog = window.zion?.state?.get?.("models.catalog") || [];
    const item = Array.isArray(catalog)
      ? catalog.find((m) => m.providerId === providerId && m.id === modelId)
      : null;
    return {
      providerId,
      modelId,
      label: String(active?.label || item?.label || modelId)
    };
  }
  function ensureActiveModel() {
    const active = window.zion.state.get("chat.activeModel");
    if (!active) {
      let restored = null;
      try {
        const raw = localStorage.getItem("zion.chat.defaultModel") || "";
        if (raw) {
          try {
            const j = JSON.parse(raw);
            if (j?.providerId && j?.modelId) restored = { providerId: String(j.providerId), modelId: String(j.modelId) };
          } catch {
            const parts = String(raw).split(":");
            if (parts.length >= 2) restored = { providerId: parts[0], modelId: parts.slice(1).join(":") };
          }
        }
      } catch {}

      if (restored) {
        const catalog = window.zion.state.get("models.catalog") || [];
        const item = catalog.find((m) => m.providerId === restored.providerId && m.id === restored.modelId);
        if (item) {
          window.zion.state.set("chat.activeModel", { providerId: item.providerId, modelId: item.id, label: item.label || item.id });
          return;
        }
      }

      window.zion.state.set("chat.activeModel", { providerId: "deepseek", modelId: "deepseek-chat", label: "DeepSeek Chat" });
    }
  }
  await refreshCatalog();
  ensureActiveModel();

  const initStoredBool = (stateKey, lsKey, defaultValue = true) => {
    try {
      const existing = window.zion?.state?.get?.(stateKey);
      if (typeof existing === "boolean") return existing;
    } catch {}
    let next = defaultValue;
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw === "0" || raw === "false") next = false;
      else if (raw === "1" || raw === "true") next = true;
    } catch {}
    try { window.zion?.state?.set?.(stateKey, next); } catch {}
    return next;
  };
  initStoredBool(RUN_FINISHED_SOUND_STATE_KEY, RUN_FINISHED_SOUND_LS_KEY, true);

  ctx.subscriptions.push(
    window.zion.state.onDidChange("chat.activeModel", (nv) => {
      try {
        if (!nv?.providerId || !nv?.modelId) return;
        localStorage.setItem(
          "zion.chat.defaultModel",
          JSON.stringify({ providerId: String(nv.providerId), modelId: String(nv.modelId) })
        );
      } catch {}
    })
  );

  // 模型切换器装饰器（挂载面板）
  let modelSwitcher = null;
  const decSwitcher = window.zion.editor.registerDecorator({
    id: "dev.langchain-chat.model-switcher",
    apply() {
      modelSwitcher = installModelSwitcher();
      return { dispose() { modelSwitcher?.dispose?.(); modelSwitcher = null; } };
    }
  });
  ctx.subscriptions.push(decSwitcher);

  const decOverviewRail = window.zion.editor.registerDecorator({
    id: "dev.langchain-chat.overview-rail",
    apply(editor) {
      return createChatOverviewRail(editor);
    }
  });
  ctx.subscriptions.push(decOverviewRail);

  // 工具函数
  const resolveSessionContext = (opts = {}) => {
    try {
      const ctx = window.zion?.sessions?.resolveContext?.(opts);
      if (ctx) return ctx;
    } catch {}
    return null;
  };
  const getEd = (opts) => {
    const ctx = resolveSessionContext(opts);
    if (ctx?.editor) return ctx.editor;
    if (opts?.editor) return opts.editor;
    if (opts?.panelId) {
      const panelEd = window.zion?.panels?.getEditor?.(opts.panelId);
      if (panelEd) return panelEd;
    }
    const activePanelId = window.zion?.panels?.getActivePanelId?.();
    if (activePanelId) {
      const panelEd = window.zion?.panels?.getEditor?.(activePanelId);
      if (panelEd) return panelEd;
    }
    return window.zion?.window?.activeEditor;
  };

  const getSessionId = (opts) => {
    const ctx = resolveSessionContext(opts || {});
    if (ctx?.sessionId) return ctx.sessionId;
    if (opts?.editor?.sessionId) return opts.editor.sessionId;
    if (opts?.sessionId) return opts.sessionId;
    if (opts?.panelId) {
      const panelSid = window.zion?.panels?.list?.().find((p) => p.id === opts.panelId)?.activeTabId;
      if (panelSid) return panelSid;
    }
    const activePanelId = window.zion?.panels?.getActivePanelId?.();
    if (activePanelId) {
      const panelSid = window.zion?.panels?.list?.().find((p) => p.id === activePanelId)?.activeTabId;
      if (panelSid) return panelSid;
    }
    return window.zion?.state?.get("sessions.currentId");
  };
  const getPanelSessionId = (panelId) => {
    if (!panelId) return null;
    try {
      const sid = window.zion?.sessions?.getPanelSessionId?.(panelId);
      if (sid) return sid;
    } catch {}
    try {
      return window.zion?.panels?.list?.().find((panel) => panel.id === panelId)?.activeTabId || null;
    } catch {}
    return null;
  };
  const isEditorShowingSession = (editor, sid) => {
    if (!editor || !sid) return false;
    try {
      const ok = window.zion?.sessions?.isEditorShowingSession?.(editor, sid);
      if (typeof ok === "boolean") return ok;
    } catch {}
    const panelId = editor?.panelId || null;
    if (panelId) {
      return getPanelSessionId(panelId) === sid;
    }
    return getSessionId() === sid;
  };
  const runtime = createChatRuntime({
    state: window.zion.state,
    events: window.zion.events,
    getSessionId: () => getSessionId()
  });
  const getRunState = runtime.getRunState;
  const setRunState = runtime.setRunState;
  ctx.subscriptions.push(runtime);

  window.zion.chat = {
    ...(window.zion.chat || {}),
    run: (opts = {}) => doRun(opts),
    stop: (sid) => runtime.stopSession(sid),
    retry: (_sid) => doRun({}),
    isStreaming: (sid) => {
      const targetSid = sid || getSessionId();
      return !!runtime.getRunState(targetSid)?.streaming;
    },
    setActiveModel: (m) => {
      window.zion.state.set("chat.activeModel", m);
    },
    getActiveModel: () => window.zion.state.get("chat.activeModel") || null
  };
  ctx.subscriptions.push({
    dispose() {
      try {
        if (prevChatApi) window.zion.chat = prevChatApi;
      } catch {}
    }
  });

  let runFinishedAudioCtx = null;
  const playRunFinishedSound = async () => {
    if (!window.zion?.state?.get?.(RUN_FINISHED_SOUND_STATE_KEY)) return false;
    try {
      const Ctor = window.AudioContext || window["webkitAudioContext"];
      if (!Ctor) return false;
      if (!runFinishedAudioCtx || runFinishedAudioCtx.state === "closed") {
        runFinishedAudioCtx = new Ctor();
      }
      const audioCtx = runFinishedAudioCtx;
      if (audioCtx.state === "suspended") {
        try { await audioCtx.resume(); } catch {}
      }
      const startAt = audioCtx.currentTime + 0.01;
      const notes = [
        { freq: 880, duration: 0.07, delay: 0 },
        { freq: 1174.66, duration: 0.09, delay: 0.08 }
      ];
      for (const note of notes) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(note.freq, startAt + note.delay);
        gain.gain.setValueAtTime(0.0001, startAt + note.delay);
        gain.gain.linearRampToValueAtTime(0.028, startAt + note.delay + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + note.delay + note.duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(startAt + note.delay);
        osc.stop(startAt + note.delay + note.duration + 0.01);
      }
      return true;
    } catch (e) {
      console.warn("[langchain-chat] run finished sound failed:", e);
      return false;
    }
  };
  ctx.subscriptions.push({
    dispose() {
      try { runFinishedAudioCtx?.close?.(); } catch {}
      runFinishedAudioCtx = null;
    }
  });
  ctx.subscriptions.push(
    window.zion.events.on("chat/runFinished", () => {
      void playRunFinishedSound();
    })
  );
  // 简易工具执行器：支持外部注册与内置示例
  async function executeToolCall(call, sid) {
    const isAborted = () => !!getRunState(sid)?.aborted;

    // 立刻检查全局中断标志
    if (isAborted()) {
      return `Tool "${call.name}" execution aborted`;
    }

    // 优先使用状态总线里的处理器：{ [name]: (args) => Promise<string> | string }
    const handlers = window.zion?.state?.get("chat.toolHandlers") || {};
    if (handlers && typeof handlers[call.name] === "function") {
      try {
        const out = await handlers[call.name](call.args, {
          toolCallId: call.id,
          sessionId: sid,
          toolName: call.name
        });
        // 再次检查中断，避免在 handler 返回后继续处理
        if (isAborted()) {
          return `Tool "${call.name}" execution aborted`;
        }
        return typeof out === "string" ? out : JSON.stringify(out);
      } catch (e) {
        // 若已中断，优先返回中断信息
        if (isAborted()) return `Tool "${call.name}" execution aborted`;
        return `Tool "${call.name}" error: ${e?.message || String(e)}`;
      }
    }

    // 内置示例（同步/轻量异步逻辑）
    try {
      // 在耗时或可能抛错的逻辑处也确保检查中断（尽量快速返回）
      switch (call.name) {
        case "echo":
          return typeof call.args === "string" ? call.args : JSON.stringify(call.args);
        case "sum":
          if (isAborted()) return `Tool "${call.name}" execution aborted`;
          if (Array.isArray(call.args?.numbers)) {
            const s = call.args.numbers.reduce((a, b) => a + Number(b || 0), 0);
            return String(s);
          }
          return "Invalid args for sum: expected { numbers: number[] }";
        case "calculate":
          if (isAborted()) return `Tool "${call.name}" execution aborted`;
          if (call.args?.expression) {
            // 极简演示：仅允许数字与 + - * / ()
            const expr = String(call.args.expression);
            if (!/^[\d\+\-\*\/\.\(\)\s]+$/.test(expr)) return "Unsafe expression";
            // eslint-disable-next-line no-eval
            const res = eval(expr);
            return String(res);
          }
          return "Invalid args for calculate: expected { expression: string }";
        default:
          return `Unknown tool: ${call.name}`;
      }
    } catch (e) {
      if (isAborted()) return `Tool "${call.name}" execution aborted`;
      return `Tool "${call.name}" failed: ${e?.message || String(e)}`;
    }
  }

  function inferToolOk(toolName, result) {
    const tn = String(toolName || "").toLowerCase();
    const isEdit = tn === "edit" || tn === "fsedit";
    const isWrite = tn === "write" || tn === "fswrite";

    let obj = null;
    if (result != null && typeof result === "object") obj = result;
    if (!obj) {
      try {
        const parsed = JSON.parse(String(result ?? ""));
        if (parsed && typeof parsed === "object") obj = parsed;
      } catch {}
    }

    if (isEdit && obj && typeof obj.replaced === "number") return obj.replaced > 0;
    if (isWrite && obj && typeof obj.ok === "boolean") return obj.ok;
    if (isWrite && obj && typeof obj.success === "boolean") return obj.success;

    if (result == null) return null;
    if (typeof result === "object") {
      if (typeof result.ok === "boolean") return result.ok;
      if (typeof result.success === "boolean") return result.success;
      try {
        const s = JSON.stringify(result);
        result = s;
      } catch {
        return true;
      }
    }
    const text = String(result ?? "");
    const head = text.slice(0, 240).toLowerCase().trim();

    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object") {
        if (typeof obj.ok === "boolean") return obj.ok;
        if (typeof obj.success === "boolean") return obj.success;
      }
    } catch {}

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

  // 通用运行逻辑（含 Tool Calls 链式继续）
  const doRun = async (opts = {}) => {
    const ed = getEd(opts);
    if (!ed) {
      console.log("[langchain-chat] no active editor");
      return;
    }
    const panelId = opts?.panelId || ed?.panelId || null;
    // 确保已选择激活模型
    ensureActiveModel();
    const sid = getSessionId({ ...opts, panelId });
    if (!sid) {
      console.log("[langchain-chat] no target session");
      return;
    }
    const panelSessionId = panelId ? getPanelSessionId(panelId) : null;
    if (panelId && panelSessionId && sid !== panelSessionId) {
      console.warn("[langchain-chat] run aborted: target session does not match editor panel", { panelId, sid, panelSessionId });
      return;
    }
    const runModel = getResolvedModelSnapshot();
    const streaming = !!getRunState(sid)?.streaming;
    if (streaming) {
      console.log("[langchain-chat] already streaming in current session, abort");
      return; // 防止本会话并发；其他会话不受影响
    }

    const readScrollSnapshot = () => {
      try {
        const scrollDOM = ed?.getView?.()?.scrollDOM;
        if (!scrollDOM) return null;
        return {
          top: typeof scrollDOM.scrollTop === "number" ? scrollDOM.scrollTop : 0,
          left: typeof scrollDOM.scrollLeft === "number" ? scrollDOM.scrollLeft : 0
        };
      } catch {
        return null;
      }
    };
    const restoreScrollSnapshot = (snapshot) => {
      if (!snapshot) return;
      const apply = () => {
        try {
          const scrollDOM = ed?.getView?.()?.scrollDOM;
          if (!scrollDOM) return;
          scrollDOM.scrollTop = Math.max(0, snapshot.top || 0);
          scrollDOM.scrollLeft = Math.max(0, snapshot.left || 0);
        } catch {}
      };
      apply();
      try { requestAnimationFrame(apply); } catch {}
    };

    // 1. 获取当前光标位置
    const cursor = ed.getCursor();

    // 2. 组装 messages：从文档开始到光标位置的所有内容
    const fullDoc = ed.getValue();
    const lines = fullDoc.split("\n");
    const cursorLine = cursor.line;
    const contentBeforeCursor = lines.slice(0, cursorLine + 1).join("\n");

    // 解析角色块
    const baseMessages = parseMessages(contentBeforeCursor);
    if (baseMessages.length === 0) {
      window.zion.events.emit("chat/runError", { error: "No content to send" });
      console.log("[langchain-chat] no content, abort");
      return;
    }

    // 根据开关注入终端上下文（默认开启；显式关闭时不注入）
    try {
      let includeTerminal = window.zion?.state?.get("chat.includeTerminalContext");
      // 默认开启注入（若用户尚未显式设置）
      if (includeTerminal === undefined) {
        includeTerminal = true;
        try { window.zion?.state?.set("chat.includeTerminalContext", true); } catch {}
      }
      if (includeTerminal !== false) {
        // 若状态总线中暂时没有会话列表，主动获取一次，确保注入“所有会话信息”
        const readBase = () => {
          const st1 = window.zion?.state?.get("localTools.baseUrl");
          if (typeof st1 === "string" && st1.trim()) return st1.trim();
          try {
            const s = localStorage.getItem("zion.localTools.baseUrl") || localStorage.getItem("zion.localSearch.baseUrl") || "";
            if (s) return s.trim();
          } catch {}
          return "http://127.0.0.1:8765";
        };
        let sessions = window.zion?.state?.get("terminal.sessions");
        if (!Array.isArray(sessions) || sessions.length === 0) {
          try {
            const base = readBase().replace(/\/$/, "");
            const resp = await fetch(`${base}/sessions`, { method: "GET" });
            const j = await resp.json().catch(() => null);
            if (resp.ok && j && Array.isArray(j.sessions)) {
              sessions = j.sessions;
              try { window.zion?.state?.set("terminal.sessions", sessions); } catch {}
            } else {
              sessions = Array.isArray(sessions) ? sessions : [];
            }
          } catch {
            sessions = Array.isArray(sessions) ? sessions : [];
          }
        }
        const activeId = window.zion?.state?.get("terminal.activeSessionId") || null;
        const ctxObj = { activeSessionId: activeId, sessions };
        const text = `Terminal Context\n${JSON.stringify(ctxObj, null, 2)}`;
        baseMessages.unshift({ role: "system", content: text });
      }
    } catch {}

    // 解析工具定义（委托给独立 tools 插件）
    const tools = window.zion?.commands?.executeCommand("tools.parseFromContent", contentBeforeCursor) || null;

    // 3. 插入 assistant 块（用于承载输出）
    const beforeInsertScroll = readScrollSnapshot();
    const { anchor, insertLine } = insertAssistantBlock(ed, {
      sessionId: sid,
      state: window.zion.state,
      cursor
    });
    restoreScrollSnapshot(beforeInsertScroll);

    // 4. 状态 & 事件
    const runId = "run_" + Math.random().toString(36).slice(2);
    runtime.beginRun(sid, runId);
    setRunState(sid, { aborted: false, model: runModel });
    try { window.zion?.state?.set?.(`chat.followLatest.${sid}`, true); } catch {}
    const followInsertedAssistant = window.zion?.state?.get?.(`chat.followLatest.${sid}`) !== false;
    if (followInsertedAssistant) {
      const syncInsertedAssistantVisibility = () => {
        try {
          window.zion?.state?.set?.(`chat.followSuppressUntil.${sid}`, Date.now() + 500);
        } catch {}
        ensureAssistantLatestVisible(ed, { startLineHint: insertLine, sessionId: sid });
        try {
          window.zion?.state?.set?.(`chat.followLatest.${sid}`, true);
        } catch {}
      };
      try {
        requestAnimationFrame(() => requestAnimationFrame(syncInsertedAssistantVisibility));
      } catch {
        setTimeout(syncInsertedAssistantVisibility, 0);
      }
    }
    window.zion.events.emit("chat/runStarted", { runId, sessionId: sid, panelId, model: runModel });

    // 工具调用收集（多步链式调用在每一步内局部收集）
    let aborted = false;
    // 每会话中断标志
    setRunState(sid, { aborted: false });

    // 通用 token 写入逻辑（写入同一个 assistant block，批量 flush 以降低刷新压力）
    // TokenBuffer：30ms 批量写入，同一行追加，触底才自动滚动
    const tokenBuffer = (() => {
      let acc = [];
      let timer = null;
      const interval = 30; // ms

      const flushImpl = () => {
        timer = null;
        if (acc.length === 0) return;
        const text = acc.join("");
        acc = [];
        if (!getRunState(sid)?.streaming) return;

        const editorShowingSession = isEditorShowingSession(ed, sid);
        if (!editorShowingSession) {
          try {
            window.zion.commands.executeCommand("zion.sessions.appendAssistantToken", { id: sid, token: text, runId });
            window.zion.events.emit("chat/token", { runId, token: text, sessionId: sid, panelId });
          } catch (e) {
            console.error("[langchain-chat] background append token error:", e);
          }
          return;
        }

        try {
          const appended = appendAssistantTokenToEditor(ed, {
            token: text,
            anchor,
            startLineHint: insertLine
          });
          if (!appended) return;
          window.zion.events.emit("chat/token", { runId, token: text, sessionId: sid, panelId });

          // 触底才自动滚动（避免用户上拉时被抢滚）
          const scroller = ed?.getView?.()?.scrollDOM || document.querySelector(".cm-scroller");
          if (scroller) {
            const followLatest = window.zion?.state?.get?.(`chat.followLatest.${sid}`) !== false;
            if (followLatest) {
              ensureAssistantLatestVisible(ed, { startLineHint: insertLine, sessionId: sid });
            }
          }
        } catch (e) {
          console.error("[langchain-chat] append token batch error:", e);
        }
      };

      return {
        push(tk) {
          acc.push(tk);
          if (!timer) timer = setTimeout(flushImpl, interval);
        },
        flush() {
          if (timer) { clearTimeout(timer); timer = null; }
          flushImpl();
        },
        stop() {
          if (timer) { clearTimeout(timer); timer = null; }
          acc = [];
        }
      };
    })();

    const appendToken = (tk) => {
      tokenBuffer.push(tk);
    };

    // 在最终阶段追加换行并清理（先 flush 剩余缓冲）
    const finalize = () => {
      try { tokenBuffer.flush(); } catch {}
      let autoInsert = window.zion?.state?.get('chat.autoInsertUserPrompt');
      if (autoInsert === undefined) {
        autoInsert = true;
        try { window.zion?.state?.set('chat.autoInsertUserPrompt', true); } catch {}
      }
      let autoFocus = window.zion?.state?.get('chat.autoFocusUserPrompt');
      if (autoFocus === undefined) {
        autoFocus = true;
        try { window.zion?.state?.set('chat.autoFocusUserPrompt', true); } catch {}
      }
      const editorShowingSession = isEditorShowingSession(ed, sid);
      if (editorShowingSession) {
        try {
          finalizeAssistantBlock(ed, {
            anchor,
            startLineHint: insertLine,
            autoInsertUserPrompt: !!autoInsert,
            autoFocusUserPrompt: !!autoFocus
          });
          const followLatest = window.zion?.state?.get?.(`chat.followLatest.${sid}`) !== false;
          if (followLatest) {
            const syncUserPromptVisibility = () => {
              ensureTrailingUserPromptVisible(ed, { startLineHint: insertLine, sessionId: sid });
            };
            try {
              requestAnimationFrame(() => requestAnimationFrame(syncUserPromptVisibility));
            } catch {
              setTimeout(syncUserPromptVisibility, 0);
            }
          }
        } catch {}
      } else {
        try {
          const currentDoc = String(window.zion.commands.executeCommand("zion.sessions.getDoc", sid) || "");
          const finalized = ensureTrailingUserPromptInDocText(currentDoc, {
            startLineHint: insertLine,
            autoInsertUserPrompt: !!autoInsert
          });
          if (finalized.text !== currentDoc) {
            window.zion.commands.executeCommand("zion.sessions.setDoc", { id: sid, text: finalized.text });
          }
        } catch {}
      }
      tokenBuffer.stop();
      runtime.markAwaiting(sid);
      window.zion.commands.executeCommand("zion.sessions.bumpUpdatedAt", sid);
      window.zion.events.emit("chat/runFinished", { runId, sessionId: sid, panelId });
    };

    // 单步调用（收集本步工具调用并执行，返回本步的调用与结果）
    const runStep = async (msgs) => {
      if (aborted || getRunState(sid)?.aborted) return { calls: [], results: [] };
      const calls = [];
      const resultsById = new Map();
      const promises = [];

      let stepReasoning = "";

      const streamResult = await runStream({
        messages: msgs,
        tools,
        activeModel: runModel,
        onToken: appendToken,
        beforeControlEvent: () => {
          try { tokenBuffer.flush(); } catch {}
        },
        onToolCall: (tc) => {
          if (aborted || getRunState(sid)?.aborted) return;
          try { tokenBuffer.flush(); } catch {}
          // 收集本步的 assistant tool_calls
          calls.push({ id: tc.id, name: tc.name, args: tc.args });
          // 执行工具并收集结果
          window.zion.events.emit("chat/toolCall", { runId, toolCall: tc, sessionId: sid, panelId });
          const p = executeToolCall(tc, sid)
            .then(res => {
              if (aborted || getRunState(sid)?.aborted) return;
              const content = String(res || "");
              resultsById.set(tc.id, { id: tc.id, content });
              const ok = inferToolOk(tc.name, res);
              window.zion.events.emit("chat/toolResult", { runId, toolCallId: tc.id, result: res, ok, sessionId: sid, panelId });
            })
            .catch(err => {
              if (aborted || getRunState(sid)?.aborted) return;
              const msg = `Tool "${tc.name}" failed: ${err?.message || String(err)}`;
              resultsById.set(tc.id, { id: tc.id, content: msg });
              window.zion.events.emit("chat/toolResult", { runId, toolCallId: tc.id, result: msg, ok: false, sessionId: sid, panelId });
            });
          promises.push(p);
        },
        onEnd: () => { /* 中间步骤不清理，留到链式结束后统一 finalize */ },
        onError: (e) => {
          if (e?.name === "AbortError") { aborted = true; runtime.markAborted(sid); return; }
          window.zion.state.set("chat.error", e.message);
          window.zion.events.emit("chat/runError", { runId, error: e, sessionId: sid, panelId });
          // 显示错误通知
          try {
            window.zion.notification.show(`大模型回答出错: ${e?.message || String(e)}`, {
              type: 'error',
              duration: 6000
            });
          } catch (err) {
            console.error('[langchain-chat] failed to show error notification:', err);
          }
          aborted = true;
          runtime.markError(sid, e);
        },
        getController: (controller) => {
          runtime.setController(sid, controller);
        },
        runId,
        sessionId: sid,
        panelId
      });

      stepReasoning = String(streamResult?.reasoning_content || "");

      // 等待工具执行完成，确保生成 tool 结果
      if (promises.length > 0) {
        try { await Promise.allSettled(promises); } catch {}
      }

      const results = calls
        .map((call) => resultsById.get(call.id))
        .filter(Boolean);
      if (aborted || getRunState(sid)?.aborted) return { calls: [], results: [], reasoning_content: stepReasoning };
      return { calls, results, reasoning_content: stepReasoning };
    };

    try {
      // 多步链式：直到本步不再产生 tool_calls 为止
      let msgs = baseMessages;

      // 在进入链式调用之前，运行消息贡献者（如 Skills），以便按需注入 System 指令（渐进式披露）
      if (window.zion?.__runMessageContributors) {
        try {
          let dbgCompression = false;
          try {
            dbgCompression = !!window.zion?.state?.get?.('compression.settings')?.debugLogging;
          } catch {}
          const beforeCount = Array.isArray(msgs) ? msgs.length : 0;
          if (dbgCompression) {
            console.log('[langchain-chat]', 'run contributors: pre (before send)', { stage: 'pre', messages: beforeCount });
          }
          msgs = await window.zion.__runMessageContributors(msgs, "pre");
          if (dbgCompression) {
            const afterCount = Array.isArray(msgs) ? msgs.length : 0;
            console.log('[langchain-chat]', 'run contributors: pre done', { stage: 'pre', beforeMessages: beforeCount, afterMessages: afterCount });
          }
        } catch (e) {
          console.warn("[langchain-chat] pre contributors error:", e);
        }
      }

      // 根据“发起会话位置（光标）上方”的内容，按编辑器顺序把历史工具调用插入到对应的 assistant 消息之后
      if (window.zion?.state?.get("chat.includeToolHistory") || window.zion?.state?.get("chat.includeThinkingHistory")) {
        try {
          const active = runModel;
          let preservedThinking = false;
          try {
            const prov = window.zion?.models?.getProvider?.(active?.providerId);
            const cfg = await prov?.resolve?.(active?.modelId);
            preservedThinking = !!cfg?.preservedThinking;
          } catch {}

          const stripLeadingOmitted = (s) => {
            const raw = String(s || "");
            const trimmedStart = raw.replace(/^\s+/, "");
            const lower = trimmedStart.toLowerCase();
            const candidates = ["[reasoning omitted]", "reasoning_omitted", "reasoning omitted", "[reasoning_omitted]"];
            for (const c of candidates) {
              if (lower.startsWith(c)) {
                return trimmedStart.slice(c.length).replace(/^\s+/, "");
              }
            }
            return raw;
          };
          const mode = normalizeToolCallsReasoningContentMode(window.zion?.state?.get?.("chat.toolCallsReasoningContentMode"));
          const forceReasoning = shouldForceReasoningContentWithToolCalls({ mode, modelId: active?.modelId, modelName: active?.modelId });

          const ann = window.zion?.commands?.executeCommand?.("zion.chatCards.getSessionAnnotations", sid) || {};
          const limitPos = contentBeforeCursor.length;

          // tools (must have both call and result to satisfy API constraints)
          const itemsToolsRaw = Array.isArray(ann.tools) ? ann.tools : [];
          const deleted = new Set(Array.isArray(ann.deletedToolIds) ? ann.deletedToolIds : []);
          const itemsTools = itemsToolsRaw
            .filter(it => it && it.id && !deleted.has(it.id))
            .filter(it => typeof it.from === "number" && it.from >= 0 && it.from < limitPos)
            .filter(it => it.name && it.args && it.result != null)
            .sort((a, b) => (a.from || 0) - (b.from || 0));

          // thinking
          const itemsThinkingRaw = Array.isArray(ann.thinking) ? ann.thinking : [];
          const deletedThinking = new Set(Array.isArray(ann.deletedThinkingIds) ? ann.deletedThinkingIds : []);
          const itemsThinking = itemsThinkingRaw
            .filter(it => it && it.id && !deletedThinking.has(it.id))
            .filter(it => typeof it.from === "number" && it.from >= 0 && it.from < limitPos)
            .filter(it => typeof it.text === "string" && it.text.trim().length > 0)
            .sort((a, b) => (a.from || 0) - (b.from || 0));

          // Build role ranges to locate assistant blocks within contentBeforeCursor
          const buildRanges = (text) => {
            const lines = String(text || "").replace(/\r/g, "").split("\n");
            const ranges = [];
            let pos = 0;
            let startPos = 0;
            let currentRole = "user";
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              const trimmed = line.trim();
              // Skip widget stubs (e.g., "思考", "调用 read")
              if (/^(思考|Thinking)$/i.test(trimmed)) {
                pos += line.length + 1;
                continue;
              }
              if (/^(调用|Call)\s+\S+$/i.test(trimmed)) {
                pos += line.length + 1;
                continue;
              }
              const m = line.match(/^(system|user|assistant)\s+(.*)$/);
              if (m) {
                // If the body is a widget stub, treat as part of previous range
                const body = m[2].trim();
                if (/^(思考|Thinking|调用|Call)\s*/i.test(body)) {
                  pos += line.length + 1;
                  continue;
                }
                if (pos > startPos) {
                  ranges.push({ role: currentRole, from: startPos, to: pos });
                }
                currentRole = m[1];
                startPos = pos;
              }
              pos += line.length + 1;
            }
            if (pos > startPos) ranges.push({ role: currentRole, from: startPos, to: pos });
            return ranges;
          };

          const ranges = buildRanges(contentBeforeCursor);
          const assistantRanges = ranges.filter(r => r.role === "assistant");
          const assistantMsgIdxs = [];
          for (let i = 0; i < msgs.length; i++) {
            if (msgs[i]?.role === "assistant") assistantMsgIdxs.push(i);
          }

          // group ordered units per assistant message index
          const groups = new Map(); // idx -> Array<{ pos:number, kind:'tool'|'thinking', data:any }>
          const findAssistantIndexForPos = (p) => {
            for (let i = 0; i < assistantRanges.length; i++) {
              const r = assistantRanges[i];
              if (p >= r.from && p < r.to) {
                return assistantMsgIdxs[i] ?? -1;
              }
            }
            let fallback = -1;
            for (let i = 0; i < assistantRanges.length; i++) {
              if (assistantRanges[i].to <= p) fallback = assistantMsgIdxs[i] ?? -1;
            }
            return fallback;
          };

          // collect tool units
          if (window.zion?.state?.get("chat.includeToolHistory") && itemsTools.length) {
            for (const it of itemsTools) {
              const idx = findAssistantIndexForPos(it.from);
              if (idx < 0) continue;
              const arr = groups.get(idx) || [];
              arr.push({
                pos: it.from,
                kind: "tool",
                data: {
                  id: it.id,
                  name: it.name,
                  args: it.args,
                  result: String(it.result)
                }
              });
              groups.set(idx, arr);
            }
          }

          // collect thinking units
          if (window.zion?.state?.get("chat.includeThinkingHistory") && itemsThinking.length) {
            for (const it of itemsThinking) {
              const idx = findAssistantIndexForPos(it.from);
              if (idx < 0) continue;
              const arr = groups.get(idx) || [];
              arr.push({
                pos: it.from,
                kind: "thinking",
                data: { content: String(it.text || "") }
              });
              groups.set(idx, arr);
            }
          }

          // write back maintaining editor order:
          // for each assistant idx, insert units sorted by pos:
          // - thinking: insert an assistant message with content
          // - tool: insert an assistant message with single tool_call, then immediately the corresponding tool message
          if (groups.size > 0) {
            const sortedIdxs = Array.from(groups.keys()).sort((a, b) => a - b);
            let offset = 0;
            for (const baseIdx of sortedIdxs) {
              const idx = baseIdx + offset;
              const units = (groups.get(baseIdx) || []).slice().sort((a, b) => (a.pos || 0) - (b.pos || 0));
              let localInserted = 0;
              for (const unit of units) {
                if (unit.kind === "thinking") {
                  if (preservedThinking) {
                    const base = msgs[idx];
                    if (base && base.role === "assistant") {
                      const prevRaw = typeof base.reasoning_content === "string" ? base.reasoning_content : "";
                      const prev = stripLeadingOmitted(prevRaw);
                      const next = String(unit.data.content || "");
                      base.reasoning_content = prev ? `${prev}\n\n${next}` : next;
                    }
                  } else {
                    // assistant text in order
                    msgs.splice(idx + 1 + localInserted, 0, { role: "assistant", content: unit.data.content });
                    localInserted += 1;
                    offset += 1;
                  }
                } else if (unit.kind === "tool") {
                  // assistant tool_calls block followed immediately by its tool result
                  const tc = {
                    id: unit.data.id,
                    type: "function",
                    function: { name: unit.data.name, arguments: JSON.stringify(unit.data.args || {}) }
                  };
                  const aMsg = { role: "assistant", tool_calls: [tc] };
                  if (forceReasoning) aMsg.reasoning_content = DEFAULT_REASONING_CONTENT_PLACEHOLDER;
                  msgs.splice(idx + 1 + localInserted, 0, aMsg);
                  msgs.splice(idx + 2 + localInserted, 0, { role: "tool", tool_call_id: unit.data.id, content: unit.data.result });
                  localInserted += 2;
                  offset += 2;
                }
              }
            }
          }
        } catch {}
      }

      while (true) {
        if (window.zion?.__runMessageContributors) {
          try {
            let dbgCompression = false;
            try {
              dbgCompression = !!window.zion?.state?.get?.('compression.settings')?.debugLogging;
            } catch {}
            const beforeCount = Array.isArray(msgs) ? msgs.length : 0;
            if (dbgCompression) {
              console.log('[langchain-chat]', 'run contributors: post (before step)', { stage: 'post', messages: beforeCount });
            }
            msgs = await window.zion.__runMessageContributors(msgs, "post");
            if (dbgCompression) {
              const afterCount = Array.isArray(msgs) ? msgs.length : 0;
              console.log('[langchain-chat]', 'run contributors: post done', { stage: 'post', beforeMessages: beforeCount, afterMessages: afterCount });
            }
          } catch (e) {
            console.warn("[langchain-chat] post contributors error:", e);
          }
        }

        const step = await runStep(msgs);
        if (aborted || getRunState(sid)?.aborted) { finalize(); return; }

        // 若本步产生了工具调用与结果，则构造下一步消息继续
        if (step.calls.length > 0) {
          const active = runModel;
          const mode = normalizeToolCallsReasoningContentMode(window.zion?.state?.get?.("chat.toolCallsReasoningContentMode"));
          const forceReasoning = shouldForceReasoningContentWithToolCalls({ mode, modelId: active?.modelId, modelName: active?.modelId });

          const assistantToolCalls = step.calls.map(tc => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) }
          }));
          const toolMsgs = step.results.map(tr => ({
            role: "tool",
            tool_call_id: tr.id,
            content: tr.content
          }));

          const assistantMsg = { role: "assistant", tool_calls: assistantToolCalls };
          if (step.reasoning_content || forceReasoning) {
            assistantMsg.reasoning_content = step.reasoning_content || DEFAULT_REASONING_CONTENT_PLACEHOLDER;
          }

          msgs = [
            ...msgs,
            assistantMsg,
            ...toolMsgs
          ];
          // 继续下一步
          continue;
        }

        // 无新的工具调用，结束链式
        break;
      }

      // 全流程结束
      finalize();
    } catch (e) {
      console.error("[langchain-chat] runStream outer error:", e);
      finalize();
    }
  };

  // 注册命令（完全复用现有 ID）
  const cmds = [
    window.zion.commands.registerCommand("chat.runSelection", (opts) => doRun({ ...opts, useSelection: true })),
    window.zion.commands.registerCommand("chat.run", (opts) => doRun(opts || {})),
    window.zion.commands.registerCommand("chat.stop", (sid) => {
      const targetSid = sid || (() => {
        const activePanelId = window.zion?.panels?.getActivePanelId?.();
        if (activePanelId) {
          return window.zion?.panels?.list?.().find((p) => p.id === activePanelId)?.activeTabId || null;
        }
        return null;
      })();
      return runtime.stopSession(targetSid || undefined);
    }),
    window.zion.commands.registerCommand("chat.retry", (opts) => doRun(opts || {}))
  ];
  ctx.subscriptions.push(...cmds);

  const toggleStateBool = (key, defaultValue = true) => {
    let v = window.zion?.state?.get?.(key);
    if (v === undefined) v = defaultValue;
    const next = !v;
    try { window.zion?.state?.set?.(key, next); } catch {}
    try {
      window.zion?.notification?.show?.(`${key} = ${next}`, { type: 'info', duration: 2500 });
    } catch {}
    return next;
  };
  const setStoredStateBool = (key, lsKey, value, label = key) => {
    const next = !!value;
    try { localStorage.setItem(lsKey, next ? "1" : "0"); } catch {}
    try { window.zion?.state?.set?.(key, next); } catch {}
    try {
      window.zion?.notification?.show?.(`${label}${next ? "已开启" : "已关闭"}`, { type: "info", duration: 2500 });
    } catch {}
    return next;
  };

  const dispToggleAutoInsert = window.zion.commands.registerCommand('chat.toggleAutoInsertUserPrompt', () => {
    toggleStateBool('chat.autoInsertUserPrompt', true);
  });
  const dispToggleAutoFocus = window.zion.commands.registerCommand('chat.toggleAutoFocusUserPrompt', () => {
    toggleStateBool('chat.autoFocusUserPrompt', true);
  });
  const dispSetRunFinishedSound = window.zion.commands.registerCommand("chat.setRunFinishedSoundEnabled", (value) => {
    return setStoredStateBool(RUN_FINISHED_SOUND_STATE_KEY, RUN_FINISHED_SOUND_LS_KEY, value, "会话结束提示音");
  });
  const dispToggleRunFinishedSound = window.zion.commands.registerCommand("chat.toggleRunFinishedSound", () => {
    const cur = !!window.zion?.state?.get?.(RUN_FINISHED_SOUND_STATE_KEY);
    return window.zion.commands.executeCommand("chat.setRunFinishedSoundEnabled", !cur);
  });
  ctx.subscriptions.push(dispToggleAutoInsert, dispToggleAutoFocus, dispSetRunFinishedSound, dispToggleRunFinishedSound);

  const dSlashAutoInsert = window.zion.slash?.registerCommand?.({
    id: 'chat.toggleAutoInsertUserPrompt',
    trigger: ['autouser', 'auto.user', 'toggle.autouser'],
    title: '切换自动插入 user',
    description: '回答结束后自动插入下一行 user 角色前缀',
    category: 'chat',
    priority: 70,
    execute: () => window.zion.commands.executeCommand('chat.toggleAutoInsertUserPrompt')
  });
  const dSlashAutoFocus = window.zion.slash?.registerCommand?.({
    id: 'chat.toggleAutoFocusUserPrompt',
    trigger: ['autofocus', 'auto.focus', 'toggle.autofocus'],
    title: '切换自动聚焦 user',
    description: '自动插入 user 后是否把光标移动到 user 后',
    category: 'chat',
    priority: 69,
    execute: () => window.zion.commands.executeCommand('chat.toggleAutoFocusUserPrompt')
  });
  const dSlashRunFinishedSound = window.zion.slash?.registerCommand?.({
    id: "chat.toggleRunFinishedSound",
    trigger: ["endsound", "run.endsound", "toggle.endsound"],
    title: "切换结束提示音",
    description: "切换会话运行结束后的系统提示音",
    category: "chat",
    priority: 68,
    execute: () => window.zion.commands.executeCommand("chat.toggleRunFinishedSound")
  });
  if (dSlashAutoInsert) ctx.subscriptions.push(dSlashAutoInsert);
  if (dSlashAutoFocus) ctx.subscriptions.push(dSlashAutoFocus);
  if (dSlashRunFinishedSound) ctx.subscriptions.push(dSlashRunFinishedSound);

  try {
    const reg = window.zion?.__editorHeaderMenuRegistry;
    const disp = reg?.register?.({
      id: "dev.langchain-chat.runFinishedSound.headerMenu",
      title: t("status.runFinishedSound", "Run Finished Sound"),
      section: "Chat",
      order: 35,
      kind: "toggle",
      getChecked: () => !!window.zion.state.get(RUN_FINISHED_SOUND_STATE_KEY),
      onClick: () => window.zion.commands.executeCommand("chat.toggleRunFinishedSound")
    });
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  // 模型选择相关命令
  const dispListProviders = window.zion.commands.registerCommand("models.listProviders", () => {
    console.log("[models] providers:", window.zion.models.listProviders());
  });
  const dispListModels = window.zion.commands.registerCommand("models.listModels", async () => {
    await refreshCatalog();
    console.log("[models] catalog:", window.zion.state.get("models.catalog"));
  });
  const dispSelectModel = window.zion.commands.registerCommand("models.selectModel", (spec) => {
    if (!spec) return;
    const [providerId, modelId] = String(spec).split(":");
    if (!providerId || !modelId) return;
    const catalog = window.zion.state.get("models.catalog") || [];
    const item = catalog.find(m => m.providerId === providerId && m.id === modelId);
    window.zion.state.set("chat.activeModel", { providerId, modelId, label: item?.label || modelId });
  });
  const dispNextModel = window.zion.commands.registerCommand("models.selectNextModel", async () => {
    await refreshCatalog();
    const catalog = window.zion.state.get("models.catalog") || [];
    if (catalog.length === 0) return;
    const active = window.zion.state.get("chat.activeModel");
    const idx = catalog.findIndex(m => m.providerId === active?.providerId && m.id === active?.modelId);
    const next = catalog[(idx + 1) % catalog.length] || catalog[0];
    window.zion.state.set("chat.activeModel", { providerId: next.providerId, modelId: next.id, label: next.label });
  });
  const dispPrevModel = window.zion.commands.registerCommand("models.selectPrevModel", async () => {
    await refreshCatalog();
    const catalog = window.zion.state.get("models.catalog") || [];
    if (catalog.length === 0) return;
    const active = window.zion.state.get("chat.activeModel");
    const idx = catalog.findIndex(m => m.providerId === active?.providerId && m.id === active?.modelId);
    const prev = catalog[(idx - 1 + catalog.length) % catalog.length] || catalog[0];
    window.zion.state.set("chat.activeModel", { providerId: prev.providerId, modelId: prev.id, label: prev.label });
  });
  ctx.subscriptions.push(dispListProviders, dispListModels, dispSelectModel, dispNextModel, dispPrevModel);

  // 打开/关闭模型切换器
  const dispOpenSwitcher = window.zion.commands.registerCommand("models.openSwitcher", async () => {
    await refreshCatalog();
    if (modelSwitcher) modelSwitcher.open();
  });
  const dispCloseSwitcher = window.zion.commands.registerCommand("models.closeSwitcher", () => {
    modelSwitcher?.close?.();
  });
  ctx.subscriptions.push(dispListProviders, dispListModels, dispSelectModel, dispNextModel, dispPrevModel, dispOpenSwitcher, dispCloseSwitcher);

  // 注册快捷键
  const kbs = [
    window.zion.keybindings.register({ command: "chat.runSelection", key: "Mod-Enter", when: "editorFocus" }),
    window.zion.keybindings.register({ command: "chat.stop", key: "Escape", when: "editorFocus" }),
    window.zion.keybindings.register({ command: "chat.retry", key: "Mod-Shift-r", when: "editorFocus" }),
    window.zion.keybindings.register({ command: "models.openSwitcher", key: "Mod-Shift-m", when: "editorFocus" })
  ];
  ctx.subscriptions.push(...kbs);

  // 右键菜单
  if (window.zion.menus?.register) {
    const safeIdPart = (s) => encodeURIComponent(String(s)).replace(/%/g, "_");

    const modelCmdDisposables = new Map();
    const ensureModelCmd = (id, fn) => {
      if (modelCmdDisposables.has(id)) return;
      modelCmdDisposables.set(id, window.zion.commands.registerCommand(id, fn));
    };

    const runChatMenuItem = {
      command: "chat.run",
      title: t("cmd.run", "Run Chat"),
      when: "editorFocus",
      submenu: []
    };
    const selectModelMenuItem = {
      command: "models.openSwitcher",
      title: t("slash.selectModel.title", "Select Model") + "...",
      when: "editorFocus",
      submenu: []
    };

    const menuDisposables = [
      window.zion.menus.register("editor/context", runChatMenuItem),
      window.zion.menus.register("editor/context", selectModelMenuItem),
      window.zion.menus.register("editor/context", {
        command: "chat.stop",
        title: t("cmd.stop", "Stop Chat"),
        when: "editorFocus"
      }),
      window.zion.menus.register("editor/context", {
        command: "chat.retry",
        title: t("cmd.retry", "Retry Chat"),
        when: "editorFocus"
      })
    ];

    const buildModelMenuItems = (mode) => {
      const catalog = window.zion.state.get("models.catalog") || [];
      const active = window.zion.state.get("chat.activeModel");
      const keep = new Set();

      const items = catalog.map((m) => {
        const isActive = m.providerId === active?.providerId && m.id === active?.modelId;
        const label = m.label || m.id;
        const title = isActive ? `✓ ${label}` : label;
        const cmdId = `${mode}.${safeIdPart(m.providerId)}.${safeIdPart(m.id)}`;
        keep.add(cmdId);

        ensureModelCmd(cmdId, () => {
          window.zion.state.set("chat.activeModel", { providerId: m.providerId, modelId: m.id, label });
          if (mode === "chat.runDefaultWithModel") {
            window.zion.commands.executeCommand("chat.run");
          }
          return true;
        });

        return { command: cmdId, title, when: "editorFocus" };
      });

      for (const [id, disp] of modelCmdDisposables) {
        if (!id.startsWith(`${mode}.`)) continue;
        if (keep.has(id)) continue;
        try {
          disp?.dispose?.();
        } catch {}
        modelCmdDisposables.delete(id);
      }

      return items;
    };

    const rebuildContextMenu = () => {
      const active = window.zion.state.get("chat.activeModel");
      const defaultLabel = active?.label || active?.modelId || "unknown";
      runChatMenuItem.title = `${t("cmd.run", "Run Chat")} (${defaultLabel})`;
      runChatMenuItem.submenu = [];
      selectModelMenuItem.submenu = buildModelMenuItems("models.setDefaultModel");
    };

    rebuildContextMenu();
    ctx.subscriptions.push(
      ...menuDisposables,
      {
        dispose: () => {
          for (const [, disp] of modelCmdDisposables) {
            try {
              disp?.dispose?.();
            } catch {}
          }
          modelCmdDisposables.clear();
        }
      },
      window.zion.state.onDidChange("chat.activeModel", rebuildContextMenu),
      window.zion.state.onDidChange("models.catalog", rebuildContextMenu)
    );
  }

  // 状态栏 Model 按钮（动态展示与切换）
  let modelBtnDisp = null;
  const updateModelBtn = () => {
    const active = window.zion.state.get("chat.activeModel");
    const catalog = window.zion.state.get("models.catalog") || [];
    const activeItem = catalog.find(m => 
      m.providerId === active?.providerId && m.id === active?.modelId
    );
    
    let label = active?.label || active?.modelId || "unknown";
    let tooltip = "Select Model (Search / ↑↓ / PgUp/PgDn / Home/End / Enter / Esc)";
    
    if (activeItem?.requiresConfig) {
      label = `⚠️ ${label}`;
      tooltip = `${activeItem.configHint || "需要配置 API key"} - ${tooltip}`;
    }
    
    modelBtnDisp?.dispose?.();
    modelBtnDisp = window.zion.bottomStatusBar?.registerItem?.({
      id: "langchain.chat.model",
      text: t("status.model", "Model: {label}", { label }),
      tooltip,
      priority: 80,
      onClick: () => window.zion.commands.executeCommand("models.openSwitcher")
    }) || window.zion.editorHeaderMenu?.register?.({
      id: "langchain.chat.model",
      title: t("status.model", "Model: {label}", { label }),
      section: "Chat",
      order: 10,
      onClick: () => window.zion.commands.executeCommand("models.openSwitcher")
    }) || window.zion.statusBar.registerItem({
      id: "langchain.chat.model",
      text: t("status.model", "Model: {label}", { label }),
      tooltip,
      onClick: () => window.zion.commands.executeCommand("models.openSwitcher")
    });
  };
  updateModelBtn();
  ctx.subscriptions.push(
    window.zion.state.onDidChange("chat.activeModel", updateModelBtn),
    window.zion.state.onDidChange("models.catalog", updateModelBtn),
    window.zion.events.on("i18n/changed", updateModelBtn)
  );

  // Editor header Run/Stop button (only when this plugin is active)
  try {
    let btn = null;
    let streamingSub = null;
    let deferred = null;

    const ensureButton = () => {
      const headerEl = document.querySelector(".zion-editor-header");
      if (!headerEl) return null;
      if (headerEl.querySelector("button[data-zion-core-runstop-button='1']")) return null;

      const settingsBtn = headerEl.querySelector("button[data-zion-editor-settings-menu-button='1']");

      if (!btn || !btn.isConnected) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "zion-editor-header-action is-icon zion-editor-chat-runstop-button";
        btn.setAttribute("data-zion-langchain-runstop-button", "1");
        btn.setAttribute("aria-label", "Run/Stop");
        btn.onclick = (e) => {
          try { e.stopPropagation(); } catch {}
          try {
            const streaming = !!window.zion?.state?.get?.("chat.streaming");
            if (streaming) window.zion.commands.executeCommand("chat.stop");
            else {
              const ed = window.zion?.window?.activeEditor;
              const sel = String(ed?.getSelection?.() || "");
              if (sel.trim()) window.zion.commands.executeCommand("chat.runSelection");
              else window.zion.commands.executeCommand("chat.run");
            }
          } catch {}
        };
      }

      const update = () => {
        const streaming = !!window.zion?.state?.get?.("chat.streaming");
        btn.innerHTML = `<span class="codicon ${streaming ? "codicon-debug-stop" : "codicon-play"}" aria-hidden="true"></span>`;
        btn.title = streaming ? "Stop (Esc)" : "Run (Mod-Enter)";
        try { btn.classList.toggle("is-stop", streaming); } catch {}
      };
      update();

      if (settingsBtn) headerEl.insertBefore(btn, settingsBtn);
      else headerEl.appendChild(btn);

      return btn;
    };

    if (!ensureButton()) {
      deferred = window.setInterval(() => {
        if (ensureButton()) {
          try { window.clearInterval(deferred); } catch {}
          deferred = null;
        }
      }, 500);
    }

    try {
      streamingSub = window.zion.state.onDidChange("chat.streaming", () => {
        try {
          if (btn && btn.isConnected) {
            const streaming = !!window.zion?.state?.get?.("chat.streaming");
            btn.innerHTML = `<span class="codicon ${streaming ? "codicon-debug-stop" : "codicon-play"}" aria-hidden="true"></span>`;
            btn.title = streaming ? "Stop (Esc)" : "Run (Mod-Enter)";
            try { btn.classList.toggle("is-stop", streaming); } catch {}
          }
        } catch {}
      });
    } catch {}

    ctx.subscriptions.push({
      dispose: () => {
        try { streamingSub?.dispose?.(); } catch {}
        try { if (deferred) window.clearInterval(deferred); } catch {}
        try { btn?.remove?.(); } catch {}
        btn = null;
        streamingSub = null;
        deferred = null;
      }
    });
  } catch {}

  // 注册“模型管理”工具（CRUD + 设置激活）
  try { registerModelsTools(); } catch {}

  try {
    const settingsDisp = window.zion?.settings?.registerPage?.({
      id: "services.langchain-models",
      title: "Models",
      titleKey: "dev.langchain-chat.settings.models.title",
      description: "Manage model providers and default model",
      descriptionKey: "dev.langchain-chat.settings.models.description",
      category: "services",
      order: 30,
      pluginId: "dev.langchain-chat",
      keywords: ["models", "llm", "provider", "langchain", "deepseek", "claude", "gemini"],
      sections: [
        {
          id: "langchain.models.manage",
          title: "Models",
          titleKey: "dev.langchain-chat.settings.models.section",
          settings: [
            {
              id: "chat.models.manager",
              label: "Models",
              labelKey: "dev.langchain-chat.settings.models.label",
              kind: "custom",
              order: 10,
              renderCustom: () => createElement(ModelsSettingsPage)
            }
          ]
        }
      ]
    });
    if (settingsDisp) ctx.subscriptions.push(settingsDisp);
  } catch (e) {
    console.warn("[langchain-chat] failed to register settings page", e);
  }

  try {
    let installed = false;

    const installSlash = () => {
      if (installed) return true;
      const slash = window.zion?.slash;
      if (!slash || typeof slash.registerCommand !== "function") return false;

      const disp = [];

      disp.push(
        slash.registerCommand({
          id: "langchain.chat.run",
          trigger: ["chat", "ask"],
          title: t("slash.chat.title", "Chat"),
          description: t("slash.chat.description", "Run chat with current context"),
          category: t("category.chat", "chat"),
          icon: "💬",
          execute: () => window.zion.commands.executeCommand("chat.run")
        })
      );

      disp.push(
        slash.registerCommand({
          id: "langchain.chat.runSelection",
          trigger: ["chatSelection", "chatSel"],
          title: t("slash.chatSelection.title", "Chat (Selection)"),
          description: t("slash.chatSelection.description", "Run chat using current selection"),
          category: t("category.chat", "chat"),
          icon: "📝",
          execute: () => window.zion.commands.executeCommand("chat.runSelection")
        })
      );

      disp.push(
        slash.registerCommand({
          id: "langchain.chat.stop",
          trigger: ["stop", "stopChat"],
          title: t("slash.stop.title", "Stop Chat"),
          description: t("slash.stop.description", "Abort current streaming run"),
          category: t("category.chat", "chat"),
          icon: "⏹️",
          execute: () => window.zion.commands.executeCommand("chat.stop")
        })
      );

      disp.push(
        slash.registerCommand({
          id: "langchain.chat.retry",
          trigger: ["retry", "chatRetry"],
          title: t("slash.retry.title", "Retry Chat"),
          description: t("slash.retry.description", "Re-run chat with the last prompt"),
          category: t("category.chat", "chat"),
          icon: "🔁",
          execute: () => window.zion.commands.executeCommand("chat.retry")
        })
      );

      disp.push(
        slash.registerCommand({
          id: "langchain.models.pick",
          trigger: ["models", "model"],
          title: t("slash.selectModel.title", "Select Model"),
          description: t("slash.selectModel.description", "Pick a model"),
          category: t("category.models", "models"),
          icon: "🧠",
          submenu: async () => {
            await refreshCatalog().catch(() => {});
            const catalog = window.zion?.state?.get("models.catalog") || [];
            const active = window.zion?.state?.get("chat.activeModel");
            const items = (catalog || []).map((m) => {
              const providerId = String(m.providerId || "");
              const modelId = String(m.id || "");
              const label = String(m.label || modelId);
              const isActive = providerId === active?.providerId && modelId === active?.modelId;
              const suffix = m?.requiresConfig ? " (needs config)" : "";
              return {
                title: `${isActive ? "✓ " : ""}${label}${suffix}${providerId ? ` — ${providerId}` : ""}`,
                description: `${providerId}:${modelId}`,
                icon: m?.requiresConfig ? "⚠️" : "🧠",
                execute: () => {
                  window.zion.commands.executeCommand("models.selectModel", `${providerId}:${modelId}`);
                }
              };
            });

            items.sort((a, b) => {
              const ta = String(a.title || "").toLowerCase();
              const tb = String(b.title || "").toLowerCase();
              if (ta < tb) return -1;
              if (ta > tb) return 1;
              return String(a.description || "").localeCompare(String(b.description || ""));
            });

            return items;
          },
          execute: () => {}
        })
      );

      disp.push(
        slash.registerCommand({
          id: "langchain.models.openSwitcher",
          trigger: ["modelSwitcher"],
          title: t("slash.openModelSwitcher.title", "Open Model Switcher"),
          description: t("slash.openModelSwitcher.description", "Open the model switcher panel"),
          category: t("category.models", "models"),
          icon: "🧠",
          execute: () => window.zion.commands.executeCommand("models.openSwitcher")
        })
      );

      disp.push(
        slash.registerCommand({
          id: "langchain.models.select",
          trigger: ["modelSelect", "setModel"],
          title: t("slash.setActiveModel.title", "Set Active Model"),
          description: t("slash.selectModel.description", "Pick a model"),
          category: t("category.models", "models"),
          icon: "🧠",
          params: [
            {
              name: "model",
              type: "select",
              label: t("slash.model.label", "Model"),
              asyncOptions: async () => {
                await refreshCatalog().catch(() => {});
                const catalog = window.zion?.state?.get("models.catalog") || [];
                const active = window.zion?.state?.get("chat.activeModel");
                const out = (catalog || []).map((m) => {
                  const providerId = String(m.providerId || "");
                  const modelId = String(m.id || "");
                  const label = String(m.label || modelId);
                  const isActive = providerId === active?.providerId && modelId === active?.modelId;
                  const suffix = m?.requiresConfig ? " (needs config)" : "";
                  return {
                    value: `${providerId}:${modelId}`,
                    label: `${isActive ? "✓ " : ""}${label}${suffix} — ${providerId}`
                  };
                });

                out.sort((a, b) => String(a.label || "").localeCompare(String(b.label || "")));
                return out;
              }
            }
          ],
          execute: async (p) => {
            const key = p?.model ? String(p.model) : "";
            if (!key || !key.includes(":")) return;
            window.zion.commands.executeCommand("models.selectModel", key);
          }
        })
      );

      ctx.subscriptions.push(...disp);
      installed = true;
      return true;
    };

    if (!installSlash()) {
      let tries = 0;
      const timer = window.setInterval(() => {
        tries++;
        if (installSlash() || tries > 50) {
          window.clearInterval(timer);
        }
      }, 200);
      ctx.subscriptions.push({ dispose: () => window.clearInterval(timer) });
    }
  } catch {}
}
