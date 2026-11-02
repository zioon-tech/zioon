const I18N_NS = "dev.image-enhanced";
const I18N_MESSAGES = {
  "zh-CN": {
    "category.image": "图片增强",
    "cmd.copyImage": "图片增强：复制图片到剪贴板",
    "cmd.downloadImage": "图片增强：下载图片",
    "cmd.openInNewTab": "图片增强：在新标签页打开图片",
    "cmd.showImageInfo": "图片增强：显示图片信息",
    "ui.preview": "预览",
    "ui.openWindow": "新窗",
    "ui.copyLink": "复制链接",
    "ui.copyMarkdown": "复制 Markdown",
    "ui.delete": "删除",
    "ui.copy": "复制",
    "ui.download": "下载",
    "ui.zoomView": "放大查看",
    "ui.copyImage": "复制图片",
    "ui.downloadImage": "下载图片",
    "ui.openInNewTab": "在新标签页打开",
    "ui.showImageInfo": "显示图片信息",
    "ui.imageInfo": "图片信息",
    "ui.width": "宽度",
    "ui.height": "高度",
    "ui.aspectRatio": "宽高比",
    "ui.unknown": "未知",
    "ui.error": "错误",
    "msg.unresolved": "无法解析图片地址",
    "msg.loadFailed": "无法加载图片",
    "msg.copied": "图片已复制到剪贴板",
    "msg.copyFailed": "复制失败：{message}",
    "msg.downloadFailed": "下载失败：{message}",
    "msg.infoFailed": "获取信息失败：{message}"
  },
  "en-US": {
    "category.image": "Image Enhanced",
    "cmd.copyImage": "Image Enhanced: Copy Image to Clipboard",
    "cmd.downloadImage": "Image Enhanced: Download Image",
    "cmd.openInNewTab": "Image Enhanced: Open Image in New Tab",
    "cmd.showImageInfo": "Image Enhanced: Show Image Info",
    "ui.preview": "Preview",
    "ui.openWindow": "New Window",
    "ui.copyLink": "Copy Link",
    "ui.copyMarkdown": "Copy Markdown",
    "ui.delete": "Delete",
    "ui.copy": "Copy",
    "ui.download": "Download",
    "ui.zoomView": "Zoom View",
    "ui.copyImage": "Copy Image",
    "ui.downloadImage": "Download Image",
    "ui.openInNewTab": "Open in New Tab",
    "ui.showImageInfo": "Show Image Info",
    "ui.imageInfo": "Image Info",
    "ui.width": "Width",
    "ui.height": "Height",
    "ui.aspectRatio": "Aspect Ratio",
    "ui.unknown": "Unknown",
    "ui.error": "Error",
    "msg.unresolved": "Unable to resolve image URL",
    "msg.loadFailed": "Unable to load image",
    "msg.copied": "Image copied to clipboard",
    "msg.copyFailed": "Copy failed: {message}",
    "msg.downloadFailed": "Download failed: {message}",
    "msg.infoFailed": "Failed to get image info: {message}"
  }
};

