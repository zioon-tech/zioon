import { RangeSetBuilder, type Extension, Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import katex from "katex";
import mermaid from "mermaid";
import { encode as encodePlantUML } from "plantuml-encoder";

/**
 * Revised WYSIWYG plugin:
 * - Use syntaxTree.iterate for block-level detection (headers, lists, fenced code, tables, math blocks)
 * - Use single-line regex only inside visibleRanges and skip content inside code fences
 * - All visual changes are Decoration.mark / Decoration.widget / Decoration.line (no replace across line breaks)
 * - Update is incremental: rebuild only when docChanged || viewportChanged || transactions changed
 */

/* Helpers */
const inViewport = (view: EditorView, from: number, to: number) =>
  view.viewport.to >= from && view.viewport.from <= to;

function isPosInsideNode(pos: number, node: { from: number; to: number } | null) {
  if (!node) return false;
  return pos >= node.from && pos < node.to;
}

/* Simple inline fallback regex (single-line, limited, executed only in visible ranges) */
const INLINE_FALLBACK = /(\*\*([^*\n]+)\*\*)|(_([^_\n]+)_)|(`([^`\n]+)`)|(\[([^\]]+)\]\(([^)\n]+)\))|(!\[([^\]]*)\]\(([^)\n]+)\))|(\$([^\$\n]+)\$)|(~~([^~\n]+)~~)/g;

/* App image short link resolver: app://img/<id> -> DataURL from IndexedDB ("dev.paste-image-db"/"images") */
const APP_IMG_PREFIX = "app://img/";
const appImageCache = new Map<string, string>();

function openPasteImageDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open("dev.paste-image-db", 1);
      req.onupgradeneeded = (e: any) => {
        const db: IDBDatabase = e.target.result;
        if (!db.objectStoreNames.contains("images")) {
          db.createObjectStore("images", { keyPath: "id" });
        }
      };
      req.onsuccess = (e: any) => resolve(e.target.result as IDBDatabase);
      req.onerror = (e: any) => reject(e.target.error);
    } catch (err) {
      reject(err);
    }
  });
}

async function getDataUrlById(id: string): Promise<string | null> {
  if (!id) return null;
  if (appImageCache.has(id)) return appImageCache.get(id)!;
  const db = await openPasteImageDB();
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("images", "readonly");
      const store = tx.objectStore("images");
      const req = store.get(id);
      req.onsuccess = (e: any) => {
        try { db.close(); } catch {}
        const rec = e.target.result as { id: string; dataUrl: string } | undefined;
        if (rec && rec.dataUrl) {
          appImageCache.set(id, rec.dataUrl);
          resolve(rec.dataUrl);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => {
        try { db.close(); } catch {}
        resolve(null);
      };
    } catch {
      try { db.close(); } catch {}
      resolve(null);
    }
  });
}

async function resolveAppImage(src: string): Promise<string | null> {
  if (!src || !src.startsWith(APP_IMG_PREFIX)) return null;
  const id = src.slice(APP_IMG_PREFIX.length);
  try {
    const url = await getDataUrlById(id);
    return url || null;
  } catch {
    return null;
  }
}

/* Widget implementations (small, eq provided for reuse) */

class SimpleLinkWidget extends WidgetType {
  constructor(private label: string, private url: string) { super(); }
  eq(other: SimpleLinkWidget) { return other.label === this.label && other.url === this.url; }
  toDOM() {
    const a = document.createElement("a");
    a.className = "cm-md-link";
    a.href = this.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = this.label;
    a.title = this.url;
    return a;
  }
  ignoreEvent() { return true; }
}

class SimpleImageWidget extends WidgetType {
  constructor(private alt: string, private src: string) { super(); }
  eq(other: SimpleImageWidget) { return other.alt === this.alt && other.src === this.src; }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-img-wrap";

    const mkFallback = () => {
      const fallback = document.createElement("span");
      fallback.className = "cm-md-img-fallback";
      fallback.textContent = this.alt || "[image]";
      return fallback;
    };

    const src = this.src || "";
    // Handle internal short link: app://img/<id>
    if (src.startsWith(APP_IMG_PREFIX)) {
      const ph = mkFallback();
      wrap.appendChild(ph);
      // Async resolve to DataURL and replace placeholder
      resolveAppImage(src).then((url) => {
        if (!url) return;
        try {
          const img = document.createElement("img");
          img.className = "cm-md-img";
          img.alt = this.alt || "";
          img.referrerPolicy = "no-referrer";
          (img as any).loading = "lazy";
          img.src = url;
          img.addEventListener("error", () => {
            const fb = mkFallback();
            if (img.parentNode) img.parentNode.replaceChild(fb, img);
          });
          wrap.replaceChild(img, ph);
        } catch {}
      }).catch(() => {
        // keep fallback if resolve fails
      });
    } else {
      const img = document.createElement("img");
      img.className = "cm-md-img";
      img.alt = this.alt || "";
      img.referrerPolicy = "no-referrer";
      (img as any).loading = "lazy";
      img.src = src;
      img.addEventListener("error", () => {
        const fb = mkFallback();
        if (img.parentNode) img.parentNode.replaceChild(fb, img);
      });
      wrap.appendChild(img);
    }

    return wrap;
  }
  ignoreEvent() { return true; }
}

class SimpleCodeWidget extends WidgetType {
  constructor(private code: string) { super(); }
  eq(other: SimpleCodeWidget) { return other.code === this.code; }
  toDOM() {
    const el = document.createElement("code");
    el.className = "cm-md-code";
    el.textContent = this.code;
    return el;
  }
  ignoreEvent() { return true; }
}

class HeadingWidget extends WidgetType {
  constructor(private text: string, private level: number) { super(); }
  eq(other: HeadingWidget) { return other.text === this.text && other.level === this.level; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-md-heading";
    const sizes: Record<number, string> = { 1: "1.6em", 2: "1.4em", 3: "1.25em", 4: "1.15em", 5: "1.05em", 6: "1em" };
    span.style.fontSize = sizes[this.level] ?? "1em";
    // Use inner text only; inline parsing left to fallback renderer if needed
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() { return true; }
}

class TaskWidget extends WidgetType {
  constructor(private checked: boolean, private onToggle: () => void, private label: string) { super(); }
  eq(other: TaskWidget) {
    return other.checked === this.checked && other.label === this.label;
  }
  toDOM() {
    const container = document.createElement("span");
    container.className = "cm-md-task";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!this.checked;
    checkbox.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { this.onToggle(); } catch (err) { console.error("[wysiwyg] task toggle", err); }
    });
    const label = document.createElement("span");
    label.textContent = this.label;
    container.appendChild(checkbox);
    container.appendChild(label);
    return container;
  }
  // Prevent editor from moving cursor when clicking diagram area, so toolbar stays clickable.
  ignoreEvent() { return true; }
}

class MathWidget extends WidgetType {
  constructor(private expr: string, private display: boolean) { super(); }
  eq(other: MathWidget) { return other.expr === this.expr && other.display === this.display; }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.display ? "cm-md-math-block" : "cm-md-math-inline";
    try {
      katex.render(this.expr, el, { throwOnError: false, displayMode: this.display });
    } catch (err) {
      el.textContent = this.expr;
      el.classList.add("cm-md-math-error");
    }
    return el;
  }
  ignoreEvent() { return true; }
}

/**
 * 可编辑/可拖动的表格组件：
 * - 单元格与表头可 contentEditable，失焦或回车触发提交，回写到 Markdown 源文本。
 * - 列宽可通过表头右侧把手拖动，使用 table-layout: fixed 控制布局。
 * - 单元格内容随宽度自动换行（CSS 配合）。
 */
class TableWidget extends WidgetType {
  private columnWidths: number[] = [];

  constructor(
    private headers: string[],
    private aligns: Array<"left" | "center" | "right">,
    private rows: string[][],
    private sourceFrom: number,
    private sourceTo: number,
    private onCommit: (text: string) => void
  ) {
    super();
  }

  eq(other: TableWidget) {
    const sameHdr = this.headers.join("|") === other.headers.join("|");
    const sameAlign = this.aligns.join(",") === other.aligns.join(",");
    const thisRows = this.rows.map(r => r.join("|")).join("\n");
    const otherRows = other.rows.map(r => r.join("|")).join("\n");
    // 列宽不是语义的一部分，不参与 eq 比较
    return sameHdr && sameAlign && thisRows === otherRows;
  }

  private sanitizeCellText(s: string): string {
    // 去掉换行，转义管道，修剪首尾空白
    return s.replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
  }

  private buildMarkdown(): string {
    const headerLine = "| " + this.headers.map(h => this.sanitizeCellText(h)).join(" | ") + " |";
    const alignToken = (a: "left" | "center" | "right") => {
      if (a === "center") return ":---:";
      if (a === "right") return "---:";
      return ":---"; // GFM 左对齐常用 :---
    };
    const sepLine = "| " + this.aligns.map(a => alignToken(a)).join(" | ") + " |";
    const rowLines = this.rows.map(r => "| " + r.map(c => this.sanitizeCellText(c)).join(" | ") + " |");
    return [headerLine, sepLine, ...rowLines].join("\n");
  }

  private commit() {
    try {
      const md = this.buildMarkdown();
      this.onCommit(md);
    } catch (e) {
      console.error("[wysiwyg] table commit error", e);
    }
  }

  private attachCellEdit(td: HTMLTableCellElement, getSetter: () => (val: string) => void) {
    const span = document.createElement("span");
    span.className = "cm-md-cell-edit";
    span.contentEditable = "true";
    span.spellcheck = false;
    // 初始值
    span.textContent = td.textContent || "";
    // 输入时只更新内存，不立即提交
    span.addEventListener("input", () => {
      const setter = getSetter();
      setter(span.textContent || "");
    });
    // Enter/Meta+Enter 提交；Shift+Enter 插入换行（但提交时会被替换为空格）
    span.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        (ev.target as HTMLElement).blur();
      }
    });
    span.addEventListener("blur", () => {
      this.commit();
    });
    // 阻止点击选中导致编辑器焦点变化
    td.onmousedown = (e) => e.stopPropagation();
    td.onclick = (e) => e.stopPropagation();
    td.innerHTML = "";
    td.appendChild(span);
  }

  private setColumnWidth(table: HTMLTableElement, colIndex: number, widthPx: number) {
    const minWidth = Math.max(40, Math.round(widthPx)); // 最小宽度 40px
    this.columnWidths[colIndex] = minWidth;
    // 设定表头与每行对应单元格宽度
    const theadRow = table.tHead?.rows[0];
    if (theadRow && theadRow.cells[colIndex]) {
      (theadRow.cells[colIndex] as HTMLElement).style.width = `${minWidth}px`;
    }
    const rows = Array.from(table.tBodies[0]?.rows || []);
    for (const r of rows) {
      const cell = r.cells[colIndex] as HTMLElement | undefined;
      if (cell) cell.style.width = `${minWidth}px`;
    }
  }

  private attachResizer(th: HTMLTableCellElement, table: HTMLTableElement, colIndex: number) {
    const res = document.createElement("span");
    res.className = "cm-md-col-resizer";
    th.style.position = "relative";
    th.appendChild(res);

    let dragging = false;
    let startX = 0;
    let startW = 0;

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const w = startW + dx;
      this.setColumnWidth(table, colIndex, w);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try { document.body.style.cursor = ""; } catch {}
    };

    res.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.clientX;
      startW = th.getBoundingClientRect().width;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      try { document.body.style.cursor = "col-resize"; } catch {}
    });
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-md-table";

    // THEAD
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    this.headers.forEach((h, i) => {
      const th = document.createElement("th");
      th.style.textAlign = this.aligns[i] || "left";
      th.textContent = h;

      // 表头可编辑
      this.attachCellEdit(th as unknown as HTMLTableCellElement, () => {
        return (val: string) => {
          this.headers[i] = val;
        };
      });

      // 拖动列宽
      this.attachResizer(th as unknown as HTMLTableCellElement, table, i);

      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    // TBODY
    const tbody = document.createElement("tbody");
    this.rows.forEach((row, ri) => {
      const tr = document.createElement("tr");
      row.forEach((cell, ci) => {
        const td = document.createElement("td");
        td.style.textAlign = this.aligns[ci] || "left";
        td.textContent = cell;

        // 单元格可编辑
        this.attachCellEdit(td, () => {
          return (val: string) => {
            this.rows[ri][ci] = val;
          };
        });

        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    // 初始列宽应用（如果已有）
    if (this.columnWidths.length) {
      this.columnWidths.forEach((w, i) => this.setColumnWidth(table, i, w));
    }

    wrap.appendChild(table);
    return wrap;
  }

  // 在表格区域内交互不让编辑器改变光标位置
  ignoreEvent() { return true; }
}

/* Mermaid helpers for theme/init and copy/export */
function getMermaidTheme(): "default" | "dark" {
  const t = document.documentElement.getAttribute("data-theme");
  return t === "light" ? "default" : "dark";
}
function ensureMermaidInit() {
  try {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: getMermaidTheme(),
      logLevel: "error",
      suppressErrors: true
    } as any);
    // Suppress global parse error handler to avoid DOM error notes
    try { (mermaid as any).parseError = () => {}; } catch {}
  } catch {}
}
async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } finally { ta.remove(); }
  }
}
function svgToDataUrl(svg: string): string {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
async function svgToPngDataUrl(svg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const bboxMatch = svg.match(/viewBox="([^"]+)"/);
        let width = 0, height = 0;
        if (bboxMatch) {
          const vb = bboxMatch[1].split(/\s+/).map(Number);
          width = Math.max(1, Math.round(vb[2]));
          height = Math.max(1, Math.round(vb[3]));
        } else {
          // fallback size
          width = Math.max(1, Math.round(img.naturalWidth || 800));
          height = Math.max(1, Math.round(img.naturalHeight || 400));
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("no canvas ctx")); return; }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/png"));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("svg->png load error"));
    img.src = svgToDataUrl(svg);
  });
}
function downloadDataUrl(filename: string, url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

class DiagramWidget extends WidgetType {
  private svgString: string | null = null;

  constructor(private code: string, private lang: "mermaid" | "uml" | "svg", private onToggle: () => void) {
    super();
  }
  eq(other: DiagramWidget) {
    return other.code === this.code && other.lang === this.lang;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-diagram";

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "cm-md-diagram-toolbar";
    const mkBtn = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.className = "cm-md-diagram-btn";
      b.textContent = label;
      b.title = title;
      b.type = "button";
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); };
      return b;
    };
    const editBtn = mkBtn("编辑", "切换到源码编辑", () => { try { this.onToggle(); } catch {} });
    const copySvgBtn = mkBtn("复制SVG", "复制为 SVG", async () => {
      if (this.svgString) await copyToClipboard(this.svgString);
    });
    const exportPngBtn = mkBtn("导出PNG", "导出为 PNG 文件", async () => {
      if (!this.svgString) return;
      try {
        const png = await svgToPngDataUrl(this.svgString);
        downloadDataUrl("diagram.png", png);
      } catch {}
    });
    const openBtn = mkBtn("新窗", "在新窗口打开", () => {
      if (!this.svgString) return;
      const w = window.open();
      if (w) {
        try {
          w.document.write(`<html><head><title>Diagram</title></head><body style="margin:0">${this.svgString}</body></html>`);
          w.document.close();
        } catch {}
      }
    });
    toolbar.append(editBtn, copySvgBtn, exportPngBtn, openBtn);
    wrap.appendChild(toolbar);

    if (this.lang === "mermaid") {
      let scratch: HTMLDivElement | null = null;
      try {
        ensureMermaidInit();
        const id = "mmd-" + Math.random().toString(36).slice(2);
        // Use an offscreen scratch container to prevent mermaid from appending error text to document.body
        scratch = document.createElement("div");
        scratch.style.position = "fixed";
        scratch.style.left = "-9999px";
        scratch.style.top = "-9999px";
        document.body.appendChild(scratch);
        mermaid.render(id, this.code, scratch).then(({ svg }) => {
          // sanitize: remove script tags
          const parser = new DOMParser();
          const doc = parser.parseFromString(svg, "image/svg+xml");
          const scripts = doc.querySelectorAll("script");
          scripts.forEach(s => s.remove());
          this.svgString = new XMLSerializer().serializeToString(doc.documentElement);
          // Clear and insert svg (keep toolbar)
          const children = Array.from(wrap.childNodes).filter(n => (n as HTMLElement)?.classList?.contains?.("cm-md-diagram-toolbar"));
          wrap.innerHTML = "";
          children.forEach(n => wrap.appendChild(n));
          wrap.appendChild(document.importNode(doc.documentElement, true));
        }).catch(() => {
          // swallow errors and avoid leaking scratch node
        }).finally(() => {
          try { scratch?.remove(); } catch {}
        });
      } catch {
        try { scratch?.remove(); } catch {}
      }
    } else if (this.lang === "uml") {
      try {
        const encoded = encodePlantUML(this.code);
        const server = (window as any).__plantuml_server || "https://www.plantuml.com/plantuml/svg/";
        const img = document.createElement("img");
        img.className = "cm-md-uml";
        img.referrerPolicy = "no-referrer";
        (img as any).loading = "lazy";
        img.src = server + encoded;
        img.addEventListener("error", () => { /* keep empty */ });
        wrap.appendChild(img);
      } catch {}
    } else if (this.lang === "svg") {
      try {
        // Sanitize SVG content: remove script tags and other potentially dangerous elements
        const parser = new DOMParser();
        const doc = parser.parseFromString(this.code, "image/svg+xml");
        
        // Remove potentially dangerous elements
        const dangerousTags = ['script', 'object', 'iframe', 'embed', 'link'];
        dangerousTags.forEach(tag => {
          const elements = doc.querySelectorAll(tag);
          elements.forEach(el => el.remove());
        });
        
        // Remove event handlers from all elements
        const allElements = doc.querySelectorAll('*');
        allElements.forEach(el => {
          const attributes = el.attributes;
          for (let i = attributes.length - 1; i >= 0; i--) {
            const attr = attributes[i];
            if (attr.name.startsWith('on')) {
              el.removeAttribute(attr.name);
            }
          }
        });

        this.svgString = new XMLSerializer().serializeToString(doc.documentElement);
        
        // Clear and insert svg (keep toolbar)
        const children = Array.from(wrap.childNodes).filter(n => (n as HTMLElement)?.classList?.contains?.("cm-md-diagram-toolbar"));
        wrap.innerHTML = "";
        children.forEach(n => wrap.appendChild(n));
        wrap.appendChild(document.importNode(doc.documentElement, true));
      } catch (error) {
        // If parsing fails, show error message
        const errorDiv = document.createElement("div");
        errorDiv.className = "cm-md-svg-error";
        errorDiv.textContent = "SVG 解析错误";
        wrap.appendChild(errorDiv);
      }
    }

    // Interaction: do not toggle preview on diagram area, so toolbar stays clickable.
    return wrap;
  }
  // Prevent editor from moving cursor when clicking diagram area, so toolbar stays clickable.
  ignoreEvent() { return true; }
}

/* Build decorations using syntax tree for blocks and single-line inline fallback in visibleRanges
   Important: collect all ranges first and sort by position before building DecorationSet,
   otherwise RangeSetBuilder order constraints may cause only the first chunk to render. */
function buildDecorations(view: EditorView, activeLines: Set<number>, expandedDiagrams: Set<number>) {
  const doc = view.state.doc;
  const tree = syntaxTree(view.state) as any;

  // Collect then sort to respect RangeSetBuilder ordering
  const pending: { from: number; to: number; dec: Decoration }[] = [];
  const add = (from: number, to: number, dec: Decoration) => {
    pending.push({ from, to, dec });
  };
  // track processed quote block starts to avoid duplicate processing when syntax tree yields multiple QuoteMark nodes
  const processedQuoteStarts = new Set<number>();

  // Helper: is position inside fenced code
  const isInsideFencedCode = (pos: number) => {
    let inside = false;
    try {
      tree.iterate({
        enter: (node: any) => {
          const name = node.name || node.type?.name;
          if ((name === "FencedCode" || name === "CodeBlock") && isPosInsideNode(pos, node)) {
            inside = true;
          }
        }
      });
    } catch {}
    return inside;
  };

  // 1) Block-level via syntax tree (only for nodes within viewport)
  try {
    tree.iterate({
      enter: (node: any) => {
        const name = node.name || node.type?.name;
        const from = node.from, to = node.to;
        if (!inViewport(view, from, to)) return;

        // Headers: style content; on active line keep '#' markers visible, off active line hide them
        if (name === "Header" || name === "HeaderMark") {
          const line = doc.lineAt(from);
          const text = doc.sliceString(line.from, line.to);
          const m = /^(#{1,6})\s*(.*)$/.exec(text);
          if (m) {
            const level = Math.min(6, m[1].length);
            const content = m[2] || "";
            const markerEnd = line.from + (m[0].length - content.length);
            const isActive = activeLines.has(line.number);
            if (!isActive) {
              add(line.from, markerEnd, Decoration.mark({ class: "cm-z-hide-syntax" }));
            }
            const cls = `cm-md-heading cm-md-h${level}`;
            add(markerEnd, line.to, Decoration.mark({ class: cls }));
          }
          return;
        }

        // Task list markers: keep raw on active line; off active line use checkbox widget
        if (name === "TaskMarker") {
          const lnNum = doc.lineAt(node.from).number;
          const isActive = activeLines.has(lnNum);
          const markerText = doc.sliceString(node.from, node.to);
          const checked = /\bx\b/i.test(markerText);
          if (!isActive) {
            add(node.from, node.to, Decoration.mark({ class: "cm-z-hide-syntax" }));
            const onToggle = () => {
              const replacement = checked ? " " : "x";
              try { view.dispatch({ changes: { from: node.from + 1, to: node.from + 2, insert: replacement } }); } catch {}
            };
            const line = doc.lineAt(node.to);
            const rest = doc.sliceString(node.to, line.to).trimStart();
            add(node.from, node.from, Decoration.widget({ widget: new TaskWidget(checked, onToggle, rest), side: 1 }));
          }
          return;
        }

        // List bullets / numbers: keep raw on active line; off active line use bullet/number widget
        if (name === "ListMark") {
          const lnNum = doc.lineAt(node.from).number;
          const isActive = activeLines.has(lnNum);
          if (!isActive) {
            add(node.from, node.to, Decoration.mark({ class: "cm-z-hide-syntax" }));
            const txt = doc.sliceString(node.from, node.to).trim();
            add(
              node.from,
              node.from,
              Decoration.widget({
                widget: new (class extends WidgetType {
                  constructor(private txt: string) { super(); }
                  eq(other: any) { return other.txt === this.txt; }
                  toDOM() {
                    const s = document.createElement("span");
                    s.className = /^[\d]/.test(this.txt) ? "cm-md-ol-num" : "cm-md-ul-bullet";
                    s.textContent = /^[\d]/.test(this.txt) ? (this.txt.replace(/\./g, "") + ".") : "•";
                    return s;
                  }
                  ignoreEvent() { return true; }
                })(txt),
                side: 1
              })
            );
          }
          return;
        }

        // Quote mark: group contiguous quote lines into a single visual block and avoid splitting marker above content
        if (name === "QuoteMark") {
          const line = doc.lineAt(node.from);
          // Determine contiguous quote block (expand up/down), skip processing if inside fenced code
          const isQuoteLineText = (txt: string) => (/^\s*>/.test(txt));
          let startLn = line.number;
          while (startLn > 1) {
            const prev = doc.line(startLn - 1);
            if (isInsideFencedCode(prev.from)) break;
            if (!isQuoteLineText(doc.sliceString(prev.from, prev.to))) break;
            startLn--;
          }
          let endLn = line.number;
          while (endLn < doc.lines) {
            const next = doc.line(endLn + 1);
            if (isInsideFencedCode(next.from)) break;
            if (!isQuoteLineText(doc.sliceString(next.from, next.to))) break;
            endLn++;
          }

          const blockStartPos = doc.line(startLn).from;
          // avoid duplicate processing for the same block
          if (processedQuoteStarts.has(blockStartPos)) return;
          processedQuoteStarts.add(blockStartPos);

          // check whether any line within block is active (caret/selection); if so we show markers on active lines
          let anyActive = false;
          for (let ln = startLn; ln <= endLn; ln++) {
            if (activeLines.has(ln)) { anyActive = true; break; }
          }

          // Apply a line decoration to every line so the visual background is contiguous.
          // For non-active lines hide the leading marker with a marker-preserving class.
          for (let ln = startLn; ln <= endLn; ln++) {
            const l = doc.line(ln);
            const txt = doc.sliceString(l.from, l.to);
            const prefixMatch = /^\s*>+\s*/.exec(txt);
            const markerLen = prefixMatch ? prefixMatch[0].length : 0;

            // Always apply line-level decoration for contiguous background
            add(l.from, l.from, Decoration.line({ class: "cm-md-quote" }));

            if (anyActive && activeLines.has(ln)) {
              // Keep marker visible on active line(s) so user can edit quote prefix normally.
              // Content is already visually styled by the line decoration.
            } else {
              // Hide marker but preserve layout using a dedicated class that doesn't collapse line height.
              if (markerLen > 0) {
                add(l.from, l.from + markerLen, Decoration.mark({ class: "cm-z-hide-marker" }));
              }
            }
          }
          return;
        }

        // Fenced code (and diagram preview)
        if (name === "FencedCode" || name === "CodeBlock") {
          const fromLineNum = doc.lineAt(node.from).number;
          const toLineNum = doc.lineAt(node.to).number;
          // add codeblock styling to all lines
          for (let ln = fromLineNum; ln <= toLineNum; ln++) {
            const l = doc.line(ln);
            add(l.from, l.from, Decoration.line({ class: "cm-md-codeblock" }));
          }
          // add fence hint on first line; last line仅在存在闭合围栏时标记
          const firstLine = doc.lineAt(node.from);
          const lastLine = doc.lineAt(node.to);
          add(firstLine.from, firstLine.from, Decoration.line({ class: "cm-md-codeblock-fence" }));

          const opener = doc.sliceString(firstLine.from, firstLine.to).trim();
          const mlang = /^```?\s*([^\s]*)/.exec(opener);
          let lang = "";
          if (mlang) lang = (mlang[1] || "").toLowerCase();

          // 检测是否存在闭合围栏（至少三个反引号，仅空格可跟随）
          const lastTextTrimmed = doc.sliceString(lastLine.from, lastLine.to).trim();
          const hasClosingFence = /^`{3,}\s*$/.test(lastTextTrimmed);
          if (hasClosingFence) {
            add(lastLine.from, lastLine.from, Decoration.line({ class: "cm-md-codeblock-fence" }));
          }

          // If any line in the block is active (caret/selection), do not render diagram preview; keep raw text for editing
          let anyActive = false;
          for (let ln = fromLineNum; ln <= toLineNum; ln++) {
            if (activeLines.has(ln)) { anyActive = true; break; }
          }

          const isDiagram = lang === "mermaid" || lang === "plantuml" || lang === "puml" || lang === "svg";
          // 仅在围栏已闭合时进行图块预览与折叠，避免未闭合围栏吞掉后续内容
          if (isDiagram && hasClosingFence && !anyActive) {
            const contentFrom = doc.lineAt(node.from).to;
            const contentTo = doc.lineAt(node.to).from;
            const code = doc.sliceString(contentFrom, contentTo);
            const diagramFrom = node.from;

            // Determine diagram type
            let diagramType: "mermaid" | "uml" | "svg" = "uml";
            if (lang === "mermaid") {
              diagramType = "mermaid";
            } else if (lang === "svg") {
              diagramType = "svg";
            }

            // preview when not expanded; toggle on click
            if (!expandedDiagrams.has(diagramFrom)) {
              add(node.from, node.from + (firstLine.to - firstLine.from) + 1, Decoration.mark({ class: "cm-z-hide-syntax" }));
              add(
                node.from,
                node.from,
                Decoration.widget({
                  widget: new DiagramWidget(code, diagramType, () => {
                    // toggle preview/raw
                    if (expandedDiagrams.has(diagramFrom)) {
                      expandedDiagrams.delete(diagramFrom);
                    } else {
                      expandedDiagrams.add(diagramFrom);
                    }
                    try { view.dispatch({ annotations: Transaction.userEvent.of("wysiwyg-refresh") }); } catch {}
                  }),
                  side: 1
                })
              );
              // collapse non-first lines
              for (let ln = fromLineNum + 1; ln <= toLineNum; ln++) {
                const l = doc.line(ln);
                add(l.from, l.from, Decoration.line({ class: "cm-md-diagram-hiddenline" }));
              }
            }
          }
          return;
        }

        // HorizontalRule (---, ***, ___)
        if (name === "HorizontalRule") {
          const line = doc.lineAt(from);
          const isActive = activeLines.has(line.number);
          if (!isActive) {
            // Hide the original markers (keep mapping stable)
            add(line.from, line.to, Decoration.mark({ class: "cm-z-hide-syntax" }));
            // Apply a line-level class so the line's padding/height can be controlled by CSS
            add(line.from, line.from, Decoration.line({ class: "cm-md-hr-line" }));

            // Insert a block widget at line start that renders the visual horizontal rule.
            // Using side: 0 places it at the line start; the line-level class ensures compact layout.
            add(
              line.from,
              line.from,
              Decoration.widget({
                widget: new (class extends WidgetType {
                  eq(other: any) { return other && other instanceof Object; }
                  toDOM() {
                    const wrap = document.createElement("div");
                    wrap.className = "cm-md-hr-wrap";
                    const hr = document.createElement("div");
                    hr.className = "cm-md-hr";
                    wrap.appendChild(hr);
                    return wrap;
                  }
                  ignoreEvent() { return true; }
                })(),
                side: 0
              })
            );
          }
          return;
        }

        // Table node: handled by visible-range fallback scanner below

        // Math block: handled by visible-range fallback ($...$) to avoid cross-line replacement issues
      }
    });
  } catch {}

  // 2) Visible-range fallback scanners (inline marks, tables, block math). Skip inside code fences.
  for (const vr of view.visibleRanges) {
    const text = doc.sliceString(vr.from, vr.to);

    // 2.1 inline marks (bold/em/code/link/image/inline-math)
    let m: RegExpExecArray | null;
    INLINE_FALLBACK.lastIndex = 0;
    while ((m = INLINE_FALLBACK.exec(text)) !== null) {
      const start = vr.from + m.index;
      const end = start + m[0].length;
      if (isInsideFencedCode(start)) continue;
      const lnNum = doc.lineAt(start).number;
      const isActive = activeLines.has(lnNum);

      // bold (**...**)
      if (m[1]) {
        if (isActive) {
          // active line: render content style, keep markers visible
          add(start + 2, end - 2, Decoration.mark({ class: "cm-md-strong" }));
        } else {
          add(start, start + 2, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start + 2, end - 2, Decoration.mark({ class: "cm-md-strong" }));
          add(end - 2, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
        }
        continue;
      }
      // em (_..._) - only when underscores are not inside a word (CommonMark rule)
      if (m[3]) {
        const before = start > 0 ? doc.sliceString(start - 1, start) : "";
        const after = end < doc.length ? doc.sliceString(end, end + 1) : "";
        const isWordChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);
        const valid = !isWordChar(before) && !isWordChar(after);
        if (!valid) {
          // Ignore intraword underscores like "wind_power_diffusion"
          continue;
        }
        if (isActive) {
          add(start + 1, end - 1, Decoration.mark({ class: "cm-md-em" }));
        } else {
          add(start, start + 1, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start + 1, end - 1, Decoration.mark({ class: "cm-md-em" }));
          add(end - 1, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
        }
        continue;
      }
      // inline code (`...`)
      if (m[5]) {
        if (isActive) {
          add(start + 1, end - 1, Decoration.mark({ class: "cm-md-code" }));
        } else {
          add(start, start + 1, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start + 1, end - 1, Decoration.mark({ class: "cm-md-code" }));
          add(end - 1, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
        }
        continue;
      }
      // link ([label](url))
      if (m[7]) {
        const label = m[8] || "";
        const url = m[9] || "";
        if (isActive) {
          // active line: keep raw markdown, optionally style label
          const labelStart = start + 1;
          const labelEnd = labelStart + label.length;
          if (label.length > 0) {
            add(labelStart, labelEnd, Decoration.mark({ class: "cm-md-link" }));
          }
        } else {
          add(start, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start, start, Decoration.widget({ widget: new SimpleLinkWidget(label, url), side: 1 }));
        }
        continue;
      }
      // image (![alt](src))
      if (m[10]) {
        const alt = m[11] || "";
        const src = m[12] || "";
        if (isActive) {
          // active line: keep raw markdown
        } else {
          add(start, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start, start, Decoration.widget({ widget: new SimpleImageWidget(alt, src), side: 1 }));
        }
        continue;
      }
      // inline math ($...$)
      if (m[13]) {
        const expr = m[14] || "";
        if (isActive) {
          // active line: keep raw markdown (no widget to avoid duplication)
        } else {
          add(start, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start, start, Decoration.widget({ widget: new MathWidget(expr, false), side: 1 }));
        }
        continue;
      }
      // strikethrough (~~...~~)
      if (m[15]) {
        if (isActive) {
          add(start + 2, end - 2, Decoration.mark({ class: "cm-md-strike" }));
        } else {
          add(start, start + 2, Decoration.mark({ class: "cm-z-hide-syntax" }));
          add(start + 2, end - 2, Decoration.mark({ class: "cm-md-strike" }));
          add(end - 2, end, Decoration.mark({ class: "cm-z-hide-syntax" }));
        }
        continue;
      }
    }

// 2.2 tables (pipe-style GFM): header + separator + rows
    // NOTE: 扫描整张表（超出可见区域），一次性折叠，避免视口反复重算引发测量循环告警
    const startLine = doc.lineAt(vr.from).number;
    const endLine = doc.lineAt(vr.to).number;

    const isTableRow = (s: string) => {
      const t = s.trim();
      if (!t.includes("|")) return false;
      // not a separator
      return !/^(\s*\|)?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+(\|\s*)?$/.test(t);
    };
    const isSeparatorRow = (s: string) => {
      const t = s.trim();
      return /^(\s*\|)?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+(\|\s*)?$/.test(t);
    };
    const splitCells = (s: string) => {
      const t = s.trim().replace(/^\|/, "").replace(/\|$/, "");
      return t.split("|").map(c => c.trim());
    };
    const parseAligns = (s: string) => {
      const cells = splitCells(s);
      return cells.map(seg => {
        const left = seg.startsWith(":");
        const right = seg.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        return "left";
      }) as Array<"left" | "center" | "right">;
    };

    let ln = startLine;
    while (ln <= endLine) {
      const line = doc.line(ln);
      const ltxt = doc.sliceString(line.from, line.to);
      if (isInsideFencedCode(line.from)) { ln++; continue; }

      if (isTableRow(ltxt)) {
        const sepLn = ln + 1;
        if (sepLn > doc.lines) { ln++; continue; }
        const sepLine = doc.line(sepLn);
        const sepTxt = doc.sliceString(sepLine.from, sepLine.to);
        if (isSeparatorRow(sepTxt)) {
          const headers = splitCells(ltxt);
          const aligns = parseAligns(sepTxt);
          const rows: string[][] = [];
          let rowLn = sepLn + 1;
          // 扫描整块表格，直到遇到非表格行/围栏或文档末尾（不受可见范围限制）
          while (rowLn <= doc.lines) {
            const rline = doc.line(rowLn);
            const rtxt = doc.sliceString(rline.from, rline.to);
            if (!isTableRow(rtxt) || isInsideFencedCode(rline.from)) break;
            rows.push(splitCells(rtxt));
            rowLn++;
          }

          // If any line within the table block is active, skip widget for easy editing
          let anyActive = false;
          for (let n = ln; n < rowLn; n++) {
            if (activeLines.has(n)) { anyActive = true; break; }
          }

          if (!anyActive) {
            // Hide header/separator/rows, insert widget on header line, collapse subsequent lines
            for (let hideLn = ln; hideLn < rowLn; hideLn++) {
              const hline = doc.line(hideLn);
              add(hline.from, hline.to, Decoration.mark({ class: "cm-z-hide-syntax" }));
              if (hideLn > ln) {
                add(hline.from, hline.from, Decoration.line({ class: "cm-md-diagram-hiddenline" }));
              }
            }
            const sourceFrom = line.from;
            const sourceTo = doc.line(rowLn - 1).to;
            add(line.from, line.from, Decoration.widget({
              widget: new TableWidget(
                headers,
                aligns,
                rows,
                sourceFrom,
                sourceTo,
                (newText: string) => {
                  try {
                    view.dispatch({
                      changes: { from: sourceFrom, to: sourceTo, insert: newText }
                    });
                  } catch (e) {
                    console.error("[wysiwyg] table commit dispatch error", e);
                  }
                }
              ),
              side: 1
            }));
          }

          // 跳过整张表（可能越过当前可见范围的末尾），避免重复处理与视口震荡
          ln = rowLn;
          continue;
        }
      }
      ln++;
    }

    // 2.3 block math ($ ... $)
    ln = startLine;
    while (ln <= endLine) {
      const line = doc.line(ln);
      const t = doc.sliceString(line.from, line.to).trim();
      if (isInsideFencedCode(line.from)) { ln++; continue; }
      const isFence = /^\$\$\s*$/.test(t);
      if (isFence) {
        // find closing fence
        let endFenceLn = ln + 1;
        while (endFenceLn <= endLine) {
          const eline = doc.line(endFenceLn);
          const et = doc.sliceString(eline.from, eline.to).trim();
          if (/^\$\$\s*$/.test(et)) break;
          endFenceLn++;
        }
        if (endFenceLn <= endLine) {
          const contentFrom = doc.line(ln + 1).from;
          const contentTo = doc.line(endFenceLn - 1).to;
          const expr = contentFrom <= contentTo ? doc.sliceString(contentFrom, contentTo) : "";

          // If any line within the block is active, skip widget for editing
          let anyActive = false;
          for (let n = ln; n <= endFenceLn; n++) {
            if (activeLines.has(n)) { anyActive = true; break; }
          }

          if (!anyActive) {
            // hide all lines and collapse middle lines
            for (let hideLn = ln; hideLn <= endFenceLn; hideLn++) {
              const hline = doc.line(hideLn);
              add(hline.from, hline.to, Decoration.mark({ class: "cm-z-hide-syntax" }));
              if (hideLn > ln) {
                add(hline.from, hline.from, Decoration.line({ class: "cm-md-diagram-hiddenline" }));
              }
            }
            // widget at start
            add(line.from, line.from, Decoration.widget({ widget: new MathWidget(expr, true), side: 1 }));
          }

          ln = endFenceLn + 1;
          continue;
        }
      }
      ln++;
    }
  }

  // Build in order
  pending.sort((a, b) => (a.from === b.from ? a.to - b.to : a.from - b.from));
  const builder = new RangeSetBuilder<Decoration>();
  for (const it of pending) {
    builder.add(it.from, it.to, it.dec);
  }
  return builder.finish();
}

/* ViewPlugin: incremental rebuilds */
const wysiwygPlugin = ViewPlugin.fromClass(class {
  decorations: any;
  expandedDiagrams = new Set<number>();

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view, getActiveLines(view), this.expandedDiagrams);
    this.bindEvents(view);
  }

  bindEvents(view: EditorView) {
    // Observe theme attribute to refresh diagrams if theme changes
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "attributes" && (m as any).attributeName === "data-theme") {
          try { view.dispatch({ annotations: Transaction.userEvent.of("wysiwyg-refresh") }); } catch {}
          break;
        }
      }
    });
    try { mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); } catch {}
    (view as any)._wysiwyg_cleanup = () => { try { mo.disconnect(); } catch {} };
  }

  update(update: ViewUpdate) {
    const selectionOnly = update.selectionSet && !update.docChanged && !update.viewportChanged;
    const needRebuild = update.docChanged || update.viewportChanged || (Array.isArray(update.transactions) && update.transactions.some(t => {
      try { return t.annotation(Transaction.userEvent) === "wysiwyg-refresh"; } catch { return false; }
    }));

    // 当编辑模式下（已展开为原文）且光标离开该代码块时，自动恢复预览
    let collapsed = false;
    if (update.selectionSet && this.expandedDiagrams.size > 0) {
      const toDelete: number[] = [];
      for (const start of this.expandedDiagrams) {
        const rng = getFencedBlockRangeAtPos(update.view, start);
        if (!rng) continue;
        let intersects = false;
        for (const sel of update.view.state.selection.ranges) {
          const sFrom = sel.from;
          const sTo = sel.to;
          // 是否与图块范围相交
          if (!(sTo <= rng.from || sFrom >= rng.to)) { intersects = true; break; }
        }
        if (!intersects) toDelete.push(start);
      }
      if (toDelete.length) {
        toDelete.forEach(p => this.expandedDiagrams.delete(p));
        collapsed = true;
      }
    }

    if (needRebuild || selectionOnly || collapsed) {
      const activeLines = getActiveLines(update.view);
      this.decorations = buildDecorations(update.view, activeLines, this.expandedDiagrams);
    }
  }

  destroy() {
    // cleanup
    try { (this as any)._wysiwyg_cleanup?.(); } catch {}
  }
}, {
  decorations: v => v.decorations
});

/* helper: compute active line numbers set */
function getActiveLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  for (const r of view.state.selection.ranges) {
    const fromLine = view.state.doc.lineAt(r.from).number;
    const toLine = view.state.doc.lineAt(r.to).number;
    for (let n = fromLine; n <= toLine; n++) lines.add(n);
  }
  return lines;
}

/* helper: 根据起始位置查找对应的围栏代码块范围（Mermaid/CodeBlock） */
function getFencedBlockRangeAtPos(view: EditorView, startPos: number): { from: number; to: number } | null {
  try {
    const tree = syntaxTree(view.state) as any;
    let found: { from: number; to: number } | null = null;
    tree.iterate({
      enter: (node: any) => {
        const name = node.name || node.type?.name;
        if ((name === "FencedCode" || name === "CodeBlock") && node.from === startPos) {
          found = { from: node.from, to: node.to };
        }
      }
    });
    return found;
  } catch {
    return null;
  }
}

export function wysiwyg(): Extension {
  return [wysiwygPlugin];
}
