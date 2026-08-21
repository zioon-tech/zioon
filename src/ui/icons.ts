type IconPathMap = Record<string, string>;

const ICON_PATHS: IconPathMap = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  pencil: '<path d="M16.5 4.5 19.5 7.5 8 19l-4 1 1-4 11.5-11.5Z"/><path d="m14.5 6.5 3 3"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  "more-horizontal": '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  "more-vertical": '<circle cx="12" cy="6" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="18" r="1.2"/>',
  "external-link": '<path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4"/>',
  play: '<path d="M8 5v14l11-7-11-7Z"/>',
  square: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-up": '<path d="m6 15 6-6 6 6"/>',
  "fold-vertical": '<path d="M6 4h12"/><path d="M6 20h12"/><path d="m8 9 4 4 4-4"/><path d="m8 15 4-4 4 4"/>',
  "unfold-vertical": '<path d="M6 4h12"/><path d="M6 20h12"/><path d="m8 13 4-4 4 4"/><path d="m8 11 4 4 4-4"/>',
  "list-tree": '<path d="M6 5h12"/><path d="M10 12h8"/><path d="M10 19h8"/><path d="M6 5v14"/><path d="M6 12h2M6 19h2"/>',
  "layout-grid": '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  "columns-2": '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M12 5v14"/>',
  "panel-bottom": '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 14h16"/>',
  "panel-right": '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M14 5v14"/>',
  "panel-inspector": '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M14 5v14"/><path d="M16.5 9h1.5M16.5 12h1.5M16.5 15h1.5"/>',
  output: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M8 14h6"/>',
  "panel-window": '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16"/><path d="M8 13h4M8 16h7"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.34-5.66"/><path d="M4 5v4h4"/><path d="M12 8v5l3 2"/>',
  extensions: '<path d="M9 3h4v4h3a2 2 0 0 1 2 2v3h3v4h-3v3a2 2 0 0 1-2 2h-3v-3H9v3H6a2 2 0 0 1-2-2v-3h3v-4H4V9a2 2 0 0 1 2-2h3V3Z"/>',
  bug: '<path d="M8 7a4 4 0 0 1 8 0"/><rect x="7" y="7" width="10" height="12" rx="4"/><path d="M3 13h4M17 13h4M5 19l3-3M19 19l-3-3M5 7l3 3M19 7l-3 3"/>',
  beaker: '<path d="M9 3h6"/><path d="M10 3v5l-5 9a3 3 0 0 0 2.6 4.5h8.8A3 3 0 0 0 19 17l-5-9V3"/><path d="M8 15h8"/>',
  "file-search": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5"/><path d="M14 3v5h5"/><circle cx="16" cy="16" r="3"/><path d="m18.5 18.5 2.5 2.5"/>',
  eraser: '<path d="m7 21-4-4L14 6a3 3 0 0 1 4.2 0 3 3 0 0 1 0 4.2L7.4 21H7Z"/><path d="m10 10 6 6"/><path d="M14 21h7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  monitor: '<rect x="4" y="5" width="16" height="12" rx="2"/><path d="M9 21h6"/><path d="M12 17v4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a13 13 0 0 1 0 18"/><path d="M12 3a13 13 0 0 0 0 18"/>',
  browser: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16"/><path d="M8 7h.01M11 7h.01"/><path d="M9 13h6M9 16h4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/>',
  "book-open": '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21V5.5Z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5A2.5 2.5 0 0 1 20 21V5.5Z"/>',
  type: '<path d="M4 6V4h16v2"/><path d="M12 4v16"/><path d="M8 20h8"/>',
  quote: '<path d="M8 11H5a4 4 0 0 1 4-4v10H5v-6"/><path d="M18 11h-3a4 4 0 0 1 4-4v10h-4v-6"/>',
  pin: '<path d="M15 4 20 9 16.5 12.5 17 18l-5-3-4.5 4.5L10 14 6 10l3-3 6-3Z"/><path d="M12 15 4 23"/>',
  minus: '<path d="M5 12h14"/>',
  table: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 10h16M4 15h16M10 5v14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
  archive: '<path d="M4 7h16"/><path d="M5 7l1 14h12l1-14"/><path d="M8 3h8l1 4H7l1-4Z"/><path d="M10 12h4"/>',
  save: '<path d="M5 4h12l2 2v14H5V4Z"/><path d="M8 4v6h8V4"/><path d="M8 20v-6h8v6"/>',
  "warning-triangle": '<path d="M12 3 22 20H2L12 3Z"/><path d="M12 9v5"/><path d="M12 17h.01"/>',
  "stop-circle": '<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  "refresh-cw": '<path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18 10a6 6 0 0 0-10-3.5L4 10"/><path d="M6 14a6 6 0 0 0 10 3.5l4-3.5"/>',
  maximize: '<path d="M8 3H3v5"/><path d="M3 3l7 7"/><path d="M16 21h5v-5"/><path d="M21 21l-7-7"/>',
  minimize: '<path d="M10 4v6H4"/><path d="M4 10l7-7"/><path d="M14 20v-6h6"/><path d="M20 14l-7 7"/>',
  note: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h3"/>',
  agent: '<rect x="5" y="8" width="14" height="10" rx="3"/><path d="M12 4v4"/><path d="M8 13h.01M16 13h.01"/><path d="M9 21h6"/><path d="M7 18l-2 2M17 18l2 2"/>',
  settings: '<path d="M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z"/><path d="M19.4 15a1.8 1.8 0 0 0 .36 2l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.8 1.8 0 0 0-2-.36 1.8 1.8 0 0 0-1.1 1.65V21a2 2 0 0 1-4 0v-.08a1.8 1.8 0 0 0-1.1-1.65 1.8 1.8 0 0 0-2 .36l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05a1.8 1.8 0 0 0 .36-2 1.8 1.8 0 0 0-1.65-1.1H3a2 2 0 0 1 0-4h.08a1.8 1.8 0 0 0 1.65-1.1 1.8 1.8 0 0 0-.36-2l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.8 1.8 0 0 0 2 .36A1.8 1.8 0 0 0 10.3 2.5V2a2 2 0 0 1 4 0v.08a1.8 1.8 0 0 0 1.1 1.65 1.8 1.8 0 0 0 2-.36l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.8 1.8 0 0 0-.36 2 1.8 1.8 0 0 0 1.65 1.1H21a2 2 0 0 1 0 4h-.08A1.8 1.8 0 0 0 19.4 15Z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  "folder-open": '<path d="M3 9V7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v1"/><path d="M4 19h14.3a2 2 0 0 0 1.9-1.4l1.2-4A2 2 0 0 0 19.5 11H5.7a2 2 0 0 0-1.9 1.4L2.6 16A2 2 0 0 0 4 19Z"/>',
  "folder-plus": '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M12 11v5M9.5 13.5h5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  "file-text": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h5"/>',
  braces: '<path d="M8 4H7a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1"/><path d="M16 4h1a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-1"/>',
  "file-code": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="m10 13-2 2 2 2M14 13l2 2-2 2"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m7 17 4-4 3 3 2-2 2 3"/>',
  "file-archive": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M10 6h2M10 9h2M10 12h2M11 15v3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  database: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  bot: '<rect x="6" y="8" width="12" height="10" rx="3"/><path d="M12 4v4"/><path d="M9 13h.01M15 13h.01"/><path d="M10 18v2h4v-2"/>',
  conversations: '<path d="M7 16H5l-3 3V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v1"/><path d="M9 9h9a4 4 0 0 1 4 4v8l-4-3H9a3 3 0 0 1-3-3v-3a3 3 0 0 1 3-3Z"/><path d="M10 13h7"/>',
  "messages-square": '<path d="M21 14a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h5"/>',
  "message-circle-plus": '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/><path d="M8 12h8M12 8v8"/>',
  tag: '<path d="M20 12 12 20 4 12V4h8l8 8Z"/><path d="M8 8h.01"/>',
  heading: '<path d="M6 5v14M18 5v14M6 12h12"/><path d="M14 19h5"/>',
  "check-circle": '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  "play-circle": '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5-6-3.5Z"/>',
  sparkles: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="m5 16 .8 2.2L8 19l-2.2.8L5 22l-.8-2.2L2 19l2.2-.8L5 16Z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/>',
  terminal: '<path d="m5 7 5 5-5 5"/><path d="M12 17h7"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M19 10h.01M7 14h.01M11 14h6"/>',
  hash: '<path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="M16 3l-2 18"/>',
  loader: '<path d="M12 3v3M12 18v3M4.9 4.9 7 7M17 17l2.1 2.1M3 12h3M18 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>'
};