function t(key, fallback, values) {
  const fullKey = `${I18N_NS}.${key}`;
  try {
    const translated = window.zion?.i18n?.t?.(fullKey, values);
    if (translated && translated !== fullKey) return translated;
  } catch {}
  return fallback;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

async function resolveSrcToUrl(src) {
  if (!src) return null;
  const resolver = window.zion?.media?.resolveImage;
  return typeof resolver === "function" ? await resolver(src) : src;
}

async function copyImageToClipboard(url) {
  const resolved = await resolveSrcToUrl(url);
  if (!resolved) throw new Error("no image url");
  const response = await fetch(resolved);
  const blob = await response.blob();
  const ClipboardItemCtor = window.ClipboardItem;
  if (!ClipboardItemCtor) throw new Error("ClipboardItem not supported");
  await navigator.clipboard.write([new ClipboardItemCtor({ [blob.type]: blob })]);
}

async function downloadImage(url) {
  const resolved = await resolveSrcToUrl(url);
  if (!resolved) throw new Error("no image url");
  const response = await fetch(resolved);
  const blob = await response.blob();
  const filename = (url || "").split("/").pop()?.split("?")?.[0] || "image.png";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

async function getImageInfo(url) {
  const resolved = await resolveSrcToUrl(url);
  return await new Promise((resolve) => {
    if (!resolved) {
      resolve({ url, error: t("msg.unresolved", "无法解析图片地址") });
      return;
    }
    const img = new window.Image();
    img.onload = () => {
      resolve({
        url,
        resolvedUrl: resolved,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        aspectRatio: img.naturalWidth && img.naturalHeight ? (img.naturalWidth / img.naturalHeight).toFixed(2) : t("ui.unknown", "未知")
      });
    };
    img.onerror = () => resolve({ url, resolvedUrl: resolved, error: t("msg.loadFailed", "无法加载图片") });
    img.src = resolved;
  });
}

function showNotification(type, message, duration = 2600) {
  const notification = document.createElement("div");
  notification.textContent = message;
  const colors = {
    info: "var(--accent, #6272a4)",
    success: "var(--ok, #50fa7b)",
    warn: "#ffb86c",
    error: "#ff5555"
  };
  notification.className = "zion-image-enhanced-toast";
  notification.style.borderLeftColor = colors[type] || colors.info;
  document.body.appendChild(notification);
  setTimeout(() => {
    notification.classList.add("leaving");
    setTimeout(() => notification.remove(), 220);
  }, duration);
}

function createPanel({ title, content }) {
  const overlay = document.createElement("div");
  overlay.className = "zion-image-enhanced-panel-overlay";
  const panel = document.createElement("div");
  panel.className = "zion-image-enhanced-panel";

  const header = document.createElement("div");
  header.className = "zion-image-enhanced-panel-header";
  const titleEl = document.createElement("div");
  titleEl.className = "zion-image-enhanced-panel-title";
  titleEl.textContent = title;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "zion-image-enhanced-panel-close";
  closeBtn.textContent = "✕";

  const contentEl = document.createElement("div");
  contentEl.className = "zion-image-enhanced-panel-content";
  if (typeof content === "string") contentEl.textContent = content;
  else if (content instanceof HTMLElement) contentEl.appendChild(content);

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKeyDown, true);
  };
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  closeBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  header.append(titleEl, closeBtn);
  panel.append(header, contentEl);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onKeyDown, true);
  return { overlay, panel, close };
}

function showImageInfo(info) {
  const wrap = document.createElement("div");
  wrap.className = "zion-image-enhanced-info";
  const items = [
    ["URL", info.url || ""],
    [t("ui.width", "宽度"), info.naturalWidth ? `${info.naturalWidth}px` : t("ui.unknown", "未知")],
    [t("ui.height", "高度"), info.naturalHeight ? `${info.naturalHeight}px` : t("ui.unknown", "未知")],
    [t("ui.aspectRatio", "宽高比"), info.aspectRatio || t("ui.unknown", "未知")]
  ];
  if (info.error) items.push([t("ui.error", "错误"), info.error]);
  for (const [k, v] of items) {
    const row = document.createElement("div");
    row.className = "zion-image-enhanced-info-row";
    const label = document.createElement("span");
    label.className = "zion-image-enhanced-info-k";
    label.textContent = `${k}:`;
    const val = document.createElement("span");
    val.className = "zion-image-enhanced-info-v";
    val.textContent = String(v);
    row.append(label, val);
    wrap.appendChild(row);
  }
  createPanel({ title: t("ui.imageInfo", "图片信息"), content: wrap });
}

let viewerOverlay = null;
let viewerState = null;

function closeImageViewer() {
  if (!viewerOverlay) return;
  try { viewerOverlay._cleanup?.(); } catch {}
  try { viewerOverlay.remove(); } catch {}
  viewerOverlay = null;
  viewerState = null;
}

