import { updatePwaThemeColor, type ResolvedTheme } from "./pwa";
import {
  getThemeOption,
  getThemeOptionByVariant,
  isThemePreference,
  isThemeSelection,
  isThemeVariant,
  registerThemeOption,
  type BuiltInThemeOption,
  type ThemePreference,
  type ThemeSelection,
  type ThemeVariant
} from "./themes";

export type { ThemePreference, ThemeSelection, ThemeVariant } from "./themes";
export type ThemeChangeSource = "init" | "settings" | "command" | "system" | "migration" | "refresh";

type ThemeableEditor = {
  setTheme(theme: ResolvedTheme): void;
  refreshWysiwyg?(): void;
};

type ThemeManagerOptions = {
  getEditorCores(): Iterable<ThemeableEditor>;
};

const THEME_PREFERENCE_KEY = "zion.themePreference";
const THEME_VARIANT_KEY = "zion.themeVariant";
const LEGACY_THEME_KEY = "zion.theme";

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

function readStoredVariant(): ThemeVariant {
  try {
    const stored = localStorage.getItem(THEME_VARIANT_KEY);
    if (isThemeVariant(stored)) return stored;
  } catch {}
  return "default";
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
  private variant: ThemeVariant;
  private resolvedTheme: ResolvedTheme;
  private mediaQuery: MediaQueryList | null = null;
  private systemHandler = () => {
    if (this.preference === "system") this.apply("system");
  };

  constructor(private readonly opts: ThemeManagerOptions) {
    const initial = readStoredPreference();
    this.preference = initial.preference;
    this.variant = readStoredVariant();
    this.resolvedTheme = this.resolvePreference(initial.preference);
    if (initial.migratedFromLegacy) this.persistPreference(initial.preference);
  }

  init(): void {
    this.mediaQuery = window.matchMedia?.("(prefers-color-scheme: light)") || null;
    try { this.mediaQuery?.addEventListener?.("change", this.systemHandler); } catch {}
    try { this.mediaQuery?.addListener?.(this.systemHandler); } catch {}
    this.exposeApi();
    this.registerCommands();
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

  getVariant(): ThemeVariant {
    if (this.preference === "system") return "default";
    return this.variant;
  }

  getSelection(): ThemeSelection {
    if (this.preference === "system") return "system";
    if (this.variant !== "default") {
      return getThemeOptionByVariant(this.variant, this.resolvedTheme).id;
    }
    return this.preference;
  }

  setSelection(selection: ThemeSelection, source: ThemeChangeSource = "settings"): void {
    if (!isThemeSelection(selection)) return;
    if (isThemePreference(selection)) {
      this.preference = selection;
      this.variant = "default";
    } else {
      const theme = getThemeOption(selection);
      this.preference = theme.baseTheme === "system" ? "system" : theme.baseTheme;
      this.variant = theme.variant;
    }
    this.persistPreference(this.preference);
    try { localStorage.setItem(THEME_VARIANT_KEY, this.variant); } catch {}
    this.apply(source, { force: true });
  }

  setPreference(preference: ThemePreference, source: ThemeChangeSource = "settings"): void {
    if (!isThemePreference(preference)) return;
    this.preference = preference;
    this.variant = "default";
    this.persistPreference(preference);
    try { localStorage.setItem(THEME_VARIANT_KEY, this.variant); } catch {}
    this.apply(source);
  }

  setVariant(variant: ThemeVariant, source: ThemeChangeSource = "settings"): void {
    if (!isThemeVariant(variant)) return;
    this.variant = variant;
    try { localStorage.setItem(THEME_VARIANT_KEY, variant); } catch {}
    this.apply(source, { force: true });
  }

  toggle(source: ThemeChangeSource = "command"): void {
    this.setPreference(this.resolvedTheme === "dark" ? "light" : "dark", source);
  }

  refresh(): void {
    this.apply("refresh", { force: true });
  }

  registerVariant(id: string, opts: {
    title: string;
    baseTheme: ThemePreference;
    css: string;
  }): { dispose(): void } {
    // Inject the CSS using the same attribute-selector pattern as built-in preset themes
    const styleId = `zion-theme-variant-${id}`;
    const existing = document.getElementById(styleId);
    if (existing) existing.remove();

    const variant = id;
    const attr = opts.baseTheme === "system" ? "[data-theme]" : `[data-theme="${opts.baseTheme}"]`;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `\n${attr}[data-theme-variant="${variant}"] {\n${opts.css}\n}\n`;
    document.head.appendChild(style);

    // Register the theme option so theme selection UI can find it
    const option: BuiltInThemeOption = {
      id,
      title: opts.title,
      description: opts.title,
      keywords: [opts.title, id],
      baseTheme: opts.baseTheme,
      variant
    };
    const optionDisposable = registerThemeOption(option);

    return {
      dispose: () => {
        const el = document.getElementById(styleId);
        if (el) el.remove();
        optionDisposable.dispose();
        // If this variant was active, reset to default
        if (this.variant === variant) {
          this.setVariant("default", "command");
        }
      }
    };
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
    const nextVariant = this.preference === "system" ? "default" : this.variant;

    for (const editor of this.opts.getEditorCores()) {
      try { editor.setTheme(nextResolved); } catch {}
    }
    document.documentElement.setAttribute("data-theme", nextResolved);
    document.documentElement.setAttribute("data-theme-variant", nextVariant);

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
    try { window.zion.state.set("ui.themeVariant", nextVariant); } catch {}
    try { window.zion.state.set("ui.theme", nextResolved); } catch {}
    this.updateStatusEntry();
    this.updateHeaderMenuEntry();

    if (changed || opts.force) {
      try {
        window.zion.events.emit("theme/changed", {
          preference: this.preference,
          variant: nextVariant,
          resolvedTheme: nextResolved,
          source
        });
      } catch {}
    }
  }

  private getDisplayLabel(): string {
    if (this.preference === "system") {
      return `System (${this.getResolvedThemeLabel()})`;
    }
    return this.getResolvedThemeLabel();
  }

  private getResolvedThemeLabel(): string {
    return getThemeOptionByVariant(this.preference === "system" ? "default" : this.variant, this.resolvedTheme).title;
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
      window.zion.commands.registerCommand("zion.setTheme", (theme: ThemeSelection) => {
        this.setSelection(theme, "command");
      });
      window.zion.commands.registerCommand("zion.theme.getSelection", () => this.getSelection());
      window.zion.commands.registerCommand("zion.theme.setSelection", (theme: ThemeSelection) => {
        this.setSelection(theme, "command");
      });
      window.zion.commands.registerCommand("zion.theme.setPreference", (theme: ThemePreference) => {
        this.setPreference(theme, "command");
      });
      window.zion.commands.registerCommand("zion.theme.getPreference", () => this.getPreference());
      window.zion.commands.registerCommand("zion.theme.getResolvedTheme", () => this.getResolvedTheme());
      window.zion.commands.registerCommand("zion.theme.getVariant", () => this.getVariant());
      window.zion.commands.registerCommand("zion.theme.setVariant", (variant: ThemeVariant) => {
        this.setVariant(variant, "command");
      });
      window.zion.commands.registerCommand("zion.toggleTheme", () => this.toggle("command"));
    } catch {}
  }

  private exposeApi(): void {
    try {
      (window.zion as any).theme = {
        getPreference: () => this.getPreference(),
        getSelection: () => this.getSelection(),
        getResolvedTheme: () => this.getResolvedTheme(),
        getVariant: () => this.getVariant(),
        setSelection: (selection: ThemeSelection) => this.setSelection(selection, "settings"),
        setPreference: (preference: ThemePreference) => this.setPreference(preference, "settings"),
        setVariant: (variant: ThemeVariant) => this.setVariant(variant, "settings"),
        registerVariant: (id: string, opts: { title: string; baseTheme: ThemePreference; css: string }) =>
          this.registerVariant(id, opts),
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
