import { useEffect, useMemo, useState } from "react";
import {
  THINKING_MODE_FIELDS,
  getThinkingEffortOptions,
  getThinkingModeLabel,
  getThinkingModeOptions,
  inferThinkingCapability,
  inferThinkingEffortCapability,
  normalizeThinkingEffort,
  normalizeThinkingMode
} from "./model-config-fields.js";

const DYN_KEY = "zion.models.dynamic";
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
      "interleavedThinking"
    ]
  },
  anthropic: {
    title: "Claude",
    apiKeyKey: "zion.claude.apiKey",
    configKey: "zion.claude.config",
    fields: ["temperature", "max_tokens", "stream"]
  },
  google: {
    title: "Gemini",
    apiKeyKey: "zion.gemini.apiKey",
    configKey: "zion.gemini.config",
    fields: ["temperature", "max_tokens", "stream"]
  }
};

function loadJson(key, fallback) {
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
  return loadJson(DYN_KEY, {});
}

function saveDynamicStore(dict) {
  localStorage.setItem(DYN_KEY, JSON.stringify(dict));
}

function loadCustomRows() {
  const dict = loadDynamicStore();
  return Object.entries(dict)
    .map(([id, cfg]) => ({ id, ...cfg }))
    .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
}

function loadProviderDraft(providerId) {
  const meta = BUILTIN_PROVIDER_META[providerId];
  if (!meta) return null;
  const cfg = loadJson(meta.configKey, {});
  const apiKey = localStorage.getItem(meta.apiKeyKey) || "";
  return {
    apiKey,
    label: String(cfg.label || ""),
    modelName: String(cfg.modelName || ""),
    temperature: cfg.temperature ?? "",
    max_tokens: cfg.max_tokens ?? "",
    stream: cfg.stream !== false,
    supportsImage: !!cfg.supportsImage,
    supportsThinking: cfg.supportsThinking,
    supportsThinkingEffort: cfg.supportsThinkingEffort,
    thinkingMode: normalizeThinkingMode(cfg.thinkingMode),
    thinkingEffort: normalizeThinkingEffort(cfg.thinkingEffort),
    preservedThinking: !!cfg.preservedThinking,
    interleavedThinking: !!cfg.interleavedThinking
  };
}

function saveProviderDraft(providerId, draft) {
  const meta = BUILTIN_PROVIDER_META[providerId];
  if (!meta) return;
  const next = {};
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
    if (field === "temperature" && draft.temperature !== "") next.temperature = Number(draft.temperature);
    if (field === "max_tokens" && draft.max_tokens !== "") next.max_tokens = Number(draft.max_tokens);
    if (field === "label" && String(draft.label || "").trim()) next.label = String(draft.label).trim();
    if (field === "modelName" && String(draft.modelName || "").trim()) next.modelName = String(draft.modelName).trim();
  }
  localStorage.setItem(meta.apiKeyKey, String(draft.apiKey || "").trim());
  localStorage.setItem(meta.configKey, JSON.stringify(next));
}

