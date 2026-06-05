export type ResolvedTheme = "light" | "dark";

function ensureThemeColorMeta(): HTMLMetaElement {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  return meta;
}

export function updatePwaThemeColor(theme: ResolvedTheme): void {
  try {
    const meta = ensureThemeColorMeta();
    const cs = getComputedStyle(document.documentElement);
    const themeColor =
      String(cs.getPropertyValue("--app-theme-color") || "").trim() ||
      String(cs.getPropertyValue("--panel") || "").trim();
    const fallback = theme === "light" ? "#ffffff" : "#282a36";
    meta.setAttribute("content", themeColor || fallback);
  } catch {}
}
