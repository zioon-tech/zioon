import { useEffect, useMemo, useState } from "react";

const DYN_KEY = "zion.models.dynamic";
const PROVIDER_ORDER = ["deepseek", "anthropic", "google"];

const BUILTIN_PROVIDER_META = {
  deepseek: {
    title: "DeepSeek",
    apiKeyKey: "zion.deepseek.apiKey",
    configKey: "zion.deepseek.config",
    fields: ["label", "modelName", "temperature", "max_tokens", "stream", "supportsImage", "preservedThinking", "interleavedThinking"]
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
  if (providerId === "deepseek") return "适合日常对话与代码任务";
  if (providerId === "anthropic") return "偏重稳定表达与长文本";
  if (providerId === "google") return "适合多模态与通用问答";
  return "模型提供方";
}

function describeConfigState(requiresConfig) {
  return requiresConfig ? "还需要补全密钥后才能稳定使用" : "已具备基本使用条件";
}

function getBuiltInStatusRows(row, isActive) {
  return [
    { label: "提供方", value: getProviderTitle(row.providerId) },
    { label: "模型标识", value: row.id },
    { label: "当前默认", value: isActive ? "是" : "否" },
    { label: "连接状态", value: row.requiresConfig ? "待补全" : "已就绪" }
  ];
}

function getCustomStatusRows(editingId, isActive, draft) {
  return [
    { label: "模型 ID", value: editingId || "新建中" },
    { label: "接口地址", value: draft.url || "未填写" },
    { label: "当前默认", value: isActive ? "是" : "否" },
    { label: "连接状态", value: draft.key ? "已填写密钥" : "待补全" }
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

function ProviderConfigEditor({ providerId, draft, onChange, onSave, saving }) {
  const meta = BUILTIN_PROVIDER_META[providerId];
  if (!meta || !draft) return null;
  const showAdvanced = providerId === "deepseek";

  return (
    <div className="lc-models-detail-stack">
      <section className="lc-models-detail-card">
        <div className="lc-models-detail-section-title">连接与常用偏好</div>
        <div className="lc-models-detail-section-desc">先完成最关键的连接项，再按需展开高级设置。</div>
        <div className="lc-models-form two-cols">
          <label className="lc-models-field wide">
            <span>API Key</span>
            <input
              type="password"
              value={draft.apiKey}
              placeholder="输入 API Key"
              onChange={(e) => onChange(providerId, "apiKey", e.target.value)}
            />
          </label>
          {providerId === "deepseek" ? (
            <label className="lc-models-field">
              <span>显示名称</span>
              <input
                type="text"
                value={draft.label}
                placeholder="例如：DeepSeek Chat"
                onChange={(e) => onChange(providerId, "label", e.target.value)}
              />
            </label>
          ) : null}
          {providerId === "deepseek" ? (
            <label className="lc-models-field">
              <span>默认模型</span>
              <input
                type="text"
                value={draft.modelName}
                placeholder="例如：deepseek-chat"
                onChange={(e) => onChange(providerId, "modelName", e.target.value)}
              />
            </label>
          ) : null}
        </div>
        <div className="lc-models-actions">
          <button type="button" className="primary" onClick={() => void onSave(providerId)} disabled={saving}>
            {saving ? "保存中..." : "保存更改"}
          </button>
        </div>
      </section>

      <details className="lc-models-advanced">
        <summary className="lc-models-advanced-summary">高级设置</summary>
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
        </div>
        <div className="lc-models-checks">
          <label className="lc-models-check">
            <input
              type="checkbox"
              checked={!!draft.stream}
              onChange={(e) => onChange(providerId, "stream", e.target.checked)}
            />
            <span>流式返回</span>
          </label>
          {showAdvanced ? (
            <>
              <label className="lc-models-check">
                <input
                  type="checkbox"
                  checked={!!draft.supportsImage}
                  onChange={(e) => onChange(providerId, "supportsImage", e.target.checked)}
                />
                <span>支持图片</span>
              </label>
              <label className="lc-models-check">
                <input
                  type="checkbox"
                  checked={!!draft.preservedThinking}
                  onChange={(e) => onChange(providerId, "preservedThinking", e.target.checked)}
                />
                <span>保留思维链</span>
              </label>
              <label className="lc-models-check">
                <input
                  type="checkbox"
                  checked={!!draft.interleavedThinking}
                  onChange={(e) => onChange(providerId, "interleavedThinking", e.target.checked)}
                />
                <span>交错思维链</span>
              </label>
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
          <div className="lc-models-detail-title">{editingId ? draft.label || editingId : "新建自定义模型"}</div>
          <div className="lc-models-detail-subtitle">
            {editingId ? "保留最必要的信息，作为你自己的默认模型来源。" : "填写基础连接信息后即可加入模型列表。"}
          </div>
        </div>
        <div className="lc-models-detail-actions">
          {editingId ? (
            <button type="button" onClick={onActivate} disabled={isActive}>
              {isActive ? "当前默认" : "设为默认"}
            </button>
          ) : null}
          <button type="button" className="primary" onClick={() => void onSave()} disabled={saving}>
            {saving ? "保存中..." : editingId ? "保存更改" : "创建模型"}
          </button>
          {editingId ? (
            <button type="button" onClick={onDelete} disabled={saving}>
              删除
            </button>
          ) : (
            <button type="button" onClick={onReset} disabled={saving}>
              清空
            </button>
          )}
        </div>
      </section>

      <PreferenceStatusCard title="当前状态" rows={getCustomStatusRows(editingId, isActive, draft)} />

      <section className="lc-models-detail-card">
        <div className="lc-models-detail-section-title">基础信息</div>
        <div className="lc-models-detail-section-desc">先填能决定可不可用的关键信息。</div>
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
            <span>显示名称</span>
            <input type="text" value={draft.label} placeholder="例如：My Model" onChange={(e) => onChange("label", e.target.value)} />
          </label>
          <label className="lc-models-field wide">
            <span>接口地址</span>
            <input
              type="text"
              value={draft.url}
              placeholder="https://api.openai.com/v1/chat/completions"
              onChange={(e) => onChange("url", e.target.value)}
            />
          </label>
          <label className="lc-models-field">
            <span>API Key</span>
            <input type="password" value={draft.key} placeholder="输入 API Key" onChange={(e) => onChange("key", e.target.value)} />
          </label>
          <label className="lc-models-field">
            <span>接口类型</span>
            <select value={draft.providerType} onChange={(e) => onChange("providerType", e.target.value)}>
              <option value="openai">OpenAI</option>
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
            </select>
          </label>
        </div>
      </section>

      <details className="lc-models-advanced">
        <summary className="lc-models-advanced-summary">高级设置</summary>
        <div className="lc-models-form two-cols">
          <label className="lc-models-field">
            <span>模型名覆盖</span>
            <input type="text" value={draft.modelName} placeholder="可选，例如：gpt-4o-mini" onChange={(e) => onChange("modelName", e.target.value)} />
          </label>
          <label className="lc-models-field">
            <span>Temperature</span>
            <input type="number" value={draft.temperature} placeholder="0.7" onChange={(e) => onChange("temperature", e.target.value)} />
          </label>
          <label className="lc-models-field">
            <span>Max Tokens</span>
            <input type="number" value={draft.max_tokens} placeholder="4096" onChange={(e) => onChange("max_tokens", e.target.value)} />
          </label>
        </div>
        <div className="lc-models-checks">
          <label className="lc-models-check">
            <input type="checkbox" checked={!!draft.stream} onChange={(e) => onChange("stream", e.target.checked)} />
            <span>流式返回</span>
          </label>
          <label className="lc-models-check">
            <input type="checkbox" checked={!!draft.supportsImage} onChange={(e) => onChange("supportsImage", e.target.checked)} />
            <span>支持图片</span>
          </label>
          <label className="lc-models-check">
            <input
              type="checkbox"
              checked={!!draft.preservedThinking}
              onChange={(e) => onChange("preservedThinking", e.target.checked)}
            />
            <span>保留思维链</span>
          </label>
          <label className="lc-models-check">
            <input
              type="checkbox"
              checked={!!draft.interleavedThinking}
              onChange={(e) => onChange("interleavedThinking", e.target.checked)}
            />
            <span>交错思维链</span>
          </label>
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
    if (!id) return setStatus("缺少 Model ID");
    if (!url) return setStatus("缺少 Base URL");
    if (!key) return setStatus("缺少 API Key");

    setSavingKey("custom");
    try {
      const dict = loadDynamicStore();
      if (!editingCustomId && dict[id]) {
        setStatus(`模型已存在: ${id}`);
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
      setEditingCustomId(id);
      setCustomDraft(draftFromCustomRow({ id, ...next }));
      setSelection({ kind: "custom", providerId: "user.dynamic", id });
      setStatus(`已保存 custom model: ${id}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey("");
    }
  };

  const handleDeleteCustom = async (row) => {
    const ok = window.confirm(`删除模型 "${row.id}" ?`);
    if (!ok) return;
    setSavingKey(`delete:${row.id}`);
    try {
      const dict = loadDynamicStore();
      delete dict[row.id];
      saveDynamicStore(dict);
      await refresh();
      if (selection?.kind === "custom" && selection.id === row.id) {
        setSelection(selectFallback(activeModel, builtins, loadCustomRows()));
      }
      if (editingCustomId === row.id) {
        setEditingCustomId("");
        setCustomDraft(emptyCustomDraft());
      }
      setStatus(`已删除 custom model: ${row.id}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey("");
    }
  };

  const handleActivate = async (row) => {
    try {
      window.zion?.commands?.executeCommand?.("models.selectModel", `${row.providerId}:${row.id}`);
      setStatus(`当前模型: ${row.label || row.id}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const activeLabel = activeModel?.label || activeModel?.modelId || "未选择模型";
  const selectedProviderId = selectedBuiltIn?.providerId || null;

  return (
    <div className="lc-models">
      <div className="lc-models-toolbar">
        <div className="lc-models-toolbar-main">
          <div className="lc-models-toolbar-title">模型偏好</div>
          <div className="lc-models-toolbar-meta">当前默认：{activeLabel}</div>
        </div>
        <div className="lc-models-toolbar-actions">
          <button type="button" onClick={() => void refresh()}>
            刷新
          </button>
          <button type="button" className="primary" onClick={startNewCustom}>
            新建自定义模型
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
                      {active ? <span className="lc-models-pill">当前</span> : row.requiresConfig ? <span className="lc-models-pill is-warn">待补全</span> : null}
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
                新建
              </button>
            </div>
            <div className="lc-models-sidebar-list">
              {customRows.length === 0 ? (
                <div className="lc-models-empty">暂无</div>
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
                      {active ? <span className="lc-models-pill">当前</span> : null}
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
                    {getProviderSummary(selectedBuiltIn.providerId)}，{describeConfigState(selectedBuiltIn.requiresConfig)}。
                  </div>
                  <div className="lc-models-detail-meta">
                    <span className="lc-models-row-meta">{getProviderTitle(selectedBuiltIn.providerId)}</span>
                    {selectedBuiltIn.requiresConfig ? <span className="lc-models-pill is-warn">需配置</span> : null}
                    {activeModel?.providerId === selectedBuiltIn.providerId && activeModel?.modelId === selectedBuiltIn.id ? (
                      <span className="lc-models-pill">当前</span>
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
                      ? "当前默认"
                      : "设为默认"}
                  </button>
                </div>
              </section>

              <PreferenceStatusCard
                title="当前状态"
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
