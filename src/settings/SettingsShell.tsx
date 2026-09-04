import { useEffect, useMemo, useRef, useState } from "react";
import type {
  SettingContribution,
  SettingsCategory,
  SettingsPageContribution
} from "./registry";
import { settingsRegistry } from "./registry";

type SettingsShellProps = {
  onRequestClose: () => void;
};

type CategoryGroup = {
  id: string;
  label: string;
  description: string;
  pages: SettingsPageContribution[];
  settingCount: number;
};

const CATEGORY_ORDER: SettingsCategory[] = [
  "general",
  "editor",
  "services",
  "workspace",
  "extensions",
  "advanced"
];

const CATEGORY_META: Record<SettingsCategory, { label: string; labelEn: string; description: string; descriptionEn: string }> = {
  general: { label: "通用", labelEn: "General", description: "基础偏好与通用行为", descriptionEn: "Basic preferences and general behavior" },
  editor: { label: "编辑器", labelEn: "Editor", description: "编辑器行为与显示相关设置", descriptionEn: "Editor behavior and display settings" },
  services: { label: "服务", labelEn: "Services", description: "服务地址、Mail 与外部集成", descriptionEn: "Service endpoints, mail, and external integrations" },
  workspace: { label: "工作区", labelEn: "Workspace", description: "技能索引、文件访问与工作区能力", descriptionEn: "Skill indexing, file access, and workspace capabilities" },
  extensions: { label: "扩展", labelEn: "Extensions", description: "扩展提供的自定义设置", descriptionEn: "Custom settings provided by extensions" },
  advanced: { label: "高级", labelEn: "Advanced", description: "实验项和高级能力", descriptionEn: "Experimental options and advanced capabilities" }
};

function isEnglishLocale(): boolean {
  try {
    return String(window.zion?.i18n?.getLocale?.() || window.zion?.state?.get?.("ui.locale") || "").startsWith("en");
  } catch {
    return false;
  }
}

function ui(zh: string, en: string): string {
  return isEnglishLocale() ? en : zh;
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function tr(key: string | undefined, fallback = ""): string {
  if (!key) return fallback;
  try {
    const translated = window.zion?.i18n?.t?.(key);
    if (translated && translated !== key) return translated;
  } catch {
    // Fall back to the supplied copy when the i18n service is unavailable.
  }
  return fallback || key;
}

function settingLabel(setting: SettingContribution): string {
  return tr(setting.labelKey, setting.label);
}

function settingDescription(setting: SettingContribution): string {
  return tr(setting.descriptionKey, setting.description || "");
}

function pageTitle(page: SettingsPageContribution): string {
  return tr(page.titleKey, page.title);
}

function pageDescription(page: SettingsPageContribution): string {
  return tr(page.descriptionKey, page.description || "");
}

function sectionTitle(section: SettingsPageContribution["sections"][number]): string {
  return tr(section.titleKey, section.title);
}

function sectionDescription(section: SettingsPageContribution["sections"][number]): string {
  return tr(section.descriptionKey, section.description || "");
}

function optionLabel(option: NonNullable<SettingContribution["enumOptions"]>[number]): string {
  return tr(option.labelKey, option.label);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return String(a) === String(b);
  }
}

function formatDefaultValue(value: unknown): string {
  if (typeof value === "boolean") return value ? ui("开", "On") : ui("关", "Off");
  if (Array.isArray(value)) return value.join(", ");
  if (value == null || value === "") return ui("空", "Empty");
  return String(value);
}

function isDefaultValue(setting: SettingContribution, value: unknown): boolean {
  if (setting.defaultValue === undefined) return false;
  return valuesEqual(normalizeDraftValue(setting, value), normalizeDraftValue(setting, setting.defaultValue));
}

function getIdleMetaText(setting: SettingContribution, value: unknown): string {
  if (setting.defaultValue === undefined) return "";
  return isDefaultValue(setting, value) ? ui("使用默认值", "Using default") : ui("已自定义", "Customized");
}

function getControlLayout(setting: SettingContribution): "compact" | "wide" {
  if (setting.controlLayout) return setting.controlLayout;
  if (setting.kind === "textarea") return "wide";
  if (setting.inputMode === "url" || setting.inputMode === "email") return "wide";
  return "compact";
}

function normalizeDraftValue(setting: SettingContribution, value: unknown): unknown {
  if (setting.kind === "boolean") return !!value;
  if (setting.kind === "multiselect") return Array.isArray(value) ? value.map(String) : [];
  if (value == null) return "";
  return value;
}