async function openImageViewerByUrl(src, alt, groupItems = null, groupIndex = 0) {
  const items = Array.isArray(groupItems) && groupItems.length
    ? groupItems
    : [{ src, alt }];
  let currentIndex = Math.max(0, Math.min(Number(groupIndex) || 0, items.length - 1));
  const initialItem = items[currentIndex] || { src, alt };
  const url = await resolveSrcToUrl(initialItem.src);
  if (!url) return;
  closeImageViewer();

  const overlay = document.createElement("div");
  overlay.className = "zion-image-viewer-overlay";

  const imageContainer = document.createElement("div");
  imageContainer.className = "zion-image-viewer-container";

  const viewerImg = document.createElement("img");
  viewerImg.className = "zion-image-viewer-img";
  viewerImg.src = url;
  viewerImg.alt = initialItem.alt || "Image";
  imageContainer.appendChild(viewerImg);

  const toolbar = document.createElement("div");
  toolbar.className = "zion-image-viewer-toolbar";

  const mkBtn = (label, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "zion-image-viewer-btn";
    b.textContent = label;
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { onClick(); } catch {}
    };
    return b;
  };
  const sep = () => {
    const s = document.createElement("span");
    s.className = "zion-image-viewer-sep";
    return s;
  };
  const scaleDisplay = document.createElement("span");
  scaleDisplay.className = "zion-image-viewer-scale";
  scaleDisplay.textContent = "100%";
  const imageCounter = document.createElement("span");
  imageCounter.className = "zion-image-viewer-scale";

  const state = { scale: 1, tx: 0, ty: 0, dragging: false, startX: 0, startY: 0 };
  const updateTransform = () => {
    imageContainer.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
    scaleDisplay.textContent = `${Math.round(state.scale * 100)}%`;
  };
  const zoom = (d) => {
    state.scale = Math.max(0.1, Math.min(5, state.scale + d));
    updateTransform();
  };
  const reset = () => {
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
    updateTransform();
  };
  const showItem = async (nextIndex) => {
    currentIndex = (nextIndex + items.length) % items.length;
    const item = items[currentIndex];
    const nextUrl = await resolveSrcToUrl(item.src);
    if (!nextUrl) return;
    viewerImg.src = nextUrl;
    viewerImg.alt = item.alt || "Image";
    imageCounter.textContent = `${currentIndex + 1} / ${items.length}`;
    viewerState = { items, index: currentIndex, src: item.src, url: nextUrl };
    reset();
  };

  const controls = [
    mkBtn("−", () => zoom(-0.2)),
    scaleDisplay,
    mkBtn("+", () => zoom(0.2)),
    mkBtn("↺", () => reset())
  ];
  if (items.length > 1) {
    imageCounter.textContent = `${currentIndex + 1} / ${items.length}`;
    controls.push(
      sep(),
      mkBtn("←", () => { void showItem(currentIndex - 1); }),
      imageCounter,
      mkBtn("→", () => { void showItem(currentIndex + 1); })
    );
  }
  controls.push(
    sep(),
    mkBtn(t("ui.copy", "复制"), async () => {
      try { await copyImageToClipboard(viewerState?.src || src); showNotification("success", t("msg.copied", "图片已复制到剪贴板")); } catch (e) { showNotification("error", t("msg.copyFailed", "复制失败：{message}", { message: e?.message || e })); }
    }),
    mkBtn(t("ui.download", "下载"), async () => {
      try { await downloadImage(viewerState?.src || src); } catch (e) { showNotification("error", t("msg.downloadFailed", "下载失败：{message}", { message: e?.message || e })); }
    }),
    sep(),
    mkBtn("✕", () => closeImageViewer())
  );
  toolbar.append(...controls);

  overlay.append(imageContainer, toolbar);
  document.body.appendChild(overlay);
  viewerOverlay = overlay;
  viewerState = { items, index: currentIndex, src: initialItem.src, url };

  const onWheel = (e) => {
    e.preventDefault();
    e.stopPropagation();
    zoom(e.deltaY > 0 ? -0.1 : 0.1);
  };
  const onMouseDown = (e) => {
    if (e.target !== overlay && e.target !== imageContainer) return;
    e.preventDefault();
    e.stopPropagation();
    state.dragging = true;
    state.startX = e.clientX - state.tx;
    state.startY = e.clientY - state.ty;
    overlay.style.cursor = "grabbing";
  };
  const onMouseMove = (e) => {
    if (!state.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    state.tx = e.clientX - state.startX;
    state.ty = e.clientY - state.startY;
    updateTransform();
  };
  const onMouseUp = (e) => {
    if (!state.dragging) return;
    e.preventDefault();
    e.stopPropagation();
    state.dragging = false;
    overlay.style.cursor = "grab";
  };
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeImageViewer();
    } else if (items.length > 1 && e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      void showItem(currentIndex - 1);
    } else if (items.length > 1 && e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      void showItem(currentIndex + 1);
    }
  };
  const onClickBg = (e) => {
    if (e.target === overlay) {
      e.preventDefault();
      e.stopPropagation();
      closeImageViewer();
    }
  };

  overlay.addEventListener("wheel", onWheel, { passive: false });
  overlay.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("keydown", onKeyDown, true);
  overlay.addEventListener("click", onClickBg);

  overlay._cleanup = () => {
    try { overlay.removeEventListener("wheel", onWheel); } catch {}
    try { overlay.removeEventListener("mousedown", onMouseDown); } catch {}
    try { document.removeEventListener("mousemove", onMouseMove); } catch {}
    try { document.removeEventListener("mouseup", onMouseUp); } catch {}
    try { document.removeEventListener("keydown", onKeyDown, true); } catch {}
    try { overlay.removeEventListener("click", onClickBg); } catch {}
  };
  updateTransform();
}

