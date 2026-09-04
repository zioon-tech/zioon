import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS,
  MAX_MODEL_DESCRIPTION_LENGTH,
  MAX_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS,
  THINKING_MODE_FIELDS,
  getThinkingEffortOptions,
  getThinkingModeLabel,
  getThinkingModeOptions,
  inferThinkingCapability,
  inferThinkingEffortCapability,
  normalizeAutoContinueOnColonMaxAttempts,
  normalizeModelDescription,
  normalizeThinkingEffort,
  normalizeThinkingMode
} from "./model-config-fields.js";
import {
  getBuiltinModelLimits,
  hasCapabilityLimitOverride,
  normalizeModelLimits,
  resolveModelLimits
} from "./model-limits.js";
import { refreshModelCatalog } from "./model-catalog.js";
import {
  deleteDynamicModel,
  loadDynamicModelStore,
  loadLocalDynamicModelStore,
  upsertDynamicModel
} from "./runtime-user-model-store.js";
import {
  loadProviderConfig,
  saveProviderConfig
} from "./provider-config-storage.js";

const PROVIDER_ORDER = ["deepseek", "anthropic", "google"];
const isEn = () => String(window.zion?.i18n?.getLocale?.() || window.zion?.state?.get?.("ui.locale") || "").startsWith("en");
const tt = (zh, en) => (isEn() ? en : zh);

const BUILTIN_PROVIDER_META = {
  deepseek: {
    title: "DeepSeek",
    apiKeyKey: "zion.deepseek.apiKey",
    configKey: "zion.deepseek.config",
    fields: [
      "label",
      "modelName",
      "temperature",
      "max_tokens",
      "stream",
      "supportsImage",
      "supportsThinking",
      "supportsThinkingEffort",
      "thinkingMode",
      "thinkingEffort",
      "preservedThinking",
      "interleavedThinking",
      "autoContinueOnColonMaxAttempts"
    ]
  },
  anthropic: {
    title: "Claude",
    apiKeyKey: "zion.claude.apiKey",
    configKey: "zion.claude.config",
    fields: [
      "temperature",
      "max_tokens",
      "stream",
      "supportsImage",
      "supportsThinking",
      "supportsThinkingEffort",
      "thinkingMode",
      "thinkingEffort",
      "preservedThinking",
      "interleavedThinking"
    ]
  },
  google: {
    title: "Gemini",
    apiKeyKey: "zion.gemini.apiKey",
    configKey: "zion.gemini.config",
    fields: [
      "temperature",
      "max_tokens",
      "stream",
      "supportsImage",
      "supportsThinking",
      "supportsThinkingEffort",
      "thinkingMode",
      "thinkingEffort",
      "preservedThinking",
      "interleavedThinking"
    ]
  }
};

