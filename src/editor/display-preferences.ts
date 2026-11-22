/** Display preferences belong to the viewer, independently of document storage.
 * Only this explicit allowlist can be migrated from a signed-in Workbench Space. */
export const DISPLAY_DEFAULTS = {
  "zion.wysiwyg": true,
  "zion.wysiwyg.keepActiveLineRendered": true,
  "zion.lineNumbers": false,
  "zion.activeLineHighlight": false,
  "zion.syntaxHighlight": true,
  "zion.autoIndent": true,
  "zion.folding": false,
  "zion.lineWrap": true,
  "zion.vimMode": false,
  "zion.minimap": false,
  "zion.selectionHighlight": true,
  "zion.editor.fontFamilyPreset": "system-sans",
  "zion.editor.customFontFamily": "",
  "zion.editor.fontSize": 13,
  "zion.editor.lineHeight": 1.6,
  "zion.editor.textColor": "",
  "zion.editorWidthMode": "standard",
  "zion.headingSize": "xsmall",
  "zion.roleUserBlockBackground": false,
  "zion.panelFocusHighlight": true,
  "dev.sticky-user-header.enabled": false,
  "zion.toc.groupByRole": false,
  "zion.toc.collapsedMode": "auto",
  "zion.roles.prefixes": '["tool"]',
  "dev.roles.prefixes": "[]",
  "zion.roles.highlightBlockRoles": '["user"]',
  "dev.roles.highlightBlockRoles": '["user"]',
  "zion.editorHeaderMenu.collapsedSections": "{}"
} as const;
export type DisplayPreferenceKey = keyof typeof DISPLAY_DEFAULTS;
type Listener = (key: string) => void;
let viewerId = "";
const documentAliases = new Map<string, string>();
const listeners = new Set<Listener>();
const browserStorage = () => globalThis.localStorage;
const namespace = () => `zion.display.v1:${encodeURIComponent(viewerId || "anonymous")}:`;
export const isDisplayPreference = (key: string) =>
  Object.hasOwn(DISPLAY_DEFAULTS, key) || key.startsWith("zion.minimap.session.");

