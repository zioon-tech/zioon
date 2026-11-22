import { DISPLAY_DEFAULTS, displayPreferenceStorage, readDisplayPreference, subscribeDisplayPreferences } from "../editor/display-preferences";
import type { SettingsPageContribution } from "./registry";
  const normalizeOptionalColor = (value: unknown) => String(value ?? "").trim().slice(0, 80);

  const validateOptionalColor = (value: unknown) => {
    const color = normalizeOptionalColor(value);
    if (!color) return null;
    try {
      if (CSS.supports?.("color", color)) return null;
    } catch {}
    return "请输入有效的 CSS 颜色，例如 #d1d5db、rgb(209 213 219)；留空则跟随主题。";
  };

  const validateFontFamily = (value: unknown) => {
    const raw = String(value ?? "");
    if (!raw.trim()) return null;
    if (raw.length > 180 || /[;{}<>]/.test(raw) || /[\r\n]/.test(raw)) {
      return "字体名称只能包含字体族列表，不能包含 CSS 语句或换行。";
    }
    return null;
  };

  const validateNumberRange = (value: unknown, min: number, max: number, unitLabel: string) => {
    const n = Number(String(value ?? "").trim());
    if (!Number.isFinite(n)) return `请输入有效数字。`;
    if (n < min || n > max) return `请输入 ${min} 到 ${max} ${unitLabel}之间的数值。`;
    return null;
  };


/** Original Workbench typography page, shared with reader settings. */
export function createEditorAppearancePage(): SettingsPageContribution {
  const page: SettingsPageContribution = {
      id: "editor.appearance",
      title: "Editor Appearance",
      category: "editor",
      order: 10,
      keywords: ["editor", "appearance", "font", "color", "typography", "编辑器", "字体", "颜色"],
      sections: [
        {
          id: "editor.appearance.typography",
          title: "Typography",
          description: "默认跟随主题；这些设置只覆盖编辑器正文区域。",
          settings: [
            {
              id: "editor.appearance.fontFamilyPreset",
              label: "字体族",
              description: "选择编辑器正文使用的字体族。默认使用系统无衬线字体，适合 Markdown 阅读和编辑。",
              kind: "select",
              scope: "application",
              defaultValue: DISPLAY_DEFAULTS["zion.editor.fontFamilyPreset"],
              enumOptions: [
                { label: "系统无衬线（默认）", value: "system-sans" },
                { label: "系统等宽", value: "system-mono" },
                { label: "衬线", value: "serif" },
                { label: "自定义字体族", value: "custom" }
              ],
              getValue: () => readDisplayPreference("zion.editor.fontFamilyPreset"),
              setValue: (value: unknown) => displayPreferenceStorage.setItem("zion.editor.fontFamilyPreset", String(value ?? "")),
              reset: () => displayPreferenceStorage.removeItem("zion.editor.fontFamilyPreset")
            },
            {
              id: "editor.appearance.customFontFamily",
              label: "自定义字体族",
              description: "当字体族选择“自定义”时生效，例如 \"LXGW WenKai\", \"PingFang SC\", sans-serif。",
              kind: "string",
              scope: "application",
              controlLayout: "wide",
              defaultValue: DISPLAY_DEFAULTS["zion.editor.customFontFamily"],
              placeholder: "\"LXGW WenKai\", \"PingFang SC\", sans-serif",
              getValue: () => readDisplayPreference("zion.editor.customFontFamily"),
              setValue: (value: unknown) => displayPreferenceStorage.setItem("zion.editor.customFontFamily", String(value ?? "")),
              validate: validateFontFamily,
              reset: () => displayPreferenceStorage.removeItem("zion.editor.customFontFamily")
            },
            {
              id: "editor.appearance.fontSize",
              label: "字号",
              description: "编辑器正文基础字号，单位 px。",
              kind: "number",
              inputMode: "decimal",
              scope: "application",
              defaultValue: DISPLAY_DEFAULTS["zion.editor.fontSize"],
              getValue: () => readDisplayPreference("zion.editor.fontSize"),
              setValue: (value: unknown) => displayPreferenceStorage.setItem("zion.editor.fontSize", String(value ?? "")),
              validate: (value: unknown) => validateNumberRange(value, 10, 24, "px "),
              reset: () => displayPreferenceStorage.removeItem("zion.editor.fontSize")
            },
            {
              id: "editor.appearance.lineHeight",
              label: "行高",
              description: "编辑器正文行高倍率。Markdown 阅读编辑建议保持在 1.5 到 1.8 之间。",
              kind: "number",
              inputMode: "decimal",
              scope: "application",
              defaultValue: DISPLAY_DEFAULTS["zion.editor.lineHeight"],
              getValue: () => readDisplayPreference("zion.editor.lineHeight"),
              setValue: (value: unknown) => displayPreferenceStorage.setItem("zion.editor.lineHeight", String(value ?? "")),
              validate: (value: unknown) => validateNumberRange(value, 1.2, 2.4, ""),
              reset: () => displayPreferenceStorage.removeItem("zion.editor.lineHeight")
            }
          ]
        },
        {
          id: "editor.appearance.colors",
          title: "Colors",
          description: "颜色默认跟随当前主题；只有填写自定义值时才覆盖主题。",
          settings: [
            {
              id: "editor.appearance.textColor",
              label: "正文颜色",
              description: "留空则跟随主题正文色。支持 CSS 颜色值，例如 #d1d5db 或 rgb(209 213 219)。",
              kind: "string",
              scope: "application",
              defaultValue: DISPLAY_DEFAULTS["zion.editor.textColor"],
              placeholder: "留空跟随主题",
              getValue: () => readDisplayPreference("zion.editor.textColor"),
              setValue: (value: unknown) => displayPreferenceStorage.setItem("zion.editor.textColor", String(value ?? "")),
              validate: validateOptionalColor,
              reset: () => displayPreferenceStorage.removeItem("zion.editor.textColor")
            }
          ]
        }
      ]
  };
  for (const section of page.sections) for (const setting of section.settings) {
    const key = setting.id.replace("editor.appearance.", "zion.editor.");
    setting.subscribeValue = listener => subscribeDisplayPreferences(changed => {
      if (changed === key || changed === "*") listener();
    });
  }
  return page;
}