const TEXT_ALIASES: Record<string, string> = {
  "📄": "output",
  "📑": "list-tree",
  "📋": "copy",
  "💬": "history",
  "🧩": "extensions",
  "💻": "terminal",
  "🪟": "panel-window",
  "🖥️": "monitor",
  "🌐": "globe",
  "⌨️": "terminal",
  "⌨": "terminal",
  "🕘": "history",
  "ℹ️": "info",
  "🔼": "chevron-up",
  "↻": "loader",
  "🔄": "loader",
  "➕": "plus",
  "✅": "check",
  "🗑️": "trash",
  "📁": "folder",
  "🧠": "sparkles",
  "📌": "heading",
  "🔤": "type",
  "➖": "minus",
  "🔗": "link",
  "🖼️": "image",
  "📊": "table",
  "⏰": "clock",
  "📅": "calendar",
  "📦": "archive",
  "💾": "save",
  "📝": "note",
  "⏹️": "stop-circle",
  "🔁": "repeat",
  "⚠️": "warning-triangle",
  "←": "chevron-left",
  "@": "messages-square",
  "◇": "folder",
  "Δ": "file-text"
};

const CODICON_ALIASES: Record<string, string> = {
  add: "plus",
  close: "x",
  edit: "pencil",
  pencil: "pencil",
  trash: "trash",
  trashcan: "trash",
  copy: "copy",
  check: "check",
  ellipsis: "more-horizontal",
  "kebab-horizontal": "more-horizontal",
  "kebab-vertical": "more-vertical",
  "ellipsis-vertical": "more-vertical",
  more: "more-horizontal",
  "link-external": "external-link",
  play: "play",
  "debug-stop": "square",
  "chevron-right": "chevron-right",
  "chevron-down": "chevron-down",
  "chevron-left": "chevron-left",
  "chevron-up": "chevron-up",
  fold: "fold-vertical",
  unfold: "unfold-vertical",
  "list-tree": "list-tree",
  "split-horizontal": "columns-2",
  "layout-panel": "panel-bottom",
  "layout-sidebar-right": "panel-right",
  "editor-layout": "panel-right",
  preview: "panel-inspector",
  "window": "panel-window",
  "remote": "globe",
  output: "output",
  history: "history",
  extensions: "extensions",
  "debug-alt": "bug",
  beaker: "beaker",
  "go-to-file": "file-search",
  "clear-all": "eraser",
  warning: "warning-triangle",
  discard: "history",
  "screen-full": "maximize",
  "screen-normal": "minimize",
  refresh: "refresh-cw",
  "refresh-cw": "refresh-cw",
  browser: "browser",
  gear: "settings",
  settings: "settings",
  folder: "folder",
  "folder-opened": "folder-open",
  "new-folder": "folder-plus",
  file: "file",
  "file-text": "file-text",
  markdown: "file-text",
  json: "braces",
  "file-code": "file-code",
  "file-media": "image",
  "file-zip": "file-archive",
  lock: "lock",
  database: "database",
  hubot: "agent",
  robot: "agent",
  agent: "agent",
  "comment-discussion": "messages-square",
  "comments": "messages-square",
  "book": "book-open",
  tag: "tag",
  pin: "pin",
  "symbol-property": "heading",
  "symbol-string": "type",
  "symbol-key": "type",
  "circle-large-outline": "circle",
  zap: "sparkles",
  link: "link",
  "horizontal-rule": "minus",
  eye: "eye",
  info: "info",
  search: "search",
  terminal: "terminal",
  keyboard: "keyboard",
  loading: "loader"
};