async function loadSettingValue(setting: SettingContribution): Promise<unknown> {
  if (typeof setting.getValue === "function") {
    return normalizeDraftValue(setting, await setting.getValue());
  }
  return normalizeDraftValue(setting, setting.defaultValue);
}

function sortPages(a: SettingsPageContribution, b: SettingsPageContribution): number {
  const orderCompare = (a.order ?? 0) - (b.order ?? 0);
  if (orderCompare !== 0) return orderCompare;
  return pageTitle(a).localeCompare(pageTitle(b));
}

function sortSettings(a: SettingContribution, b: SettingContribution): number {
  const orderCompare = (a.order ?? 0) - (b.order ?? 0);
  if (orderCompare !== 0) return orderCompare;
  return settingLabel(a).localeCompare(settingLabel(b));
}

function matchesSetting(setting: SettingContribution, query: string): boolean {
  const haystack = [
    setting.id,
    settingLabel(setting),
    settingDescription(setting),
    setting.scope,
    ...(setting.tags || [])
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
  return haystack.includes(query);
}

function matchesPage(page: SettingsPageContribution, query: string): boolean {
  const haystack = [page.id, pageTitle(page), pageDescription(page), page.pluginId, ...(page.keywords || [])]
    .map(normalizeText)
    .filter(Boolean)
    .join(" ");
  return haystack.includes(query);
}

function filterPages(pages: SettingsPageContribution[], query: string): SettingsPageContribution[] {
  if (!query) {
    return pages.slice().sort(sortPages);
  }

  const filtered = pages
    .map((page) => {
      const pageMatched = matchesPage(page, query);
      const sections = page.sections
        .map((section) => {
          const sectionMatched = [section.id, sectionTitle(section), sectionDescription(section)]
            .map(normalizeText)
            .filter(Boolean)
            .join(" ")
            .includes(query);
          const settings = section.settings
            .filter((setting) => pageMatched || sectionMatched || matchesSetting(setting, query))
            .sort(sortSettings);
          if (settings.length === 0) return null;
          return { ...section, settings };
        })
        .filter(Boolean) as SettingsPageContribution["sections"];

      if (sections.length === 0) return null;
      return { ...page, sections };
    })
    .filter((page): page is SettingsPageContribution => !!page);

  return filtered.sort(sortPages);
}

function buildCategories(pages: SettingsPageContribution[]): CategoryGroup[] {
  const groups = new Map<SettingsCategory, SettingsPageContribution[]>();
  for (const page of pages) {
    const list = groups.get(page.category) || [];
    list.push(page);
    groups.set(page.category, list);
  }

  return CATEGORY_ORDER.filter((category) => groups.has(category)).map((category) => {
    const groupPages = (groups.get(category) || []).slice().sort(sortPages);
    return {
      id: category,
      label: isEnglishLocale() ? CATEGORY_META[category].labelEn : CATEGORY_META[category].label,
      description: isEnglishLocale() ? CATEGORY_META[category].descriptionEn : CATEGORY_META[category].description,
      pages: groupPages,
      settingCount: groupPages.reduce(
        (sum, page) => sum + page.sections.reduce((sectionSum, section) => sectionSum + section.settings.length, 0),
        0
      )
    };
  });
}

function useSettingsPages(): SettingsPageContribution[] {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const disp = settingsRegistry.onDidChange(() => setRevision((v) => v + 1));
    let i18nDisp: { dispose?: () => void } | undefined;
    try {
      i18nDisp = window.zion?.events?.on?.("i18n/changed", () => setRevision((v) => v + 1));
    } catch {
      // The settings shell can run before the global event bus is installed.
    }
    return () => {
      disp.dispose();
      try {
        i18nDisp?.dispose?.();
      } catch {
        // Disposal is best-effort during Workbench teardown.
      }
    };
  }, []);
  return useMemo(() => settingsRegistry.getPages(), [revision]);
}

function LegacyMount({ setting }: { setting: SettingContribution }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = "";
    setError("");
    if (typeof setting.renderLegacy !== "function") return;
    let disp: { dispose?: () => void } | void;
    try {
      disp = setting.renderLegacy(host);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      try {
        disp?.dispose?.();
      } catch {
        // Best-effort cleanup for legacy settings renderers.
      }
      try {
        host.innerHTML = "";
      } catch {
        // Ignore teardown failures from detached hosts.
      }
    };
  }, [setting]);

  return (
    <div className="zion-settings-item-body">
      <div ref={hostRef} className="zion-settings-legacy-host zion-settings-form-scope" />
      {error ? <div className="zion-settings-item-error">{ui("渲染失败", "Render failed")}: {error}</div> : null}
    </div>
  );
}