function loadJson(key, fallback) {
  if (key?.endsWith(".config")) {
    return loadProviderConfig(key);
  }
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function loadDynamicStore() {
  return loadLocalDynamicModelStore();
}

function loadCustomRows() {
  const dict = loadDynamicStore();
  return Object.entries(dict)
    .map(([id, cfg]) => ({ id, ...cfg }))
    .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
}

async function loadCustomRowsAsync() {
  const dict = await loadDynamicModelStore();
  return Object.entries(dict)
    .map(([id, cfg]) => ({ id, ...cfg }))
    .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
}

function loadProviderDraft(providerId, modelId, catalogItem = null) {
  const meta = BUILTIN_PROVIDER_META[providerId];
  if (!meta) return null;
  const cfg = loadJson(meta.configKey, {});
  const apiKey = localStorage.getItem(meta.apiKeyKey) || "";
  const detectedLimits = normalizeModelLimits(
    catalogItem?.detectedLimits || catalogItem?.limits || getBuiltinModelLimits(providerId, modelId)
  );
  const limits = resolveModelLimits({
    providerId,
    modelId,
    descriptor: { limits: detectedLimits },
    config: cfg
  });
  return {
    apiKey,
    description: normalizeModelDescription(
      cfg.modelDescriptions?.[modelId] || catalogItem?.description
    ),
    label: String(cfg.label || ""),
    modelName: String(cfg.modelName || ""),
    temperature: cfg.temperature ?? "",
    max_tokens: limits.defaultOutputTokens ?? "",
    contextWindowTokens: limits.contextWindowTokens ?? "",
    maxInputTokens: limits.maxInputTokens ?? "",
    maxOutputTokens: limits.maxOutputTokens ?? "",
    limitsSource: limits.source || "unknown",
    useDetectedLimits: !hasCapabilityLimitOverride(cfg, modelId),
    detectedLimits,
    stream: cfg.stream !== false,
    supportsImage: cfg.supportsImage ?? providerId !== "deepseek",
    supportsThinking: cfg.supportsThinking,
    supportsThinkingEffort: cfg.supportsThinkingEffort,
    thinkingMode: normalizeThinkingMode(cfg.thinkingMode),
    thinkingEffort: normalizeThinkingEffort(cfg.thinkingEffort),
    preservedThinking: cfg.preservedThinking ?? providerId === "deepseek",
    interleavedThinking: cfg.interleavedThinking ?? providerId === "deepseek",
    autoContinueOnColonMaxAttempts:
      providerId === "deepseek"
        ? normalizeAutoContinueOnColonMaxAttempts(cfg.autoContinueOnColonMaxAttempts)
        : DEFAULT_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS
  };
}

function saveProviderDraft(providerId, modelId, draft) {
  const meta = BUILTIN_PROVIDER_META[providerId];
  if (!meta) return;
  const current = loadJson(meta.configKey, {});
  const next = { ...current };
  for (const field of meta.fields) {
    if (field === "stream") next.stream = !!draft.stream;
    if (field === "supportsImage") next.supportsImage = !!draft.supportsImage;
    if (field === "supportsThinking") next.supportsThinking = draft.supportsThinking == null || draft.supportsThinking === "" ? undefined : !!draft.supportsThinking;
    if (field === "supportsThinkingEffort") {
      next.supportsThinkingEffort =
        draft.supportsThinkingEffort == null || draft.supportsThinkingEffort === "" ? undefined : !!draft.supportsThinkingEffort;
    }
    if (field === "thinkingMode") next.thinkingMode = normalizeThinkingMode(draft.thinkingMode);
    if (field === "thinkingEffort") next.thinkingEffort = normalizeThinkingEffort(draft.thinkingEffort);
    if (field === "preservedThinking") next.preservedThinking = !!draft.preservedThinking;
    if (field === "interleavedThinking") next.interleavedThinking = !!draft.interleavedThinking;
    if (field === "autoContinueOnColonMaxAttempts") {
      next.autoContinueOnColonMaxAttempts = normalizeAutoContinueOnColonMaxAttempts(
        draft.autoContinueOnColonMaxAttempts
      );
    }
    if (field === "temperature") {
      if (draft.temperature !== "") next.temperature = Number(draft.temperature);
      else delete next.temperature;
    }
    if (field === "label") {
      if (String(draft.label || "").trim()) next.label = String(draft.label).trim();
      else delete next.label;
    }
    if (field === "modelName") {
      if (String(draft.modelName || "").trim()) next.modelName = String(draft.modelName).trim();
      else delete next.modelName;
    }
  }
  const modelLimits = { ...(current.modelLimits || {}) };
  const perModel = {};
  if (!draft.useDetectedLimits) {
    if (draft.contextWindowTokens !== "") perModel.contextWindowTokens = Number(draft.contextWindowTokens);
    if (draft.maxInputTokens !== "") perModel.maxInputTokens = Number(draft.maxInputTokens);
    if (draft.maxOutputTokens !== "") perModel.maxOutputTokens = Number(draft.maxOutputTokens);
  }
  if (draft.max_tokens !== "") perModel.defaultOutputTokens = Number(draft.max_tokens);
  if (Object.keys(perModel).length) modelLimits[modelId] = perModel;
  else delete modelLimits[modelId];
  if (Object.keys(modelLimits).length) next.modelLimits = modelLimits;
  else delete next.modelLimits;
  const modelDescriptions = { ...(current.modelDescriptions || {}) };
  const description = normalizeModelDescription(draft.description);
  if (description) modelDescriptions[modelId] = description;
  else delete modelDescriptions[modelId];
  if (Object.keys(modelDescriptions).length) next.modelDescriptions = modelDescriptions;
  else delete next.modelDescriptions;
  localStorage.setItem(meta.apiKeyKey, String(draft.apiKey || "").trim());
  saveProviderConfig(meta.configKey, next);
}

function emptyCustomDraft() {
  return {
    id: "",
    label: "",
    description: "",
    url: "",
    key: "",
    providerType: "openai",
    modelName: "",
    temperature: "",
    max_tokens: "",
    contextWindowTokens: "",
    maxInputTokens: "",
    maxOutputTokens: "",
    stream: true,
    supportsImage: false,
    supportsThinking: "",
    supportsThinkingEffort: "",
    thinkingMode: "auto",
    thinkingEffort: "auto",
    preservedThinking: false,
    interleavedThinking: false
  };
}

function draftFromCustomRow(row) {
  if (!row) return emptyCustomDraft();
  return {
    id: String(row.id || ""),
    label: String(row.label || ""),
    description: normalizeModelDescription(row.description),
    url: String(row.url || ""),
    key: String(row.key || ""),
    providerType: String(row.providerType || "openai"),
    modelName: String(row.modelName || row.model || ""),
    temperature: row.temperature ?? "",
    max_tokens: row.max_tokens ?? "",
    contextWindowTokens: row.contextWindowTokens ?? row.limits?.contextWindowTokens ?? "",
    maxInputTokens: row.maxInputTokens ?? row.limits?.maxInputTokens ?? "",
    maxOutputTokens: row.maxOutputTokens ?? row.limits?.maxOutputTokens ?? "",
    stream: row.stream !== false,
    supportsImage: !!row.supportsImage,
    supportsThinking: row.supportsThinking ?? "",
    supportsThinkingEffort: row.supportsThinkingEffort ?? "",
    thinkingMode: normalizeThinkingMode(row.thinkingMode),
    thinkingEffort: normalizeThinkingEffort(row.thinkingEffort),
    preservedThinking: !!row.preservedThinking,
    interleavedThinking: !!row.interleavedThinking
  };
}

function buildProviderDrafts(catalog) {
  const drafts = {};
  for (const row of Array.isArray(catalog) ? catalog : []) {
    if (!BUILTIN_PROVIDER_META[row?.providerId]) continue;
    drafts[`${row.providerId}:${row.id}`] = loadProviderDraft(row.providerId, row.id, row);
  }
  return drafts;
}

function validateLimitDraft(draft) {
  const fields = [
    [tt("上下文窗口", "Context window"), draft?.contextWindowTokens],
    [tt("最大输入", "Max input"), draft?.maxInputTokens],
    [tt("最大输出", "Max output"), draft?.maxOutputTokens],
    [tt("默认输出", "Default output"), draft?.max_tokens]
  ];
  for (const [label, value] of fields) {
    if (value === "" || value == null) continue;
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
      return tt(`${label}必须是正数`, `${label} must be a positive number`);
    }
  }
  const contextWindowTokens = Number(draft?.contextWindowTokens || 0);
  const maxInputTokens = Number(draft?.maxInputTokens || 0);
  const maxOutputTokens = Number(draft?.maxOutputTokens || 0);
  const defaultOutputTokens = Number(draft?.max_tokens || 0);
  if (maxInputTokens && contextWindowTokens && maxInputTokens > contextWindowTokens) {
    return tt("最大输入不能超过上下文窗口", "Max input cannot exceed the context window");
  }
  if (maxOutputTokens && contextWindowTokens && maxOutputTokens > contextWindowTokens) {
    return tt("最大输出不能超过上下文窗口", "Max output cannot exceed the context window");
  }
  if (defaultOutputTokens && maxOutputTokens && defaultOutputTokens > maxOutputTokens) {
    return tt("默认输出不能超过模型最大输出", "Default output cannot exceed the model maximum");
  }
  return "";
}

function useZionState(key, fallbackValue) {
  const read = () => window.zion?.state?.get?.(key) ?? fallbackValue;
  const [value, setValue] = useState(read);

  useEffect(() => {
    setValue(read());
    const disp = window.zion?.state?.onDidChange?.(key, (next) => {
      setValue(next ?? fallbackValue);
    });
    return () => disp?.dispose?.();
  }, [key]);

  return value;
}

function getProviderTitle(providerId) {
  return BUILTIN_PROVIDER_META[providerId]?.title || providerId;
}

