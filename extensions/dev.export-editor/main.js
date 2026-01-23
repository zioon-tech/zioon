function readCssVar(name, fallback) {
  try {
    const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return val || fallback;
  } catch {
    return fallback;
  }
}

function sanitizeFilenameBase(base) {
  const cleaned = String(base || "export")
    .trim()
    .slice(0, 64)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ");
  return cleaned || "export";
}

function getTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function downloadBlob(filename, blob) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function blobUrl(blob) {
  return URL.createObjectURL(blob);
}

const STYLE_PROPS = [
  "display",
  "visibility",
  "opacity",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
  "box-sizing",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "overflow",
  "overflow-x",
  "overflow-y",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-style",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "border-width",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-radius",
  "outline",
  "background",
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "background-repeat",
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "font-variant",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration",
  "text-transform",
  "white-space",
  "word-break",
  "word-wrap",
  "tab-size",
  "-moz-tab-size",
  "caret-color",
  "transform",
  "transform-origin",
  "filter",
  "flex",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "align-items",
  "align-content",
  "justify-content",
  "gap",
  "grid",
  "grid-template-columns",
  "grid-template-rows",
  "grid-auto-flow",
  "grid-column",
  "grid-row"
];

function cloneWithComputedStyles(node) {
  const clone = node.cloneNode(false);

  if (node.nodeType === 1) {
    const src = node;
    const dst = clone;
    const cs = getComputedStyle(src);
    for (const prop of STYLE_PROPS) {
      const val = cs.getPropertyValue(prop);
      if (val) dst.style.setProperty(prop, val, cs.getPropertyPriority(prop));
    }
    for (const attr of src.attributes || []) {
      if (attr && attr.name && attr.value && attr.name !== "style") {
        dst.setAttribute(attr.name, attr.value);
      }
    }
  }

  for (const child of Array.from(node.childNodes)) {
    clone.appendChild(cloneWithComputedStyles(child));
  }

  return clone;
}

function getContentDom() {
  const editorRoot = document.querySelector(".cm-editor");
  const scroller = editorRoot?.querySelector?.(".cm-scroller") || null;
  const content = editorRoot?.querySelector?.(".cm-content") || null;
  return { editorRoot, scroller, content };
}

async function waitTwoFrames() {
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));
}

