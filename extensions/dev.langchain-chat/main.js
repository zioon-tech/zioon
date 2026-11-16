import { createElement } from "react";
import { runStream } from "./chat-service.js";
import { accountCan } from "../../packages/account-ui/src/client";
import {
  DEFAULT_REASONING_CONTENT_PLACEHOLDER,
  normalizeToolCallsReasoningContentMode,
  shouldForceReasoningContentWithToolCalls
} from "./reasoning-policy.js";
import {
  getThinkingEffortOptionLabel,
  getThinkingModeOptionLabel,
  getSupportedThinkingEfforts,
  inferThinkingCapability,
  inferThinkingEffortCapability,
  normalizeThinkingEffort,
  normalizeThinkingMode
} from "./model-config-fields.js";
import { deepseekProvider } from "./deepseek-provider.js";
import { claudeProvider } from "./claude-provider.js";
import { geminiProvider } from "./gemini-provider.js";
import { userModelsProvider } from "./user-models-provider.js";
import { installModelSwitcher } from "./model-switcher.js";
import { registerModelsTools } from "./models-tools.js";
import {
  findRuntimeModelProfile,
  invalidateRuntimeDynamicModelCache,
  loadLocalDynamicModelStore,
  loadRuntimeModelProfiles,
  mergeRuntimeModelProfileConfig,
  upsertDynamicModel
} from "./runtime-user-model-store.js";
import {
  loadProviderConfig,
  saveProviderConfigPatch
} from "./provider-config-storage.js";
import { createChatOverviewRail } from "./overview-rail.js";
import { ModelsSettingsPage } from "./ModelsSettingsPage.jsx";
import { buildContextWindowSnapshot } from "./context-health.js";
import {
  rebuildModelCatalog,
  startModelHealthMonitor
} from "./model-catalog.js";
import {
  appendAssistantToken as appendAssistantTokenToEditor,
  ensureTrailingUserPromptInDocText,
  finalizeAssistantBlock,
  insertAssistantBlock,
  parseMessages
} from "../../src/chat/doc";
import {
  beginConversationViewportFollow,
  isConversationViewportFollowing,
  scheduleConversationViewportFollow
} from "../../src/chat/conversation-viewport.js";
import { createChatRuntime } from "../../src/chat/runtime";
import { captureDocumentInput } from "../../src/chat/document-input";
import { reconstructWidgetHistoryMessages } from "../../src/chat/widget-history";
import { createToolCardId } from "../../src/chat/tool-card-id";
import { createProgrammaticExecutor } from "./programmatic-runner.js";
import {
  finalizeProgrammaticSession,
  projectRunEventToSession
} from "./programmatic-session.js";
import {
  abortInteractiveRuntimeRun,
  captureInteractiveRuntimeAccount,
  createInteractiveRuntimeHandle,
  includeTerminalContextForRuntime,
  interactiveRuntimeEligibility,
  listInteractiveRuntimeSupportedTools,
  observeInteractiveRuntimeRun,
  respondInteractiveRuntimeRun,
  persistInteractiveRuntimeProfileModel,
  prepareInteractiveRuntimeMessages,
  previewInteractiveRuntimeRequest,
  probeInteractiveRuntime,
  readInteractiveRuntimeConfig,
  resolveInteractiveRuntimeProfileModel,
  shouldUseInteractiveRuntime,
  syncWorkbenchModelProfiles
} from "./runtime-backend.js";
import { inferToolResultError } from "./tool-result-diagnostics.js";

function runtimeSkillsMetadata(state = globalThis.window?.zion?.state) {
  const catalog = state?.get?.("skills.catalog");
  const transientCatalog = (Array.isArray(catalog) ? catalog : [])
    .filter((skill) =>
      skill?.id
      && skill?.body
      && skill.transient === true
    )
    .map((skill) => ({
      id: String(skill.id),
      name: String(skill.name || skill.id),
      description: String(skill.description || ""),
      sourceNodeId: String(skill.sourceNodeId || ""),
      sourceNodeLabel: String(skill.sourceNodeLabel || ""),
      sourcePath: String(skill.sourcePath || skill.path || ""),
      sourceFile: String(skill.sourceFile || skill.file || ""),
      contentHash: String(skill.contentHash || ""),
      body: String(skill.body || ""),
      transient: true
    }));
  return {
    ...(transientCatalog.length ? { transientCatalog } : {})
  };
}

const I18N_NS = "dev.langchain-chat";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.chat": "聊天",
    "category.models": "模型",
    "cmd.runSelection": "运行聊天（选中内容）",
    "cmd.submit": "发送消息",
    "cmd.run": "从此处继续对话",
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
    "status.runtime": "Runtime",
    "status.runtimeOffline": "Runtime 离线",
    "status.browserRuntime": "浏览器模式",
    "status.tooltip.runtime": "Runtime 已连接：{url}",
    "status.tooltip.runtimeOffline": "Runtime 不可用：{url}",
    "status.tooltip.browserRuntime": "当前使用浏览器兼容模式",
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
    "modelSwitcher.runtimeCredentialStored": "凭证已安全保存在 Runtime；留空保持不变",
    "modelSwitcher.deepseekSaved": "DeepSeek 配置已保存",
    "modelSwitcher.failedSave": "保存失败：{message}",
    "modelSwitcher.modelExists": "模型已存在：{id}",
    "modelSwitcher.saved": "已保存",
    "modelSwitcher.provider": "提供方",
    "modelSwitcher.modelId": "模型 ID",
    "modelSwitcher.displayName": "显示名称",
    "modelSwitcher.description": "模型描述",
    "modelSwitcher.providerType": "接口类型",
    "modelSwitcher.baseUrl": "接口地址",
    "modelSwitcher.modelOverride": "模型名覆盖",
    "modelSwitcher.thinkingMode": "思考方式",
    "modelSwitcher.thinkingEffort": "思考强度",
    "modelSwitcher.stream": "流式返回",
    "modelSwitcher.supportsImage": "支持图片",
    "modelSwitcher.autoContinueOnColonMaxAttempts": "异常 Stop 续写次数",
    "modelSwitcher.autoContinueOnColonMaxAttempts.description": "DeepSeek 异常 stop 时最多自动续写多少次，包括冒号中断和只有推理、没有正式输出；设为 0 可关闭。",
    "modelSwitcher.openaiCompatible": "OpenAI 兼容",
    "modelSwitcher.editableSuffix": "（可编辑参数）",
    "modelSwitcher.readonlySuffix": "（只读）",
    "modelSwitcher.placeholder.modelId": "例如：deepseek-v4-flash",
    "modelSwitcher.placeholder.label": "例如：My Model",
    "modelSwitcher.placeholder.description": "模型定位、优势或适用场景",
    "modelSwitcher.placeholder.baseUrl": "例如：https://api.openai.com/v1/chat/completions",
    "modelSwitcher.placeholder.modelOverride": "可选，例如：gpt-4o-mini",
    "status.imageSupported": "图像",
    "status.imageUnsupported": "无图",
    "status.thinking.auto": "思考:自动",
    "status.thinking.off": "思考:关",
    "status.thinking.on": "思考:开",
    "status.thinking.none": "思考:无",
    "status.thinking.prefix": "思考",
    "status.tooltip.model": "模型: {label}",
    "status.tooltip.thinkingMode": "思考方式: {value}",
    "status.tooltip.thinkingEffort": "思考强度: {value}",
    "status.tooltip.thinkingCapability": "思考能力: {value}",
    "status.tooltip.effortCapability": "强度调节: {value}",
    "status.tooltip.imageInput": "图片输入: {value}",
    "status.tooltip.supported": "支持",
    "status.tooltip.unsupported": "不支持",
    "status.tooltip.unknown": "未知",
    "status.tooltip.unconfirmed": "未确认",
    "status.tooltip.openSwitcher": "点击模型项打开模型切换器。",
    "status.tooltip.cycleThinking": "点击切换思考开关；思考强度可在模型设置中调整。"
  },
  "en-US": {
    "category.chat": "Chat",
    "category.models": "Models",
    "cmd.runSelection": "Run Chat (Selection)",
    "cmd.submit": "Send Message",
    "cmd.run": "Continue Chat from Here",
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
    "status.runtime": "Runtime",
    "status.runtimeOffline": "Runtime offline",
    "status.browserRuntime": "Browser mode",
    "status.tooltip.runtime": "Runtime connected: {url}",
    "status.tooltip.runtimeOffline": "Runtime unavailable: {url}",
    "status.tooltip.browserRuntime": "Using browser compatibility mode",
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
    "modelSwitcher.runtimeCredentialStored": "Stored securely in Runtime; leave blank to keep",
    "modelSwitcher.deepseekSaved": "DeepSeek configuration saved",
    "modelSwitcher.failedSave": "Failed to save: {message}",
    "modelSwitcher.modelExists": "Model already exists: {id}",
    "modelSwitcher.saved": "Saved",
    "modelSwitcher.provider": "Provider",
    "modelSwitcher.modelId": "Model ID",
    "modelSwitcher.displayName": "Display Name",
    "modelSwitcher.description": "Model Description",
    "modelSwitcher.providerType": "Provider Type",
    "modelSwitcher.baseUrl": "Base URL",
    "modelSwitcher.modelOverride": "Model Override",
    "modelSwitcher.thinkingMode": "Thinking Mode",
    "modelSwitcher.thinkingEffort": "Thinking Effort",
    "modelSwitcher.stream": "Stream",
    "modelSwitcher.supportsImage": "Supports images",
    "modelSwitcher.autoContinueOnColonMaxAttempts": "Abnormal-stop Continuations",
    "modelSwitcher.autoContinueOnColonMaxAttempts.description": "Maximum automatic continuations after an abnormal DeepSeek stop, including trailing-colon and reasoning-only responses; set to 0 to disable.",
    "modelSwitcher.openaiCompatible": "OpenAI compatible",
    "modelSwitcher.editableSuffix": " (editable)",
    "modelSwitcher.readonlySuffix": " (read-only)",
    "modelSwitcher.placeholder.modelId": "e.g. deepseek-v4-flash",
    "modelSwitcher.placeholder.label": "e.g. My Model",
    "modelSwitcher.placeholder.description": "Model role, strengths, or use cases",
    "modelSwitcher.placeholder.baseUrl": "e.g. https://api.openai.com/v1/chat/completions",
    "modelSwitcher.placeholder.modelOverride": "Optional, e.g. gpt-4o-mini",
    "status.imageSupported": "image",
    "status.imageUnsupported": "no image",
    "status.thinking.auto": "Thinking:auto",
    "status.thinking.off": "Thinking:off",
    "status.thinking.on": "Thinking:on",
    "status.thinking.none": "Thinking:none",
    "status.thinking.prefix": "Thinking",
    "status.tooltip.model": "Model: {label}",
    "status.tooltip.thinkingMode": "Thinking mode: {value}",
    "status.tooltip.thinkingEffort": "Thinking effort: {value}",
    "status.tooltip.thinkingCapability": "Thinking capability: {value}",
    "status.tooltip.effortCapability": "Effort control: {value}",
    "status.tooltip.imageInput": "Image input: {value}",
    "status.tooltip.supported": "Supported",
    "status.tooltip.unsupported": "Unsupported",
    "status.tooltip.unknown": "Unknown",
    "status.tooltip.unconfirmed": "Unconfirmed",
    "status.tooltip.openSwitcher": "Click the model item to open the model switcher.",
    "status.tooltip.cycleThinking": "Click to toggle thinking; adjust effort in model settings."
  }
};

function t(key, fallback, values) {
  try {
    const translated = window.zion?.i18n?.t?.(`${I18N_NS}.${key}`, values);
    if (translated && translated !== `${I18N_NS}.${key}`) return translated;
  } catch {}
  return fallback;
}