function parseMarkdownImageAt(view, pos) {
  try {
    const doc = view.state.doc;
    const slice = doc.sliceString(pos, Math.min(doc.length, pos + 600));
    const m = /^!\[[^\]]*?\]\(([^)\n]+)\)/.exec(slice);
    if (!m) return null;
    const full = m[0];
    const src = m[1] || "";
    const from = pos;
    const to = pos + full.length;
    return { from, to, src, raw: full };
  } catch {
    return null;
  }
}

function readImageInfo(view, wrap) {
  const src = wrap?.dataset?.imageSrc;
  const from = Number(wrap?.dataset?.imageFrom);
  const to = Number(wrap?.dataset?.imageTo);
  if (src && Number.isInteger(from) && Number.isInteger(to) && to > from) {
    const gallery = wrap.closest?.(".cm-md-gallery");
    const cells = gallery ? [...gallery.querySelectorAll(".cm-md-gallery-cell")] : [];
    const groupItems = cells.map(cell => ({
      src: cell.dataset.imageSrc || "",
      alt: cell.dataset.imageAlt || ""
    })).filter(item => item.src);
    return {
      from,
      to,
      src,
      raw: wrap.dataset.imageMarkdown || view.state.sliceDoc(from, to),
      groupItems,
      groupIndex: Math.max(0, cells.indexOf(wrap))
    };
  }
  let pos = null;
  try { pos = view.posAtDOM(wrap); } catch {}
  return typeof pos === "number" ? parseMarkdownImageAt(view, pos) : null;
}