async function captureContentViewportBlob(scroller, content, offsetY) {
  const width = Math.max(1, scroller.clientWidth);
  const height = Math.max(1, scroller.clientHeight);
  const bg = readCssVar("--bg", "#282c34");
  const fg = readCssVar("--fg", "#d1d5db");

  const clone = cloneWithComputedStyles(content);
  clone.style.margin = "0";
  clone.style.position = "relative";
  clone.style.top = `-${Math.max(0, offsetY)}px`;

  const container = document.createElement("div");
  container.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  container.style.overflow = "hidden";
  container.style.background = bg;
  container.style.color = fg;
  container.appendChild(clone);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${container.outerHTML}</foreignObject></svg>`;
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  const img = await new Promise((resolve, reject) => {
    const im = new globalThis.Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("svg load"));
    im.src = svgUrl;
  }).finally(() => {
    try {
      URL.revokeObjectURL(svgUrl);
    } catch {}
  });

  const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no ctx");
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);

  return await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png");
  });
}

async function ensureHtml2Canvas() {
  const g = globalThis;
  if (g.html2canvas && typeof g.html2canvas === "function") return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error("html2canvas load"));
    document.head.appendChild(s);
  });
}

async function captureEditorViewportBlobFallback(scroller) {
  await ensureHtml2Canvas();
  const bg = readCssVar("--bg", "#282c34");
  const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const canvas = await globalThis.html2canvas(scroller, {
    backgroundColor: bg,
    scale,
    useCORS: true,
    allowTaint: true
  });
  return await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png");
  });
}

async function captureEditorAllScreenshots() {
  const { scroller, content } = getContentDom();
  if (!scroller || !content) throw new Error("no editor");

  const startTop = scroller.scrollTop;
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const step = Math.max(1, scroller.clientHeight);
  const positions = [];

  for (let top = 0; top < maxTop; top += step) positions.push(top);
  positions.push(maxTop);

  const blobs = [];
  try {
    for (const top of positions) {
      scroller.scrollTop = top;
      await waitTwoFrames();
      try {
        blobs.push(await captureContentViewportBlob(scroller, content, top));
      } catch (e) {
        blobs.push(await captureEditorViewportBlobFallback(scroller));
      }
    }
  } finally {
    scroller.scrollTop = startTop;
  }
  return blobs;
}

async function loadImageFromBlob(blob) {
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new globalThis.Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("img load"));
    };
    img.src = url;
  });
}

async function stitchScreenshotsToCanvas(blobs) {
  const images = [];
  for (const b of blobs) {
    images.push(await loadImageFromBlob(b));
  }
  const width = images.reduce((w, im) => Math.max(w, im.naturalWidth || im.width), 1);
  const totalHeight = images.reduce((h, im) => h + (im.naturalHeight || im.height), 0);
  const scale = 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(totalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no ctx");
  ctx.scale(scale, scale);
  let y = 0;
  for (const im of images) {
    const w = im.naturalWidth || im.width;
    const h = im.naturalHeight || im.height;
    ctx.drawImage(im, 0, y, w, h);
    y += h;
  }
  return canvas;
}

async function sliceCanvasToPages(srcCanvas, maxPageHeightPx) {
  const pages = [];
  const total = srcCanvas.height;
  const width = srcCanvas.width;
  let y = 0;
  while (y < total) {
    const sliceH = Math.min(maxPageHeightPx, total - y);
    const c = document.createElement("canvas");
    c.width = width;
    c.height = sliceH;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("no ctx");
    ctx.drawImage(srcCanvas, 0, y, width, sliceH, 0, 0, width, sliceH);
    const blob = await new Promise((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error("toBlob")), "image/png"));
    pages.push(blob);
    y += sliceH;
  }
  return pages;
}

async function exportPngSingle() {
  const base = sanitizeFilenameBase("editor");
  const time = getTimestamp();
  const blobs = await captureEditorAllScreenshots();
  const stitched = await stitchScreenshotsToCanvas(blobs);
  const blob = await new Promise((resolve, reject) => stitched.toBlob(b => b ? resolve(b) : reject(new Error("toBlob")), "image/png"));
  downloadBlob(`${base}-${time}.png`, blob);
}

async function exportPngMulti() {
  const base = sanitizeFilenameBase("editor");
  const time = getTimestamp();
  const blobs = await captureEditorAllScreenshots();
  const stitched = await stitchScreenshotsToCanvas(blobs);
  const maxH = 16000; // limit per image
  const pages = await sliceCanvasToPages(stitched, maxH);
  const total = pages.length;
  for (let i = 0; i < pages.length; i++) {
    const suffix = total > 1 ? `-${i + 1}of${total}` : "";
    downloadBlob(`${base}-${time}${suffix}.png`, pages[i]);
  }
}

async function exportPdf() {
  const blobs = await captureEditorAllScreenshots();
  const stitched = await stitchScreenshotsToCanvas(blobs);
  // Assume 96 CSS px per inch. A4 8.27in x 11.69in -> about 794 x 1123 px content area (excluding margins).
  const pageHeightPx = 1123;
  const pageBlobs = await sliceCanvasToPages(stitched, pageHeightPx);
  const urls = pageBlobs.map(blobUrl);

  const w = window.open("", "_blank");
  if (!w) throw new Error("blocked");

  const bg = readCssVar("--bg", "#ffffff");
  const fg = readCssVar("--fg", "#2a2a2a");
  const rootVars = [
    "--bg",
    "--panel",
    "--border",
    "--fg",
    "--accent",
    "--ok",
    "--md-code-bg",
    "--md-code-border",
    "--md-codeblock-bg",
    "--md-codeblock-border",
    "--md-quote-bg",
    "--md-quote-border",
    "--md-table-header-bg",
    "--editor-font-size",
    "--selection-bg"
  ]
    .map((k) => `${k}: ${readCssVar(k, "initial")};`)
    .join("\n");

  const body = urls.map(u => `<div class="page"><img src="${u}" /></div>`).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>export</title><style>:root{${rootVars}}html,body{margin:0;background:${bg};color:${fg}}@page{size:A4;margin:10mm}.page{page-break-after:always;margin:0;padding:0}img{width:100%;height:auto;display:block}</style></head><body>${body}<script>setTimeout(()=>{try{window.focus();window.print();}catch{}},150)</script></body></html>`;

  w.document.open();
  w.document.write(html);
  w.document.close();
}