function insertAfterLeadingSystem(messages, injectedMessage) {
  const list = Array.isArray(messages) ? messages : [];
  let insertAt = 0;
  while (insertAt < list.length && list[insertAt]?.role === "system") insertAt += 1;
  return [
    ...list.slice(0, insertAt),
    injectedMessage,
    ...list.slice(insertAt)
  ];
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

function findAssistantEndLineFromStateDoc(doc, startLineHint = 0) {
  if (!doc?.lines || typeof doc.line !== "function") return null;
  const roleHeadRe = /^\s*(system|user|assistant|tool)\s+/;
  let assistantLine = -1;
  for (let i = Math.max(0, startLineHint || 0); i < doc.lines; i++) {
    if (/^\s*assistant\s+/.test(doc.line(i + 1).text || "")) {
      assistantLine = i;
      break;
    }
  }
  if (assistantLine < 0) {
    for (let i = doc.lines - 1; i >= 0; i--) {
      if (/^\s*assistant\s+/.test(doc.line(i + 1).text || "")) {
        assistantLine = i;
        break;
      }
    }
  }
  if (assistantLine < 0) return null;
  let endLine = assistantLine;
  for (let i = assistantLine + 1; i < doc.lines; i++) {
    if (roleHeadRe.test(doc.line(i + 1).text || "")) break;
    endLine = i;
  }
  return { assistantLine, endLine };
}

function readChatBoolDefaultTrue(key) {
  try {
    return window.zion?.state?.get?.(key) !== false;
  } catch {
    return true;
  }
}

function isChatMessageAssemblyDebugEnabled() {
  try {
    if (window.zion?.state?.get?.("chat.debugMessageAssembly")) return true;
    return !!window.zion?.state?.get?.("compression.settings")?.debugLogging;
  } catch {
    return false;
  }
}

function getEditorBottomSafeMargin(scrollDOM, baseMargin = 24) {
  try {
    const scrollRect = scrollDOM?.getBoundingClientRect?.();
    if (!scrollRect) return baseMargin;
    const selectors = ["#bottombar", "#statusbar"];
    let overlap = 0;
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const style = window.getComputedStyle?.(el);
      if (style?.display === "none" || style?.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      const intersectsX = rect.right > scrollRect.left && rect.left < scrollRect.right;
      if (!intersectsX) continue;
      const bottomOverlap = Math.max(0, scrollRect.bottom - rect.top);
      overlap = Math.max(overlap, Math.min(rect.height, bottomOverlap));
    }
    return baseMargin + Math.ceil(overlap) + (overlap > 0 ? 8 : 0);
  } catch {
    return baseMargin;
  }
}

function getStructuralRoleScrollMargin(scrollDOM) {
  try {
    const viewport = Math.max(0, Number(scrollDOM?.clientHeight) || 0);
    return getEditorBottomSafeMargin(scrollDOM, 24) + Math.min(96, Math.max(40, Math.round(viewport * 0.12)));
  } catch {
    return 80;
  }
}


function ensureAssistantLatestVisible(editor, opts = {}) {
  try {
    const view = editor?.getView?.();
    const scrollDOM = view?.scrollDOM;
    const doc = view?.state?.doc;
    if (!view || !scrollDOM || !doc) return false;
    const range = findAssistantEndLineFromStateDoc(doc, opts.startLineHint || 0);
    if (!range) {
      return false;
    }
    const line = doc.line(Math.max(1, Math.min(doc.lines, range.endLine + 1)));
    const block = view.lineBlockAt(line.to);
    const margin = opts.structuralRole
      ? getStructuralRoleScrollMargin(scrollDOM)
      : getEditorBottomSafeMargin(scrollDOM, 24);
    if (
      opts.initial === true
      && block.top >= scrollDOM.scrollTop
      && block.bottom <= scrollDOM.scrollTop + scrollDOM.clientHeight
    ) {
      return true;
    }
    const visibleBottom = scrollDOM.scrollTop + scrollDOM.clientHeight - margin;
    if (block.bottom <= visibleBottom) {
      return true;
    }
    const nextScrollTop = Math.max(0, block.bottom - scrollDOM.clientHeight + margin);
    try {
      const sessionId = opts.sessionId || null;
      if (sessionId) {
        window.zion?.state?.set?.(`chat.followSuppressUntil.${sessionId}`, Date.now() + 80);
      }
      scrollDOM.__zionProgrammaticScrollUntil = Math.max(
        Number(scrollDOM.__zionProgrammaticScrollUntil) || 0,
        Date.now() + 80
      );
    } catch {}
    scrollDOM.scrollTop = nextScrollTop;
    return true;
  } catch {}
  return false;
}

function scheduleAssistantLatestVisible(editor, opts = {}) {
  const view = editor?.getView?.();
  if (!view) return false;
  return scheduleConversationViewportFollow(view, {
    sessionId: opts.sessionId || "",
    state: window.zion?.state,
    cycleId: opts.followCycleId || opts.traceId || "",
    initial: opts.initial === true,
    reveal: () => ensureAssistantLatestVisible(editor, {
      ...opts,
      phase: "animation-frame"
    })
  });
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
    const topMargin = getEditorBottomSafeMargin(scrollDOM, 24);
    const bottomMargin = opts.structuralRole
      ? getStructuralRoleScrollMargin(scrollDOM)
      : topMargin;
    if (
      opts.initial === true
      && block.top >= scrollDOM.scrollTop
      && block.bottom <= scrollDOM.scrollTop + scrollDOM.clientHeight
    ) {
      return true;
    }
    const visibleTop = scrollDOM.scrollTop + topMargin;
    const visibleBottom = scrollDOM.scrollTop + scrollDOM.clientHeight - bottomMargin;
    let nextScrollTop = null;
    if (block.bottom > visibleBottom) {
      nextScrollTop = Math.max(0, block.bottom - scrollDOM.clientHeight + bottomMargin);
    } else if (block.top < visibleTop) {
      nextScrollTop = Math.max(0, block.top - topMargin);
    }
    if (nextScrollTop == null) {
      return true;
    }
    try {
      const sessionId = opts.sessionId || null;
      if (sessionId) {
        window.zion?.state?.set?.(`chat.followSuppressUntil.${sessionId}`, Date.now() + 80);
      }
      scrollDOM.__zionProgrammaticScrollUntil = Math.max(
        Number(scrollDOM.__zionProgrammaticScrollUntil) || 0,
        Date.now() + 80
      );
    } catch {}
    scrollDOM.scrollTop = nextScrollTop;
    return true;
  } catch {}
  return false;
}