function emptyCustomDraft() {
  return {
    id: "",
    label: "",
    url: "",
    key: "",
    providerType: "openai",
    modelName: "",
    temperature: "",
    max_tokens: "",
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
    url: String(row.url || ""),
    key: String(row.key || ""),
    providerType: String(row.providerType || "openai"),
    modelName: String(row.modelName || row.model || ""),
    temperature: row.temperature ?? "",
    max_tokens: row.max_tokens ?? "",
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

async function rebuildCatalog() {
  const ids = window.zion?.models?.listProviders?.() || [];
  const models = [];
  for (const pid of ids) {
    const prov = window.zion?.models?.getProvider?.(pid);
    if (!prov?.list) continue;
    let list = [];
    try {
      list = await prov.list();
    } catch {}
    for (const m of list || []) {
      let requiresConfig = false;
      let configHint = "";
      try {
        const cfg = await prov.resolve?.(m.id);
        if (cfg?._requiresConfig && (!cfg.key || !String(cfg.key).trim())) {
          requiresConfig = true;
          configHint = cfg._configHint || tt("需要配置 API key", "API key required");
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
  window.zion?.state?.set?.("models.catalog", models);
  return models;
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

function describeConfigState(requiresConfig) {
  return requiresConfig ? tt("还需要补全密钥后才能稳定使用", "Complete the key before stable use") : tt("已具备基本使用条件", "Ready for basic use");
}

function getBuiltInStatusRows(row, isActive) {
  return [
    { label: tt("提供方", "Provider"), value: getProviderTitle(row.providerId) },
    { label: tt("模型标识", "Model ID"), value: row.id },
    { label: tt("当前默认", "Default"), value: isActive ? tt("是", "Yes") : tt("否", "No") },
    { label: tt("连接状态", "Connection"), value: row.requiresConfig ? tt("待补全", "Incomplete") : tt("已就绪", "Ready") }
  ];
}

function getCustomStatusRows(editingId, isActive, draft) {
  return [
    { label: tt("模型 ID", "Model ID"), value: editingId || tt("新建中", "New") },
    { label: tt("接口地址", "Base URL"), value: draft.url || tt("未填写", "Empty") },
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
          value={normalizeThinkingEffort(draft.thinkingEffort)}
          onChange={(e) => onChange("thinkingEffort", e.target.value)}
          title={supportsEffort ? tt("当前模型可能支持思考强度。", "This model may support thinking effort.") : tt("未确认当前模型支持强度设置；如服务商兼容，可手动选择。", "Effort support is not confirmed; choose manually if your provider supports it.")}
        >
          {getThinkingEffortOptions().map((option) => (
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

function ProviderConfigEditor({ providerId, draft, onChange, onSave, saving }) {
  const meta = BUILTIN_PROVIDER_META[providerId];
  if (!meta || !draft) return null;
  const showAdvanced = providerId === "deepseek";

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
              onChange={(e) => onChange(providerId, "apiKey", e.target.value)}
            />
          </label>
          {providerId === "deepseek" ? (
            <label className="lc-models-field">
              <span>{tt("显示名称", "Display Name")}</span>
              <input
                type="text"
                value={draft.label}
                placeholder={tt("例如：DeepSeek Chat", "e.g. DeepSeek Chat")}
                onChange={(e) => onChange(providerId, "label", e.target.value)}
              />
            </label>
          ) : null}
          {providerId === "deepseek" ? (
            <label className="lc-models-field">
              <span>{tt("默认模型", "Default Model")}</span>
              <input
                type="text"
                value={draft.modelName}
                placeholder={tt("例如：deepseek-chat", "e.g. deepseek-chat")}
                onChange={(e) => onChange(providerId, "modelName", e.target.value)}
              />
            </label>
          ) : null}
        </div>
        <div className="lc-models-actions">
          <button type="button" className="primary" onClick={() => void onSave(providerId)} disabled={saving}>
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
              onChange={(e) => onChange(providerId, "temperature", e.target.value)}
            />
          </label>
          <label className="lc-models-field">
            <span>Max Tokens</span>
            <input
              type="number"
              value={draft.max_tokens}
              placeholder="4096"
              onChange={(e) => onChange(providerId, "max_tokens", e.target.value)}
            />
          </label>
          {showAdvanced ? (
            <ThinkingConfigFields
              draft={draft}
              onChange={(field, value) => onChange(providerId, field, value)}
              modelInfo={{ providerId, providerType: providerId === "deepseek" ? "openai" : providerId, modelName: draft.modelName }}
            />
          ) : null}
        </div>
        <div className="lc-models-checks">
          <label className="lc-models-check">
            <input
              type="checkbox"
              checked={!!draft.stream}
              onChange={(e) => onChange(providerId, "stream", e.target.checked)}
            />
            <span>{tt("流式返回", "Stream")}</span>
          </label>
          {showAdvanced ? (
            <>
              <label className="lc-models-check">
                <input
                  type="checkbox"
                  checked={!!draft.supportsImage}
                  onChange={(e) => onChange(providerId, "supportsImage", e.target.checked)}
                />
                <span>{tt("支持图片", "Supports Images")}</span>
              </label>
              {THINKING_MODE_FIELDS.map((field) => (
                <label key={field.key} className="lc-models-check" title={isEn() ? field.descriptionEn || field.description : field.description}>
                  <input
                    type="checkbox"
                    checked={!!draft[field.key]}
                    onChange={(e) => onChange(providerId, field.key, e.target.checked)}
                  />
                  <span>{getThinkingModeLabel(field.key)}</span>
                </label>
              ))}
            </>
          ) : null}
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
            <span>Max Tokens</span>
            <input type="number" value={draft.max_tokens} placeholder="4096" onChange={(e) => onChange("max_tokens", e.target.value)} />
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
  return { kind: "new-custom", providerId: "user.dynamic", id: "" };
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
  const [providerDrafts, setProviderDrafts] = useState(() => ({
    deepseek: loadProviderDraft("deepseek"),
    anthropic: loadProviderDraft("anthropic"),
    google: loadProviderDraft("google")
  }));
  const [selection, setSelection] = useState(null);
  const [customDraft, setCustomDraft] = useState(emptyCustomDraft);
  const [editingCustomId, setEditingCustomId] = useState("");
  const [status, setStatus] = useState("");
  const [savingKey, setSavingKey] = useState("");

  useEffect(() => {
    setCatalog(Array.isArray(catalogFromState) ? catalogFromState : []);
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
    const nextCustomRows = loadCustomRows();
    setCustomRows(nextCustomRows);
  }, [catalog]);

  useEffect(() => {
    const nextCustomRows = loadCustomRows();
    const nextBuiltins = Array.isArray(catalogFromState)
      ? catalogFromState.filter((row) => row.providerId !== "user.dynamic")
      : [];
    setCustomRows(nextCustomRows);
    setSelection((prev) => {
      if (isValidSelection(prev, nextBuiltins, nextCustomRows)) return prev;
      return selectFallback(activeModel, nextBuiltins, nextCustomRows);
    });
  }, [activeModel, catalogFromState]);

  const selectedBuiltIn =
    selection?.kind === "catalog"
      ? builtins.find((row) => row.providerId === selection.providerId && row.id === selection.id) || null
      : null;
  const refresh = async () => {
    const next = await rebuildCatalog();
    const nextCustomRows = loadCustomRows();
    setCatalog(next);
    setCustomRows(nextCustomRows);
    setProviderDrafts({
      deepseek: loadProviderDraft("deepseek"),
      anthropic: loadProviderDraft("anthropic"),
      google: loadProviderDraft("google")
    });
    setSelection((prev) => {
      const nextBuiltins = next.filter((row) => row.providerId !== "user.dynamic");
      if (isValidSelection(prev, nextBuiltins, nextCustomRows)) return prev;
      return selectFallback(activeModel, nextBuiltins, nextCustomRows);
    });
  };

  const setProviderField = (providerId, field, value) => {
    setProviderDrafts((prev) => ({
      ...prev,
      [providerId]: {
        ...(prev[providerId] || loadProviderDraft(providerId)),
        [field]: value
      }
    }));
  };

  const handleSaveProvider = async (providerId) => {
    setSavingKey(`provider:${providerId}`);
    try {
      saveProviderDraft(providerId, providerDrafts[providerId]);
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
    if (!key) return setStatus(tt("缺少 API Key", "Missing API Key"));

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
        url,
        key,
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
      dict[id] = next;
      saveDynamicStore(dict);
      await refresh();
      try { window.zion?.events?.emit?.("models/configChanged", { providerId: "user.dynamic", modelId: id }); } catch {}
      setEditingCustomId(id);
      setCustomDraft(draftFromCustomRow({ id, ...next }));
      setSelection({ kind: "custom", providerId: "user.dynamic", id });
      setStatus(tt(`已保存 custom model: ${id}`, `Saved custom model: ${id}`));
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
      const dict = loadDynamicStore();
      delete dict[row.id];
      saveDynamicStore(dict);
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
                    {getProviderSummary(selectedBuiltIn.providerId)}{isEn() ? ", " : "，"}{describeConfigState(selectedBuiltIn.requiresConfig)}{isEn() ? "." : "。"}
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
                draft={providerDrafts[selectedProviderId]}
                onChange={setProviderField}
                onSave={handleSaveProvider}
                saving={savingKey === `provider:${selectedProviderId}`}
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