function SettingBadges({ setting }: { setting: SettingContribution }) {
  const badges: string[] = [];
  if (setting.scope && setting.scope !== "application") badges.push(setting.scope);
  if (setting.requiresRestart) badges.push("requires restart");
  if (setting.experimental) badges.push("experimental");
  if (setting.dangerous) badges.push("dangerous");
  if (badges.length === 0) return null;
  return (
    <div className="zion-settings-setting-badges">
      {badges.map((badge) => (
        <span
          key={badge}
          className={`zion-settings-setting-badge ${
            badge === "dangerous" ? "is-danger" : badge === "experimental" ? "is-experimental" : ""
          }`}
        >
          {badge}
        </span>
      ))}
    </div>
  );
}

function CustomSettingBody({ setting }: { setting: SettingContribution }) {
  const description = settingDescription(setting);
  if (typeof setting.renderCustom === "function") {
    return (
      <div className="zion-settings-item-body">
        {description ? <p className="zion-settings-item-desc">{description}</p> : null}
        <div className="zion-settings-react-host zion-settings-form-scope">
          {setting.renderCustom({ setting })}
        </div>
      </div>
    );
  }
  return <LegacyMount setting={setting} />;
}

function isCustomSetting(setting: SettingContribution): boolean {
  return setting.kind === "custom" || typeof setting.renderCustom === "function" || typeof setting.renderLegacy === "function";
}

function isStandaloneCustomPage(page: SettingsPageContribution): boolean {
  if (page.sections.length !== 1) return false;
  const [section] = page.sections;
  if (section.settings.length !== 1) return false;
  return isCustomSetting(section.settings[0]);
}

function StandaloneCustomSetting({ setting }: { setting: SettingContribution }) {
  if (typeof setting.renderCustom === "function") {
    return <div className="zion-settings-standalone zion-settings-form-scope">{setting.renderCustom({ setting })}</div>;
  }
  return (
    <div className="zion-settings-standalone">
      <LegacyMount setting={setting} />
    </div>
  );
}

