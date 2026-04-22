import { useEffect, useMemo, useState } from "react";

function formatToolTitle(name) {
  const value = String(name || "").trim();
  if (!value) return "Unnamed Tool";
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getToolDescription(tool) {
  const text = String(tool?.description || "").trim();
  if (text) return text;
  return "允许模型在需要时调用这个工具。";
}

export function ToolsSettingsPage({ getTools, setEnabledTools, openSwitcher }) {
  const [tools, setTools] = useState(() => getTools());

  useEffect(() => {
    const refresh = () => setTools(getTools());
    refresh();
    const subs = [
      window.zion?.state?.onDidChange?.("chat.tools", refresh),
      window.zion?.state?.onDidChange?.("chat.enabledTools", refresh)
    ].filter(Boolean);
    return () => {
      subs.forEach((sub) => {
        try { sub.dispose?.(); } catch {}
      });
    };
  }, [getTools]);

  const enabledNames = useMemo(
    () => tools.filter((tool) => tool.enabled).map((tool) => tool.name),
    [tools]
  );
  const enabledCount = enabledNames.length;
  const totalCount = tools.length;

  const toggleTool = async (name) => {
    const next = new Set(enabledNames);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    await setEnabledTools(Array.from(next));
  };

  return (
    <div className="lc-tools">
      <section className="lc-tools-hero">
        <div>
          <div className="lc-tools-title">工具偏好</div>
          <div className="lc-tools-subtitle">只保留你愿意让模型调用的工具。这里更适合做日常开关，复杂选择交给切换器。</div>
        </div>
        <div className="lc-tools-actions">
          <button type="button" className="primary" onClick={() => void openSwitcher()}>
            打开切换器
          </button>
        </div>
      </section>

      <section className="lc-tools-summary">
        <div className="lc-tools-summary-main">
          <span className="lc-tools-summary-number">{enabledCount}</span>
          <span className="lc-tools-summary-text">已启用，共 {totalCount} 个工具</span>
        </div>
        <div className="lc-tools-summary-actions">
          <button type="button" className="zion-settings-link-button" onClick={() => void setEnabledTools([])}>
            全部关闭
          </button>
          <button type="button" className="zion-settings-link-button" onClick={() => void setEnabledTools(tools.map((tool) => tool.name))}>
            全部启用
          </button>
        </div>
      </section>

      <section className="lc-tools-panel">
        <div className="lc-tools-section-title">可用工具</div>
        <div className="lc-tools-section-desc">点击右侧开关即可控制启用状态。启用中的工具会排在前面，方便快速浏览。</div>
        <div className="lc-tools-list" role="list">
          {tools.length === 0 ? (
            <div className="lc-tools-empty">当前还没有可用工具。</div>
          ) : (
            tools.map((tool) => (
              <div
                key={tool.name}
                className={`lc-tools-row ${tool.enabled ? "is-enabled" : ""}`}
                role="listitem"
              >
                <div className="lc-tools-row-main">
                  <div className="lc-tools-row-head">
                    <span className="lc-tools-row-title">{tool.title}</span>
                    {tool.enabled ? <span className="lc-tools-row-state">已启用</span> : null}
                  </div>
                  <div className="lc-tools-row-desc">{getToolDescription(tool)}</div>
                  {tool.title !== tool.name ? (
                    <div className="lc-tools-row-meta">{tool.name}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={`lc-tools-toggle ${tool.enabled ? "is-enabled" : ""}`}
                  aria-pressed={tool.enabled}
                  aria-label={`${tool.enabled ? "关闭" : "启用"} ${tool.title}`}
                  onClick={() => void toggleTool(tool.name)}
                >
                  <span className="lc-tools-toggle-track">
                    <span className="lc-tools-toggle-knob" />
                  </span>
                </button>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

export function buildToolRows(rawTools, enabledNames) {
  const enabledSet = new Set(Array.isArray(enabledNames) ? enabledNames : []);
  return (Array.isArray(rawTools) ? rawTools : [])
    .map((tool) => {
      const name = tool?.function?.name;
      if (!name) return null;
      return {
        name,
        title: formatToolTitle(name),
        description: String(tool?.function?.description || "").trim(),
        enabled: enabledSet.has(name)
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
      return left.title.localeCompare(right.title);
    });
}
