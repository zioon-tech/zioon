import type { ResolvedTheme } from "./pwa";

export type ThemePreference = "system" | "light" | "dark";

// Stricter variant type for built-in theme options:
// expose a union of built-in values but accept any string at runtime via a branded type.
// This lets TypeScript autocomplete built-in names while also accepting plugin-registered ones.
export type ThemeVariant = string;

export type ThemeSelection = string;

export type BuiltInThemeOption = {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  baseTheme: ThemePreference;
  variant: ThemeVariant;
};

export const BUILT_IN_THEME_OPTIONS: readonly BuiltInThemeOption[] = [
  {
    id: "system",
    title: "System",
    description: "跟随系统外观自动切换 Light / Dark",
    keywords: ["theme", "appearance", "system", "auto", "跟随系统"],
    baseTheme: "system",
    variant: "default"
  },
  {
    id: "dark",
    title: "Dark",
    description: "Zion Next 默认深色主题",
    keywords: ["theme", "appearance", "dark", "默认深色"],
    baseTheme: "dark",
    variant: "default"
  },
  {
    id: "light",
    title: "Light",
    description: "Zion Next 默认浅色主题",
    keywords: ["theme", "appearance", "light", "浅色"],
    baseTheme: "light",
    variant: "default"
  },
  {
    id: "visual-studio-dark",
    title: "Visual Studio Dark",
    description: "参考 VS Code Visual Studio Dark 的深色主题",
    keywords: ["theme", "appearance", "dark", "visual studio", "vscode", "vs dark"],
    baseTheme: "dark",
    variant: "visual-studio-dark"
  },
  {
    id: "github-dark",
    title: "GitHub Dark",
    description: "参考 GitHub Dark 的高对比代码主题",
    keywords: ["theme", "appearance", "dark", "github", "primer"],
    baseTheme: "dark",
    variant: "github-dark"
  },
  {
    id: "github-light",
    title: "GitHub Light",
    description: "参考 GitHub Light 的清爽浅色主题",
    keywords: ["theme", "appearance", "light", "github", "primer"],
    baseTheme: "light",
    variant: "github-light"
  },
  {
    id: "catppuccin-mocha",
    title: "Catppuccin Mocha",
    description: "柔和低刺激的暖色暗色主题",
    keywords: ["theme", "appearance", "dark", "catppuccin", "mocha"],
    baseTheme: "dark",
    variant: "catppuccin-mocha"
  },
  {
    id: "catppuccin-latte",
    title: "Catppuccin Latte",
    description: "柔和奶油感浅色主题，适合长时间阅读",
    keywords: ["theme", "appearance", "light", "catppuccin", "latte", "cream"],
    baseTheme: "light",
    variant: "catppuccin-latte"
  },
  {
    id: "tokyo-night",
    title: "Tokyo Night",
    description: "蓝紫科技感暗色主题，适合夜间使用",
    keywords: ["theme", "appearance", "dark", "tokyo night", "blue", "purple"],
    baseTheme: "dark",
    variant: "tokyo-night"
  },
  {
    id: "rose-pine-dawn",
    title: "Rose Pine Dawn",
    description: "暖纸张感浅色主题，柔和且精致",
    keywords: ["theme", "appearance", "light", "rose pine", "dawn", "warm"],
    baseTheme: "light",
    variant: "rose-pine-dawn"
  },
  {
    id: "everforest-light",
    title: "Everforest Light",
    description: "护眼米绿色浅色主题，适合长时间写作",
    keywords: ["theme", "appearance", "light", "everforest", "green", "warm"],
    baseTheme: "light",
    variant: "everforest-light"
  },
  {
    id: "kanagawa-lotus",
    title: "Kanagawa Lotus",
    description: "日式纸张感浅色主题，辨识度更高",
    keywords: ["theme", "appearance", "light", "kanagawa", "lotus", "paper"],
    baseTheme: "light",
    variant: "kanagawa-lotus"
  },
  {
    id: "xiaohongshu",
    title: "小红书",
    description: "暖白底与珊瑚红强调色，适合轻内容和笔记式阅读",
    keywords: ["theme", "appearance", "light", "xiaohongshu", "rednote", "小红书", "红书", "warm", "coral"],
    baseTheme: "light",
    variant: "xiaohongshu"
  },
  {
    id: "wechat",
    title: "微信",
    description: "清爽浅绿与微信绿强调色，适合对话和长时间阅读",
    keywords: ["theme", "appearance", "light", "wechat", "weixin", "微信", "green", "chat"],
    baseTheme: "light",
    variant: "wechat"
  }
] as const;

// ---- Registered (plugin) theme options ----

const registeredThemeOptions = new Map<string, BuiltInThemeOption>();

export function registerThemeOption(option: BuiltInThemeOption): { dispose(): void } {
  const id = option.id;
  registeredThemeOptions.set(id, option);
  return {
    dispose: () => { registeredThemeOptions.delete(id); }
  };
}

export function getRegisteredThemeOptions(): BuiltInThemeOption[] {
  return Array.from(registeredThemeOptions.values());
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function isThemeVariant(value: unknown): value is ThemeVariant {
  if (value === "default") return true;
  if (BUILT_IN_THEME_OPTIONS.some((t) => t.variant === value)) return true;
  for (const opt of registeredThemeOptions.values()) {
    if (opt.variant === value) return true;
  }
  return typeof value === "string" && value.length > 0;
}

export function isThemeSelection(value: unknown): value is ThemeSelection {
  if (BUILT_IN_THEME_OPTIONS.some((t) => t.id === value)) return true;
  for (const opt of registeredThemeOptions.values()) {
    if (opt.id === value || opt.variant === value) return true;
  }
  return false;
}

export function getThemeOption(selection: ThemeSelection): BuiltInThemeOption {
  // Check built-in first
  const builtIn = BUILT_IN_THEME_OPTIONS.find((t) => t.id === selection);
  if (builtIn) return builtIn;
  // Check registered
  const registered = registeredThemeOptions.get(selection);
  if (registered) return registered;
  // Fallback
  return BUILT_IN_THEME_OPTIONS[0];
}

export function getThemeOptionByVariant(variant: ThemeVariant, resolvedTheme: ResolvedTheme): BuiltInThemeOption {
  if (variant !== "default") {
    // Check built-in
    const builtIn = BUILT_IN_THEME_OPTIONS.find((t) => t.variant === variant);
    if (builtIn) return builtIn;
    // Check registered
    for (const opt of registeredThemeOptions.values()) {
      if (opt.variant === variant) return opt;
    }
  }
  return getThemeOption(resolvedTheme);
}