function StandardSettingBody({ setting }: { setting: SettingContribution }) {
  const controlLayout = getControlLayout(setting);
  const description = settingDescription(setting);
  const placeholder = tr(setting.placeholderKey, setting.placeholder || "");
  const actionLabel = tr(setting.actionLabelKey, setting.actionLabel || ui("执行", "Run"));
  const [loading, setLoading] = useState(setting.kind !== "action");
  const [saving, setSaving] = useState(false);
  const [savedValue, setSavedValue] = useState<unknown>(normalizeDraftValue(setting, setting.defaultValue));
  const [draftValue, setDraftValue] = useState<unknown>(normalizeDraftValue(setting, setting.defaultValue));
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const reload = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await loadSettingValue(setting);
      setSavedValue(next);
      setDraftValue(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (setting.kind === "action") return;
    void reload();
  }, [setting]);

  const dirty = !valuesEqual(savedValue, draftValue);

  useEffect(() => {
    if (setting.kind === "action") return;
    if (loading || saving || !dirty) return;
    if (typeof setting.setValue !== "function") return;
    const delay = setting.kind === "boolean" || setting.kind === "select" ? 80 : 320;
    const timer = window.setTimeout(() => {
      void persistDraft();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [dirty, draftValue, loading, saving, setting]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 2200);
    return () => window.clearTimeout(timer);
  }, [message]);

  const validateDraft = async (): Promise<string> => {
    if (typeof setting.validate !== "function") return "";
    try {
      return (await setting.validate(draftValue)) || "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  const persistDraft = async () => {
    if (typeof setting.setValue !== "function") return;
    setSaving(true);
    const validationError = await validateDraft();
    if (validationError) {
      setError(validationError);
      setSaving(false);
      return;
    }
    try {
      await setting.setValue(draftValue);
      const next = await loadSettingValue(setting);
      setSavedValue(next);
      setDraftValue(next);
      setError("");
      setMessage(ui("已保存", "Saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setMessage("");
    try {
      if (typeof setting.reset === "function") {
        await setting.reset();
        await reload();
        setMessage(ui("已恢复默认", "Restored default"));
      } else {
        setDraftValue(savedValue);
        setError("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleAction = async () => {
    if (typeof setting.run !== "function") return;
    setSaving(true);
    setMessage("");
    setError("");
    try {
      await setting.run();
      setMessage(ui("已执行", "Done"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const renderControl = () => {
    if (setting.kind === "boolean") {
      return (
        <label className="zion-settings-toggle">
          <input
            type="checkbox"
            checked={!!draftValue}
            onChange={(e) => {
              setDraftValue(e.target.checked);
              setError("");
            }}
          />
          <span>{draftValue ? ui("开", "On") : ui("关", "Off")}</span>
        </label>
      );
    }

    if (setting.kind === "textarea") {
      return (
        <textarea
          value={String(draftValue ?? "")}
          placeholder={placeholder}
          onChange={(e) => {
            setDraftValue(e.target.value);
            setError("");
          }}
        />
      );
    }

    if (setting.kind === "select") {
      return (
        <select
          value={String(draftValue ?? "")}
          onChange={(e) => {
            setDraftValue(e.target.value);
            setError("");
          }}
        >
          {(setting.enumOptions || []).map((option) => (
            <option key={option.value} value={option.value}>
              {optionLabel(option)}
            </option>
          ))}
        </select>
      );
    }

    if (setting.kind === "multiselect") {
      const selected = Array.isArray(draftValue) ? draftValue.map(String) : [];
      const selectedSet = new Set(selected);
      const options = setting.enumOptions || [];
      return (
        <div className="zion-settings-multiselect">
          {options.length === 0 ? (
            <div className="zion-settings-multiselect-empty">{ui("暂无可选项", "No options available")}</div>
          ) : (
            options.map((option) => (
              <label key={option.value} className="zion-settings-multiselect-option">
                <input
                  type="checkbox"
                  checked={selectedSet.has(option.value)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(option.value);
                    else next.delete(option.value);
                    setDraftValue(Array.from(next));
                    setError("");
                  }}
                />
                <span className="zion-settings-multiselect-label">{optionLabel(option)}</span>
              </label>
            ))
          )}
        </div>
      );
    }

    if (setting.kind === "action") {
      return (
        <button type="button" className="primary" disabled={saving} onClick={() => void handleAction()}>
          {saving ? ui("执行中...", "Running...") : actionLabel}
        </button>
      );
    }

    if (setting.kind === "number") {
      return (
        <input
          type="number"
          value={String(draftValue ?? "")}
          placeholder={placeholder}
          inputMode={setting.inputMode ?? "numeric"}
          onChange={(e) => {
            setDraftValue(e.target.value);
            setError("");
          }}
        />
      );
    }

    return (
      <input
        type={setting.kind === "password" ? "password" : "text"}
        value={String(draftValue ?? "")}
        placeholder={placeholder}
        inputMode={setting.inputMode}
        onChange={(e) => {
          setDraftValue(e.target.value);
          setError("");
        }}
      />
    );
  };

  return (
    <div className={`zion-settings-standard-row ${controlLayout === "wide" ? "is-wide" : "is-compact"}`}>
      <div className="zion-settings-standard-main">
        {description ? <p className="zion-settings-item-desc">{description}</p> : null}
        <div className="zion-settings-setting-footer">
          <div className="zion-settings-inline-help">
            {error
              ? error
              : saving
                ? ui("正在保存...", "Saving...")
                : message
                  ? message
                  : dirty
                    ? ui("已修改", "Modified")
                    : getIdleMetaText(setting, savedValue)}
          </div>
          {typeof setting.reset === "function" ? (
            <button
              type="button"
              className="zion-settings-link-button"
              disabled={saving}
              title={setting.defaultValue !== undefined ? `${ui("默认值", "Default")}: ${formatDefaultValue(setting.defaultValue)}` : undefined}
              onClick={() => void handleReset()}
            >
              {ui("重置", "Reset")}
            </button>
          ) : null}
        </div>
      </div>
      <div className={`zion-settings-standard-control zion-settings-form-scope ${controlLayout === "wide" ? "is-wide" : "is-compact"}`}>
        {loading ? <div className="zion-settings-inline-help">{ui("加载中...", "Loading...")}</div> : renderControl()}
      </div>
    </div>
  );
}

function SettingCard({ setting }: { setting: SettingContribution }) {
  const isCustom = isCustomSetting(setting);
  const controlLayout = getControlLayout(setting);
  const label = settingLabel(setting);
  return (
    <article
      className={`zion-settings-item ${isCustom ? "is-custom" : "is-standard"} ${
        !isCustom && controlLayout === "wide" ? "is-wide" : !isCustom ? "is-compact" : ""
      }`}
      title={setting.id}
    >
      <div className="zion-settings-item-head">
        <div>
          <h3 className="zion-settings-item-title">{label}</h3>
        </div>
        <SettingBadges setting={setting} />
      </div>
      {isCustom ? <CustomSettingBody setting={setting} /> : <StandardSettingBody setting={setting} />}
    </article>
  );
}

export function SettingsShell({ onRequestClose }: SettingsShellProps) {
  const pages = useSettingsPages();
  const [query, setQuery] = useState("");
  const normalizedQuery = normalizeText(query);
  const filteredPages = useMemo(() => filterPages(pages, normalizedQuery), [pages, normalizedQuery]);
  const categories = useMemo(() => buildCategories(filteredPages), [filteredPages]);
  const [activePageId, setActivePageId] = useState("");

  useEffect(() => {
    if (normalizedQuery) return;
    if (!filteredPages.some((page) => page.id === activePageId)) {
      setActivePageId(filteredPages[0]?.id || "");
    }
  }, [activePageId, filteredPages, normalizedQuery]);

  const visiblePages = useMemo(() => {
    if (normalizedQuery) return filteredPages;
    return filteredPages.filter((page) => page.id === activePageId);
  }, [activePageId, filteredPages, normalizedQuery]);

  const totalCount = filteredPages.reduce(
    (sum, page) => sum + page.sections.reduce((sectionSum, section) => sectionSum + section.settings.length, 0),
    0
  );

  return (
    <div className="zion-settings-shell">
      <div className="zion-settings-topbar">
        <div className="zion-settings-headings">
          <div className="zion-settings-eyebrow">{ui("偏好", "Preferences")}</div>
          <h2 className="zion-settings-title">{ui("设置", "Settings")}</h2>
        </div>
        <button type="button" className="zion-settings-close" onClick={onRequestClose}>
          {ui("关闭", "Close")}
        </button>
      </div>

      <div className="zion-settings-toolbar">
        <input
          className="zion-settings-search"
          type="text"
          placeholder={ui("搜索设置", "Search settings")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <div className="zion-settings-summary">
          {normalizedQuery ? ui(`${totalCount} 个结果`, `${totalCount} results`) : ui(`${totalCount} 个设置项`, `${totalCount} settings`)}
        </div>
      </div>

      <div className="zion-settings-layout">
        <aside className="zion-settings-sidebar">
          <div className="zion-settings-sidebar-title">{ui("设置", "Settings")}</div>
          {categories.map((category) => {
            return (
              <div key={category.id} className="zion-settings-sidebar-group">
                <div className="zion-settings-sidebar-group-title">
                  <span>{category.label}</span>
                </div>
                {category.pages.map((page) => {
                  const active = !normalizedQuery && activePageId === page.id;
                  const pageSettingCount = page.sections.reduce((sum, section) => sum + section.settings.length, 0);
                  return (
                    <button
                      key={page.id}
                      type="button"
                      className={`zion-settings-nav ${active ? "is-active" : ""}`}
                      onClick={() => setActivePageId(page.id)}
                    >
                      <span className="zion-settings-nav-main">
                        <span className="zion-settings-nav-label">{pageTitle(page)}</span>
                      </span>
                      <span className="zion-settings-nav-count">{pageSettingCount}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </aside>

        <main className="zion-settings-content">
          {visiblePages.length === 0 ? (
            <div className="zion-settings-empty">{ui("没有匹配的设置项，试试别的关键字。", "No matching settings. Try another keyword.")}</div>
          ) : (
            visiblePages.map((page) => (
              <section key={page.id} className="zion-settings-category">
                {isStandaloneCustomPage(page) ? (
                  <StandaloneCustomSetting setting={page.sections[0].settings[0]} />
                ) : (
                  <>
                    <div className="zion-settings-category-head">
                      <div>
                        <div className="zion-settings-category-label">{pageTitle(page)}</div>
                        <div className="zion-settings-category-meta">
                          {pageDescription(page) || (isEnglishLocale() ? CATEGORY_META[page.category].descriptionEn : CATEGORY_META[page.category].description)}
                        </div>
                      </div>
                    </div>

                    {page.sections.map((section) => (
                      <div key={`${page.id}:${section.id}`} className="zion-settings-section">
                        <div className="zion-settings-section-title">{sectionTitle(section)}</div>
                        {sectionDescription(section) ? (
                          <div className="zion-settings-section-desc">{sectionDescription(section)}</div>
                        ) : null}
                        <div className="zion-settings-section-grid">
                          {section.settings.map((setting) => (
                            <SettingCard key={setting.id} setting={setting} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </section>
            ))
          )}
        </main>
      </div>
    </div>
  );
}