export function setDisplayPreferenceViewer(userId: string, legacySpaceId?: string) {
  const changed = viewerId !== (userId || "");
  if (changed) documentAliases.clear();
  viewerId = userId || "";
  if (viewerId && legacySpaceId) {
    // Never enumerate another user's content or import the browser-era document cache.
    for (const key of Object.keys(DISPLAY_DEFAULTS)) {
      try {
        if (displayPreferenceStorage.getItem(key) != null) continue;
        const legacy = browserStorage()?.getItem(
          `zion.scoped:${encodeURIComponent(viewerId)}:${encodeURIComponent(legacySpaceId)}:${key}`);
        if (legacy != null) displayPreferenceStorage.setItem(key, legacy);
      } catch {}
    }
  }
  if (changed) emit("*");
}
function emit(key: string) { for (const listener of listeners) listener(key); }
const minimapPrefix = "zion.minimap.session.";
function resolvedKey(key: string) {
  const alias = key.startsWith(minimapPrefix) ? documentAliases.get(key.slice(minimapPrefix.length)) : null;
  return alias ? minimapPrefix + alias : key;
}
export function registerDisplayDocumentAlias(alias: string, identity: string, legacyValue?: string | null) {
  if (!alias || !/^document:[a-f0-9]{64}$/.test(identity)) return;
  if (documentAliases.get(alias) === identity) return;
  const value = legacyValue ?? displayPreferenceStorage.getItem(minimapPrefix + alias);
  documentAliases.set(alias, identity);
  const key = minimapPrefix + identity;
  if (displayPreferenceStorage.getItem(key) == null && /^(0|1|true|false)$/.test(value || ""))
    displayPreferenceStorage.setItem(key, value!);
  emit(key);
}
export const displayPreferenceStorage = {
  getItem(key: string): string | null {
    if (!isDisplayPreference(key)) return null;
    try { return browserStorage()?.getItem(namespace() + resolvedKey(key)) ?? null; } catch { return null; }
  },
  setItem(key: string, value: string) {
    if (!isDisplayPreference(key)) throw new Error("Unknown display preference");
    key = resolvedKey(key);
    try { browserStorage()?.setItem(namespace() + key, value); } catch {}
    emit(key);
  },
  removeItem(key: string) {
    if (!isDisplayPreference(key)) return;
    key = resolvedKey(key);
    try { browserStorage()?.removeItem(namespace() + key); } catch {}
    emit(key);
  }
};
export function subscribeDisplayPreferences(listener: Listener) {
  if (!listeners.size && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return { dispose() {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  } };
}
function onStorage(event: StorageEvent) {
  if (event.key === null) emit("*");
  else if (event.key.startsWith(namespace())) emit(event.key.slice(namespace().length));
  else if (/^zion\.(theme|locale)/.test(event.key)) emit(event.key);
}
export function parseNumberPreference(value: unknown, fallback: number, min: number, max: number) {
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
export function readMinimapPreference(documentId = "") {
  const raw = documentId ? displayPreferenceStorage.getItem(`zion.minimap.session.${documentId}`) : null;
  return raw === "1" || raw === "true" ? true : raw === "0" || raw === "false" ? false
    : !!readDisplayPreference("zion.minimap");
}
export function sanitizeFontFamily(value: unknown) {
  const raw = String(value ?? "").trim().slice(0, 180);
  return /[;{}<>\r\n]/.test(raw) ? "" : raw;
}
export function readDisplayPreference(key: DisplayPreferenceKey): boolean | number | string {
  const fallback = DISPLAY_DEFAULTS[key];
  const raw = displayPreferenceStorage.getItem(key);
  if (raw == null) return fallback;
  if (typeof fallback === "boolean") return raw === "1" || raw === "true" ? true
    : raw === "0" || raw === "false" ? false : fallback;
  if (key === "zion.editor.fontSize") return parseNumberPreference(raw, 13, 10, 24);
  if (key === "zion.editor.lineHeight") return parseNumberPreference(raw, 1.6, 1.2, 2.4);
  if (key === "zion.editor.customFontFamily") return sanitizeFontFamily(raw);
  if (key === "zion.editor.textColor") {
    const color = raw.trim().slice(0, 80);
    try { return color && CSS.supports("color", color) ? color : ""; } catch { return ""; }
  }
  const enums: Partial<Record<DisplayPreferenceKey, string[]>> = {
    "zion.editor.fontFamilyPreset": ["system-sans", "system-mono", "serif", "custom"],
    "zion.editorWidthMode": ["standard", "wide", "full"],
    "zion.headingSize": ["medium", "small", "xsmall"],
    "zion.toc.collapsedMode": ["manual-collapsed", "auto"]
  };
  return enums[key] && !enums[key]!.includes(raw) ? fallback : raw;
}

/** Original width-mode application, shared by every actual editor instance. */
export function applyEditorWidth(view: { dom: HTMLElement; scrollDOM: HTMLElement }, mode = readDisplayPreference("zion.editorWidthMode")) {
  const cm = view.dom, scroller = view.scrollDOM;
  for (const property of ["maxWidth", "width", "marginLeft", "marginRight", "paddingLeft",
    "paddingRight", "boxSizing", "display", "minWidth"] as const) scroller.style[property] = "";
  cm.style.width = scroller.style.width = "100%";
  if (mode !== "full") {
    const maxWidth = mode === "wide" ? 960 : 720;
    scroller.style.boxSizing = "border-box";
    scroller.style.paddingLeft = `max(0px, calc((100% - ${maxWidth}px - var(--zion-toc-inline-width, 0px)) / 2))`;
    scroller.style.paddingRight = `max(0px, calc((100% - ${maxWidth}px + var(--zion-toc-inline-width, 0px)) / 2))`;
    scroller.style.minWidth = "0";
  }
}
export function applyDisplayPresentation(root: HTMLElement) {
  const get = readDisplayPreference;
  const preset = get("zion.editor.fontFamilyPreset"), custom = get("zion.editor.customFontFamily");
  const family = preset === "system-mono" ? "var(--font-mono)"
    : preset === "serif" ? "Georgia, 'Times New Roman', 'Noto Serif SC', 'Songti SC', serif"
    : preset === "custom" && custom ? String(custom) : "var(--font-sans)";
  root.style.setProperty("--editor-content-font-family", family);
  root.style.setProperty("--editor-content-font-size", `${get("zion.editor.fontSize")}px`);
  root.style.setProperty("--editor-content-line-height", String(get("zion.editor.lineHeight")));
  const color = get("zion.editor.textColor");
  if (color) root.style.setProperty("--editor-text-fg", String(color)); else root.style.removeProperty("--editor-text-fg");
  root.setAttribute("data-heading-size", String(get("zion.headingSize")));
  root.setAttribute("data-role-user-block-bg", get("zion.roleUserBlockBackground") ? "1" : "0");
  root.setAttribute("data-panel-focus-highlight", get("zion.panelFocusHighlight") ? "enabled" : "disabled");
}

export const DISPLAY_STATE_KEYS: Partial<Record<DisplayPreferenceKey, string>> = {
  "zion.wysiwyg": "ui.wysiwyg", "zion.wysiwyg.keepActiveLineRendered": "ui.wysiwyg.keepActiveLineRendered",
  "zion.lineNumbers": "ui.lineNumbers", "zion.activeLineHighlight": "ui.activeLineHighlight",
  "zion.syntaxHighlight": "ui.syntaxHighlight", "zion.autoIndent": "ui.autoIndent",
  "zion.folding": "ui.folding", "zion.lineWrap": "ui.lineWrap", "zion.vimMode": "ui.editor.vimMode",
  "zion.minimap": "ui.minimapEnabled", "zion.selectionHighlight": "ui.selectionHighlight",
  "zion.editorWidthMode": "ui.editorWidthMode", "zion.headingSize": "ui.headingSize",
  "zion.roleUserBlockBackground": "ui.roleUserBlockBackground", "zion.panelFocusHighlight": "ui.panelFocusHighlight",
  "zion.toc.groupByRole": "toc.groupByRole"
};