const NATIVE_CODICON_NAMES = new Set(["comment-discussion"]);

function normalizeCodiconName(name: string): string {
  return String(name || "").trim().replace(/^codicon-/, "").replace(/[^a-z0-9-]/gi, "");
}

function shouldUseNativeCodicon(name: string): boolean {
  return NATIVE_CODICON_NAMES.has(normalizeCodiconName(name));
}

export function codiconHtml(name: string, className = "", size?: number): string {
  const codiconName = normalizeCodiconName(name) || "file";
  const extraClass = className ? ` ${className}` : "";
  const style = typeof size === "number" ? ` style="font-size:${size}px;width:${size}px;height:${size}px;"` : "";
  return `<span class="codicon codicon-${codiconName}${extraClass}" aria-hidden="true"${style}></span>`;
}

export function createCodicon(name: string, className = "", size?: number): HTMLSpanElement {
  const span = document.createElement("span");
  const codiconName = normalizeCodiconName(name) || "file";
  span.className = `codicon codicon-${codiconName}${className ? ` ${className}` : ""}`;
  span.setAttribute("aria-hidden", "true");
  if (typeof size === "number") {
    span.style.fontSize = `${size}px`;
    span.style.width = `${size}px`;
    span.style.height = `${size}px`;
  }
  return span;
}