function showQuickPick(actions) {
  const existing = document.getElementById("zion-export-editor-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "zion-export-editor-overlay";
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.zIndex = "99999";
  overlay.style.background = "rgba(0,0,0,0.35)";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  const panel = document.createElement("div");
  panel.style.position = "fixed";
  panel.style.right = "20px";
  panel.style.bottom = "56px";
  panel.style.minWidth = "220px";
  panel.style.background = "var(--panel)";
  panel.style.border = "1px solid var(--border)";
  panel.style.borderRadius = "8px";
  panel.style.boxShadow = "0 12px 28px rgba(0,0,0,0.35)";
  panel.style.padding = "10px";
  panel.style.color = "var(--fg)";
  panel.onclick = (e) => e.stopPropagation();

  const title = document.createElement("div");
  title.textContent = "Export";
  title.style.fontWeight = "600";
  title.style.marginBottom = "8px";
  panel.appendChild(title);

  for (const a of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = a.label;
    btn.style.width = "100%";
    btn.style.textAlign = "left";
    btn.style.padding = "8px 10px";
    btn.style.borderRadius = "6px";
    btn.style.border = "1px solid var(--border)";
    btn.style.background = "transparent";
    btn.style.color = "var(--fg)";
    btn.style.cursor = "pointer";
    btn.onmouseenter = () => (btn.style.background = "rgba(98,114,164,0.18)");
    btn.onmouseleave = () => (btn.style.background = "transparent");
    btn.onclick = async () => {
      overlay.remove();
      await a.run();
    };
    panel.appendChild(btn);
  }

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const onEsc = (ev) => {
    if (ev.key === "Escape") {
      overlay.remove();
      document.removeEventListener("keydown", onEsc, true);
    }
  };
  document.addEventListener("keydown", onEsc, true);
}

export async function activate(ctx) {
  const cmdPngSingle = window.zion.commands.registerCommand("exportEditor.asPng", async () => {
    try {
      await exportPngSingle();
      window.zion?.notification?.show?.("已导出 PNG（单张拼接，保留渲染）", { type: "success", duration: 2000 });
      return true;
    } catch (e) {
      window.zion?.notification?.show?.(`导出失败: ${e?.message || String(e)}`, { type: "error" });
      return false;
    }
  });

  const cmdPngMulti = window.zion.commands.registerCommand("exportEditor.asPngMulti", async () => {
    try {
      await exportPngMulti();
      window.zion?.notification?.show?.("已导出 PNG（多张分页，保留渲染）", { type: "success", duration: 2000 });
      return true;
    } catch (e) {
      window.zion?.notification?.show?.(`导出失败: ${e?.message || String(e)}`, { type: "error" });
      return false;
    }
  });

  const cmdPdf = window.zion.commands.registerCommand("exportEditor.asPdf", async () => {
    try {
      await exportPdf();
      window.zion?.notification?.show?.("已打开打印对话框（可另存为 PDF）", { type: "info", duration: 2500 });
      return true;
    } catch (e) {
      window.zion?.notification?.show?.(`导出失败: ${e?.message || String(e)}`, { type: "error" });
      return false;
    }
  });

  ctx.subscriptions.push(cmdPngSingle, cmdPngMulti, cmdPdf);

  try {
    const menu = window.zion.menus.register("editor/context", {
      title: "Export",
      when: "editorFocus",
      submenu: [
        { command: "exportEditor.asPng", title: "Export as PNG", when: "editorFocus" },
        { command: "exportEditor.asPngMulti", title: "Export as PNG (pages)", when: "editorFocus" },
        { command: "exportEditor.asPdf", title: "Export as PDF", when: "editorFocus" }
      ]
    });
    ctx.subscriptions.push(menu);
  } catch {}

  try {
    const status = window.zion.statusBar.registerItem({
      id: "dev.export-editor",
      text: "Export",
      tooltip: "导出当前编辑器（保留渲染）",
      onClick: () => {
        showQuickPick([
          { label: "Export as PNG", run: () => window.zion.commands.executeCommand("exportEditor.asPng") },
          { label: "Export as PNG (pages)", run: () => window.zion.commands.executeCommand("exportEditor.asPngMulti") },
          { label: "Export as PDF", run: () => window.zion.commands.executeCommand("exportEditor.asPdf") }
        ]);
      }
    });
    ctx.subscriptions.push(status);
  } catch {}

  try {
    const slash = window.zion?.slash?.registerCommand;
    if (typeof slash === "function") {
      ctx.subscriptions.push(
        slash({
          id: "export.png",
          trigger: ["exportpng", "png"],
          title: "Export as PNG",
          description: "导出当前编辑器（保留渲染）为 PNG（单张拼接）",
          category: "export",
          priority: 80,
          execute: async () => {
            await exportPngSingle();
          }
        })
      );
      ctx.subscriptions.push(
        slash({
          id: "export.pdf",
          trigger: ["exportpdf", "pdf"],
          title: "Export as PDF",
          description: "导出当前编辑器（保留渲染）为 PDF",
          category: "export",
          priority: 79,
          execute: async () => {
            await exportPdf();
          }
        })
      );
      ctx.subscriptions.push(
        slash({
          id: "export.pngMulti",
          trigger: ["exportpngpages", "pngpages"],
          title: "Export as PNG (pages)",
          description: "导出当前编辑器（保留渲染）为 PNG（多张分页）",
          category: "export",
          priority: 78,
          execute: async () => {
            await exportPngMulti();
          }
        })
      );
    }
  } catch {}
}

export async function deactivate() {}