function getProviderSummary(providerId) {
  if (providerId === "deepseek") return tt("适合日常对话与代码任务", "Good for daily chat and coding tasks");
  if (providerId === "anthropic") return tt("偏重稳定表达与长文本", "Strong at stable writing and long-form text");
  if (providerId === "google") return tt("适合多模态与通用问答", "Good for multimodal and general Q&A");
  return tt("模型提供方", "Model provider");
}

function describeAvailability(row) {
  if (row?.requiresConfig || row?.availability?.status === "misconfigured") {
    return tt("还需要补全配置后才能使用", "Complete the configuration before use");
  }
  const status = row?.availability?.status || "unknown";
  if (status === "available") return tt("最近检查可用", "Available at the latest check");
  if (status === "degraded") return tt("最近检查状态不稳定", "The latest check was degraded");
  if (status === "unavailable") return tt("最近检查不可用", "Unavailable at the latest check");
  return tt("尚未确认可用性", "Availability has not been confirmed");
}

function formatAvailability(row) {
  if (row?.requiresConfig || row?.availability?.status === "misconfigured") {
    return tt("待配置", "Misconfigured");
  }
  const status = row?.availability?.status || "unknown";
  if (status === "available") return tt("可用", "Available");
  if (status === "degraded") return tt("不稳定", "Degraded");
  if (status === "unavailable") return tt("不可用", "Unavailable");
  return tt("未知", "Unknown");
}

function formatTokenLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return tt("未知", "Unknown");
  return new Intl.NumberFormat(isEn() ? "en-US" : "zh-CN").format(Math.round(number));
}

function getBuiltInStatusRows(row, isActive) {
  return [
    { label: tt("提供方", "Provider"), value: getProviderTitle(row.providerId) },
    { label: tt("模型标识", "Model ID"), value: row.id },
    { label: tt("上下文窗口", "Context Window"), value: formatTokenLimit(row.limits?.contextWindowTokens) },
    { label: tt("最大输出", "Max Output"), value: formatTokenLimit(row.limits?.maxOutputTokens) },
    { label: tt("当前默认", "Default"), value: isActive ? tt("是", "Yes") : tt("否", "No") },
    { label: tt("连接状态", "Connection"), value: formatAvailability(row) }
  ];
}

function getCustomStatusRows(editingId, isActive, draft) {
  return [
    { label: tt("模型 ID", "Model ID"), value: editingId || tt("新建中", "New") },
    { label: tt("接口地址", "Base URL"), value: draft.url || tt("未填写", "Empty") },
    { label: tt("上下文窗口", "Context Window"), value: formatTokenLimit(draft.contextWindowTokens) },
    { label: tt("最大输出", "Max Output"), value: formatTokenLimit(draft.maxOutputTokens) },
    { label: tt("当前默认", "Default"), value: isActive ? tt("是", "Yes") : tt("否", "No") },
    { label: tt("连接状态", "Connection"), value: draft.key ? tt("已填写密钥", "Key provided") : tt("待补全", "Incomplete") }
  ];
}

function getSelectionKey(selection) {
  if (!selection) return "";
  if (selection.kind === "new-custom") return "new-custom";
  return `${selection.kind}:${selection.providerId || ""}:${selection.id || ""}`;
}

