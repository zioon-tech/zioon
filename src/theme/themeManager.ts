import { updatePwaThemeColor, type ResolvedTheme } from "./pwa";

export type ThemePreference = "system" | "light" | "dark";
export type ThemeChangeSource = "init" | "settings" | "command" | "system" | "migration" | "refresh";

type ThemeableEditor = {
  setTheme(theme: ResolvedTheme): void;
  refreshWysiwyg?(): void;
};

type ThemeManagerOptions = {
  getEditorCores(): Iterable<ThemeableEditor>;
};

const THEME_PREFERENCE_KEY = "zion.themePreference";
const LEGACY_THEME_KEY = "zion.theme";

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function isResolvedTheme(value: unknown): value is ResolvedTheme {
  return value === "light" || value === "dark";
}

function readStoredPreference(): { preference: ThemePreference; migratedFromLegacy: boolean } {
  try {
    const stored = localStorage.getItem(THEME_PREFERENCE_KEY);
    if (isThemePreference(stored)) return { preference: stored, migratedFromLegacy: false };

    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    if (isResolvedTheme(legacy)) return { preference: legacy, migratedFromLegacy: true };
  } catch {}
  return { preference: "system", migratedFromLegacy: false };
}

function getSystemTheme(): ResolvedTheme {
  try {
    return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export class ThemeManager {
  private preference: ThemePreference;
  private resolvedTheme: ResolvedTheme;
  private mediaQuery: MediaQueryList | null = null;
  private systemHandler = () => {
    if (this.preference === "system") this.apply("system");
  };

  constructor(private readonly opts: ThemeManagerOptions) {
    const initial = readStoredPreference();
    this.preference = initial.preference;
    this.resolvedTheme = this.resolvePreference(initial.preference);
    if (initial.migratedFromLegacy) this.persistPreference(initial.preference);
  }

  init(): void {
    this.mediaQuery = window.matchMedia?.("(prefers-color-scheme: light)") || null;
    try { this.mediaQuery?.addEventListener?.("change", this.systemHandler); } catch {}
    try { this.mediaQuery?.addListener?.(this.systemHandler); } catch {}
    this.exposeApi();
    this.registerCommands();
    this.registerSettings();
    this.apply("init", { force: true });
  }

  dispose(): void {
    try { this.mediaQuery?.removeEventListener?.("change", this.systemHandler); } catch {}
    try { this.mediaQuery?.removeListener?.(this.systemHandler); } catch {}
    this.mediaQuery = null;
  }

  getPreference(): ThemePreference {
    return this.preference;
  }

  getResolvedTheme(): ResolvedTheme {
    return this.resolvedTheme;
  }

  setPreference(preference: ThemePreference, source: ThemeChangeSource = "settings"): void {
    if (!isThemePreference(preference)) return;
    this.preference = preference;
    this.persistPreference(preference);
    this.apply(source);
  }

  toggle(source: ThemeChangeSource = "command"): void {
    this.setPreference(this.resolvedTheme === "dark" ? "light" : "dark", source);
  }

  refresh(): void {
    this.apply("refresh", { force: true });
  }

  getToken(name: string): string {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch {
      return "";
    }
  }

  private resolvePreference(preference: ThemePreference): ResolvedTheme {
    return preference === "system" ? getSystemTheme() : preference;
  }

  private persistPreference(preference: ThemePreference): void {
    try { localStorage.setItem(THEME_PREFERENCE_KEY, preference); } catch {}
    try { localStorage.setItem(LEGACY_THEME_KEY, this.resolvePreference(preference)); } catch {}
  }

  private apply(source: ThemeChangeSource, opts: { force?: boolean } = {}): void {
    const nextResolved = this.resolvePreference(this.preference);
    const changed = this.resolvedTheme !== nextResolved;
    this.resolvedTheme = nextResolved;
    try { localStorage.setItem(LEGACY_THEME_KEY, nextResolved); } catch {}

    for (const editor of this.opts.getEditorCores()) {
      try { editor.setTheme(nextResolved); } catch {}
    }
    document.documentElement.setAttribute("data-theme", nextResolved);

    const refreshEditorThemes = () => {
      for (const editor of this.opts.getEditorCores()) {
        try { editor.refreshWysiwyg?.(); } catch {}
      }
    };
    refreshEditorThemes();
    requestAnimationFrame(() => {
      refreshEditorThemes();
      updatePwaThemeColor(nextResolved);
    });
    updatePwaThemeColor(nextResolved);

    try { window.zion.state.set("ui.themePreference", this.preference); } catch {}
    try { window.zion.state.set("ui.theme", nextResolved); } catch {}
    this.updateStatusEntry();
    this.updateHeaderMenuEntry();

    if (changed || opts.force) {
      try {
        window.zion.events.emit("theme/changed", {
          preference: this.preference,
          resolvedTheme: nextResolved,
          source
        });
      } catch {}
    }
  }

  private getDisplayLabel(): string {
    if (this.preference === "system") {
      return `System (${this.resolvedTheme === "dark" ? "Dark" : "Light"})`;
    }
    return this.resolvedTheme === "dark" ? "Dark" : "Light";
  }

  private updateStatusEntry(): void {
    try {
      window.zion.statusBar.registerItem({
        id: "core.theme",
        text: `Theme: ${this.getDisplayLabel()}`,
        tooltip: "Click to toggle theme",
        onClick: () => window.zion.commands.executeCommand("zion.toggleTheme"),
        priority: 80
      });
    } catch {}
  }

  private updateHeaderMenuEntry(): void {
    try {
      window.zion.editorHeaderMenu?.register?.({
        id: "core.theme",
        title: `切换主题：${this.getDisplayLabel()}`,
        section: "Layout",
        order: 10,
        command: "zion.toggleTheme"
      });
    } catch {}
  }

  private registerCommands(): void {
    try {
      window.zion.commands.registerCommand("zion.setTheme", (theme: ThemePreference) => {
        this.setPreference(theme, "command");
      });
      window.zion.commands.registerCommand("zion.theme.setPreference", (theme: ThemePreference) => {
        this.setPreference(theme, "command");
      });
      window.zion.commands.registerCommand("zion.theme.getPreference", () => this.getPreference());
      window.zion.commands.registerCommand("zion.theme.getResolvedTheme", () => this.getResolvedTheme());
      window.zion.commands.registerCommand("zion.toggleTheme", () => this.toggle("command"));
    } catch {}
  }

  private registerSettings(): void {
    try {
      window.zion.settings?.registerPage?.({
        id: "core.appearance",
        title: "Appearance",
        category: "general",
        order: 10,
        keywords: ["theme", "appearance", "color", "dark", "light", "system"],
        sections: [
          {
            id: "core.appearance.theme",
            title: "Theme",
            settings: [
              {
                id: "appearance.colorTheme",
                label: "Color theme",
                description: "Choose whether Zion Next uses a light theme, a dark theme, or follows the system appearance.",
                kind: "select",
                scope: "application",
                defaultValue: "system",
                enumOptions: [
                  { label: "System", value: "system" },
                  { label: "Light", value: "light" },
                  { label: "Dark", value: "dark" }
                ],
                getValue: () => this.getPreference(),
                setValue: (value: unknown) => {
                  if (isThemePreference(value)) this.setPreference(value, "settings");
                }
              }
            ]
          }
        ]
      });
    } catch {}
  }

  private exposeApi(): void {
    try {
      (window.zion as any).theme = {
        getPreference: () => this.getPreference(),
        getResolvedTheme: () => this.getResolvedTheme(),
        setPreference: (preference: ThemePreference) => this.setPreference(preference, "settings"),
        toggle: () => this.toggle("command"),
        refresh: () => this.refresh(),
        getToken: (name: string) => this.getToken(name)
      };
    } catch {}
  }
}

export function createThemeManager(opts: ThemeManagerOptions): ThemeManager {
  return new ThemeManager(opts);
}