function createToolbar() {
  const el = document.createElement("div");
  el.className = "zion-image-toolbar";
  const mkBtn = (label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "zion-image-toolbar-btn";
    b.textContent = label;
    return b;
  };
  const previewBtn = mkBtn("");
  const openBtn = mkBtn("");
  const copyUrlBtn = mkBtn("");
  const copyMdBtn = mkBtn("");
  const delBtn = mkBtn("");
  delBtn.classList.add("danger");
  el.append(previewBtn, openBtn, copyUrlBtn, copyMdBtn, delBtn);
  const refreshLabels = () => {
    previewBtn.textContent = t("ui.preview", "预览");
    openBtn.textContent = t("ui.openWindow", "新窗");
    copyUrlBtn.textContent = t("ui.copyLink", "复制链接");
    copyMdBtn.textContent = t("ui.copyMarkdown", "复制 Markdown");
    delBtn.textContent = t("ui.delete", "删除");
  };
  refreshLabels();
  return { el, previewBtn, openBtn, copyUrlBtn, copyMdBtn, delBtn, refreshLabels };
}

function ensureStyles() {
  const id = "dev.image-enhanced.styles";
  const prev = document.getElementById(id);
  if (prev) return prev;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
.zion-image-toolbar{
  position:fixed;
  z-index:9999;
  display:flex;
  gap:6px;
  padding:4px 6px;
  border-radius:6px;
  border:1px solid var(--border);
  background:rgba(0,0,0,0.55);
  backdrop-filter: blur(6px);
  color:var(--fg);
  box-shadow: 0 10px 24px rgba(0,0,0,0.25);
}
:root[data-theme="light"] .zion-image-toolbar{
  background: rgba(255,255,255,0.92);
}
.zion-image-toolbar-btn{
  background:transparent;
  color:inherit;
  border:1px solid transparent;
  border-radius:6px;
  font-size:12px;
  padding:3px 8px;
  cursor:pointer;
}
.zion-image-toolbar-btn:hover{
  background:var(--border);
  border-color:var(--border);
}
.zion-image-toolbar-btn.danger:hover{
  background: rgba(239, 68, 68, 0.18);
  border-color: rgba(239, 68, 68, 0.35);
}

.zion-image-enhanced-menu{
  position: fixed;
  background: var(--panel, #282a36);
  border: 1px solid var(--border, #44475a);
  border-radius: 6px;
  padding: 6px 0;
  z-index: 1000000;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  min-width: 190px;
}
.zion-image-enhanced-menu-item{
  padding: 8px 14px;
  cursor: pointer;
  font-size: 13px;
  color: var(--fg, #d1d5db);
  display: flex;
  align-items: center;
  user-select: none;
}
.zion-image-enhanced-menu-item:hover{
  background: var(--border, #44475a);
}

.zion-image-viewer-overlay{
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.9);
  z-index: 999999;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
}
.zion-image-viewer-container{
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.12s ease;
  will-change: transform;
}
.zion-image-viewer-img{
  max-width: 100%;
  max-height: 90vh;
  object-fit: contain;
  user-select: none;
  pointer-events: none;
}
.zion-image-viewer-toolbar{
  position: fixed;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(40, 44, 52, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  gap: 10px;
  align-items: center;
  z-index: 1000000;
}
:root[data-theme="light"] .zion-image-viewer-toolbar{
  background: rgba(255,255,255,0.92);
  border-color: var(--border);
}
.zion-image-viewer-btn{
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: var(--fg);
  border-radius: 6px;
  padding: 5px 10px;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  transition: background 120ms ease, border-color 120ms ease;
}
:root[data-theme="light"] .zion-image-viewer-btn{
  border-color: var(--border);
}
.zion-image-viewer-btn:hover{
  background: rgba(255, 255, 255, 0.10);
  border-color: rgba(255, 255, 255, 0.25);
}
:root[data-theme="light"] .zion-image-viewer-btn:hover{
  background: rgba(0,0,0,0.06);
  border-color: var(--border);
}
.zion-image-viewer-scale{
  color: var(--fg);
  font-size: 12px;
  min-width: 46px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
}
.zion-image-viewer-sep{
  width: 1px;
  height: 18px;
  background: rgba(255,255,255,0.18);
  display: inline-block;
}
:root[data-theme="light"] .zion-image-viewer-sep{
  background: rgba(0,0,0,0.12);
}

.zion-image-enhanced-toast{
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 10px 14px;
  background: var(--panel, #282a36);
  border: 1px solid var(--border, #44475a);
  border-left: 4px solid var(--accent, #6272a4);
  border-radius: 6px;
  color: var(--fg, #d1d5db);
  z-index: 1000001;
  box-shadow: 0 4px 12px rgba(0,0,0,0.30);
  font-size: 13px;
  opacity: 1;
  transform: translateY(0);
  transition: opacity 180ms ease, transform 180ms ease;
}
.zion-image-enhanced-toast.leaving{
  opacity: 0;
  transform: translateY(4px);
}

.zion-image-enhanced-panel-overlay{
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 1000001;
  display: flex;
  align-items: center;
  justify-content: center;
}
.zion-image-enhanced-panel{
  background: var(--panel, #282a36);
  border: 1px solid var(--border, #44475a);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.35);
  max-width: 520px;
  max-height: 80vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  color: var(--fg, #d1d5db);
}
.zion-image-enhanced-panel-header{
  padding: 10px 14px;
  border-bottom: 1px solid var(--border, #44475a);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.zion-image-enhanced-panel-title{
  font-weight: 600;
  font-size: 13px;
}
.zion-image-enhanced-panel-close{
  background: transparent;
  border: none;
  color: var(--fg, #d1d5db);
  cursor: pointer;
  font-size: 16px;
  padding: 4px;
  line-height: 1;
}
.zion-image-enhanced-panel-content{
  padding: 14px;
  font-size: 13px;
}
.zion-image-enhanced-info{
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.zion-image-enhanced-info-row{
  display: flex;
  gap: 10px;
}
.zion-image-enhanced-info-k{
  min-width: 64px;
  opacity: 0.85;
}
.zion-image-enhanced-info-v{
  word-break: break-all;
  font-family: var(--font-mono, ui-monospace);
  opacity: 0.95;
}
`;
  document.head.appendChild(style);
  return style;
}

function closeImageMenu() {
  try { document.querySelector(".zion-image-enhanced-menu")?.remove?.(); } catch {}
}

function showImageMenuAt(x, y, items) {
  closeImageMenu();
  const menu = document.createElement("div");
  menu.className = "zion-image-enhanced-menu";
  menu.style.left = `${Math.round(x)}px`;
  menu.style.top = `${Math.round(y)}px`;
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "zion-image-enhanced-menu-item";
    row.textContent = it.label;
    row.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeImageMenu();
      try { it.action(); } catch {}
    };
    menu.appendChild(row);
  }
  document.body.appendChild(menu);

  const close = (ev) => {
    if (!menu.contains(ev.target)) closeImageMenu();
  };
  const closeOnContextMenu = (ev) => {
    if (!menu.contains(ev.target)) closeImageMenu();
  };
  const cleanup = () => {
    document.removeEventListener("click", close, true);
    document.removeEventListener("contextmenu", closeOnContextMenu, true);
  };
  setTimeout(() => {
    document.addEventListener("click", close, true);
    document.addEventListener("contextmenu", closeOnContextMenu, true);
  }, 0);
  menu._cleanup = cleanup;
  const mo = new window.MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node?.nodeType === 1) {
          const el = node;
          const isMenu = el.classList?.contains?.("cm-tooltip-menu") || el.classList?.contains?.("context-menu") || el.getAttribute?.("role") === "menu" || el.querySelector?.('[role="menuitem"]');
          if (isMenu && el !== menu && !menu.contains(el)) {
            closeImageMenu();
            try { mo.disconnect(); } catch {}
          }
        }
      }
    }
  });
  try { mo.observe(document.body, { childList: true, subtree: true }); } catch {}
  const oldRemove = menu.remove.bind(menu);
  menu.remove = () => {
    try { cleanup(); } catch {}
    try { mo.disconnect(); } catch {}
    oldRemove();
  };
}

function registerCommands(ctx, getCurrent) {
  const reg = window.zion?.commands?.registerCommand;
  if (typeof reg !== "function") return;
  const copyCmd = reg("imageEnhancer.copyImage", async () => {
    const cur = getCurrent();
    const src = cur?.src;
    if (!src) return;
    try { await copyImageToClipboard(src); showNotification("success", t("msg.copied", "图片已复制到剪贴板")); } catch (e) { showNotification("error", t("msg.copyFailed", "复制失败：{message}", { message: e?.message || e })); }
  });
  const downloadCmd = reg("imageEnhancer.downloadImage", async () => {
    const cur = getCurrent();
    const src = cur?.src;
    if (!src) return;
    try { await downloadImage(src); } catch (e) { showNotification("error", t("msg.downloadFailed", "下载失败：{message}", { message: e?.message || e })); }
  });
  const openTabCmd = reg("imageEnhancer.openInNewTab", async () => {
    const cur = getCurrent();
    const src = cur?.src;
    if (!src) return;
    try {
      const url = await resolveSrcToUrl(src);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch {}
  });
  const infoCmd = reg("imageEnhancer.showImageInfo", async () => {
    const cur = getCurrent();
    const src = cur?.src;
    if (!src) return;
    try { const info = await getImageInfo(src); showImageInfo(info); } catch (e) { showNotification("error", t("msg.infoFailed", "获取信息失败：{message}", { message: e?.message || e })); }
  });
  ctx.subscriptions.push(copyCmd, downloadCmd, openTabCmd, infoCmd);
}

export async function activate(ctx) {
  try {
    const dispI18n = window.zion?.i18n?.registerNamespace?.(I18N_NS, I18N_MESSAGES);
    if (dispI18n) ctx.subscriptions.push(dispI18n);
  } catch {}
  let current = null;
  registerCommands(ctx, () => current);

  const disp = window.zion?.editor?.registerDecorator?.({
    id: "dev.image-enhanced.toolbar",
    apply: (editor) => {
      const view = editor?.getView?.();
      if (!view) return { dispose() {} };
      const styleEl = ensureStyles();
      const toolbar = createToolbar();
      document.body.appendChild(toolbar.el);
      toolbar.el.style.display = "none";

      current = null;

      const hide = () => {
        current = null;
        toolbar.el.style.display = "none";
      };

      const positionNear = (rect) => {
        const pad = 8;
        const w = toolbar.el.offsetWidth || 180;
        const h = toolbar.el.offsetHeight || 28;
        let left = rect.right - w;
        let top = rect.top - h - 8;
        if (left < pad) left = pad;
        if (top < pad) top = rect.bottom + 8;
        toolbar.el.style.left = `${Math.round(left)}px`;
        toolbar.el.style.top = `${Math.round(top)}px`;
      };

      const onClick = async (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        if (toolbar.el.contains(target)) return;
        const img = target.closest?.(".cm-md-img, .cm-md-img-fallback, .cm-md-gallery-cell");
        if (!img) {
          hide();
          return;
        }
        const wrap = img.closest?.(".cm-md-img-wrap") || img;
        const info = readImageInfo(view, wrap);
        if (!info) { hide(); return; }
        current = info;
        toolbar.el.style.display = "flex";
        positionNear(wrap.getBoundingClientRect());
      };

      const onContextMenu = async (ev) => {
        const target = ev.target instanceof Element ? ev.target : null;
        if (!target) return;
        if (toolbar.el.contains(target)) return;
        const img = target.closest?.(".cm-md-img, .cm-md-img-fallback, .cm-md-gallery-cell");
        if (!img) return;
        const wrap = img.closest?.(".cm-md-img-wrap") || img;
        const info = readImageInfo(view, wrap);
        if (!info) return;
        current = info;
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation?.();
        toolbar.el.style.display = "none";
        const src = info.src;
        showImageMenuAt(ev.clientX, ev.clientY, [
          {
            label: `🔍 ${t("ui.zoomView", "放大查看")}`,
            action: () => openImageViewerByUrl(
              src,
              img.getAttribute?.("alt") || img.dataset?.imageAlt || "",
              info.groupItems,
              info.groupIndex
            )
          },
          { label: `📋 ${t("ui.copyImage", "复制图片")}`, action: async () => { try { await copyImageToClipboard(src); showNotification("success", t("msg.copied", "图片已复制到剪贴板")); } catch (e) { showNotification("error", t("msg.copyFailed", "复制失败：{message}", { message: e?.message || e })); } } },
          { label: `⬇️ ${t("ui.downloadImage", "下载图片")}`, action: async () => { try { await downloadImage(src); } catch (e) { showNotification("error", t("msg.downloadFailed", "下载失败：{message}", { message: e?.message || e })); } } },
          { label: `🌐 ${t("ui.openInNewTab", "在新标签页打开")}`, action: async () => { try { const url = await resolveSrcToUrl(src); if (url) window.open(url, "_blank", "noopener,noreferrer"); } catch {} } },
          { label: `ℹ️ ${t("ui.showImageInfo", "显示图片信息")}`, action: async () => { try { const ii = await getImageInfo(src); showImageInfo(ii); } catch (e) { showNotification("error", t("msg.infoFailed", "获取信息失败：{message}", { message: e?.message || e })); } } }
        ]);
      };

      const onScroll = () => hide();
      const onResize = () => { if (toolbar.el.style.display !== "none") hide(); };
      const onKeydown = (ev) => { if (ev.key === "Escape") hide(); };

      view.dom.addEventListener("click", onClick, true);
      view.dom.addEventListener("contextmenu", onContextMenu, true);
      window.addEventListener("resize", onResize);
      window.addEventListener("keydown", onKeydown, true);
      view.scrollDOM?.addEventListener?.("scroll", onScroll, { passive: true });
      const dispI18n = window.zion?.events?.on?.("i18n/changed", () => {
        toolbar.refreshLabels?.();
        closeImageMenu();
      });

      toolbar.previewBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const src = current?.src;
        if (!src) return;
        try {
          await openImageViewerByUrl(src, "", current?.groupItems, current?.groupIndex);
        } catch {}
        hide();
      };
      toolbar.openBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const src = current?.src;
        if (!src) return;
        try {
          const url = await resolveSrcToUrl(src);
          if (!url) return;
          window.open(url, "_blank", "noopener,noreferrer");
        } catch {}
        hide();
      };
      toolbar.copyUrlBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const src = current?.src;
        if (!src) return;
        try { await copyToClipboard(src); } catch {}
        hide();
      };
      toolbar.copyMdBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const raw = current?.raw;
        if (!raw) return;
        try { await copyToClipboard(raw); } catch {}
        hide();
      };
      toolbar.delBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const from = current?.from;
        const to = current?.to;
        if (typeof from !== "number" || typeof to !== "number") return;
        try { view.dispatch({ changes: { from, to, insert: "" } }); } catch {}
        hide();
      };

      return {
        dispose() {
          try { view.dom.removeEventListener("click", onClick, true); } catch {}
          try { view.dom.removeEventListener("contextmenu", onContextMenu, true); } catch {}
          try { window.removeEventListener("resize", onResize); } catch {}
          try { window.removeEventListener("keydown", onKeydown, true); } catch {}
          try { view.scrollDOM?.removeEventListener?.("scroll", onScroll); } catch {}
          try { dispI18n?.dispose?.(); } catch {}
          try { toolbar.el.remove(); } catch {}
          try { styleEl?.remove?.(); } catch {}
          try { closeImageMenu(); } catch {}
          try { closeImageViewer(); } catch {}
        }
      };
    }
  });
  ctx.subscriptions.push(disp);
}