function PreferenceStatusCard({ title, rows }) {
  return (
    <section className="lc-models-detail-card is-subtle">
      <div className="lc-models-detail-section-title">{title}</div>
      <div className="lc-models-status-grid">
        {rows.map((row) => (
          <div key={row.label} className="lc-models-status-row">
            <span className="lc-models-status-label">{row.label}</span>
            <span className="lc-models-status-value">{row.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ThinkingConfigFields({ draft, onChange, modelInfo }) {
  const capability = inferThinkingCapability({ cfg: draft, ...modelInfo });
  const supportsEffort = inferThinkingEffortCapability({ cfg: draft, ...modelInfo });
  const effortOptions = getThinkingEffortOptions({ cfg: draft, ...modelInfo });
  const normalizedEffort = normalizeThinkingEffort(draft.thinkingEffort);
  const selectedEffort = effortOptions.some((option) => option.value === normalizedEffort) ? normalizedEffort : "auto";
  const hint =
    capability === "supported"
      ? supportsEffort
        ? tt("当前模型看起来支持思考，也可能支持强度设置。", "This model appears to support thinking and may support effort control.")
        : tt("当前模型看起来支持思考，但未确认支持强度设置。", "This model appears to support thinking, but effort control is not confirmed.")
      : capability === "unsupported"
        ? tt("当前模型标记为不支持思考。", "This model is marked as not supporting thinking.")
        : tt("是否支持思考取决于服务商和模型。", "Thinking support depends on the provider and model.");

  return (
    <>
      <label className="lc-models-field">
        <span>{tt("思考方式", "Thinking Mode")}</span>
        <select value={normalizeThinkingMode(draft.thinkingMode)} onChange={(e) => onChange("thinkingMode", e.target.value)}>
          {getThinkingModeOptions().map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="lc-models-field">
        <span>{tt("思考强度", "Thinking Effort")}</span>
        <select
          value={selectedEffort}
          onChange={(e) => onChange("thinkingEffort", e.target.value)}
          title={supportsEffort ? tt("当前模型可能支持思考强度。", "This model may support thinking effort.") : tt("未确认当前模型支持强度设置；如服务商兼容，可手动选择。", "Effort support is not confirmed; choose manually if your provider supports it.")}
        >
          {effortOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="lc-models-field wide">
        <span>{tt("思考能力", "Thinking Capability")}</span>
        <div className="lc-models-status">{hint}</div>
      </div>
    </>
  );
}

function ProviderConfigEditor({ providerId, modelId, draft, onChange, onSave, onResetLimits, saving }) {
  const meta = BUILTIN_PROVIDER_META[providerId];
  if (!meta || !draft) return null;
  const showAdvanced = true;
  const providerType = providerId === "anthropic" ? "claude" : providerId === "google" ? "gemini" : "openai";
  const effectiveModelName = providerId === "deepseek" ? draft.modelName || modelId : modelId;

  return (
    <div className="lc-models-detail-stack">
      <section className="lc-models-detail-card">
        <div className="lc-models-detail-section-title">{tt("连接与常用偏好", "Connection & Preferences")}</div>
        <div className="lc-models-detail-section-desc">{tt("先完成最关键的连接项，再按需展开高级设置。", "Complete the key connection fields first, then expand advanced settings if needed.")}</div>
        <div className="lc-models-form two-cols">
          <label className="lc-models-field wide">
            <span>API Key</span>
            <input
              type="password"
              value={draft.apiKey}
              placeholder={tt("输入 API Key", "Enter API Key")}
              onChange={(e) => onChange("apiKey", e.target.value)}
            />
          </label>
          {providerId === "deepseek" ? (
            <label className="lc-models-field">
              <span>{tt("显示名称", "Display Name")}</span>
              <input
                type="text"
                value={draft.label}
                placeholder={tt("例如：DeepSeek Chat", "e.g. DeepSeek Chat")}
                onChange={(e) => onChange("label", e.target.value)}
              />
            </label>
          ) : null}
          <label className="lc-models-field wide">
            <span>{tt("模型描述", "Model Description")}</span>
            <textarea
              rows="3"
              maxLength={MAX_MODEL_DESCRIPTION_LENGTH}
              value={draft.description}
              placeholder={tt("记录模型定位、优势或适用场景", "Describe the model's role, strengths, or use cases")}
              onChange={(e) => onChange("description", e.target.value)}
            />
          </label>
          {providerId === "deepseek" ? (
            <label className="lc-models-field">
              <span>{tt("默认模型", "Default Model")}</span>
              <input
                type="text"
                value={draft.modelName}
                placeholder={tt("例如：deepseek-v4-flash", "e.g. deepseek-v4-flash")}
                onChange={(e) => onChange("modelName", e.target.value)}
              />
            </label>
          ) : null}
        </div>
        <div className="lc-models-actions">
          <button type="button" className="primary" onClick={() => void onSave()} disabled={saving}>
            {saving ? tt("保存中...", "Saving...") : tt("保存更改", "Save Changes")}
          </button>
        </div>
      </section>

      <details className="lc-models-advanced">
        <summary className="lc-models-advanced-summary">{tt("高级设置", "Advanced Settings")}</summary>
        <div className="lc-models-form two-cols">
          <label className="lc-models-field">
            <span>Temperature</span>
            <input
              type="number"
              value={draft.temperature}
              placeholder="0.7"
              onChange={(e) => onChange("temperature", e.target.value)}
            />
          </label>
          <label className="lc-models-field">
            <span>{tt("上下文窗口", "Context Window")}</span>
            <input
              type="number"
              min="1"
              value={draft.contextWindowTokens}
              placeholder={String(draft.detectedLimits?.contextWindowTokens || "")}
              onChange={(e) => onChange("contextWindowTokens", e.target.value)}
            />
          </label>
          <label className="lc-models-field">
            <span>{tt("最大输入 Tokens", "Max Input Tokens")}</span>
            <input
              type="number"
              min="1"
              value={draft.maxInputTokens}
              placeholder={String(draft.detectedLimits?.maxInputTokens || "")}
              onChange={(e) => onChange("maxInputTokens", e.target.value)}
            />
          </label>
          <label className="lc-models-field">
            <span>{tt("最大输出 Tokens", "Max Output Tokens")}</span>
            <input
              type="number"
              min="1"
              value={draft.maxOutputTokens}
              placeholder={String(draft.detectedLimits?.maxOutputTokens || "")}
              onChange={(e) => onChange("maxOutputTokens", e.target.value)}
            />
          </label>
          <label className="lc-models-field">
            <span>{tt("默认输出 Tokens", "Default Output Tokens")}</span>
            <input
              type="number"
              min="1"
              max={draft.maxOutputTokens || undefined}
              value={draft.max_tokens}
              placeholder={providerId === "anthropic" ? "64000" : providerId === "google" ? "32768" : tt("服务商默认", "Provider default")}
              onChange={(e) => onChange("max_tokens", e.target.value)}
            />
          </label>
          {providerId === "deepseek" ? (
            <label
              className="lc-models-field"
              title={tt(
                "DeepSeek 异常 stop 时最多自动续写多少次，包括冒号中断和只有推理、没有正式输出；设为 0 可关闭。",
                "Maximum automatic continuations after an abnormal DeepSeek stop, including trailing-colon and reasoning-only responses; set to 0 to disable."
              )}
            >
              <span>{tt("异常 Stop 续写次数", "Abnormal-stop Continuations")}</span>
              <input
                type="number"
                min="0"
                max={MAX_AUTO_CONTINUE_ON_COLON_MAX_ATTEMPTS}
                step="1"
                value={draft.autoContinueOnColonMaxAttempts}
                onChange={(e) => onChange("autoContinueOnColonMaxAttempts", e.target.value)}
              />
            </label>
          ) : null}
          {showAdvanced ? (
            <ThinkingConfigFields
              draft={draft}
              onChange={onChange}
              modelInfo={{ providerId, providerType, modelId, modelName: effectiveModelName }}
            />
          ) : null}
        </div>
        <div className="lc-models-checks">
          <label className="lc-models-check">
            <input
              type="checkbox"
              checked={!!draft.stream}
                  onChange={(e) => onChange("stream", e.target.checked)}
            />
            <span>{tt("流式返回", "Stream")}</span>
          </label>
          {showAdvanced ? (
            <>
              <label className="lc-models-check">
                <input
                  type="checkbox"
                  checked={!!draft.supportsImage}
                  onChange={(e) => onChange("supportsImage", e.target.checked)}
                />
                <span>{tt("支持图片", "Supports Images")}</span>
              </label>
              {THINKING_MODE_FIELDS.map((field) => (
                <label key={field.key} className="lc-models-check" title={isEn() ? field.descriptionEn || field.description : field.description}>
                  <input
                    type="checkbox"
                    checked={!!draft[field.key]}
                    onChange={(e) => onChange(field.key, e.target.checked)}
                  />
                  <span>{getThinkingModeLabel(field.key)}</span>
                </label>
              ))}
            </>
          ) : null}
        </div>
        <div className="lc-models-actions">
          <button type="button" onClick={onResetLimits} disabled={draft.useDetectedLimits}>
            {tt("恢复自动限制", "Restore Detected Limits")}
          </button>
          <span className="lc-models-row-meta">
            {tt("限制来源", "Limits Source")}: {draft.useDetectedLimits ? draft.limitsSource : tt("手动覆盖", "Manual Override")}
          </span>
        </div>
      </details>
    </div>
  );
}

function CustomModelDetail({
  draft,
  editingId,
  isActive,
  saving,
  onChange,
  onSave,
  onActivate,
  onDelete,
  onReset
}) {
  return (
    <div className="lc-models-detail-stack">
      <section className="lc-models-detail-hero">
        <div>
          <div className="lc-models-detail-title">{editingId ? draft.label || editingId : tt("新建自定义模型", "New Custom Model")}</div>
          <div className="lc-models-detail-subtitle">
            {editingId ? tt("保留最必要的信息，作为你自己的默认模型来源。", "Keep the essential fields for your own default model source.") : tt("填写基础连接信息后即可加入模型列表。", "Fill in the basic connection fields to add it to the model list.")}
          </div>
        </div>
        <div className="lc-models-detail-actions">
          {editingId ? (
            <button type="button" onClick={onActivate} disabled={isActive}>
              {isActive ? tt("当前默认", "Current Default") : tt("设为默认", "Set as Default")}
            </button>
          ) : null}
          <button type="button" className="primary" onClick={() => void onSave()} disabled={saving}>
            {saving ? tt("保存中...", "Saving...") : editingId ? tt("保存更改", "Save Changes") : tt("创建模型", "Create Model")}
          </button>
          {editingId ? (
            <button type="button" onClick={onDelete} disabled={saving}>
              {tt("删除", "Delete")}
            </button>
          ) : (
            <button type="button" onClick={onReset} disabled={saving}>
              {tt("清空", "Clear")}
            </button>
          )}
        </div>
      </section>

      <PreferenceStatusCard title={tt("当前状态", "Current Status")} rows={getCustomStatusRows(editingId, isActive, draft)} />

      <section className="lc-models-detail-card">
        <div className="lc-models-detail-section-title">{tt("基础信息", "Basic Info")}</div>
        <div className="lc-models-detail-section-desc">{tt("先填能决定可不可用的关键信息。", "Fill in the key fields that determine whether the model is usable.")}</div>
        <div className="lc-models-form two-cols">
          <label className="lc-models-field">
            <span>ID</span>
            <input
              type="text"
              value={draft.id}
              disabled={!!editingId}
              placeholder="my-model"
              onChange={(e) => onChange("id", e.target.value)}
            />
          </label>
          <label className="lc-models-field">
            <span>{tt("显示名称", "Display Name")}</span>
            <input type="text" value={draft.label} placeholder={tt("例如：My Model", "e.g. My Model")} onChange={(e) => onChange("label", e.target.value)} />
          </label>
          <label className="lc-models-field wide">
            <span>{tt("接口地址", "Base URL")}</span>
            <input
              type="text"
              value={draft.url}
              placeholder="https://api.openai.com/v1/chat/completions"
              onChange={(e) => onChange("url", e.target.value)}
            />
          </label>
          <label className="lc-models-field">
            <span>API Key</span>
            <input type="password" value={draft.key} placeholder={tt("输入 API Key", "Enter API Key")} onChange={(e) => onChange("key", e.target.value)} />
          </label>
          <label className="lc-models-field">
            <span>{tt("接口类型", "Provider Type")}</span>
            <select value={draft.providerType} onChange={(e) => onChange("providerType", e.target.value)}>
              <option value="openai">OpenAI</option>
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
            </select>
          </label>
          <label className="lc-models-field wide">
            <span>{tt("模型描述", "Model Description")}</span>
            <textarea
              rows="3"
              maxLength={MAX_MODEL_DESCRIPTION_LENGTH}
              value={draft.description}
              placeholder={tt("记录模型定位、优势或适用场景", "Describe the model's role, strengths, or use cases")}
              onChange={(e) => onChange("description", e.target.value)}
            />
          </label>
        </div>
      </section>

      <details className="lc-models-advanced">
        <summary className="lc-models-advanced-summary">{tt("高级设置", "Advanced Settings")}</summary>
        <div className="lc-models-form two-cols">
          <label className="lc-models-field">
            <span>{tt("模型名覆盖", "Model Override")}</span>
            <input type="text" value={draft.modelName} placeholder={tt("可选，例如：gpt-4o-mini", "Optional, e.g. gpt-4o-mini")} onChange={(e) => onChange("modelName", e.target.value)} />
          </label>
          <label className="lc-models-field">
            <span>Temperature</span>
            <input type="number" value={draft.temperature} placeholder="0.7" onChange={(e) => onChange("temperature", e.target.value)} />
          </label>
          <label className="lc-models-field">
            <span>{tt("上下文窗口", "Context Window")}</span>
            <input type="number" min="1" value={draft.contextWindowTokens} placeholder="128000" onChange={(e) => onChange("contextWindowTokens", e.target.value)} />
          </label>
          <label className="lc-models-field">
            <span>{tt("最大输入 Tokens", "Max Input Tokens")}</span>
            <input type="number" min="1" value={draft.maxInputTokens} placeholder="128000" onChange={(e) => onChange("maxInputTokens", e.target.value)} />
          </label>
          <label className="lc-models-field">
            <span>{tt("最大输出 Tokens", "Max Output Tokens")}</span>
            <input type="number" min="1" value={draft.maxOutputTokens} placeholder="8192" onChange={(e) => onChange("maxOutputTokens", e.target.value)} />
          </label>
          <label className="lc-models-field">
            <span>{tt("默认输出 Tokens", "Default Output Tokens")}</span>
            <input type="number" min="1" max={draft.maxOutputTokens || undefined} value={draft.max_tokens} placeholder="4096" onChange={(e) => onChange("max_tokens", e.target.value)} />
          </label>
          <ThinkingConfigFields
            draft={draft}
            onChange={onChange}
            modelInfo={{ providerId: "user.dynamic", providerType: draft.providerType, modelId: editingId || draft.id, modelName: draft.modelName || draft.id }}
          />
        </div>
        <div className="lc-models-checks">
          <label className="lc-models-check">
            <input type="checkbox" checked={!!draft.stream} onChange={(e) => onChange("stream", e.target.checked)} />
            <span>{tt("流式返回", "Stream")}</span>
          </label>
          <label className="lc-models-check">
            <input type="checkbox" checked={!!draft.supportsImage} onChange={(e) => onChange("supportsImage", e.target.checked)} />
            <span>{tt("支持图片", "Supports Images")}</span>
          </label>
          {THINKING_MODE_FIELDS.map((field) => (
            <label key={field.key} className="lc-models-check" title={isEn() ? field.descriptionEn || field.description : field.description}>
              <input
                type="checkbox"
                checked={!!draft[field.key]}
                onChange={(e) => onChange(field.key, e.target.checked)}
              />
              <span>{getThinkingModeLabel(field.key)}</span>
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}

function selectFallback(activeModel, builtins, customRows) {
  if (activeModel?.providerId === "user.dynamic") {
    const activeCustom = customRows.find((row) => row.id === activeModel.modelId);
    if (activeCustom) return { kind: "custom", providerId: "user.dynamic", id: activeCustom.id };
  }

  if (activeModel?.providerId) {
    const activeBuiltIn = builtins.find(
      (row) => row.providerId === activeModel.providerId && row.id === activeModel.modelId
    );
    if (activeBuiltIn) {
      return { kind: "catalog", providerId: activeBuiltIn.providerId, id: activeBuiltIn.id };
    }
  }

  if (builtins[0]) return { kind: "catalog", providerId: builtins[0].providerId, id: builtins[0].id };
  if (customRows[0]) return { kind: "custom", providerId: "user.dynamic", id: customRows[0].id };
  return null;
}

function isValidSelection(selection, builtins, customRows) {
  if (!selection) return false;
  if (selection.kind === "new-custom") return true;
  if (selection.kind === "catalog") {
    return builtins.some((row) => row.providerId === selection.providerId && row.id === selection.id);
  }
  if (selection.kind === "custom") {
    return customRows.some((row) => row.id === selection.id);
  }
  return false;
}

export function ModelsSettingsPage() {
  useZionState("ui.locale", window.zion?.i18n?.getLocale?.() || "zh-CN");
  const activeModel = useZionState("chat.activeModel", null);
  const catalogFromState = useZionState("models.catalog", []);
  const [catalog, setCatalog] = useState(Array.isArray(catalogFromState) ? catalogFromState : []);
  const [customRows, setCustomRows] = useState(() => loadCustomRows());
  const [providerDrafts, setProviderDrafts] = useState(() => buildProviderDrafts(catalogFromState));
  const [selection, setSelection] = useState(null);
  const [customDraft, setCustomDraft] = useState(emptyCustomDraft);
  const [editingCustomId, setEditingCustomId] = useState("");
  const [status, setStatus] = useState("");
  const [savingKey, setSavingKey] = useState("");

  useEffect(() => {
    const nextCatalog = Array.isArray(catalogFromState) ? catalogFromState : [];
    setCatalog(nextCatalog);
    setProviderDrafts(buildProviderDrafts(nextCatalog));
  }, [catalogFromState]);

  const builtins = useMemo(
    () => (Array.isArray(catalog) ? catalog.filter((row) => row.providerId !== "user.dynamic") : []),
    [catalog]
  );

  const providerGroups = useMemo(() => {
    const map = new Map();
    for (const row of builtins) {
      const list = map.get(row.providerId) || [];
      list.push(row);
      map.set(row.providerId, list);
    }
    const ids = Array.from(map.keys()).sort((a, b) => {
      const ai = PROVIDER_ORDER.indexOf(a);
      const bi = PROVIDER_ORDER.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return String(a).localeCompare(String(b));
    });
    return ids.map((providerId) => ({
      providerId,
      title: getProviderTitle(providerId),
      rows: (map.get(providerId) || []).slice().sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)))
    }));
  }, [builtins]);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    void loadCustomRowsAsync().then(setCustomRows).catch(() => {
      setCustomRows(loadCustomRows());
    });
  }, [catalog]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const nextCustomRows = await loadCustomRowsAsync().catch(() => loadCustomRows());
      if (cancelled) return;
      const nextBuiltins = Array.isArray(catalogFromState)
        ? catalogFromState.filter((row) => row.providerId !== "user.dynamic")
        : [];
      setCustomRows(nextCustomRows);
      setSelection((prev) => {
        if (isValidSelection(prev, nextBuiltins, nextCustomRows)) return prev;
        return selectFallback(activeModel, nextBuiltins, nextCustomRows);
      });
    })();
    return () => { cancelled = true; };
  }, [activeModel, catalogFromState]);

  const selectedBuiltIn =
    selection?.kind === "catalog"
      ? builtins.find((row) => row.providerId === selection.providerId && row.id === selection.id) || null
      : null;
  const refresh = async () => {
    const next = await refreshModelCatalog({ checkHealth: true });
    const nextCustomRows = await loadCustomRowsAsync().catch(() => loadCustomRows());
    setCatalog(next);
    setCustomRows(nextCustomRows);
    setProviderDrafts(buildProviderDrafts(next));
    setSelection((prev) => {
      const nextBuiltins = next.filter((row) => row.providerId !== "user.dynamic");
      if (isValidSelection(prev, nextBuiltins, nextCustomRows)) return prev;
      return selectFallback(activeModel, nextBuiltins, nextCustomRows);
    });
  };

  const setProviderField = (providerId, modelId, field, value) => {
    const key = `${providerId}:${modelId}`;
    setProviderDrafts((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] || loadProviderDraft(providerId, modelId)),
        [field]: value,
        ...(["contextWindowTokens", "maxInputTokens", "maxOutputTokens"].includes(field)
          ? { useDetectedLimits: false, limitsSource: "user" }
          : {})
      }
    }));
  };

  const resetProviderLimits = (providerId, modelId) => {
    const key = `${providerId}:${modelId}`;
    setProviderDrafts((prev) => {
      const current = prev[key] || loadProviderDraft(providerId, modelId);
      const detected = current.detectedLimits || getBuiltinModelLimits(providerId, modelId);
      return {
        ...prev,
        [key]: {
          ...current,
          contextWindowTokens: detected.contextWindowTokens ?? "",
          maxInputTokens: detected.maxInputTokens ?? "",
          maxOutputTokens: detected.maxOutputTokens ?? "",
          limitsSource: detected.source || "unknown",
          useDetectedLimits: true
        }
      };
    });
  };

  const handleSaveProvider = async (providerId, modelId) => {
    const key = `${providerId}:${modelId}`;
    const draft = providerDrafts[key] || loadProviderDraft(providerId, modelId);
    const validationError = validateLimitDraft(draft);
    if (validationError) {
      setStatus(validationError);
      return;
    }
    setSavingKey(`provider:${providerId}:${modelId}`);
    try {
      saveProviderDraft(providerId, modelId, draft);
      await refresh();
      try { window.zion?.events?.emit?.("models/configChanged", { providerId }); } catch {}
      setStatus(`${getProviderTitle(providerId)} 配置已保存`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey("");
    }
  };

  const startNewCustom = () => {
    setEditingCustomId("");
    setCustomDraft(emptyCustomDraft());
    setSelection({ kind: "new-custom", providerId: "user.dynamic", id: "" });
  };

  const startEditCustom = (row) => {
    setEditingCustomId(String(row.id || ""));
    setCustomDraft(draftFromCustomRow(row));
    setSelection({ kind: "custom", providerId: "user.dynamic", id: String(row.id || "") });
  };

  const resetCustomEditor = () => {
    if (editingCustomId) {
      const row = customRows.find((item) => item.id === editingCustomId);
      if (row) {
        setCustomDraft(draftFromCustomRow(row));
        return;
      }
    }
    setCustomDraft(emptyCustomDraft());
  };

  const handleSaveCustom = async () => {
    const id = String(customDraft.id || "").trim();
    const url = String(customDraft.url || "").trim();
    const key = String(customDraft.key || "").trim();
    if (!id) return setStatus(tt("缺少 Model ID", "Missing Model ID"));
    if (!url) return setStatus(tt("缺少 Base URL", "Missing Base URL"));
    const existingRow = editingCustomId
      ? customRows.find((item) => item.id === editingCustomId)
      : null;
    const credentialAlreadyConfigured = !!existingRow?._credentialConfigured;
    if (!key && !credentialAlreadyConfigured) {
      return setStatus(tt("缺少 API Key", "Missing API Key"));
    }
    const validationError = validateLimitDraft(customDraft);
    if (validationError) return setStatus(validationError);

    setSavingKey("custom");
    try {
      const dict = loadDynamicStore();
      if (!editingCustomId && dict[id]) {
        setStatus(tt(`模型已存在: ${id}`, `Model already exists: ${id}`));
        setSavingKey("");
        return;
      }
      const next = {
        label: String(customDraft.label || "").trim() || undefined,
        description: normalizeModelDescription(customDraft.description) || undefined,
        url,
        ...(key ? { key } : {}),
        providerType: String(customDraft.providerType || "openai"),
        stream: !!customDraft.stream,
        supportsImage: !!customDraft.supportsImage,
        supportsThinking: customDraft.supportsThinking == null || customDraft.supportsThinking === "" ? undefined : !!customDraft.supportsThinking,
        supportsThinkingEffort:
          customDraft.supportsThinkingEffort == null || customDraft.supportsThinkingEffort === "" ? undefined : !!customDraft.supportsThinkingEffort,
        thinkingMode: normalizeThinkingMode(customDraft.thinkingMode),
        thinkingEffort: normalizeThinkingEffort(customDraft.thinkingEffort),
        preservedThinking: !!customDraft.preservedThinking,
        interleavedThinking: !!customDraft.interleavedThinking
      };
      if (String(customDraft.modelName || "").trim()) {
        next.modelName = String(customDraft.modelName).trim();
        next.model = String(customDraft.modelName).trim();
      }
      if (customDraft.temperature !== "") next.temperature = Number(customDraft.temperature);
      if (customDraft.max_tokens !== "") next.max_tokens = Number(customDraft.max_tokens);
      if (customDraft.contextWindowTokens !== "") next.contextWindowTokens = Number(customDraft.contextWindowTokens);
      if (customDraft.maxInputTokens !== "") next.maxInputTokens = Number(customDraft.maxInputTokens);
      if (customDraft.maxOutputTokens !== "") next.maxOutputTokens = Number(customDraft.maxOutputTokens);
      const saved = await upsertDynamicModel({ modelId: id, config: next });
      await refresh();
      try { window.zion?.events?.emit?.("models/configChanged", { providerId: "user.dynamic", modelId: id }); } catch {}
      setEditingCustomId(id);
      setCustomDraft(draftFromCustomRow({ id, ...next }));
      setSelection({ kind: "custom", providerId: "user.dynamic", id });
      setStatus(saved?.warning
        ? tt(`已本地保存 custom model: ${id}；Runtime 同步失败`, `Saved custom model locally: ${id}; Runtime sync failed`)
        : tt(`已保存 custom model: ${id}`, `Saved custom model: ${id}`));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey("");
    }
  };

  const handleDeleteCustom = async (row) => {
    const ok = window.confirm(tt(`删除模型 "${row.id}" ?`, `Delete model "${row.id}"?`));
    if (!ok) return;
    setSavingKey(`delete:${row.id}`);
    try {
      await deleteDynamicModel({ modelId: row.id });
      await refresh();
      try { window.zion?.events?.emit?.("models/configChanged", { providerId: "user.dynamic", modelId: row.id }); } catch {}
      if (selection?.kind === "custom" && selection.id === row.id) {
        setSelection(selectFallback(activeModel, builtins, loadCustomRows()));
      }
      if (editingCustomId === row.id) {
        setEditingCustomId("");
        setCustomDraft(emptyCustomDraft());
      }
      setStatus(tt(`已删除 custom model: ${row.id}`, `Deleted custom model: ${row.id}`));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey("");
    }
  };

  const handleActivate = async (row) => {
    try {
      window.zion?.commands?.executeCommand?.("models.selectModel", `${row.providerId}:${row.id}`);
      setStatus(tt(`当前模型: ${row.label || row.id}`, `Current model: ${row.label || row.id}`));
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const activeLabel = activeModel?.label || activeModel?.modelId || tt("未选择模型", "No model selected");
  const selectedProviderId = selectedBuiltIn?.providerId || null;
  const selectedProviderDraftKey = selectedBuiltIn
    ? `${selectedBuiltIn.providerId}:${selectedBuiltIn.id}`
    : "";

  return (
    <div className="lc-models">
      <div className="lc-models-toolbar">
        <div className="lc-models-toolbar-main">
          <div className="lc-models-toolbar-title">{tt("模型偏好", "Model Preferences")}</div>
          <div className="lc-models-toolbar-meta">{tt("当前默认", "Current default")}: {activeLabel}</div>
        </div>
        <div className="lc-models-toolbar-actions">
          <button type="button" onClick={() => void refresh()}>
            {tt("刷新", "Refresh")}
          </button>
          <button type="button" className="primary" onClick={startNewCustom}>
            {tt("新建自定义模型", "New Custom Model")}
          </button>
        </div>
      </div>

      <div className="lc-models-workbench">
        <aside className="lc-models-sidebar">
          {providerGroups.map((group) => (
            <section key={group.providerId} className="lc-models-sidebar-group">
              <div className="lc-models-sidebar-group-title">{group.title}</div>
              <div className="lc-models-sidebar-list">
                {group.rows.map((row) => {
                  const selected =
                    selection?.kind === "catalog" &&
                    selection.providerId === row.providerId &&
                    selection.id === row.id;
                  const active =
                    activeModel?.providerId === row.providerId && activeModel?.modelId === row.id;
                  return (
                    <button
                      key={`${row.providerId}:${row.id}`}
                      type="button"
                      className={`lc-models-sidebar-item ${selected ? "is-selected" : ""} ${active ? "is-active" : ""}`}
                      onClick={() => setSelection({ kind: "catalog", providerId: row.providerId, id: row.id })}
                    >
                      <span className="lc-models-sidebar-item-main">
                        <span className="lc-models-sidebar-item-title">{row.label || row.id}</span>
                      </span>
                      {active ? <span className="lc-models-pill">{tt("当前", "Current")}</span> : row.requiresConfig ? <span className="lc-models-pill is-warn">{tt("待补全", "Incomplete")}</span> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

          <section className="lc-models-sidebar-group">
            <div className="lc-models-sidebar-group-head">
              <div className="lc-models-sidebar-group-title">Custom</div>
              <button type="button" className="lc-models-quiet-button" onClick={startNewCustom}>
                {tt("新建", "New")}
              </button>
            </div>
            <div className="lc-models-sidebar-list">
              {customRows.length === 0 ? (
                <div className="lc-models-empty">{tt("暂无", "None")}</div>
              ) : (
                customRows.map((row) => {
                  const selected = selection?.kind === "custom" && selection.id === row.id;
                  const active =
                    activeModel?.providerId === "user.dynamic" && activeModel?.modelId === row.id;
                  return (
                    <button
                      key={row.id}
                      type="button"
                      className={`lc-models-sidebar-item ${selected ? "is-selected" : ""} ${active ? "is-active" : ""}`}
                      onClick={() => startEditCustom(row)}
                    >
                      <span className="lc-models-sidebar-item-main">
                        <span className="lc-models-sidebar-item-title">{row.label || row.id}</span>
                      </span>
                      {active ? <span className="lc-models-pill">{tt("当前", "Current")}</span> : null}
                    </button>
                  );
                })
              )}
            </div>
          </section>
        </aside>

        <main className="lc-models-detail" key={getSelectionKey(selection)}>
          {selectedBuiltIn ? (
            <div className="lc-models-detail-stack">
              <section className="lc-models-detail-hero">
                <div>
                  <div className="lc-models-detail-title">{selectedBuiltIn.label || selectedBuiltIn.id}</div>
                  <div className="lc-models-detail-subtitle">
                    {getProviderSummary(selectedBuiltIn.providerId)}{isEn() ? ", " : "，"}{describeAvailability(selectedBuiltIn)}{isEn() ? "." : "。"}
                  </div>
                  <div className="lc-models-detail-meta">
                    <span className="lc-models-row-meta">{getProviderTitle(selectedBuiltIn.providerId)}</span>
                    {selectedBuiltIn.requiresConfig ? <span className="lc-models-pill is-warn">{tt("需配置", "Needs Config")}</span> : null}
                    {activeModel?.providerId === selectedBuiltIn.providerId && activeModel?.modelId === selectedBuiltIn.id ? (
                      <span className="lc-models-pill">{tt("当前", "Current")}</span>
                    ) : null}
                  </div>
                </div>
                <div className="lc-models-detail-actions">
                  <button
                    type="button"
                    onClick={() => void handleActivate(selectedBuiltIn)}
                    disabled={activeModel?.providerId === selectedBuiltIn.providerId && activeModel?.modelId === selectedBuiltIn.id}
                  >
                    {activeModel?.providerId === selectedBuiltIn.providerId && activeModel?.modelId === selectedBuiltIn.id
                      ? tt("当前默认", "Current Default")
                      : tt("设为默认", "Set as Default")}
                  </button>
                </div>
              </section>

              <PreferenceStatusCard
                title={tt("当前状态", "Current Status")}
                rows={getBuiltInStatusRows(
                  selectedBuiltIn,
                  activeModel?.providerId === selectedBuiltIn.providerId && activeModel?.modelId === selectedBuiltIn.id
                )}
              />

              <ProviderConfigEditor
                providerId={selectedProviderId}
                modelId={selectedBuiltIn.id}
                draft={providerDrafts[selectedProviderDraftKey] || loadProviderDraft(selectedProviderId, selectedBuiltIn.id, selectedBuiltIn)}
                onChange={(field, value) => setProviderField(selectedProviderId, selectedBuiltIn.id, field, value)}
                onSave={() => handleSaveProvider(selectedProviderId, selectedBuiltIn.id)}
                onResetLimits={() => resetProviderLimits(selectedProviderId, selectedBuiltIn.id)}
                saving={savingKey === `provider:${selectedProviderId}:${selectedBuiltIn.id}`}
              />
            </div>
          ) : (
            <CustomModelDetail
              draft={customDraft}
              editingId={editingCustomId}
              isActive={activeModel?.providerId === "user.dynamic" && activeModel?.modelId === editingCustomId}
              saving={savingKey === "custom" || savingKey === `delete:${editingCustomId}`}
              onChange={(field, value) => setCustomDraft((prev) => ({ ...prev, [field]: value }))}
              onSave={handleSaveCustom}
              onActivate={() =>
                editingCustomId
                  ? handleActivate({
                      providerId: "user.dynamic",
                      id: editingCustomId,
                      label: customDraft.label || editingCustomId
                    })
                  : undefined
              }
              onDelete={() =>
                editingCustomId
                  ? handleDeleteCustom({
                      id: editingCustomId,
                      label: customDraft.label
                    })
                  : undefined
              }
              onReset={resetCustomEditor}
            />
          )}
        </main>
      </div>

      {status ? <div className="lc-models-status">{status}</div> : null}
    </div>
  );
}
