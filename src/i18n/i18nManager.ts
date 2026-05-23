export type ZionLocale = "zh-CN" | "en-US";
export type ZionI18nMessages = Record<string, string>;
export type ZionI18nBundle = Partial<Record<ZionLocale, ZionI18nMessages>>;

export type ZionI18nChangeEvent = {
  locale: ZionLocale;
  previousLocale: ZionLocale;
};

type InterpolationValues = Record<string, string | number | boolean | null | undefined>;

const LOCALE_KEY = "zion.locale";
const DEFAULT_LOCALE: ZionLocale = "zh-CN";

const SUPPORTED_LOCALES: Array<{ value: ZionLocale; label: string; nativeLabel: string }> = [
  { value: "zh-CN", label: "Chinese (Simplified)", nativeLabel: "简体中文" },
  { value: "en-US", label: "English", nativeLabel: "English" }
];

function isSupportedLocale(value: unknown): value is ZionLocale {
  return value === "zh-CN" || value === "en-US";
}

function readStoredLocale(): ZionLocale {
  try {
    const stored = localStorage.getItem(LOCALE_KEY);
    if (isSupportedLocale(stored)) return stored;
  } catch {}
  return DEFAULT_LOCALE;
}

function interpolate(input: string, values?: InterpolationValues): string {
  if (!values) return input;
  return input.replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key];
    return value === undefined || value === null ? match : String(value);
  });
}

export class I18nManager {
  private locale: ZionLocale = readStoredLocale();
  private namespaces = new Map<string, ZionI18nBundle>();

  init(): void {
    this.exposeApi();
    this.registerCommands();
    this.applyLocale(this.locale, { emit: false });
  }

  getLocale(): ZionLocale {
    return this.locale;
  }

  getDefaultLocale(): ZionLocale {
    return DEFAULT_LOCALE;
  }

  getSupportedLocales(): Array<{ value: ZionLocale; label: string; nativeLabel: string }> {
    return SUPPORTED_LOCALES.slice();
  }

  setLocale(locale: ZionLocale): void {
    if (!isSupportedLocale(locale)) return;
    const previousLocale = this.locale;
    this.locale = locale;
    try { localStorage.setItem(LOCALE_KEY, locale); } catch {}
    this.applyLocale(locale, { previousLocale, emit: previousLocale !== locale });
  }

  toggleLocale(): void {
    this.setLocale(this.locale === "zh-CN" ? "en-US" : "zh-CN");
  }

  registerNamespace(namespace: string, messages: ZionI18nBundle): { dispose(): void } {
    const ns = String(namespace || "").trim();
    if (!ns) return { dispose() {} };
    const prev = this.namespaces.get(ns);
    this.namespaces.set(ns, messages || {});
    return {
      dispose: () => {
        if (prev) this.namespaces.set(ns, prev);
        else this.namespaces.delete(ns);
      }
    };
  }

  t(key: string, values?: InterpolationValues): string {
    const rawKey = String(key || "");
    let namespace = "";
    for (const candidate of this.namespaces.keys()) {
      if (!rawKey.startsWith(`${candidate}.`)) continue;
      if (candidate.length > namespace.length) namespace = candidate;
    }
    if (!namespace) return rawKey;

    const messageKey = rawKey.slice(namespace.length + 1);
    const bundle = this.namespaces.get(namespace);
    const message =
      bundle?.[this.locale]?.[messageKey] ??
      bundle?.[DEFAULT_LOCALE]?.[messageKey] ??
      bundle?.["en-US"]?.[messageKey];

    return message ? interpolate(message, values) : rawKey;
  }

  private applyLocale(locale: ZionLocale, opts: { previousLocale?: ZionLocale; emit: boolean }): void {
    try { document.documentElement.setAttribute("lang", locale); } catch {}
    try { window.zion.state.set("ui.locale", locale); } catch {}
    if (!opts.emit) return;
    try {
      window.zion.events.emit("i18n/changed", {
        locale,
        previousLocale: opts.previousLocale || locale
      } satisfies ZionI18nChangeEvent);
    } catch {}
  }

  private registerCommands(): void {
    try {
      window.zion.commands.registerCommand("zion.setLanguage", (locale: ZionLocale) => this.setLocale(locale));
      window.zion.commands.registerCommand("zion.toggleLanguage", () => this.toggleLocale());
      window.zion.commands.registerCommand("zion.i18n.setLocale", (locale: ZionLocale) => this.setLocale(locale));
      window.zion.commands.registerCommand("zion.i18n.getLocale", () => this.getLocale());
      window.zion.commands.registerCommand("zion.i18n.getSupportedLocales", () => this.getSupportedLocales());
    } catch {}
  }

  private exposeApi(): void {
    try {
      (window.zion as any).i18n = {
        getLocale: () => this.getLocale(),
        getDefaultLocale: () => this.getDefaultLocale(),
        getSupportedLocales: () => this.getSupportedLocales(),
        setLocale: (locale: ZionLocale) => this.setLocale(locale),
        toggleLocale: () => this.toggleLocale(),
        registerNamespace: (namespace: string, messages: ZionI18nBundle) => this.registerNamespace(namespace, messages),
        t: (key: string, values?: InterpolationValues) => this.t(key, values)
      };
    } catch {}
  }
}

export function createI18nManager(): I18nManager {
  return new I18nManager();
}