export function zionIconName(name: string): string {
  const value = String(name || "").trim();
  const raw = (TEXT_ALIASES[value] || value).replace(/^codicon-/, "");
  return CODICON_ALIASES[raw] || raw || "file";
}

export function hasZionIcon(name: string): boolean {
  const value = String(name || "").trim();
  if (!value) return false;
  const raw = (TEXT_ALIASES[value] || value).replace(/^codicon-/, "");
  const resolved = CODICON_ALIASES[raw] || raw;
  return Object.prototype.hasOwnProperty.call(ICON_PATHS, resolved);
}

export function zionIconHtml(name: string, className = "", size?: number): string {
  const iconName = zionIconName(name);
  const path = ICON_PATHS[iconName] || ICON_PATHS.file;
  const extraClass = className ? ` ${className}` : "";
  const style = typeof size === "number" ? ` style="width:${size}px;height:${size}px;"` : "";
  return `<span class="zion-icon zion-icon-${iconName}${extraClass}" data-zion-icon="${iconName}" aria-hidden="true"${style}><svg viewBox="0 0 24 24">${path}</svg></span>`;
}

export function createZionIcon(name: string, className = "", size?: number): HTMLSpanElement {
  const wrapper = document.createElement("span");
  wrapper.innerHTML = zionIconHtml(name, className, size);
  return (wrapper.firstElementChild as HTMLSpanElement) || document.createElement("span");
}

export function setZionIconOnly(target: HTMLElement, name: string, className = "", size?: number) {
  target.textContent = "";
  target.appendChild(createZionIcon(name, className, size));
}

export function zionIconHtmlFromCodicon(codicon: string, className = "", size?: number): string {
  const raw = normalizeCodiconName(codicon);
  if (shouldUseNativeCodicon(raw)) return codiconHtml(raw, className, size);
  return zionIconHtml(zionIconName(raw), className, size);
}

export function createZionIconFromCodicon(codicon: string, className = "", size?: number): HTMLSpanElement {
  const raw = normalizeCodiconName(codicon);
  if (shouldUseNativeCodicon(raw)) return createCodicon(raw, className, size);
  return createZionIcon(zionIconName(raw), className, size);
}

export function installZionIcons() {
  const api = {
    html: zionIconHtml,
    htmlFromCodicon: zionIconHtmlFromCodicon,
    create: createZionIcon,
    createFromCodicon: createZionIconFromCodicon,
    nameFromCodicon: zionIconName,
    has: hasZionIcon
  };
  (window as any).zionIcons = api;
  try {
    const z = (window as any).zion || ((window as any).zion = {});
    z.icons = api;
  } catch {}
  return api;
}

declare global {
  interface Window {
    zionIcons?: ReturnType<typeof installZionIcons>;
  }
}
