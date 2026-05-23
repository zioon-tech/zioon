import type { ReactNode } from "react";

export type SettingsCategory =
  | "general"
  | "editor"
  | "services"
  | "workspace"
  | "extensions"
  | "advanced";

export type SettingKind =
  | "string"
  | "password"
  | "number"
  | "boolean"
  | "select"
  | "multiselect"
  | "textarea"
  | "action"
  | "custom";

export type SettingScope = "application" | "workspace" | "plugin";

export interface SettingOption {
  label: string;
  labelKey?: string;
  value: string;
}

export interface SettingRenderProps {
  setting: SettingContribution;
}

export interface SettingContribution {
  id: string;
  label: string;
  labelKey?: string;
  description?: string;
  descriptionKey?: string;
  kind: SettingKind;
  controlLayout?: "compact" | "wide";
  order?: number;
  tags?: string[];
  scope?: SettingScope;
  defaultValue?: unknown;
  placeholder?: string;
  placeholderKey?: string;
  inputMode?: "text" | "numeric" | "decimal" | "email" | "url" | "search";
  enumOptions?: SettingOption[];
  requiresRestart?: boolean;
  experimental?: boolean;
  dangerous?: boolean;
  actionLabel?: string;
  actionLabelKey?: string;
  getValue?: () => unknown | Promise<unknown>;
  setValue?: (value: unknown) => void | Promise<void>;
  validate?: (value: unknown) => string | null | Promise<string | null>;
  reset?: () => void | Promise<void>;
  run?: () => void | Promise<void>;
  renderCustom?: (props: SettingRenderProps) => ReactNode;
  renderLegacy?: (container: HTMLElement) => { dispose?: () => void } | void;
}

export interface SettingSectionContribution {
  id: string;
  title: string;
  titleKey?: string;
  description?: string;
  descriptionKey?: string;
  order?: number;
  settings: SettingContribution[];
}

export interface SettingsPageContribution {
  id: string;
  title: string;
  titleKey?: string;
  description?: string;
  descriptionKey?: string;
  category: SettingsCategory;
  order?: number;
  keywords?: string[];
  pluginId?: string;
  sections: SettingSectionContribution[];
}

/**
 * Legacy item bridge.
 * 保留给尚未迁移到 page/section/setting 协议的插件使用。
 */
export interface SettingsItem {
  id: string;
  category?: string;
  section: string;
  title: string;
  description?: string;
  keywords?: string[];
  order?: number;
  renderReact?: (props: { item: SettingsItem }) => ReactNode;
  render?: (container: HTMLElement) => { dispose?: () => void } | void;
}

export interface Disposable {
  dispose(): void;
}

type ChangeHandler = () => void;

const CATEGORY_SET = new Set<SettingsCategory>([
  "general",
  "editor",
  "services",
  "workspace",
  "extensions",
  "advanced"
]);

function normalizeCategory(input?: string): SettingsCategory {
  const raw = String(input || "").trim().toLowerCase();
  if (CATEGORY_SET.has(raw as SettingsCategory)) {
    return raw as SettingsCategory;
  }
  if (raw === "service") return "services";
  if (raw === "extension") return "extensions";
  return "extensions";
}

function sortSettings<T extends { order?: number; id?: string; title?: string; label?: string }>(items: T[]): T[] {
  return items.slice().sort((a, b) => {
    const orderCompare = (a.order ?? 0) - (b.order ?? 0);
    if (orderCompare !== 0) return orderCompare;
    const aName = a.title || a.label || a.id || "";
    const bName = b.title || b.label || b.id || "";
    return aName.localeCompare(bName);
  });
}

function clonePage(page: SettingsPageContribution): SettingsPageContribution {
  return {
    ...page,
    sections: sortSettings(page.sections).map((section) => ({
      ...section,
      settings: sortSettings(section.settings)
    }))
  };
}

function legacyItemToPage(item: SettingsItem): SettingsPageContribution {
  return {
    id: `legacy.${item.id}`,
    title: item.section || item.title,
    description: item.description,
    category: normalizeCategory(item.category),
    order: item.order,
    keywords: item.keywords,
    pluginId: "legacy",
    sections: [
      {
        id: `${item.id}.section`,
        title: item.section || "General",
        order: item.order,
        settings: [
          {
            id: item.id,
            label: item.title,
            description: item.description,
            kind: "custom",
            order: item.order,
            tags: item.keywords,
            renderCustom: item.renderReact ? () => item.renderReact!({ item }) : undefined,
            renderLegacy: item.render
          }
        ]
      }
    ]
  };
}

export class SettingsRegistry {
  private pages = new Map<string, SettingsPageContribution>();
  private changeHandlers: ChangeHandler[] = [];

  registerPage(page: SettingsPageContribution): Disposable {
    this.pages.set(page.id, clonePage(page));
    this.fireChange();
    return {
      dispose: () => {
        if (this.pages.get(page.id)?.id === page.id) {
          this.pages.delete(page.id);
          this.fireChange();
        }
      }
    };
  }

  registerItem(item: SettingsItem): Disposable {
    return this.registerPage(legacyItemToPage(item));
  }

  getPages(): SettingsPageContribution[] {
    return sortSettings(Array.from(this.pages.values())).map((page) => clonePage(page));
  }

  onDidChange(handler: ChangeHandler): Disposable {
    this.changeHandlers.push(handler);
    return {
      dispose: () => {
        const idx = this.changeHandlers.indexOf(handler);
        if (idx >= 0) this.changeHandlers.splice(idx, 1);
      }
    };
  }

  private fireChange() {
    for (const handler of this.changeHandlers) {
      try {
        handler();
      } catch {
        // Ignore misbehaving listeners to avoid breaking the registry.
      }
    }
  }
}

export const settingsRegistry = new SettingsRegistry();