function scheduleDocLineVisible(editor, lineIndex, opts = {}) {
  const view = editor?.getView?.();
  if (!view) return false;
  return scheduleConversationViewportFollow(view, {
    sessionId: opts.sessionId || "",
    state: window.zion?.state,
    cycleId: opts.followCycleId || opts.traceId || "",
    initial: opts.initial === true,
    reveal: () => ensureDocLineVisible(editor, lineIndex, {
      ...opts,
      phase: "animation-frame"
    })
  });
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

  try {
    const fallbackRuntimeTools = listInteractiveRuntimeSupportedTools();
    const currentRuntimeTools = window.zion?.state?.get?.("runtime.supportedToolNames");
    const seededFallback = !Array.isArray(currentRuntimeTools) || currentRuntimeTools.length === 0;
    if (seededFallback) {
      window.zion?.state?.set?.("runtime.supportedToolNames", fallbackRuntimeTools);
    }
    ctx.subscriptions.push({
      dispose() {
        try {
          const current = window.zion?.state?.get?.("runtime.supportedToolNames");
          if (
            seededFallback
            && Array.isArray(current)
            && current.join("\n") === fallbackRuntimeTools.join("\n")
          ) {
            window.zion?.state?.set?.("runtime.supportedToolNames", []);
          }
        } catch {}
      }
    });
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
      return await rebuildModelCatalog();
    } catch (e) {
      console.warn("[langchain-chat] refreshCatalog error", e);
      return [];
    }
  }
  function getResolvedModelSnapshot(source) {
    const active = source || window.zion?.state?.get?.("chat.activeModel") || { providerId: "deepseek", modelId: "deepseek-v4-flash" };
    const providerId = String(active?.providerId || "deepseek");
    const modelId = String(active?.modelId || "deepseek-v4-flash");
    const catalog = window.zion?.state?.get?.("models.catalog") || [];
    const item = Array.isArray(catalog)
      ? catalog.find((m) => m.providerId === providerId && m.id === modelId)
      : null;
    return {
      ...(active?.profileId ? { profileId: String(active.profileId) } : {}),
      providerId,
      modelId,
      label: String(active?.label || item?.label || modelId),
      ...(active?.thinkingMode != null
        ? { thinkingMode: normalizeThinkingMode(active.thinkingMode) }
        : {}),
      ...(active?.thinkingEffort != null
        ? { thinkingEffort: normalizeThinkingEffort(active.thinkingEffort) }
        : {})
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

      window.zion.state.set("chat.activeModel", { providerId: "deepseek", modelId: "deepseek-v4-flash", label: "DeepSeek V4 Flash" });
    }
  }
  await refreshCatalog();
  ensureActiveModel();
  const modelHealthMonitor = startModelHealthMonitor();
  ctx.subscriptions.push(modelHealthMonitor);

  let runtimeStatusDisposable = null;
  let runtimeModelSyncPromise = null;
  let runtimeStatusConsecutiveFailures = 0;
  let runtimeStatusLastSuccessAt = 0;
  const runtimeStatusFailureThreshold = 3;
  const runtimeStatusSuccessGraceMs = 90_000;
  const markRuntimeReachable = (baseUrl = "") => {
    runtimeStatusConsecutiveFailures = 0;
    runtimeStatusLastSuccessAt = Date.now();
    const config = readInteractiveRuntimeConfig();
    window.zion?.state?.set?.("runtime.connection", {
      ...(window.zion?.state?.get?.("runtime.connection") || {}),
      available: true,
      mode: config.mode,
      backend: "runtime",
      baseUrl: baseUrl || config.baseUrl,
      checkedAt: runtimeStatusLastSuccessAt,
      lastSuccessAt: runtimeStatusLastSuccessAt,
      transientFailure: false
    });
  };
  const updateRuntimeStatus = async () => {
    const config = readInteractiveRuntimeConfig();
    const health = config.mode === "browser"
      ? {
          available: false,
          schedulerWorker: false,
          checkedAt: Date.now()
        }
      : await probeInteractiveRuntime(config);
    const checkedAt = Number(health.checkedAt || Date.now());
    if (config.mode !== "browser") {
      if (health.available) {
        runtimeStatusConsecutiveFailures = 0;
        runtimeStatusLastSuccessAt = checkedAt;
      } else {
        runtimeStatusConsecutiveFailures += 1;
      }
    }
    const recentlyReachable = runtimeStatusLastSuccessAt > 0
      && checkedAt - runtimeStatusLastSuccessAt <= runtimeStatusSuccessGraceMs;
    const transientRuntimeFailure = config.mode === "runtime"
      && !health.available
      && (
        runtimeStatusConsecutiveFailures < runtimeStatusFailureThreshold
        || recentlyReachable
      );
    const backend = config.mode === "browser"
      ? "browser"
      : health.available || transientRuntimeFailure
        ? "runtime"
        : config.mode === "runtime"
          ? "runtime-offline"
          : "browser";
    const connection = {
      ...health,
      available: health.available || transientRuntimeFailure,
      healthAvailable: health.available,
      mode: config.mode,
      backend,
      baseUrl: config.baseUrl,
      consecutiveFailures: runtimeStatusConsecutiveFailures,
      ...(runtimeStatusLastSuccessAt
        ? { lastSuccessAt: runtimeStatusLastSuccessAt }
        : {}),
      ...(transientRuntimeFailure
        ? { transientFailure: true }
        : {})
    };
    window.zion?.state?.set?.("runtime.connection", {
      ...connection
    });
    runtimeStatusDisposable?.dispose?.();
    const register = window.zion?.bottomStatusBar?.registerItem
      || window.zion?.statusBar?.registerItem;
    runtimeStatusDisposable = register?.({
      id: "dev.runtime.connection",
      text: backend === "runtime"
        ? `$(server) ${t("status.runtime", "Runtime")}`
        : backend === "runtime-offline"
          ? `$(debug-disconnect) ${t("status.runtimeOffline", "Runtime offline")}`
          : `$(browser) ${t("status.browserRuntime", "Browser mode")}`,
      tooltip: backend === "runtime"
        ? transientRuntimeFailure
          ? `${t("status.tooltip.runtime", "Runtime connected: {url}", { url: config.baseUrl })}\nHealth probe is retrying: ${health.error || "unavailable"}`
          : t("status.tooltip.runtime", "Runtime connected: {url}", { url: config.baseUrl })
        : backend === "runtime-offline"
          ? t("status.tooltip.runtimeOffline", "Runtime unavailable: {url}", { url: config.baseUrl })
          : t("status.tooltip.browserRuntime", "Using browser compatibility mode"),
      priority: 74
    }) || null;
    const statusElement = document.querySelector('[data-zion-status-id="dev.runtime.connection"]');
    if (statusElement instanceof HTMLElement) {
      statusElement.dataset.runtimeConnection = backend;
    }
  };
  const syncRuntimeModelProfiles = ({
    overwriteExisting = false,
    target = null
  } = {}) => {
    if (runtimeModelSyncPromise) {
      return target
        ? runtimeModelSyncPromise.then(() =>
            syncRuntimeModelProfiles({ overwriteExisting, target })
          )
        : runtimeModelSyncPromise;
    }
    runtimeModelSyncPromise = (async () => {
      const config = readInteractiveRuntimeConfig();
      if (!await shouldUseInteractiveRuntime(config)) return null;
      const catalog = window.zion?.state?.get?.("models.catalog") || [];
      const candidates = (Array.isArray(catalog) ? catalog : [])
        .filter((model) => !["anthropic", "google"].includes(model?.providerId))
        .filter((model) => {
          if (!target?.providerId) return true;
          if (model?.providerId !== target.providerId) return false;
          return !target?.modelId || model?.id === target.modelId;
        })
        .map((model) => ({
          providerId: model.providerId,
          modelId: model.id,
          label: model.label || model.id
        }));
      const result = await syncWorkbenchModelProfiles({
        models: candidates,
        baseUrl: config.baseUrl,
        resolveConfig: async (model) => {
          const provider = window.zion?.models?.getProvider?.(model.providerId);
          return provider?.resolve?.(model.modelId);
        },
        overwriteExisting
      });
      if (result.imported.length) invalidateRuntimeDynamicModelCache();
      window.zion?.state?.set?.("runtime.modelSync", {
        imported: result.imported.map((profile) => profile.id),
        skipped: result.skipped,
        syncedAt: Date.now()
      });
      if (overwriteExisting && result.imported.length) {
        await rebuildModelCatalog({ forceRuntime: true });
      }
      return result;
    })()
      .catch((error) => {
        window.zion?.state?.set?.("runtime.modelSync", {
          imported: [],
          skipped: [],
          error: error?.message || String(error),
          syncedAt: Date.now()
        });
        return null;
      })
      .finally(() => {
        runtimeModelSyncPromise = null;
      });
    return runtimeModelSyncPromise;
  };

  let applyingRuntimeActiveModel = false;
  let runtimeActiveModelSyncPromise = null;
  const syncActiveModelFromRuntimeProfile = () => {
    if (runtimeActiveModelSyncPromise) return runtimeActiveModelSyncPromise;
    runtimeActiveModelSyncPromise = (async () => {
      const config = readInteractiveRuntimeConfig();
      if (!await shouldUseInteractiveRuntime(config)) return null;
      const model = await resolveInteractiveRuntimeProfileModel({
        baseUrl: config.baseUrl
      });
      if (!model) return null;
      applyingRuntimeActiveModel = true;
      try {
        window.zion?.state?.set?.("chat.activeModel", {
          profileId: model.profileId,
          providerId: model.providerId,
          modelId: model.modelId,
          label: model.label
        });
        try {
          localStorage.setItem(
            "zion.chat.defaultModel",
            JSON.stringify({
              providerId: model.providerId,
              modelId: model.modelId
            })
          );
        } catch {}
      } finally {
        applyingRuntimeActiveModel = false;
      }
      window.zion?.state?.set?.("runtime.defaultModelSync", {
        status: "synced",
        profileId: model.profileId,
        providerId: model.providerId,
        modelId: model.modelId,
        syncedAt: Date.now()
      });
      return model;
    })()
      .catch((error) => {
        window.zion?.state?.set?.("runtime.defaultModelSync", {
          status: "error",
          error: error?.message || String(error),
          syncedAt: Date.now()
        });
        return null;
      })
      .finally(() => {
        runtimeActiveModelSyncPromise = null;
      });
    return runtimeActiveModelSyncPromise;
  };
  const persistActiveModelToRuntimeProfile = (model) => {
    if (!model?.providerId || !model?.modelId) return null;
    const config = readInteractiveRuntimeConfig();
    if (config.mode === "browser") return null;
    return (async () => {
      if (!await shouldUseInteractiveRuntime(config)) return null;
      const provider = window.zion?.models?.getProvider?.(model.providerId);
      const selectedModelConfig = await provider?.resolve?.(model.modelId);
      const result = await persistInteractiveRuntimeProfileModel({
        selectedModel: model,
        selectedModelConfig,
        baseUrl: config.baseUrl
      });
      window.zion?.state?.set?.("runtime.defaultModelSync", {
        status: "persisted",
        profileId: result.runtimeModel.profileId,
        providerId: result.runtimeModel.providerId,
        modelId: result.runtimeModel.modelId,
        syncedAt: Date.now()
      });
      return result;
    })().catch((error) => {
      window.zion?.state?.set?.("runtime.defaultModelSync", {
        status: "error",
        providerId: model.providerId,
        modelId: model.modelId,
        error: error?.message || String(error),
        syncedAt: Date.now()
      });
      return null;
    });
  };
  void updateRuntimeStatus()
    .then(() => syncRuntimeModelProfiles())
    .then(() => syncActiveModelFromRuntimeProfile());
  const runtimeStatusTimer = window.setInterval(
    () => void updateRuntimeStatus(),
    5000
  );
  ctx.subscriptions.push({
    dispose() {
      window.clearInterval(runtimeStatusTimer);
      runtimeStatusDisposable?.dispose?.();
    }
  });
  const runtimeModelSyncDisposable = window.zion?.events?.on?.(
    "models/configChanged",
    (payload) => void syncRuntimeModelProfiles({
      overwriteExisting: true,
      target: payload || null
    })
  );
  if (runtimeModelSyncDisposable) ctx.subscriptions.push(runtimeModelSyncDisposable);

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
        if (!applyingRuntimeActiveModel) {
          void persistActiveModelToRuntimeProfile(nv);
        }
      } catch {}
    })
  );

  // 模型切换器装饰器（挂载面板）
  let modelSwitcher = null;
  const decSwitcher = window.zion.editor.registerDecorator({
    id: "dev.langchain-chat.model-switcher",
    apply(editor) {
      if (String(editor?.panelId || "").startsWith("comments:")) return { dispose() {} };
      modelSwitcher = installModelSwitcher();
      return { dispose() { modelSwitcher?.dispose?.(); modelSwitcher = null; } };
    }
  });
  ctx.subscriptions.push(decSwitcher);

  const decOverviewRail = window.zion.editor.registerDecorator({
    id: "dev.langchain-chat.overview-rail",
    apply(editor) {
      if (String(editor?.panelId || "").startsWith("comments:")) return { dispose() {} };
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
  const inferRequestSource = ({ sessionId, panelId } = {}) => {
    const pid = String(panelId || "");
    const sid = String(sessionId || "");
    if (pid.startsWith("comments:") || sid.startsWith("comment:")) return "comments";
    if (pid.startsWith("agents:") || sid.startsWith("agent-task:")) return "agents";
    return "";
  };
  const compactRunTitle = (value, max = 120) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
  };
  const resolveSessionTitleForRun = (sessionId) => {
    const sid = String(sessionId || "").trim();
    if (!sid) return "";
    try {
      const meta = window.zion?.commands?.executeCommand?.("zion.sessions.getMeta", sid)
        || window.zion?.state?.get?.(`sessions.meta.${sid}`);
      const title = compactRunTitle(meta?.title);
      if (title && title !== sid) return title;
    } catch {}
    try {
      const catalog = window.zion?.state?.get?.("sessions.catalog");
      if (Array.isArray(catalog)) {
        const found = catalog.find((item) => String(item?.id || "") === sid);
        const title = compactRunTitle(found?.title);
        if (title && title !== sid) return title;
      }
    } catch {}
    return "";
  };
  const resolveRunDisplayName = (opts, sessionId) => {
    const metadata = opts?.metadata && typeof opts.metadata === "object" ? opts.metadata : {};
    return compactRunTitle(
      opts?.displayName
      || opts?.sourceName
      || metadata.displayName
      || metadata.sourceName
      || metadata.commentTitle
      || metadata.threadTitle
      || metadata.sessionTitle
      || opts?.sourceTitle
      || opts?.title
      || resolveSessionTitleForRun(sessionId)
    );
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
  const abortedLedgerDisposable = window.zion?.events?.on?.("chat/aborted", (payload = {}) => {
    const runId = String(payload?.runId || "");
    if (!runId) return;
    try {
      window.zion?.runs?.recordEvent?.({
        runId,
        type: "run.aborted",
        ts: Date.now(),
        data: { reason: payload?.reason || "user" }
      });
    } catch {}
  });
  if (abortedLedgerDisposable) ctx.subscriptions.push(abortedLedgerDisposable);

  const buildMockCurrentMessages = async (opts = {}) => {
    const ed = getEd(opts);
    if (!ed) throw new Error("No active editor");
    ensureActiveModel();
    const panelId = opts?.panelId || ed?.panelId || null;
    const sid = getSessionId({ ...opts, panelId });
    if (!sid) throw new Error("No target session");
    const runThinkingEffort = normalizeThinkingEffort(opts?.thinkingEffort);
    const resolveActiveRunModel = () => getResolvedModelSnapshot(
      runThinkingEffort === "auto" ? null : { ...window.zion.state.get("chat.activeModel"), thinkingEffort: runThinkingEffort }
    );
    const runModel = resolveActiveRunModel();
    const cursor = ed.getCursor();
    const fullDoc = ed.getValue();
    const lines = fullDoc.split("\n");
    const cursorLine = cursor.line;
    const contentBeforeCursor = lines.slice(0, cursorLine + 1).join("\n");
    let messages = parseMessages(contentBeforeCursor);
    if (Array.isArray(opts?.contextMessages) && opts.contextMessages.length) {
      messages.unshift(...opts.contextMessages.filter((m) => m?.role && typeof m.content === "string"));
    }
    if (!messages.length) throw new Error("No content to mock");

    const tools = window.zion?.commands?.executeCommand("tools.parseFromContent", contentBeforeCursor) || null;
    const runtimeConfig = readInteractiveRuntimeConfig({
      state: window.zion?.state,
      storage: globalThis.localStorage
    });
    if (runtimeConfig.mode !== "browser") {
      const requestSource = opts?.requestSource || inferRequestSource({
        sessionId: sid,
        panelId
      });
      const runtimeConnection = window.zion?.state?.get?.("runtime.connection");
      const contributorContext = {
        editor: ed,
        sessionId: sid,
        panelId,
        requestSource,
        runtimeConnection,
        runId: `runtime-preview-${Date.now().toString(36)}`
      };
      const provider = window.zion?.models?.getProvider?.(runModel?.providerId);
      const [providerModelConfig, runtimeProfiles] = await Promise.all([
        provider?.resolve?.(runModel?.modelId),
        loadRuntimeModelProfiles().catch(() => null)
      ]);
      const runtimeProfile = findRuntimeModelProfile(runtimeProfiles, runModel);
      const selectedModelConfig = mergeRuntimeModelProfileConfig(
        providerModelConfig,
        runtimeProfile
      );
      // #region debug-point C:model-ready
      if (window.zion?.state?.get?.("debug.chatSubmitUrl")) void fetch(window.zion.state.get("debug.chatSubmitUrl"), { method: "POST", body: JSON.stringify({ sessionId: "chat-submit-latency", runId: window.zion.state.get("debug.chatSubmitPhase") || "pre-fix", hypothesisId: "C", location: "runInteractiveThroughRuntime:model-ready", msg: "[DEBUG] model-ready", ts: Date.now() }) }).catch(() => {});
      // #endregion
      const [preparedMessages, sessionHistory] = await Promise.all([
        prepareInteractiveRuntimeMessages({
          messages,
          runContributors: window.zion?.__runMessageContributors,
          contributorContext,
          transformMessages: (prepared) =>
            reconstructHistory(prepared, selectedModelConfig)
        }),
        reconstructHistory(messages, selectedModelConfig)
      ]);
      const preview = await previewInteractiveRuntimeRequest({
        messages: preparedMessages,
        sessionHistory,
        tools,
        selectedModel: runModel,
        selectedModelConfig,
        runtimeCatalog: runtimeProfiles ? { profiles: runtimeProfiles } : undefined,
        title: resolveSessionTitleForRun(sid),
        workbenchSessionId: sid,
        projectId: opts?.projectId || opts?.metadata?.projectId,
        metadata: {
          ...(opts?.metadata && typeof opts.metadata === "object"
            ? opts.metadata
            : {}),
          requestSource,
          panelId,
          workbenchContributorsApplied: true,
          includeTerminalContext: includeTerminalContextForRuntime(
            window.zion?.state
          ),
          skills: {
            ...runtimeSkillsMetadata(window.zion?.state),
            ...(opts?.metadata?.skills || {})
          }
        },
        baseUrl: runtimeConfig.baseUrl
      });
      const request = preview.request || {};
      const payload = request.payload && typeof request.payload === "object"
        ? request.payload
        : {};
      return {
        id: `llm_mock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        mock: true,
        timestamp: Date.now(),
        runId: preview.runId || "mock",
        sessionId: sid,
        panelId,
        providerId: request.providerId || runModel.providerId,
        modelId: request.modelId || runModel.modelId,
        modelLabel: request.modelLabel || runModel.label || runModel.modelId,
        providerType: request.providerType || "",
        url: request.url || "mock://runtime-preview",
        stream: request.stream !== false,
        messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
        toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
        contextFailures: preview.contextFailures || [],
        payload: {
          ...payload,
          mock: true
        }
      };
    }

    if (window.zion?.__runMessageContributors) {
      const contributorCtx = {
        editor: ed,
        sessionId: sid,
        panelId,
        requestSource: opts?.requestSource || inferRequestSource({ sessionId: sid, panelId }),
        runId: "mock"
      };
      try { messages = await window.zion.__runMessageContributors(messages, "pre", contributorCtx); } catch (e) {
        console.warn("[langchain-chat] mock pre contributors error:", e);
      }
      try { messages = await window.zion.__runMessageContributors(messages, "post", contributorCtx); } catch (e) {
        console.warn("[langchain-chat] mock post contributors error:", e);
      }
    }

    return {
      id: `llm_mock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      mock: true,
      timestamp: Date.now(),
      runId: "mock",
      sessionId: sid,
      panelId,
      providerId: runModel.providerId,
      modelId: runModel.modelId,
      modelLabel: runModel.label || runModel.modelId,
      url: "mock://current-editor",
      stream: true,
      messageCount: messages.length,
      toolCount: Array.isArray(tools) ? tools.length : 0,
      payload: {
        model: runModel.modelId,
        messages,
        tools: Array.isArray(tools) && tools.length ? tools : undefined,
        stream: true,
        mock: true
      }
    };
  };

  const executeProgrammatic = createProgrammaticExecutor({
    runStream,
    getActiveModel: () => getResolvedModelSnapshot(window.zion.state.get("chat.activeModel")),
    resolveModelConfig: async (model) => {
      const prov = window.zion?.models?.getProvider?.(model?.providerId);
      return await prov?.resolve?.(model?.modelId);
    },
    getTools: () => {
      const tools = Array.isArray(window.zion?.state?.get?.("chat.tools"))
        ? window.zion.state.get("chat.tools")
        : [];
      const enabled = window.zion?.state?.get?.("chat.enabledTools");
      if (!Array.isArray(enabled)) return tools;
      const allowed = new Set(enabled.map(String));
      return tools.filter((tool) => allowed.has(String(tool?.function?.name || tool?.name || "")));
    },
    executeTool: (call, context) => executeToolCall(call, context?.sessionId || `scheduled:${call?.id || "run"}`),
    runContributors: (messages, stage, contributorCtx) =>
      window.zion?.__runMessageContributors
        ? window.zion.__runMessageContributors(messages, stage, contributorCtx)
        : messages,
    runs: window.zion?.runs,
    emit: (topic, payload) => window.zion?.events?.emit?.(topic, payload)
  });
    const programmaticRuns = new Map();
    const interactiveRuntimeObservers = new Map();
    const interactiveRuntimeOwnerRuns = new Set();
    const interactivePreparations = new Map();
    const executeAndTrack = (request = {}) => {
      const handle = executeProgrammatic(request);
      const sessionId = request?.sessionId ? String(request.sessionId) : null;
      if (sessionId) {
        programmaticRuns.set(sessionId, handle);
        handle.completion.finally(() => {
          if (programmaticRuns.get(sessionId) === handle) programmaticRuns.delete(sessionId);
        });
      }
      return handle;
    };
    const stopAnySession = (sessionId) => {
      const target = sessionId || getSessionId();
      const scheduled = target ? programmaticRuns.get(target) : null;
      if (scheduled) {
        void scheduled.abort("user");
        return { runId: scheduled.runId, sessionId: target };
      }
      return runtime.stopSession(target);
    };

  window.zion.chat = {
    ...(window.zion.chat || {}),
    run: (opts = {}) => doRun(opts),
      execute: (request = {}) => executeAndTrack(request),
    mockCurrentMessages: (opts = {}) => buildMockCurrentMessages(opts),
      stop: (sid) => stopAnySession(sid),
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
        for (const handle of programmaticRuns.values()) {
          try { void handle.abort("user"); } catch {}
        }
        programmaticRuns.clear();
        for (const observer of interactiveRuntimeObservers.values()) {
          try { observer.abort(); } catch {}
        }
        interactiveRuntimeObservers.clear();
        interactiveRuntimeOwnerRuns.clear();
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
    const isAborted = () => call?.runId
      ? !runtime.isRunActive(sid, call.runId)
      : !!getRunState(sid)?.aborted;

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
            cardId: call.cardId || null,
            runId: call.runId || null,
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

  const runInteractiveThroughRuntime = async ({
    opts,
    ed,
    panelId,
    sid,
    cursor,
    messages,
    tools,
    runModel,
    requestSource,
    runtimeConfig,
    documentAnchor,
    reconstructHistory,
    autoScrollAssistant,
    preparation,
    modelPreparation
  }) => {
    const appendUserPrompt = typeof opts.autoInsertUserPrompt === "boolean"
      ? opts.autoInsertUserPrompt
      : window.zion?.state?.get?.("chat.autoInsertUserPrompt") !== false;
    let handle;
    try {
      const contributorContext = {
        editor: ed,
        sessionId: sid,
        panelId,
        requestSource: requestSource || "interactive",
        runtimeConnection: window.zion?.state?.get?.("runtime.connection"),
        runId: `runtime-context-${Date.now().toString(36)}`
      };
      const provider = window.zion?.models?.getProvider?.(runModel?.providerId);
      const [providerModelConfig, runtimeProfiles] = await (modelPreparation || Promise.all([
        provider?.resolve?.(runModel?.modelId),
        loadRuntimeModelProfiles().catch(() => null)
      ]));
      preparation?.signal.throwIfAborted();
      preparation?.mark?.("modelConfigReady");
      const runtimeProfile = findRuntimeModelProfile(runtimeProfiles, runModel);
      const selectedModelConfig = mergeRuntimeModelProfileConfig(
        providerModelConfig,
        runtimeProfile
      );
      // #region debug-point C:model-ready
      if (window.zion?.state?.get?.("debug.chatSubmitUrl")) void fetch(window.zion.state.get("debug.chatSubmitUrl"), { method: "POST", body: JSON.stringify({ sessionId: "chat-submit-latency", runId: window.zion.state.get("debug.chatSubmitPhase") || "pre-fix", hypothesisId: "C", location: "runInteractiveThroughRuntime:model-ready", msg: "[DEBUG] model-ready", ts: Date.now() }) }).catch(() => {});
      // #endregion
      const [preparedMessages, sessionHistory] = await Promise.all([
        prepareInteractiveRuntimeMessages({
          messages,
          runContributors: window.zion?.__runMessageContributors,
          contributorContext,
          transformMessages: (prepared) =>
            reconstructHistory(prepared, selectedModelConfig)
        }),
        reconstructHistory(messages, selectedModelConfig)
      ]);
      preparation?.signal.throwIfAborted();
      preparation?.mark?.("messagesReady");
      // #region debug-point C:messages-ready
      if (window.zion?.state?.get?.("debug.chatSubmitUrl")) void fetch(window.zion.state.get("debug.chatSubmitUrl"), { method: "POST", body: JSON.stringify({ sessionId: "chat-submit-latency", runId: window.zion.state.get("debug.chatSubmitPhase") || "pre-fix", hypothesisId: "C", location: "runInteractiveThroughRuntime:messages-ready", msg: "[DEBUG] messages-ready", ts: Date.now() }) }).catch(() => {});
      // #endregion
      handle = await createInteractiveRuntimeHandle({
        messages: preparedMessages,
        sessionHistory,
        tools,
        selectedModel: runModel,
        selectedModelConfig,
        runtimeCatalog: runtimeProfiles ? { profiles: runtimeProfiles } : undefined,
        signal: preparation?.signal,
        expectedAccount: preparation?.expectedAccount,
        title: opts?.title || resolveSessionTitleForRun(sid),
        workbenchSessionId: sid,
        projectId: opts?.projectId || opts?.metadata?.projectId,
        metadata: {
          ...(opts?.metadata && typeof opts.metadata === "object" ? opts.metadata : {}),
          chatSubmission: preparation?.timings,
          requestSource: "interactive",
          panelId,
          workbenchContributorsApplied: true,
          includeTerminalContext: includeTerminalContextForRuntime(
            window.zion?.state
          ),
          skills: {
            ...runtimeSkillsMetadata(window.zion?.state),
            ...(opts?.metadata?.skills || {})
          },
          documentProjection: {
            mode: "live",
            includeReasoning:
              window.zion?.state?.get?.("chat.thinkingVisible") !== false,
            appendUserPrompt: !!appendUserPrompt,
            anchor: documentAnchor || null
          },
          workbenchClientId: String(
            window.zion?.state?.get?.("sessions.clientId") || ""
          )
        },
        baseUrl: runtimeConfig.baseUrl
      });
      markRuntimeReachable(runtimeConfig.baseUrl);
      if (preparation?.signal.aborted) {
        try { await handle.abort("cancelled-during-preparation"); }
        finally { handle.detach(); }
        return { status: "aborted" };
      }
    } catch (error) {
      if (preparation?.signal.aborted) return { status: "aborted" };
      if (
        runtimeConfig.mode === "auto"
        && !opts?.metadata?.goal
        && [
          "RUNTIME_MODEL_UNAVAILABLE",
          "RUNTIME_CONTEXT_UNSUPPORTED"
        ].includes(error?.code)
      ) {
        window.zion?.notification?.show?.(
          error?.code === "RUNTIME_CONTEXT_UNSUPPORTED"
            ? "当前插件上下文无法交给 Runtime，本次继续使用 Browser"
            : "当前模型尚未配置到 Runtime，本次继续使用 Browser",
          { type: "warning", duration: 5000 }
        );
        return { fallbackToBrowser: true };
      }
      if (preparation) runtime.markError(sid, error, preparation.id);
      window.zion.events.emit("chat/runError", {
        error,
        sessionId: sid,
        panelId
      });
      window.zion?.notification?.show?.(
        `Runtime 启动失败: ${error?.message || String(error)}`,
        { type: "error", duration: 8000 }
      );
      return null;
    }

    const runId = handle.runId;
    preparation?.mark?.("runtimeAccepted");
    window.zion?.state?.set?.(`chat.latency.${sid}`, { runId, ...preparation?.timings });
    interactiveRuntimeOwnerRuns.add(runId);
    interactiveRuntimeObservers.get(runId)?.abort();
    interactiveRuntimeObservers.delete(runId);
    const startedAt = Date.now();
    const insertLine = Math.max(0, Number(cursor?.line || 0) + 1);
    const anchor = {
      sessionId: sid,
      assistantBlockId: runId,
      headLine: insertLine,
      anchorPos: Number(documentAnchor?.fallback?.offset) || 0
    };
    const runAnchorPayload = {
      assistantBlockId: anchor?.assistantBlockId || runId,
      answerAnchorPos: typeof anchor?.anchorPos === "number" ? anchor.anchorPos : null,
      answerHeadLine: typeof anchor?.headLine === "number" ? anchor.headLine : null,
      insertLine
    };
    const runDisplayName = resolveRunDisplayName(opts, sid);
    const runMetadata = {
      ...(opts?.metadata && typeof opts.metadata === "object" ? opts.metadata : {}),
      requestSource: "interactive",
      backend: "runtime",
      runtimeBaseUrl: runtimeConfig.baseUrl,
      runtimeRunId: runId,
      runtimeAttemptId: handle.attemptId,
      runtimeModel: handle.model || null,
      documentProjectionMode: "live",
      assistantBlockId: runAnchorPayload.assistantBlockId
    };
    if (runDisplayName && !runMetadata.displayName) runMetadata.displayName = runDisplayName;
    if (runDisplayName && !runMetadata.sessionTitle) runMetadata.sessionTitle = runDisplayName;

    try {
      window.zion?.runs?.start?.({
        id: runId,
        title: opts?.title || runDisplayName || "",
        source: opts?.source || {
          pluginId: "dev.langchain-chat",
          kind: "chat-session",
          id: sid
        },
        trigger: opts?.trigger || "user",
        sessionId: sid,
        panelId,
        executionMode: "interactive-runtime",
        model: handle.model || null,
        metadata: runMetadata
      });
    } catch {}

    preparation?.accept(runId);
    runtime.beginRun(sid, runId);
    setRunState(sid, { aborted: false, model: handle.model || null }, runId);
    try {
      window.zion?.state?.set?.(
        `chat.assistantBlockId.${sid}`,
        runAnchorPayload.assistantBlockId
      );
      window.zion?.state?.set?.(
        `chat.answerHeadLine.${sid}`,
        runAnchorPayload.answerHeadLine
      );
      window.zion?.state?.set?.(
        `chat.answerAnchorPos.${sid}`,
        runAnchorPayload.answerAnchorPos
      );
    } catch {}
    runtime.setController(sid, {
      abortOnDispose: false,
      abort() {
        preparation?.clearFeedback();
        void handle.abort("user").catch(() => {});
      },
      dispose() {
        handle.detach();
      }
    }, runId);

    if (autoScrollAssistant && typeof anchor?.headLine === "number") {
      scheduleDocLineVisible(ed, anchor.headLine, {
        sessionId: sid,
        forceBottom: true,
        structuralRole: true,
        traceId: runId,
        followCycleId: preparation?.id || runId,
        initial: true
      });
    }

    let terminalProjected = false;
    const projectionOptions = {
      requestSource: requestSource || "interactive",
      backend: "runtime",
      runtimeRunId: runId,
      panelId,
      assistantBlockId: runAnchorPayload.assistantBlockId,
      answerAnchorPos: runAnchorPayload.answerAnchorPos,
      editorView: ed?.getView?.(),
      followCycleId: preparation?.id || runId,
      documentWriter: false,
      documentProjectionMode: "live",
      assistantBlockReady: true,
      appendAssistantToken: async () => true
    };
    const recordRemoteEvent = (event) => {
      try {
        window.zion?.runs?.recordEvent?.({
          runId,
          type: event.type,
          ts: event.ts ?? event.timestamp ?? Date.now(),
          sequence: event.sequence,
          data: event.data || {}
        });
      } catch {}
    };
    interactiveRuntimeOwnerRuns.add(runId);
    const consuming = (async () => {
      try {
        for await (const event of handle.events) {
          markRuntimeReachable(runtimeConfig.baseUrl);
          if (["reasoning.started", "reasoning.delta", "message.delta", "tool.started", "tool.requested"].includes(event.type)) {
            preparation?.clearFeedback({ waitForDocument: true });
          }
          if (["reasoning.delta", "message.delta"].includes(event.type)) {
            const key = event.type === "message.delta" ? "firstAnswerReceived" : "firstReasoningReceived";
            preparation?.mark?.(key);
            const previousLatency = window.zion?.state?.get?.(`chat.latency.${sid}`);
            window.zion?.state?.set?.(`chat.latency.${sid}`, {
              runId, ...preparation?.timings,
              stages: {
                ...(previousLatency?.runId === runId ? previousLatency.stages : {}),
                ...preparation?.timings?.stages
              }
            });
          }
          recordRemoteEvent(event);
          await projectRunEventToSession(
            window.zion,
            sid,
            event,
            projectionOptions
          );
          if (["run.completed", "run.failed", "run.aborted", "run.waiting"].includes(event.type)) {
            terminalProjected = true;
            preparation?.mark?.("terminalApplied");
          }
        }
      } finally {
        interactiveRuntimeOwnerRuns.delete(runId);
      }
    })();

    const result = await handle.completion;
    await consuming;
    preparation?.mark?.("streamClosed");
    window.zion?.state?.set?.(`chat.latency.${sid}`, { runId, ...preparation?.timings });
    if (result.status === "aborted" && result.reason === "detached") {
      preparation?.clearFeedback();
      return result;
    }
    if (!terminalProjected) {
      const type = result.status === "completed"
        ? "run.completed"
        : result.status === "waiting"
          ? "run.waiting"
        : result.status === "aborted"
          ? "run.aborted"
          : "run.failed";
      const terminalEvent = {
        runId,
        attemptId: handle.attemptId,
        type,
        ts: Date.now(),
        data: {
          output: result.output || "",
          usage: result.usage || null,
          error: result.error || null,
          reason: result.reason || null
          ,waiting: result.waiting || null
        }
      };
      recordRemoteEvent(terminalEvent);
      await projectRunEventToSession(
        window.zion,
        sid,
        terminalEvent,
        projectionOptions
      );
    }

    preparation?.clearFeedback({ waitForDocument: result.status === "completed" });
    if (result.status === "waiting") {
      runtime.markWaiting(sid, runId, result.waiting);
      window.zion?.notification?.show?.(`${result.waiting?.reason || "等待回复"}。在输入区填写回复并发送，可用停止按钮取消。`, { type: "info", duration: 12000 });
    } else if (result.status === "completed") {
      runtime.markAwaiting(sid, runId);
    } else if (result.status === "aborted") {
      runtime.markAborted(sid, runId);
    } else {
      runtime.markError(
        sid,
        new Error(result.error || "Runtime Run failed"),
        runId
      );
    }
    runtime.syncGlobalStreamingForActiveSession();
    if (result.status === "completed") {
      window.zion.commands.executeCommand("zion.sessions.bumpUpdatedAt", sid);
    } else if (result.status === "failed") {
      window.zion?.notification?.show?.(
        `Runtime 执行失败: ${result.error || "未知错误"}`,
        { type: "error", duration: 8000 }
      );
    }

    return {
      ...result,
      durationMs: Date.now() - startedAt
    };
  };

  const pendingRecoveryRuns = new Map();
  const projectedSequences = new Map();
  const recoveryReady = () => window.zion?.state?.get("sessions.ready") === true
    && window.zion?.state?.get("workbench.pluginsReady") === true;
  const recoverInteractiveRuntimeRun = async (runRecord) => {
    const metadata = runRecord?.metadata && typeof runRecord.metadata === "object"
      ? runRecord.metadata
      : {};
    const runId = String(metadata.runtimeRunId || runRecord?.id || "");
    const sid = String(runRecord?.sessionId || "");
    if (interactivePreparations.has(sid)) {
      if (runId) pendingRecoveryRuns.set(runId, runRecord);
      return null;
    }
    if (!recoveryReady()) {
      if (runId && sid) pendingRecoveryRuns.set(runId, runRecord);
      return null;
    }
    const ownedLocally = interactiveRuntimeOwnerRuns.has(runId);
    if (
      !runId
      || !sid
      || metadata.backend !== "runtime"
      || interactiveRuntimeObservers.has(runId)
      || ownedLocally
    ) {
      return null;
    }

    const panelId = runRecord?.panelId || null;
    const assistantBlockId = String(metadata.assistantBlockId || runId);
    const baseUrl = String(
      metadata.runtimeBaseUrl
      || readInteractiveRuntimeConfig().baseUrl
    );
    // The persisted receive ledger is not an acknowledgement from UI consumers.
    const afterSequence = projectedSequences.get(runId) || 0;
    const observer = new AbortController();
    const deferToSubmitter = () => {
      if (!interactivePreparations.has(sid) && !interactiveRuntimeOwnerRuns.has(runId)) return false;
      if (interactivePreparations.has(sid)) pendingRecoveryRuns.set(runId, runRecord);
      observer.abort();
      return true;
    };
    interactiveRuntimeObservers.set(runId, observer);
    let terminalProjected = false;

    try {
      await window.zion.commands.executeCommand("zion.sessions.getDocAsync", sid);
      await window.zion.commands.executeCommand("zion.sessions.getMetaAsync", sid);
      if (observer.signal.aborted || deferToSubmitter()) return null;
      const observed = await observeInteractiveRuntimeRun({
        runtimeRunId: runId,
        afterSequence,
        baseUrl,
        signal: observer.signal,
        onRun: async (remoteRun) => {
          if (deferToSubmitter()) return;
          metadata.documentProjectionMode = remoteRun.metadata?.documentProjection?.mode || metadata.documentProjectionMode;
          if (!["queued", "running", "waiting"].includes(remoteRun.status)) return;
          window.zion?.runs?.start?.({
            ...runRecord,
            status: "running",
            completedAt: undefined,
            terminalReason: undefined,
            error: undefined,
            metadata
          });
          runtime.beginRun(sid, runId);
          setRunState(sid, {
            aborted: false,
            model: runRecord.model || null
          }, runId);
          try {
            window.zion?.state?.set?.(
              `chat.assistantBlockId.${sid}`,
              assistantBlockId
            );
          } catch {}
          runtime.setController(sid, {
            abortOnDispose: false,
            abort() {
              void abortInteractiveRuntimeRun({
                runtimeRunId: runId,
                baseUrl,
                reason: "user"
              }).catch(() => {});
            }
          }, runId);
          if (afterSequence > 0) {
            await projectRunEventToSession(window.zion, sid, {
              runId,
              type: "run.started",
              data: { model: runRecord.model || null }
            }, {
              requestSource: "interactive",
              panelId,
              assistantBlockId,
              documentWriter: false
            });
          }
        },
        onEvent: async (event) => {
          if (deferToSubmitter()) return;
          window.zion?.runs?.recordEvent?.({
            runId,
            type: event.type,
            ts: event.ts ?? event.timestamp ?? Date.now(),
            sequence: event.sequence,
            data: event.data || {}
          });
          await projectRunEventToSession(window.zion, sid, event, {
            requestSource: "interactive",
            backend: "runtime",
            runtimeRunId: runId,
            panelId,
            assistantBlockId,
            documentWriter: false,
            documentProjectionMode: metadata.documentProjectionMode,
            resetProjection: afterSequence === 0,
            replay: true,
            appendAssistantToken: async () => true
          });
          projectedSequences.set(runId, Number(event.sequence) || afterSequence);
          if (["run.completed", "run.failed", "run.aborted", "run.waiting"].includes(event.type)) {
            terminalProjected = true;
          }
        }
      });
      if (observer.signal.aborted) return null;

      const remoteRun = observed.run;
      const terminalType = remoteRun.status === "completed"
        ? "run.completed"
        : remoteRun.status === "waiting"
          ? "run.waiting"
        : remoteRun.status === "aborted"
          ? "run.aborted"
          : ["failed", "interrupted"].includes(remoteRun.status)
            ? "run.failed"
            : null;
      if (terminalType && !terminalProjected) {
        const terminalEvent = {
          runId,
          attemptId: remoteRun.attemptId,
          type: terminalType,
          ts: remoteRun.completedAt || Date.now(),
          data: {
            output: remoteRun.output || "",
            usage: remoteRun.usage || null,
            error: remoteRun.error || null,
            reason: remoteRun.terminalReason || null
            ,waiting: remoteRun.waiting || null
          }
        };
        window.zion?.runs?.recordEvent?.(terminalEvent);
        await projectRunEventToSession(window.zion, sid, terminalEvent, {
          requestSource: "interactive",
          backend: "runtime",
          runtimeRunId: runId,
          panelId,
          assistantBlockId,
          documentWriter: false
        });
      }

      if (remoteRun.status === "waiting") {
        runtime.markWaiting(sid, runId, remoteRun.waiting);
      } else if (remoteRun.status === "completed") {
        runtime.markAwaiting(sid, runId);
        window.zion.commands.executeCommand("zion.sessions.bumpUpdatedAt", sid);
        window.zion?.events?.emit?.("chat/runFinished", {
          sessionId: sid,
          runId,
          recovered: true
        });
      } else if (remoteRun.status === "aborted") {
        runtime.markAborted(sid, runId);
      } else if (["failed", "interrupted"].includes(remoteRun.status)) {
        runtime.markError(
          sid,
          new Error(remoteRun.error || "Runtime Run failed"),
          runId
        );
        window.zion?.events?.emit?.("chat/runError", {
          sessionId: sid,
          runId,
          recovered: true,
          error: remoteRun.error || null
        });
      }
      runtime.syncGlobalStreamingForActiveSession();
      return remoteRun;
    } catch (error) {
      if (!observer.signal.aborted) {
        projectedSequences.delete(runId);
        const current = window.zion?.runs?.get?.(runId) || runRecord;
        window.zion?.runs?.start?.({
          ...current,
          status: "interrupted",
          completedAt: Date.now(),
          terminalReason: "runtime-reconnect-failed",
          error: error?.message || String(error),
          metadata
        });
        runtime.markError(sid, error, runId);
        runtime.syncGlobalStreamingForActiveSession();
      }
      return null;
    } finally {
      if (interactiveRuntimeObservers.get(runId) === observer) {
        interactiveRuntimeObservers.delete(runId);
      }
    }
  };

  const recoverInteractiveRuntimeRuns = () => {
    const candidates = window.zion?.runs?.list?.({
      status: ["queued", "running", "interrupted"]
    }) || [];
    for (const runRecord of candidates) {
      if (runRecord?.metadata?.backend === "runtime") {
        void recoverInteractiveRuntimeRun(runRecord);
      }
    }
  };

  const runtimeSessionRunSubscription = window.zion?.events?.on?.(
    "runtime/sessionRunEvent",
    (event = {}) => {
      if (
        event.type !== "run.started"
        || event.ownEvent === true
        || !event.runId
        || !event.sessionId
      ) {
        return;
      }
      void recoverInteractiveRuntimeRun({
        id: event.runId,
        attemptId: event.data?.attemptId || "",
        sessionId: event.sessionId,
        status: "running",
        metadata: {
          backend: "runtime",
          runtimeRunId: event.runId,
          runtimeBaseUrl: readInteractiveRuntimeConfig().baseUrl,
          assistantBlockId: event.runId,
          requestSource: "interactive"
        }
      });
    }
  );
  if (runtimeSessionRunSubscription) {
    ctx.subscriptions.push(runtimeSessionRunSubscription);
  }

  // 通用运行逻辑（含 Tool Calls 链式继续）
  const performRun = async (opts = {}, preparation) => {
    // #region debug-point B:submit-entry
    if (window.zion?.state?.get?.("debug.chatSubmitUrl")) void fetch(window.zion.state.get("debug.chatSubmitUrl"), { method: "POST", body: JSON.stringify({ sessionId: "chat-submit-latency", runId: window.zion.state.get("debug.chatSubmitPhase") || "pre-fix", hypothesisId: "B", location: "performRun:entry", msg: "[DEBUG] submit-entry", ts: Date.now() }) }).catch(() => {});
    // #endregion
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
    const hasExplicitEditorSession = !!(opts?.editor && opts?.sessionId);
    if (panelId && panelSessionId && sid !== panelSessionId && !hasExplicitEditorSession) {
      console.warn("[langchain-chat] run aborted: target session does not match editor panel", { panelId, sid, panelSessionId });
      return;
    }
    const runThinkingEffort = normalizeThinkingEffort(opts?.thinkingEffort);
    const skipSessionPersistence = !!opts?.skipSessionPersistence;
      const autoScrollAssistant = opts?.autoScrollAssistant !== false;
      const moveSelectionToAssistant = opts?.moveSelectionToAssistant !== false;
    const resolveActiveRunModel = () => getResolvedModelSnapshot(
      runThinkingEffort === "auto" ? null : { ...window.zion.state.get("chat.activeModel"), thinkingEffort: runThinkingEffort }
    );
    const runModel = resolveActiveRunModel();
    const streaming = !!getRunState(sid)?.streaming;
    if (streaming && getRunState(sid)?.runId !== preparation?.id) {
      console.log("[langchain-chat] already streaming in current session, abort");
      return; // 防止本会话并发；其他会话不受影响
    }

    // Start independent network reads while the document is being confirmed.
    const toolsPreparation = Promise.resolve().then(() =>
      window.zion?.commands?.executeCommand?.("tools.syncRuntime", { preferCached: true })
    ).catch(() => null).then(result => {
      preparation?.mark?.("toolsReadCompleted");
      return result;
    });
    const earlyRuntimeConfig = readInteractiveRuntimeConfig();
    const modelPreparation = earlyRuntimeConfig.mode !== "browser"
      ? Promise.all([
          Promise.resolve().then(() =>
            window.zion?.models?.getProvider?.(runModel?.providerId)?.resolve?.(runModel?.modelId)
          ).then(config => {
            preparation?.mark?.("providerConfigReadCompleted");
            return config;
          }),
          loadRuntimeModelProfiles().catch(() => null).then(profiles => {
            preparation?.mark?.("runtimeProfilesReadCompleted");
            return profiles;
          })
        ]).then(result => {
          preparation?.mark?.("modelReadCompleted");
          return result;
        })
      : null;
    // Attach a rejection handler immediately; the result is consumed below.
    modelPreparation?.catch(() => {});

    preparation?.mark?.("documentCaptured");

    // The command captures this before any asynchronous configuration or save.
    const inputSnapshot = preparation?.inputSnapshot || captureDocumentInput(ed, opts);
    const cursor = inputSnapshot.cursor;
    const fullDoc = inputSnapshot.documentText;
    // #region debug-point B:document-ready
    if (window.zion?.state?.get?.("debug.chatSubmitUrl")) void fetch(window.zion.state.get("debug.chatSubmitUrl"), { method: "POST", body: JSON.stringify({ sessionId: "chat-submit-latency", runId: window.zion.state.get("debug.chatSubmitPhase") || "pre-fix", hypothesisId: "B", location: "performRun:document-ready", msg: "[DEBUG] document-ready", ts: Date.now() }) }).catch(() => {});
    // #endregion
    const lines = fullDoc.split("\n");
    const cursorLine = cursor.line;
    const contentBeforeCursor = inputSnapshot.content;

    // 解析角色块
    let baseMessages = structuredClone(inputSnapshot.messages);
    let contextMessages = Array.isArray(opts?.contextMessages) ? opts.contextMessages : [];
    if (!contextMessages.length && (String(panelId || "").startsWith("comments:") || String(sid || "").startsWith("comment:"))) {
      try {
        const fallbackContext = await window.zion?.commands?.executeCommand?.("comments.getThreadContextMessages", {
          sessionId: sid,
          panelId
        });
        if (Array.isArray(fallbackContext) && fallbackContext.length) {
          contextMessages = fallbackContext;
        }
      } catch (e) {
        console.warn("[langchain-chat] comment context fallback failed:", e);
      }
    }
    if (contextMessages.length && !opts?.contextMessages?.length) {
      // 放行重建后的结构化消息：除了普通 string content 外，
      // 还接受 assistant.tool_calls 与 role:"tool"（tool_call_id）这类没有字符串 content 的消息，
      // 以便评论线程能继承父会话的思考/工具调用上下文（见 src/chat/widget-history.ts）。
      baseMessages.unshift(...contextMessages.filter((m) => {
        if (!m?.role) return false;
        if (typeof m.content === "string") return true;
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
        if (m.role === "tool" && m.tool_call_id) return true;
        return false;
      }));
    }
    if (baseMessages.length === 0) {
      window.zion.events.emit("chat/runError", { error: "No content to send" });
      console.log("[langchain-chat] no content, abort");
      return;
    }
    preparation?.signal.throwIfAborted();
    const savePreparation = !skipSessionPersistence
      ? Promise.resolve().then(() =>
          window.zion?.commands?.executeCommand?.(
            window.zion?.commands?.list?.().includes("zion.sessions.flushRunInput")
              ? "zion.sessions.flushRunInput"
              : "zion.sessions.flushPendingSave",
            sid
          )
        ).catch(() => false).then(result => {
          preparation?.mark?.("inputPersistenceCompleted");
          return result;
        })
      : Promise.resolve(true);

    const reconstructHistory = async (messages, resolvedConfig = null) => {
      const includeToolHistory = readChatBoolDefaultTrue("chat.includeToolHistory");
      const includeThinkingHistory = readChatBoolDefaultTrue("chat.includeThinkingHistory");
      if (!includeToolHistory && !includeThinkingHistory) return messages;
      try {
        let activeCfg = resolvedConfig;
        if (!activeCfg) {
          const provider = window.zion?.models?.getProvider?.(runModel?.providerId);
          activeCfg = await provider?.resolve?.(runModel?.modelId);
        }
        const mode = normalizeToolCallsReasoningContentMode(
          window.zion?.state?.get?.("chat.toolCallsReasoningContentMode")
        );
        const forceReasoning = shouldForceReasoningContentWithToolCalls({
          mode,
          modelId: runModel?.modelId,
          modelName: activeCfg?.modelName || runModel?.modelId,
          providerId: runModel?.providerId,
          providerType: activeCfg?.providerType,
          cfg: activeCfg
        });
        const annotations = inputSnapshot.annotations;
        return reconstructWidgetHistoryMessages(
          messages,
          contentBeforeCursor,
          annotations,
          {
            requireDocumentAnchors: true,
            includeToolHistory,
            includeThinkingHistory,
            preservedThinking: !!activeCfg?.preservedThinking,
            interleavedThinking: !!activeCfg?.interleavedThinking,
            forceReasoning,
            reasoningPlaceholder: DEFAULT_REASONING_CONTENT_PLACEHOLDER
          }
        );
      } catch (error) {
        if (isChatMessageAssemblyDebugEnabled()) {
          console.warn("[langchain-chat] widget history assembly failed", error);
        }
        return messages;
      }
    };

    // #region debug-point A:tools-start
    if (window.zion?.state?.get?.("debug.chatSubmitUrl")) void fetch(window.zion.state.get("debug.chatSubmitUrl"), { method: "POST", body: JSON.stringify({ sessionId: "chat-submit-latency", runId: window.zion.state.get("debug.chatSubmitPhase") || "pre-fix", hypothesisId: "A", location: "performRun:tools-start", msg: "[DEBUG] tools-start", ts: Date.now() }) }).catch(() => {});
    // #endregion
    try {
      await toolsPreparation;
      preparation?.mark?.("toolsReady");
    } catch {}
    // #region debug-point A:tools-ready
    if (window.zion?.state?.get?.("debug.chatSubmitUrl")) void fetch(window.zion.state.get("debug.chatSubmitUrl"), { method: "POST", body: JSON.stringify({ sessionId: "chat-submit-latency", runId: window.zion.state.get("debug.chatSubmitPhase") || "pre-fix", hypothesisId: "A", location: "performRun:tools-ready", msg: "[DEBUG] tools-ready", ts: Date.now() }) }).catch(() => {});
    // #endregion

    // 解析工具定义（委托给独立 tools 插件）
    const tools = window.zion?.commands?.executeCommand("tools.parseFromContent", contentBeforeCursor) || null;
    const requestSource = opts?.requestSource || inferRequestSource({
      sessionId: sid,
      panelId
    });
    const interactiveRuntimeConfig = readInteractiveRuntimeConfig();
    const interactiveRuntimeEligibilityResult = interactiveRuntimeEligibility({
      messages: baseMessages,
      tools,
      content: contentBeforeCursor,
      requestSource,
      skipSessionPersistence
    });
    if (
      interactiveRuntimeEligibilityResult.eligible
      && await shouldUseInteractiveRuntime(interactiveRuntimeConfig)
    ) {
      preparation?.signal.throwIfAborted();
      // Input durability belongs to admission. Working-copy saves continue
      // independently; a later edit must neither change nor cancel this input.
      void savePreparation;
      preparation?.signal.throwIfAborted();
      // #region debug-point B:save-ready
      if (window.zion?.state?.get?.("debug.chatSubmitUrl")) void fetch(window.zion.state.get("debug.chatSubmitUrl"), { method: "POST", body: JSON.stringify({ sessionId: "chat-submit-latency", runId: window.zion.state.get("debug.chatSubmitPhase") || "pre-fix", hypothesisId: "B", location: "performRun:save-ready", msg: "[DEBUG] save-ready", ts: Date.now() }) }).catch(() => {});
      // #endregion
      const insertionOffset = inputSnapshot.insertionOffset;
      let documentAnchor = preparation?.documentAnchor || {
        kind: "y-relative-position-v1",
        fallback: {
          offset: insertionOffset,
          before: fullDoc.slice(
            Math.max(0, insertionOffset - 64),
            insertionOffset
          ),
          after: fullDoc.slice(insertionOffset, insertionOffset + 64)
        }
      };
      try {
        if (!preparation?.documentAnchor) {
        documentAnchor = window.zion?.commands?.executeCommand?.(
          "zion.sessions.createCollaborationAnchor",
          {
            id: sid,
            index: insertionOffset,
            before: documentAnchor.fallback.before,
            after: documentAnchor.fallback.after
          }
        ) || documentAnchor;
        }
      } catch {}
      const runtimeResult = await runInteractiveThroughRuntime({
        opts,
        ed,
        panelId,
        sid,
        cursor,
        messages: baseMessages,
        tools,
        runModel,
        requestSource,
        runtimeConfig: interactiveRuntimeConfig,
        documentAnchor,
        reconstructHistory,
        autoScrollAssistant,
        preparation,
        modelPreparation
      });
      if (!runtimeResult?.fallbackToBrowser) return runtimeResult;
    }
    const latestUser = baseMessages.filter((message) => message.role === "user").at(-1);
    if (opts?.metadata?.goal || (typeof latestUser?.content === "string" && /^\s*\/goal(?:\s|$)/.test(latestUser.content))) {
      throw new Error("持续目标需要可用的 Zion Runtime，请检查 Runtime 连接和模型配置。");
    }

    // 3. 插入 assistant 块（用于承载输出）
    preparation?.signal.throwIfAborted();
    preparation?.release();
    const startedAt = Date.now();
    const runId = "run_" + Math.random().toString(36).slice(2);
    const { anchor, insertLine } = insertAssistantBlock(ed, {
      sessionId: sid,
      assistantBlockId: runId,
      state: window.zion.state,
      cursor
    });
    // 4. 状态 & 事件
    const contributorCtx = {
      editor: ed,
      sessionId: sid,
      panelId,
      requestSource: opts?.requestSource || inferRequestSource({ sessionId: sid, panelId }),
      runId
    };
    const runAnchorPayload = {
      assistantBlockId: anchor?.assistantBlockId || runId,
      answerAnchorPos: typeof anchor?.anchorPos === "number" ? anchor.anchorPos : null,
      answerHeadLine: typeof anchor?.headLine === "number" ? anchor.headLine : null,
      insertLine
    };
    const ledgerSource = opts?.source || {
      pluginId: "dev.langchain-chat",
      kind: "chat-session",
      id: sid
    };
    const runDisplayName = resolveRunDisplayName(opts, sid);
    const runMetadata = {
      ...(opts?.metadata && typeof opts.metadata === "object" ? opts.metadata : {}),
      requestSource: contributorCtx.requestSource
    };
    if (runDisplayName && !runMetadata.displayName) runMetadata.displayName = runDisplayName;
    if (runDisplayName && !runMetadata.sessionTitle) runMetadata.sessionTitle = runDisplayName;
    if (opts?.sourceTitle && !runMetadata.sourceTitle) runMetadata.sourceTitle = compactRunTitle(opts.sourceTitle);
    const recordRunEvent = (type, data = {}) => {
      try {
        window.zion?.runs?.recordEvent?.({
          runId,
          type,
          ts: Date.now(),
          data
        });
      } catch {}
    };
    try {
      window.zion?.runs?.start?.({
        id: runId,
        title: opts?.title || runDisplayName || "",
        source: ledgerSource,
        trigger: opts?.trigger || "user",
        sessionId: sid,
        panelId,
        executionMode: "interactive",
        model: runModel,
        metadata: runMetadata
      });
    } catch {}
    runtime.beginRun(sid, runId);
    setRunState(sid, { aborted: false, model: runModel }, runId);
    recordRunEvent("run.started", {
      executionMode: "interactive",
      model: runModel
    });
    window.zion.events.emit("chat/runStarted", {
      runId,
      sessionId: sid,
      panelId,
      model: runModel,
      editorView: ed?.getView?.(),
      followCycleId: preparation?.id || runId,
      ...runAnchorPayload
    });
      if (autoScrollAssistant && typeof anchor?.headLine === "number") {
      scheduleDocLineVisible(ed, anchor.headLine, {
        sessionId: sid,
        forceBottom: true,
        structuralRole: true,
        traceId: runId,
        followCycleId: preparation?.id || runId,
        initial: true
      });
      } else if (autoScrollAssistant) {
      scheduleAssistantLatestVisible(ed, {
        startLineHint: insertLine,
        sessionId: sid,
        traceId: runId,
        followCycleId: preparation?.id || runId,
        initial: true
      });
    }

    // 工具调用收集（多步链式调用在每一步内局部收集）
    let aborted = false;
    let failed = false;
    const isThisRunActive = () => !aborted && !failed && runtime.isRunActive(sid, runId);
      const reportRunError = (value) => {
        if (!runtime.isCurrentRun(sid, runId)) return false;
        const error = value instanceof Error
          ? value
          : new Error(String(value?.message || value || "大模型调用失败"));
        try { tokenBuffer?.flush?.(); } catch {}
        if (!runtime.markError(sid, error, runId)) return false;
        failed = true;
        recordRunEvent("run.failed", { error: error.message });
        window.zion.events.emit("chat/runError", { runId, error, sessionId: sid, panelId });
        const message = `大模型调用失败: ${error.message}`;
        try {
          if (typeof window.zion?.notification?.show === "function") {
            window.zion.notification.show(message, {
              type: "error",
              duration: 8000
            });
          } else {
            window.showToast?.(message);
          }
        } catch (notifyError) {
          console.error("[langchain-chat] failed to show error notification:", notifyError);
        }
        return true;
      };

    // 通用 token 写入逻辑（写入同一个 assistant block，批量 flush 以降低刷新压力）
    // TokenBuffer：约两帧批量写入，同一行追加，触底才自动滚动
    const tokenBuffer = (() => {
      let acc = [];
      let timer = null;
      let hasAppendedToken = false;
      const interval = 32; // ms

      const flushImpl = () => {
        timer = null;
        if (acc.length === 0) return;
        const text = acc.join("");
        acc = [];
        if (!isThisRunActive()) {
          return;
        }

        const editorShowingSession = isEditorShowingSession(ed, sid);
        if (!editorShowingSession) {
          try {
            window.zion.commands.executeCommand("zion.sessions.appendAssistantToken", {
              id: sid,
              token: text,
              runId,
              assistantBlockId: runAnchorPayload.assistantBlockId
            });
            window.zion.events.emit("chat/token", {
              runId,
              token: text,
              sessionId: sid,
              panelId,
              editorView: ed?.getView?.(),
              followCycleId: preparation?.id || runId
            });
            hasAppendedToken = true;
          } catch (e) {
            console.error("[langchain-chat] background append token error:", e);
          }
          return;
        }

        try {
          const appended = appendAssistantTokenToEditor(ed, {
            token: text,
            anchor,
              startLineHint: insertLine,
              moveSelectionToAssistant
          });
          if (!appended) {
            return;
          }
          const initialToken = !hasAppendedToken;
          hasAppendedToken = true;
          window.zion.events.emit("chat/token", {
            runId,
            token: text,
            sessionId: sid,
            panelId,
            editorView: ed?.getView?.(),
            followCycleId: preparation?.id || runId
          });

          // 触底才自动滚动（避免用户上拉时被抢滚）
          const scroller = ed?.getView?.()?.scrollDOM || document.querySelector(".cm-scroller");
          if (scroller) {
            const followLatest = isConversationViewportFollowing(
              ed?.getView?.(),
              {
                sessionId: sid,
                state: window.zion?.state
              }
            );
              if (autoScrollAssistant && followLatest) {
              scheduleAssistantLatestVisible(ed, {
                startLineHint: insertLine,
                sessionId: sid,
                traceId: runId,
                followCycleId: preparation?.id || runId,
                initial: initialToken
              });
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

    let runOutput = "";
    const appendToken = (tk) => {
      if (!isThisRunActive()) return;
      runOutput += String(tk || "");
      tokenBuffer.push(tk);
    };

    // 在最终阶段追加换行并清理（先 flush 剩余缓冲）
    const finalizeCompleted = () => {
      if (!isThisRunActive()) {
        tokenBuffer.stop();
        return false;
      }
      try { tokenBuffer.flush(); } catch {}
        let autoInsert = typeof opts?.autoInsertUserPrompt === "boolean"
          ? opts.autoInsertUserPrompt
          : window.zion?.state?.get('chat.autoInsertUserPrompt');
      if (autoInsert === undefined) {
        autoInsert = true;
        try { window.zion?.state?.set('chat.autoInsertUserPrompt', true); } catch {}
      }
        let autoFocus = typeof opts?.autoFocusUserPrompt === "boolean"
          ? opts.autoFocusUserPrompt
          : window.zion?.state?.get('chat.autoFocusUserPrompt');
      if (autoFocus === undefined) {
        autoFocus = true;
        try { window.zion?.state?.set('chat.autoFocusUserPrompt', true); } catch {}
      }
      const editorShowingSession = isEditorShowingSession(ed, sid);
      if (editorShowingSession) {
        try {
          const finalized = finalizeAssistantBlock(ed, {
            anchor,
            startLineHint: insertLine,
            autoInsertUserPrompt: !!autoInsert,
            autoFocusUserPrompt: !!autoFocus
          });
          const followLatest = isConversationViewportFollowing(
            ed?.getView?.(),
            {
              sessionId: sid,
              state: window.zion?.state
            }
          );
            if (autoScrollAssistant && followLatest) {
            if (typeof finalized?.userLine === "number") {
              scheduleDocLineVisible(ed, finalized.userLine, {
                sessionId: sid,
                forceBottom: true,
                structuralRole: true,
                traceId: runId,
                followCycleId: preparation?.id || runId
              });
            } else {
              ensureTrailingUserPromptVisible(ed, { startLineHint: insertLine, sessionId: sid, traceId: runId });
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
          if (!skipSessionPersistence && finalized.text !== currentDoc) {
            window.zion.commands.executeCommand("zion.sessions.setDoc", { id: sid, text: finalized.text });
          }
        } catch {}
      }
      tokenBuffer.stop();
      if (!runtime.markAwaiting(sid, runId)) return false;
      if (!skipSessionPersistence) window.zion.commands.executeCommand("zion.sessions.bumpUpdatedAt", sid);
      recordRunEvent("run.completed", {
        output: runOutput,
        durationMs: Date.now() - startedAt
      });
      window.zion.events.emit("chat/runFinished", { runId, sessionId: sid, panelId });
      return true;
    };

    const stopRunLocally = () => {
      tokenBuffer.stop();
    };

    // 单步调用（收集本步工具调用并执行，返回本步的调用与结果）
    const runStep = async (msgs) => {
      if (!isThisRunActive()) return { calls: [], results: [], aborted: true };
      const calls = [];
      const resultsById = new Map();
      const receivedResults = [];
      const promises = [];

      let stepReasoning = "";
      const stepIndex = Number(window.zion?.state?.get?.(`chat.usageStep.${runId}`) || 0) + 1;
      try { window.zion?.state?.set?.(`chat.usageStep.${runId}`, stepIndex); } catch {}
      const stepModel = resolveActiveRunModel();
      setRunState(sid, { model: stepModel }, runId);
      recordRunEvent("turn.started", {
        turn: stepIndex,
        model: stepModel
      });
      try {
        const prov = window.zion?.models?.getProvider?.(stepModel?.providerId);
        const cfg = await prov?.resolve?.(stepModel?.modelId);
        const contextWindow = buildContextWindowSnapshot({
          sessionId: sid,
          messages: msgs,
          model: stepModel,
          cfg,
          state: window.zion?.state
        });
        recordRunEvent("context.window", {
          ...contextWindow,
          turn: stepIndex,
          model: stepModel
        });
        window.zion?.events?.emit?.("chat/contextWindow", {
          runId,
          sessionId: sid,
          panelId,
          stepIndex,
          model: stepModel,
          ...contextWindow
        });
      } catch (error) {
        console.warn("[langchain-chat] context window estimate failed:", error);
      }
      const streamResult = await runStream({
        messages: msgs,
        tools,
        activeModel: stepModel,
        onToken: appendToken,
        beforeControlEvent: () => {
          try { tokenBuffer.flush(); } catch {}
        },
        onToolCall: (tc) => {
          if (!isThisRunActive()) return;
          try { tokenBuffer.flush(); } catch {}
          const cardId = createToolCardId(runId, tc.id);
          // 收集本步的 assistant tool_calls
          calls.push({ id: tc.id, name: tc.name, args: tc.args });
          // 执行工具并收集结果
          window.zion.events.emit("chat/toolCall", {
            runId,
            cardId,
            toolCall: { ...tc, cardId },
            sessionId: sid,
            panelId,
            ...runAnchorPayload
          });
          recordRunEvent("tool.requested", {
            turn: stepIndex,
            callId: tc.id,
            name: tc.name,
            args: tc.args
          });
          const p = executeToolCall({ ...tc, cardId, runId }, sid)
            .then(res => {
              if (!isThisRunActive()) return;
              const content = String(res || "");
              const item = { id: tc.id, content };
              resultsById.set(tc.id, item);
              receivedResults.push(item);
              const ok = inferToolOk(tc.name, res);
              const toolError = inferToolResultError(tc.name, res, ok);
              window.zion.events.emit("chat/toolResult", {
                runId,
                cardId,
                toolCallId: tc.id,
                result: res,
                ok,
                sessionId: sid,
                panelId,
                assistantBlockId: runAnchorPayload.assistantBlockId
              });
              recordRunEvent("tool.completed", {
                turn: stepIndex,
                callId: tc.id,
                name: tc.name,
                result: content,
                ...(toolError ? { error: toolError } : {})
              });
            })
            .catch(err => {
              if (!isThisRunActive()) return;
              const msg = `Tool "${tc.name}" failed: ${err?.message || String(err)}`;
              const item = { id: tc.id, content: msg };
              resultsById.set(tc.id, item);
              receivedResults.push(item);
              window.zion.events.emit("chat/toolResult", {
                runId,
                cardId,
                toolCallId: tc.id,
                result: msg,
                ok: false,
                sessionId: sid,
                panelId,
                assistantBlockId: runAnchorPayload.assistantBlockId
              });
              recordRunEvent("tool.completed", {
                turn: stepIndex,
                callId: tc.id,
                name: tc.name,
                error: err?.message || String(err)
              });
            });
          promises.push(p);
        },
        onInvalidToolCall: (tc) => {
          if (!isThisRunActive()) return;
          const id = String(tc?.id || "");
          const name = String(tc?.name || "tool");
          if (!id) return;
          const cardId = createToolCardId(runId, id);
          const args = tc?.args && typeof tc.args === "object" ? tc.args : {};
          calls.push({ id, name, args });
          const msg = `Invalid tool call arguments for "${name}": ${tc?.error || "invalid arguments"}`;
          const item = { id, content: msg };
          resultsById.set(id, item);
          receivedResults.push(item);
          window.zion.events.emit("chat/toolCall", {
            runId,
            cardId,
            toolCall: { id, cardId, name, args },
            sessionId: sid,
            panelId,
            ...runAnchorPayload
          });
          window.zion.events.emit("chat/toolResult", {
            runId,
            cardId,
            toolCallId: id,
            result: msg,
            ok: false,
            sessionId: sid,
            panelId,
            assistantBlockId: runAnchorPayload.assistantBlockId
          });
          recordRunEvent("tool.denied", {
            turn: stepIndex,
            callId: id,
            name,
            reason: tc?.error || "invalid arguments"
          });
        },
        onEnd: () => { /* 中间步骤不清理，留到链式结束后统一 finalize */ },
        onError: (e) => {
          if (!runtime.isCurrentRun(sid, runId)) return;
          if (e?.name === "AbortError") {
            aborted = true;
            runtime.markAborted(sid, runId);
            return;
          }
            reportRunError(e);
        },
        getController: (controller) => {
          runtime.setController(sid, controller, runId);
        },
        runId,
        sessionId: sid,
        panelId,
        requestSource: opts?.requestSource || inferRequestSource({ sessionId: sid, panelId }),
        stepIndex,
        ...runAnchorPayload
      });

      stepReasoning = String(streamResult?.reasoning_content || "");
      if (streamResult?.aborted) {
        aborted = true;
        runtime.markAborted(sid, runId);
        return { calls: [], results: [], reasoning_content: stepReasoning, aborted: true };
      }
      if (streamResult?.usage) {
        try {
          const prov = window.zion?.models?.getProvider?.(stepModel?.providerId);
          const cfg = await prov?.resolve?.(stepModel?.modelId);
          window.zion?.usage?.record?.({
            runId,
            sessionId: opts?.usageSessionId || sid,
            panelId,
            providerId: stepModel?.providerId,
            providerType: cfg?.providerType || stepModel?.providerId,
            modelId: stepModel?.modelId,
            modelName: cfg?.modelName || stepModel?.modelId,
            label: stepModel?.label || cfg?.label || cfg?.modelName || stepModel?.modelId,
            stepIndex,
            usage: streamResult.usage,
            cfg
          });
          window.zion?.runs?.recordUsage?.({
            runId,
            sessionId: opts?.usageSessionId || sid,
            panelId,
            model: stepModel,
            stepIndex,
            usage: streamResult.usage
          });
        } catch {}
      }

      // 等待工具执行完成，确保生成 tool 结果
      if (promises.length > 0) {
        try { await Promise.allSettled(promises); } catch {}
      }

      const seenResultIds = new Set();
      const results = receivedResults
        .filter((item) => {
          const id = String(item?.id || "");
          if (!id || seenResultIds.has(id)) return false;
          seenResultIds.add(id);
          return true;
        });
      for (const call of calls) {
        const id = String(call?.id || "");
        if (!id || seenResultIds.has(id)) continue;
        const item = resultsById.get(id);
        if (item) {
          seenResultIds.add(id);
          results.push(item);
        }
      }
      if (!isThisRunActive()) {
        return { calls: [], results: [], reasoning_content: stepReasoning, aborted, failed };
      }
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
          msgs = await window.zion.__runMessageContributors(msgs, "pre", contributorCtx);
          if (dbgCompression) {
            const afterCount = Array.isArray(msgs) ? msgs.length : 0;
            console.log('[langchain-chat]', 'run contributors: pre done', { stage: 'pre', beforeMessages: beforeCount, afterMessages: afterCount });
          }
        } catch (e) {
          console.warn("[langchain-chat] pre contributors error:", e);
        }
      }

      msgs = await reconstructHistory(msgs);

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
            msgs = await window.zion.__runMessageContributors(msgs, "post", contributorCtx);
            if (dbgCompression) {
              const afterCount = Array.isArray(msgs) ? msgs.length : 0;
              console.log('[langchain-chat]', 'run contributors: post done', { stage: 'post', beforeMessages: beforeCount, afterMessages: afterCount });
            }
          } catch (e) {
            console.warn("[langchain-chat] post contributors error:", e);
          }
        }

        const step = await runStep(msgs);
        if (step?.aborted || aborted || failed || !runtime.isCurrentRun(sid, runId)) {
          stopRunLocally();
          return;
        }

        // 若本步产生了工具调用与结果，则构造下一步消息继续
        if (step.calls.length > 0) {
          const active = runModel;
          const mode = normalizeToolCallsReasoningContentMode(window.zion?.state?.get?.("chat.toolCallsReasoningContentMode"));
          let activeCfg = null;
          try {
            const prov = window.zion?.models?.getProvider?.(active?.providerId);
            activeCfg = await prov?.resolve?.(active?.modelId);
          } catch {}
          const forceReasoning = shouldForceReasoningContentWithToolCalls({
            mode,
            modelId: active?.modelId,
            modelName: activeCfg?.modelName || active?.modelId,
            providerId: active?.providerId,
            providerType: activeCfg?.providerType,
            cfg: activeCfg
          });

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
      finalizeCompleted();
    } catch (e) {
      console.error("[langchain-chat] runStream outer error:", e);
      stopRunLocally();
        const runState = getRunState(sid);
        if (e?.name === "AbortError" || !runtime.isCurrentRun(sid, runId) || runState?.aborted) {
        aborted = true;
          if (runtime.isCurrentRun(sid, runId) && !runState?.error) {
            runtime.markAborted(sid, runId);
          }
        return;
      }
        if (runState?.error) return;
        reportRunError(e);
    }
  };

  const doRun = async (opts = {}) => {
    if (!accountCan("run.execute")) return;
    const ed = getEd(opts);
    const selection = ed?.getView?.()?.state?.selection?.main;
    opts = {
      ...opts,
      useSelection: typeof opts.useSelection === "boolean"
        ? opts.useSelection
        : !!(selection?.to > selection?.from || ed?.getSelection?.())
    };
    const panelId = opts?.panelId || ed?.panelId || null;
    const sid = getSessionId({ ...opts, panelId });
    if (!ed || !sid || getRunState(sid)?.streaming || interactivePreparations.has(sid)) return;
    const current = getRunState(sid);
    if (current?.waiting?.id && current.runId) {
      let text;
      try {
        text = captureDocumentInput(ed, opts).content;
      } catch (error) {
        window.zion?.notification?.show?.(error?.message || "请在输入区填写回复。", { type: "error" });
        return { status: "invalid-input", error };
      }
      const last = parseMessages(text).filter((message) => message.role === "user").at(-1);
      if (!last?.content?.trim()) throw new Error("请在输入区填写回复。");
      let input = last.content;
      try { input = JSON.parse(last.content); } catch {}
      const record = window.zion?.runs?.get?.(current.runId);
      const baseUrl = record?.metadata?.runtimeBaseUrl || readInteractiveRuntimeConfig().baseUrl;
      const remote = await respondInteractiveRuntimeRun({
        runtimeRunId: current.runId, waitId: current.waiting.id, input, baseUrl
      });
      return await recoverInteractiveRuntimeRun({ ...record, id: current.runId, sessionId: sid,
        metadata: { ...record?.metadata, backend: "runtime", runtimeBaseUrl: baseUrl }, status: remote.status });
    }
    const id = `preparing-${crypto.randomUUID()}`;
    const expectedAccount = captureInteractiveRuntimeAccount();
    const controller = new AbortController();
    const submittedAt = Date.now();
    const timings = { submittedAt, clientRequestId: id, stages: {} };
    const mark = (stage) => {
      if (timings.stages[stage] == null) timings.stages[stage] = Date.now() - submittedAt;
    };
    const view = ed.getView?.();
    let inputSnapshot;
    try {
      inputSnapshot = captureDocumentInput(ed, {
        ...opts,
        submissionId: id,
        annotations: window.zion?.commands?.executeCommand?.(
          "zion.chatCards.getSessionAnnotations", sid
        ) || {}
      });
    } catch (error) {
      window.zion?.notification?.show?.(
        error?.message || "无法发送当前内容。", { type: "error" }
      );
      return { status: "invalid-input", error };
    }
    const insertionOffset = inputSnapshot.insertionOffset;
    const fallback = {
      offset: insertionOffset,
      before: inputSnapshot.documentText.slice(Math.max(0, insertionOffset - 64), insertionOffset),
      after: inputSnapshot.documentText.slice(insertionOffset, insertionOffset + 64)
    };
    const documentAnchor = window.zion?.commands?.executeCommand?.(
      "zion.sessions.createCollaborationAnchor",
      { id: sid, index: insertionOffset, before: fallback.before, after: fallback.after }
    ) || { kind: "y-relative-position-v1", fallback };
    mark("inputCaptured");
    beginConversationViewportFollow(view, {
      sessionId: sid,
      state: window.zion?.state,
      cycleId: id,
      followLatest: opts?.followLatest !== false
    });
    let feedbackState = "";
    const clearFeedback = ({ waitForDocument = false } = {}) => {
      const next = waitForDocument ? "document" : "cleared";
      if (feedbackState === "cleared" || feedbackState === next) return;
      feedbackState = next;
      window.zion.events.emit("chat/prepared", {
        sessionId: sid, submissionId: id, waitForDocument
      });
    };
    const release = () => {
      if (!feedbackState) clearFeedback();
      runtime.clearController(sid, id);
      if (runtime.isRunActive(sid, id)) runtime.markAwaiting(sid, id);
      if (interactivePreparations.get(sid) === id) interactivePreparations.delete(sid);
      for (const [runId, record] of [...pendingRecoveryRuns]) {
        if (interactivePreparations.has(sid)) break;
        if (record.sessionId !== sid) continue;
        pendingRecoveryRuns.delete(runId);
        void recoverInteractiveRuntimeRun(record);
      }
    };
    interactivePreparations.set(sid, id);
    runtime.beginRun(sid, id);
    window.zion.events.emit("chat/preparing", {
      sessionId: sid, submissionId: id, editorView: view,
      answerAnchorPos: insertionOffset, followCycleId: id
    });
    mark("feedbackDispatched");
    runtime.setController(sid, { abort() {
      controller.abort();
      clearFeedback();
      if (interactivePreparations.get(sid) === id) interactivePreparations.delete(sid);
    } }, id);
    try {
      if (window.zion?.state?.get?.("workbench.accessChanged")) {
        throw new Error("账户或访问权限已变化，请重新进入工作台");
      }
      return await performRun(opts, {
        id, signal: controller.signal, clearFeedback, release, timings, mark, expectedAccount,
        inputSnapshot, documentAnchor,
        accept(runId) {
          window.zion.events.emit("chat/preparing", {
            sessionId: sid, submissionId: id, assistantBlockId: runId,
            editorView: view, answerAnchorPos: insertionOffset,
            followCycleId: id
          });
          // Transfer cancellation ownership without aborting the accepted run.
          runtime.clearController(sid, id);
          interactivePreparations.delete(sid);
          pendingRecoveryRuns.delete(runId);
        }
      });
    } catch (error) {
      clearFeedback();
      if (controller.signal.aborted) return { status: "aborted" };
      runtime.markError(sid, error, id);
      window.zion.events.emit("chat/runError", { error, sessionId: sid, panelId });
      throw error;
    } finally {
      release();
    }
  };

  // 注册命令：默认从光标所在行继续；有选区时只发送选区。
  const cmds = [
    window.zion.commands.registerCommand("chat.submit", (opts) => doRun(opts || {})),
    window.zion.commands.registerCommand("chat.runSelection", (opts) => doRun({ ...opts, useSelection: true })),
    window.zion.commands.registerCommand("chat.run", (opts) => doRun(opts || {})),
    window.zion.commands.registerCommand("chat.mockCurrentMessages", (opts) => buildMockCurrentMessages(opts || {})),
    window.zion.commands.registerCommand("chat.stop", (sid) => {
      const targetSid = sid || (() => {
        const activePanelId = window.zion?.panels?.getActivePanelId?.();
        if (activePanelId) {
          return window.zion?.panels?.list?.().find((p) => p.id === activePanelId)?.activeTabId || null;
        }
        return null;
      })();
        return stopAnySession(targetSid || undefined);
    }),
    window.zion.commands.registerCommand("chat.retry", (opts) => doRun(opts || {}))
  ];
  ctx.subscriptions.push(...cmds);
  const resumeReadyRuns = () => {
    if (!recoveryReady()) return;
    for (const record of pendingRecoveryRuns.values()) void recoverInteractiveRuntimeRun(record);
    pendingRecoveryRuns.clear();
    recoverInteractiveRuntimeRuns();
    const sid = window.zion?.state?.get("sessions.currentId");
    if (sid) void window.zion.commands.executeCommand("zion.sessions.discoverActiveRun", sid);
  };
  for (const key of ["sessions.ready", "workbench.pluginsReady"]) {
    const subscription = window.zion?.state?.onDidChange?.(key, resumeReadyRuns);
    if (subscription) ctx.subscriptions.push(subscription);
  }
  resumeReadyRuns();

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
    const catalog = window.zion.state.get("models.catalog") || [];
    const item = catalog.find(m => `${m.providerId}:${m.id}` === String(spec));
    if (!item) return;
    window.zion.state.set("chat.activeModel", { providerId: item.providerId, modelId: item.id,
      ...(item.runtimeProfileId ? { profileId: item.runtimeProfileId } : {}), label: item.label || item.id });
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
  const dispOpenSwitcher = window.zion.commands.registerCommand("models.openSwitcher", () => {
    modelSwitcher?.open?.();
    void refreshCatalog();
  });
  const dispCloseSwitcher = window.zion.commands.registerCommand("models.closeSwitcher", () => {
    modelSwitcher?.close?.();
  });
  ctx.subscriptions.push(dispListProviders, dispListModels, dispSelectModel, dispNextModel, dispPrevModel, dispOpenSwitcher, dispCloseSwitcher);

  // 注册快捷键
  const kbs = [
    window.zion.keybindings.register({ command: "chat.submit", key: "Mod-Enter", when: "editorFocus" }),
    window.zion.keybindings.register({ command: "chat.stop", key: "Escape", when: "editorFocus" }),
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

    const getActiveThinkingEffortSync = () => {
      const active = window.zion.state.get("chat.activeModel");
      if (!active?.providerId || !active?.modelId) return "auto";
      if (active.thinkingEffort) {
        return normalizeThinkingEffort(active.thinkingEffort);
      }
      try {
        if (active.providerId === "user.dynamic") {
          const dict = loadLocalDynamicModelStore();
          return normalizeThinkingEffort(dict?.[active.modelId]?.thinkingEffort);
        }
        const key =
          active.providerId === "deepseek" ? "zion.deepseek.config" :
          active.providerId === "anthropic" ? "zion.claude.config" :
          active.providerId === "google" ? "zion.gemini.config" :
          "";
        if (!key) return "auto";
        const cfg = loadProviderConfig(key);
        return normalizeThinkingEffort(cfg?.thinkingEffort);
      } catch {
        return "auto";
      }
    };

    const buildThinkingRunMenuItems = () => {
      const active = window.zion.state.get("chat.activeModel") || {};
      const providerType =
        active.providerId === "anthropic" ? "claude" :
        active.providerId === "google" ? "gemini" :
        "openai";
      const values = getSupportedThinkingEfforts({
        providerId: active.providerId,
        providerType,
        modelId: active.modelId,
        modelName: active.modelId
      }).filter((value) => value !== "auto");
      const current = getActiveThinkingEffortSync();
      return values.map((value) => ({
        command: `chat.setThinkingEffort.${value}`,
        title: `${current === value ? "✓ " : ""}思考强度：${getThinkingEffortOptionLabel(value)}`,
        when: "editorFocus"
      }));
    };

    const rebuildContextMenu = () => {
      const active = window.zion.state.get("chat.activeModel");
      const defaultLabel = active?.label || active?.modelId || "unknown";
      const thinkingEffort = getActiveThinkingEffortSync();
      const thinkingText = thinkingEffort === "auto" ? "模型默认" : getThinkingEffortOptionLabel(thinkingEffort);
        runChatMenuItem.title = t("cmd.run", "Run Chat");
        runChatMenuItem.subtitle = `${defaultLabel} · ${thinkingText}`;
      runChatMenuItem.submenu = buildThinkingRunMenuItems();
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
      window.zion.state.onDidChange("models.catalog", rebuildContextMenu),
      window.zion.events.on("models/configChanged", rebuildContextMenu)
    );
  }

  // 状态栏 Model 按钮（动态展示与切换）
  let modelBtnDisp = null;
  let thinkingBtnDisp = null;
  let modelStatusSeq = 0;
  const providerConfigKey = (providerId) => {
    if (providerId === "deepseek") return "zion.deepseek.config";
    if (providerId === "anthropic") return "zion.claude.config";
    if (providerId === "google") return "zion.gemini.config";
    return "";
  };
  const saveActiveModelConfigPatch = async (patch) => {
    const active = window.zion.state.get("chat.activeModel");
    if (!active?.providerId || !active?.modelId) return;
    if (active.providerId === "user.dynamic") {
      const dict = loadLocalDynamicModelStore();
      let resolved = {};
      try {
        resolved = await window.zion.models
          .getProvider(active.providerId)
          ?.resolve?.(active.modelId) || {};
      } catch {}
      const prev = {
        ...resolved,
        ...(dict[active.modelId] || {})
      };
      await upsertDynamicModel({
        modelId: active.modelId,
        config: { ...prev, ...patch }
      });
    } else {
      const key = providerConfigKey(active.providerId);
      if (!key) return;
      saveProviderConfigPatch(key, patch);
    }
    window.zion.state.set("chat.activeModel", {
      ...active,
      ...patch
    });
    try { await window.zion.commands.executeCommand("models.listModels"); } catch {}
    try { window.zion.events.emit("models/configChanged", { providerId: active.providerId, modelId: active.modelId }); } catch {}
    await updateModelBtn();
  };
  const setActiveThinkingEffort = async (effort) => {
    const next = normalizeThinkingEffort(effort);
    if (next === "auto") return;
    await saveActiveModelConfigPatch({
      thinkingEffort: next,
      thinkingMode: "on"
    });
    try {
      window.zion?.notification?.show?.(`思考强度已切换为：${getThinkingEffortOptionLabel(next)}`, {
        type: "info",
        duration: 2200
      });
    } catch {}
  };
  ctx.subscriptions.push(
    window.zion.commands.registerCommand("chat.setThinkingEffort.minimal", () => setActiveThinkingEffort("minimal")),
    window.zion.commands.registerCommand("chat.setThinkingEffort.low", () => setActiveThinkingEffort("low")),
    window.zion.commands.registerCommand("chat.setThinkingEffort.medium", () => setActiveThinkingEffort("medium")),
    window.zion.commands.registerCommand("chat.setThinkingEffort.high", () => setActiveThinkingEffort("high")),
    window.zion.commands.registerCommand("chat.setThinkingEffort.xhigh", () => setActiveThinkingEffort("xhigh")),
    window.zion.commands.registerCommand("chat.setThinkingEffort.max", () => setActiveThinkingEffort("max"))
  );
  const toggleActiveThinkingMode = async () => {
    const active = window.zion.state.get("chat.activeModel");
    if (!active?.providerId || !active?.modelId) return;
    let cfg = null;
    try {
      cfg = await window.zion.models.getProvider(active.providerId)?.resolve?.(active.modelId);
    } catch {}
    const current = normalizeThinkingMode(
      active.thinkingMode ?? cfg?.thinkingMode
    );
    const next = current === "on" ? "off" : "on";
    await saveActiveModelConfigPatch({
      thinkingMode: next
    });
  };
  const cycleActiveThinkingEffort = async () => {
    const active = window.zion.state.get("chat.activeModel");
    if (!active?.providerId || !active?.modelId) return;
    let cfg;
    try { cfg = await window.zion.models.getProvider(active.providerId)?.resolve?.(active.modelId); } catch {}
    const values = getSupportedThinkingEfforts({
      providerId: active.providerId,
      providerType: cfg?.providerType,
      modelId: active.modelId,
      modelName: cfg?.modelName,
      cfg
    }).filter(value => value !== "auto");
    if (!values.length) return toggleActiveThinkingMode();
    const configured = normalizeThinkingEffort(active.thinkingEffort ?? cfg?.thinkingEffort);
    const current = configured === "auto" && /^glm-5\.3(?:-flash)?$/i.test(cfg?.modelName || active.modelId)
      ? "low" : configured;
    await setActiveThinkingEffort(values[(values.indexOf(current) + 1) % values.length]);
  };
  const buildModelStatus = ({ active, cfg, activeItem }) => {
    const effectiveCfg = {
      ...(cfg || {}),
      ...(active?.thinkingMode != null
        ? { thinkingMode: active.thinkingMode }
        : {}),
      ...(active?.thinkingEffort != null
        ? { thinkingEffort: active.thinkingEffort }
        : {})
    };
    const modelLabel = active?.label || activeItem?.label || active?.modelId || "unknown";
    const providerId = active?.providerId || activeItem?.providerId || effectiveCfg.providerId || "";
    const modelId = active?.modelId || activeItem?.id || effectiveCfg.id || "";
    const modelName = effectiveCfg.modelName || modelId;
    const thinkingMode = /^glm-5\.3(?:-flash)?$/i.test(modelName)
      ? "on" : normalizeThinkingMode(effectiveCfg.thinkingMode);
    const configuredEffort = normalizeThinkingEffort(effectiveCfg.thinkingEffort);
    const thinkingEffort = configuredEffort === "auto" && /^glm-5\.3(?:-flash)?$/i.test(modelName)
      ? "low" : configuredEffort;
    const thinkingCapability = inferThinkingCapability({
      providerId,
      providerType: effectiveCfg.providerType,
      modelId,
      modelName,
      cfg: effectiveCfg
    });
    const supportsThinkingEffort = inferThinkingEffortCapability({
      providerId,
      providerType: effectiveCfg.providerType,
      modelId,
      modelName,
      cfg: effectiveCfg
    });
    const imageText = effectiveCfg.supportsImage ? t("status.imageSupported", "image") : t("status.imageUnsupported", "no image");
    let thinkingText = t("status.thinking.auto", "Thinking:auto");
    if (thinkingMode === "off") {
      thinkingText = t("status.thinking.off", "Thinking:off");
    } else if (thinkingEffort !== "auto") {
      thinkingText = `${t("status.thinking.prefix", "Thinking")}:${getThinkingEffortOptionLabel(thinkingEffort)}`;
    } else if (thinkingMode === "on") {
      thinkingText = t("status.thinking.on", "Thinking:on");
    } else if (thinkingCapability === "unsupported") {
      thinkingText = t("status.thinking.none", "Thinking:none");
    }

    const modelText = `${modelLabel} · ${imageText}`;
    if (supportsThinkingEffort && thinkingEffort === "auto" && thinkingMode === "auto") {
      thinkingText = t("status.thinking.auto", "Thinking:auto");
    }
    const capabilityText =
      thinkingCapability === "supported"
        ? t("status.tooltip.supported", "Supported")
        : thinkingCapability === "unsupported"
          ? t("status.tooltip.unsupported", "Unsupported")
          : t("status.tooltip.unknown", "Unknown");
    const tooltipLines = [
      t("status.tooltip.model", "Model: {label}", { label: modelLabel }),
      `Provider: ${providerId || "unknown"}`,
      `Model ID: ${modelId || "unknown"}`,
      t("status.tooltip.thinkingMode", "Thinking mode: {value}", { value: getThinkingModeOptionLabel(thinkingMode) }),
      t("status.tooltip.thinkingEffort", "Thinking effort: {value}", { value: getThinkingEffortOptionLabel(thinkingEffort) }),
      t("status.tooltip.thinkingCapability", "Thinking capability: {value}", { value: capabilityText }),
      t("status.tooltip.effortCapability", "Effort control: {value}", {
        value: supportsThinkingEffort ? t("status.tooltip.supported", "Supported") : t("status.tooltip.unconfirmed", "Unconfirmed")
      }),
      t("status.tooltip.imageInput", "Image input: {value}", {
        value: effectiveCfg.supportsImage ? t("status.tooltip.supported", "Supported") : t("status.tooltip.unsupported", "Unsupported")
      }),
      t("status.tooltip.openSwitcher", "Click the model item to open the model switcher.")
    ];
    const thinkingTooltip = [
      t("status.tooltip.thinkingMode", "Thinking mode: {value}", { value: getThinkingModeOptionLabel(thinkingMode) }),
      t("status.tooltip.thinkingEffort", "Thinking effort: {value}", { value: getThinkingEffortOptionLabel(thinkingEffort) }),
      t("status.tooltip.thinkingCapability", "Thinking capability: {value}", { value: capabilityText }),
      t("status.tooltip.effortCapability", "Effort control: {value}", {
        value: supportsThinkingEffort ? t("status.tooltip.supported", "Supported") : t("status.tooltip.unconfirmed", "Unconfirmed")
      }),
      getSupportedThinkingEfforts({ providerId, modelName, cfg: effectiveCfg })
        .filter(value => value !== "auto").map(getThinkingEffortOptionLabel).join(" → "),
      t("status.tooltip.cycleThinking", "Click to cycle the thinking effort levels supported by this model.")
    ].join("\n");
    return { modelText, thinkingText, modelTooltip: tooltipLines.join("\n"), thinkingTooltip };
  };
  const updateModelBtn = async () => {
    const seq = ++modelStatusSeq;
    const active = window.zion.state.get("chat.activeModel");
    const catalog = window.zion.state.get("models.catalog") || [];
    const activeItem = catalog.find(m => 
      m.providerId === active?.providerId && m.id === active?.modelId
    );
    
    let label = active?.label || active?.modelId || "unknown";
    let tooltip = "Select Model (Search / ↑↓ / PgUp/PgDn / Home/End / Enter / Esc)";
    let thinkingLabel = t("status.thinking.auto", "Thinking:auto");
    let thinkingTooltip = t("status.tooltip.cycleThinking", "Click to toggle thinking; adjust effort in model settings.");
    let cfg = null;
    try {
      const provider = active?.providerId ? window.zion.models.getProvider(active.providerId) : null;
      cfg = active?.modelId ? await provider?.resolve?.(active.modelId) : null;
    } catch {}
    if (seq !== modelStatusSeq) return;
    if (cfg) {
      const summary = buildModelStatus({ active, cfg, activeItem });
      label = summary.modelText;
      tooltip = summary.modelTooltip;
      thinkingLabel = summary.thinkingText;
      thinkingTooltip = summary.thinkingTooltip;
    }
    
    if (activeItem?.requiresConfig) {
      label = `$(warning) ${label}`;
      tooltip = `${activeItem.configHint || "需要配置 API key"} - ${tooltip}`;
    }
    
    modelBtnDisp?.dispose?.();
    thinkingBtnDisp?.dispose?.();
    modelBtnDisp = window.zion.bottomStatusBar?.registerItem?.({
      id: "langchain.chat.model",
      text: label,
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
    thinkingBtnDisp = window.zion.bottomStatusBar?.registerItem?.({
      id: "langchain.chat.thinking",
      text: thinkingLabel,
      tooltip: thinkingTooltip,
      priority: 79,
      onClick: () => cycleActiveThinkingEffort()
    });
  };
  updateModelBtn();
  ctx.subscriptions.push(
    window.zion.state.onDidChange("chat.activeModel", updateModelBtn),
    window.zion.state.onDidChange("models.catalog", updateModelBtn),
    window.zion.events.on("models/configChanged", updateModelBtn),
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
            const sid = window.zion?.state?.get?.("sessions.currentId");
            const streaming = !!window.zion?.state?.get?.("chat.streaming")
              || !!window.zion?.state?.get?.(`chat.runs.${sid}`)?.waiting;
            if (streaming) window.zion.commands.executeCommand("chat.stop");
            else window.zion.commands.executeCommand("chat.submit");
          } catch {}
        };
      }

      const update = () => {
        const sid = window.zion?.state?.get?.("sessions.currentId");
        const streaming = !!window.zion?.state?.get?.("chat.streaming")
          || !!window.zion?.state?.get?.(`chat.runs.${sid}`)?.waiting;
        btn.innerHTML = window.zionIcons?.htmlFromCodicon?.(streaming ? "debug-stop" : "play") || `<span class="codicon ${streaming ? "codicon-debug-stop" : "codicon-play"}" aria-hidden="true"></span>`;
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
            const sid = window.zion?.state?.get?.("sessions.currentId");
            const streaming = !!window.zion?.state?.get?.("chat.streaming")
              || !!window.zion?.state?.get?.(`chat.runs.${sid}`)?.waiting;
            btn.innerHTML = window.zionIcons?.htmlFromCodicon?.(streaming ? "debug-stop" : "play") || `<span class="codicon ${streaming ? "codicon-debug-stop" : "codicon-play"}" aria-hidden="true"></span>`;
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
          icon: "$(comment-discussion)",
          execute: () => window.zion.commands.executeCommand("chat.submit")
        })
      );

      disp.push(
        slash.registerCommand({
          id: "langchain.chat.runSelection",
          trigger: ["chatSelection", "chatSel"],
          title: t("slash.chatSelection.title", "Chat (Selection)"),
          description: t("slash.chatSelection.description", "Run chat using current selection"),
          category: t("category.chat", "chat"),
          icon: "$(file-text)",
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
          icon: "$(debug-stop)",
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
          icon: "$(loading)",
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
          icon: "$(zap)",
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
                icon: m?.requiresConfig ? "$(warning)" : "$(zap)",
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
          icon: "$(zap)",
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
          icon: "$(zap)",
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
