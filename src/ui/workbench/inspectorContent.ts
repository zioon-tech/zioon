import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, foldGutter, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, StateEffect, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection
} from "@codemirror/view";
import { tags as cmTags } from "@lezer/highlight";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { selectionToolbarExtension } from "../../editor/extensions/selection-toolbar";

export type InspectorTextViewOptions = {
  content: string;
  filename: string;
  language?: string;
  editable?: boolean;
  lineWrapping?: boolean;
  extensions?: Extension[];
  selectionContext?: (view: EditorView) => Record<string, unknown>;
  onChange?: (content: string) => void;
};

const wrappingCompartments = new WeakMap<EditorView, Compartment>();

function languageFromFilename(name: string): string {
  const ext = String(name || "").toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    json: "json", md: "markdown", markdown: "markdown", py: "python",
    sh: "shell", bash: "shell", zsh: "shell", css: "css", html: "html",
    xml: "xml", yaml: "yaml", yml: "yaml", go: "go", rs: "rust",
    java: "java", kt: "kotlin", swift: "swift", rb: "ruby", php: "php", sql: "sql"
  };
  return map[ext] || "text";
}

function inspectorHighlightStyle(dark: boolean): HighlightStyle {
  const colors = dark
    ? { keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff", comment: "#8b949e", fn: "#d2a8ff", property: "#79c0ff", type: "#ffa657", tag: "#7ee787" }
    : { keyword: "#cf222e", string: "#0a3069", number: "#0550ae", comment: "#6e7781", fn: "#8250df", property: "#0550ae", type: "#953800", tag: "#116329" };
  return HighlightStyle.define([
    { tag: cmTags.keyword, color: colors.keyword },
    { tag: [cmTags.string, cmTags.special(cmTags.string)], color: colors.string },
    { tag: [cmTags.number, cmTags.bool, cmTags.null], color: colors.number },
    { tag: cmTags.comment, color: colors.comment, fontStyle: "italic" },
    { tag: [cmTags.function(cmTags.variableName), cmTags.function(cmTags.propertyName)], color: colors.fn },
    { tag: cmTags.propertyName, color: colors.property },
    { tag: [cmTags.typeName, cmTags.className], color: colors.type },
    { tag: cmTags.tagName, color: colors.tag }
  ]);
}

function initialLanguageExtensions(language: string, filename: string): Extension[] {
  const lang = language.toLowerCase();
  const name = filename.toLowerCase();
  if (lang === "json" || name.endsWith(".json")) return [json()];
  if (lang === "markdown" || name.endsWith(".md") || name.endsWith(".markdown")) {
    return [markdown({ codeLanguages: languages })];
  }
  return [];
}

async function loadLanguage(language: string, filename: string): Promise<Extension | null> {
  if (initialLanguageExtensions(language, filename).length) return null;
  const normalized = language.toLowerCase();
  const descriptor = languages.find((item: any) => {
    try {
      return item?.matchFilename?.(filename)
        || item?.alias?.some?.((alias: string) => alias.toLowerCase() === normalized)
        || String(item?.name || "").toLowerCase() === normalized;
    } catch {
      return false;
    }
  }) as any;
  if (!descriptor?.load) return null;
  try {
    return await descriptor.load();
  } catch {
    return null;
  }
}

export function createInspectorTextView(parent: HTMLElement, options: InspectorTextViewOptions): EditorView {
  const filename = String(options.filename || "");
  const language = String(options.language || languageFromFilename(filename));
  const editable = options.editable === true;
  parent.classList.toggle("zion-inspector-editor-nowrap", options.lineWrapping === false);
  const wrappingCompartment = new Compartment();
  const dark = document.documentElement.getAttribute("data-theme") !== "light";
  const extensions: Extension[] = [
    EditorState.readOnly.of(!editable),
    // Keep read-only previews focusable so CodeMirror owns and reports text selections.
    EditorView.editable.of(true),
    EditorView.contentAttributes.of({
      "aria-readonly": editable ? "false" : "true",
      spellcheck: "false"
    }),
    lineNumbers(),
    foldGutter(),
    bracketMatching(),
    indentOnInput(),
    highlightSpecialChars(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    rectangularSelection(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorState.phrases.of({
      Find: "查找",
      Replace: "替换",
      next: "↓",
      previous: "↑",
      all: "全部",
      "match case": "Aa",
      regexp: ".*",
      "by word": "词",
      replace: "换",
      "replace all": "全换",
      close: "关闭"
    }),
    wrappingCompartment.of(options.lineWrapping === false ? [] : EditorView.lineWrapping),
    Prec.high(keymap.of([
      ...(editable ? [indentWithTab, ...historyKeymap] : []),
      ...searchKeymap,
      ...defaultKeymap
    ])),
    syntaxHighlighting(inspectorHighlightStyle(dark), { fallback: true }),
    selectionToolbarExtension({
      showBuiltins: false,
      itemFilter: (item) => item.id === "comments.create",
      contextProvider: options.selectionContext
    }),
    EditorView.theme({
      "&": { height: "100%", backgroundColor: "var(--editor-bg)", color: "var(--fg)" },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        fontSize: "var(--editor-content-font-size, 13px)",
        lineHeight: "1.58",
        overflowX: "auto",
        scrollbarColor: "color-mix(in srgb, var(--fg) 22%, transparent) transparent"
      },
      ".cm-content": { padding: "12px 0 34px", caretColor: "var(--accent)" },
      ".cm-line": { padding: "1px 20px 1px 12px" },
      ".cm-gutters": {
        backgroundColor: "color-mix(in srgb, var(--editor-bg) 94%, var(--surface-panel))",
        borderRight: "1px solid color-mix(in srgb, var(--border) 18%, transparent)",
        color: "var(--dim)"
      },
      ".cm-lineNumbers .cm-gutterElement": {
        minWidth: "40px",
        padding: "1px 10px 1px 6px",
        color: "color-mix(in srgb, var(--fg) 36%, transparent)"
      },
      ".cm-foldGutter .cm-gutterElement": { padding: "1px 6px", color: "color-mix(in srgb, var(--fg) 34%, transparent)" },
      ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 5.5%, transparent)" },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)",
        color: "color-mix(in srgb, var(--fg) 82%, transparent)"
      },
      ".cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent) !important" },
      ".cm-searchMatch": { backgroundColor: "var(--search-match-bg)", outline: "1px solid var(--search-match-border)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--search-current-bg)", outlineColor: "var(--search-current-border)" },
      ".cm-panels-top": { borderBottom: "1px solid var(--surface-border-soft)", backgroundColor: "var(--surface-panel)" },
      ".cm-search": {
        position: "relative",
        display: "grid",
        boxSizing: "border-box",
        width: "100%",
        gridTemplateColumns: "minmax(80px, 1fr) 28px 28px 34px",
        gap: "5px",
        margin: "0",
        padding: "8px 52px 8px 8px",
        backgroundColor: "color-mix(in srgb, var(--surface-panel) 96%, var(--editor-bg))",
        color: "var(--fg)",
        border: "0",
        borderRadius: "0",
        boxShadow: "0 1px 0 color-mix(in srgb, var(--border) 14%, transparent)"
      },
      ".cm-search br": { display: "none" },
      ".cm-search input.cm-textfield": {
        boxSizing: "border-box",
        width: "100%",
        minWidth: "0",
        height: "26px",
        margin: "0",
        padding: "0 7px",
        border: "1px solid color-mix(in srgb, var(--border) 42%, transparent)",
        borderRadius: "6px",
        outline: "none",
        backgroundColor: "var(--editor-bg)",
        color: "var(--fg)",
        font: "12px var(--font-sans)"
      },
      ".cm-search input.cm-textfield:focus": { borderColor: "var(--accent)", boxShadow: "0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent)" },
      ".cm-search input[name=search]": { gridColumn: "1", gridRow: "1" },
      ".cm-search button": {
        boxSizing: "border-box",
        minWidth: "0",
        height: "26px",
        margin: "0",
        padding: "0 5px",
        border: "0",
        borderRadius: "6px",
        backgroundColor: "transparent",
        color: "var(--fg)",
        font: "11px var(--font-sans)",
        cursor: "pointer"
      },
      ".cm-search button:hover": { backgroundColor: "color-mix(in srgb, var(--fg) 7%, transparent)" },
      ".cm-search button[name=next]": { gridColumn: "2", gridRow: "1" },
      ".cm-search button[name=prev]": { gridColumn: "3", gridRow: "1" },
      ".cm-search button[name=select]": { gridColumn: "4", gridRow: "2" },
      ".cm-search label": { display: "inline-flex", alignItems: "center", gap: "4px", minWidth: "0", height: "22px", margin: "0", color: "var(--dim)", font: "11px var(--font-sans)", whiteSpace: "nowrap" },
      ".cm-search label:nth-of-type(1)": { gridColumn: "1", gridRow: "2" },
      ".cm-search label:nth-of-type(2)": { gridColumn: "2", gridRow: "2" },
      ".cm-search label:nth-of-type(3)": { gridColumn: "3", gridRow: "2" },
      ".cm-search label input": { width: "13px", height: "13px", margin: "0", accentColor: "var(--accent)" },
      ".cm-search input[name=replace]": { gridColumn: "1", gridRow: "3" },
      ".cm-search button[name=replace]": { gridColumn: "2", gridRow: "3" },
      ".cm-search button[name=replaceAll]": { gridColumn: "3 / span 2", gridRow: "3" },
      ".cm-search button[name=close]": { position: "absolute", top: "7px", right: "7px", width: "26px", padding: "0", fontSize: "16px" },
      ".cm-tooltip": {
        border: "1px solid var(--surface-border)",
        borderRadius: "8px",
        backgroundColor: "var(--surface-panel)",
        boxShadow: "var(--elevation-panel)"
      }
    }),
    ...initialLanguageExtensions(language, filename),
    ...(options.extensions || [])
  ];
  if (editable) {
    extensions.push(history());
    extensions.push(EditorView.updateListener.of((update) => {
      if (update.docChanged) options.onChange?.(update.state.doc.toString());
    }));
  }
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: options.content, extensions })
  });
  wrappingCompartments.set(view, wrappingCompartment);
  void loadLanguage(language, filename).then((extension) => {
    if (!extension) return;
    try {
      view.dispatch({ effects: StateEffect.appendConfig.of(extension) });
    } catch {}
  });
  return view;
}

export function openInspectorSearch(view: EditorView | null): boolean {
  return view ? openSearchPanel(view) : false;
}

export function setInspectorLineWrapping(view: EditorView | null, enabled: boolean): boolean {
  const compartment = view ? wrappingCompartments.get(view) : null;
  if (!view || !compartment) return false;
  view.dom.parentElement?.classList.toggle("zion-inspector-editor-nowrap", !enabled);
  view.dispatch({ effects: compartment.reconfigure(enabled ? EditorView.lineWrapping : []) });
  return true;
}

function safeHref(value: string): string {
  const href = String(value || "").trim();
  return /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(href) ? href : "#";
}

function safeImageSrc(value: string): string {
  const src = String(value || "").trim();
  return /^(https?:|data:image\/(?:png|jpe?g|gif|webp);|blob:|app:\/\/|\/|\.\/|\.\.\/)/i.test(src) ? src : "";
}

function appendChildren(target: HTMLElement | DocumentFragment, children: any[] | undefined): void {
  for (const child of children || []) target.appendChild(renderMarkdownNode(child));
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, children?: any[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  appendChildren(node, children);
  return node;
}

function renderTable(node: any): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "zion-inspector-markdown-table-wrap";
  const table = document.createElement("table");
  const rows = node.children || [];
  rows.forEach((row: any, rowIndex: number) => {
    const section = rowIndex === 0 ? document.createElement("thead") : document.createElement("tbody");
    const tr = document.createElement("tr");
    (row.children || []).forEach((cell: any, cellIndex: number) => {
      const td = document.createElement(rowIndex === 0 ? "th" : "td");
      const align = node.align?.[cellIndex];
      if (align) td.style.textAlign = align;
      appendChildren(td, cell.children);
      tr.appendChild(td);
    });
    section.appendChild(tr);
    table.appendChild(section);
  });
  wrap.appendChild(table);
  return wrap;
}

function renderMarkdownNode(node: any): Node {
  switch (node?.type) {
    case "root": {
      const fragment = document.createDocumentFragment();
      appendChildren(fragment, node.children);
      return fragment;
    }
    case "text":
      return document.createTextNode(String(node.value || ""));
    case "paragraph":
      return element("p", node.children);
    case "heading":
      return element(`h${Math.max(1, Math.min(6, Number(node.depth) || 1))}` as keyof HTMLElementTagNameMap, node.children);
    case "strong":
      return element("strong", node.children);
    case "emphasis":
      return element("em", node.children);
    case "delete":
      return element("del", node.children);
    case "inlineCode": {
      const code = document.createElement("code");
      code.textContent = String(node.value || "");
      return code;
    }
    case "code": {
      const pre = document.createElement("pre");
      if (node.lang) pre.dataset.language = String(node.lang);
      const code = document.createElement("code");
      code.textContent = String(node.value || "");
      pre.appendChild(code);
      return pre;
    }
    case "blockquote":
      return element("blockquote", node.children);
    case "list": {
      const list = element(node.ordered ? "ol" : "ul", node.children);
      if (node.start && node.start !== 1 && list instanceof HTMLOListElement) list.start = node.start;
      return list;
    }
    case "listItem": {
      const li = element("li", node.children);
      if (typeof node.checked === "boolean") {
        li.classList.add("zion-inspector-markdown-task");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.disabled = true;
        checkbox.checked = node.checked;
        li.prepend(checkbox);
      }
      return li;
    }
    case "thematicBreak":
      return document.createElement("hr");
    case "break":
      return document.createElement("br");
    case "link": {
      const anchor = element("a", node.children);
      anchor.href = safeHref(node.url);
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      if (node.title) anchor.title = String(node.title);
      return anchor;
    }
    case "image": {
      const src = safeImageSrc(node.url);
      if (!src) return document.createTextNode(String(node.alt || node.url || ""));
      const figure = document.createElement("figure");
      const image = document.createElement("img");
      image.src = src;
      image.alt = String(node.alt || "");
      image.loading = "lazy";
      if (node.title) image.title = String(node.title);
      figure.appendChild(image);
      return figure;
    }
    case "table":
      return renderTable(node);
    case "html":
      return document.createTextNode(String(node.value || ""));
    default: {
      if (Array.isArray(node?.children)) {
        const fragment = document.createDocumentFragment();
        appendChildren(fragment, node.children);
        return fragment;
      }
      return document.createTextNode(String(node?.value || ""));
    }
  }
}

function annotateInspectorMarkdownText(article: HTMLElement, content: string): void {
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    if (walker.currentNode instanceof Text && walker.currentNode.data) textNodes.push(walker.currentNode);
  }
  let cursor = 0;
  for (const textNode of textNodes) {
    const value = textNode.data;
    let from = content.indexOf(value, cursor);
    if (from < 0) from = content.indexOf(value);
    if (from < 0) continue;
    const span = document.createElement("span");
    span.className = "zion-inspector-markdown-source-text";
    span.dataset.sourceFrom = String(from);
    span.dataset.sourceTo = String(from + value.length);
    span.textContent = value;
    textNode.replaceWith(span);
    cursor = from + value.length;
  }
}

function findMarkdownSourceLeaf(node: Node | null, offset: number, preferEnd: boolean): HTMLElement | null {
  if (!node) return null;
  const parent = node instanceof HTMLElement ? node : node.parentElement;
  const direct = parent?.closest?.<HTMLElement>(".zion-inspector-markdown-source-text");
  if (direct) return direct;
  if (!(node instanceof Element)) return null;
  const children = Array.from(node.childNodes);
  const candidate = preferEnd
    ? children[Math.max(0, Math.min(children.length - 1, offset - 1))]
    : children[Math.max(0, Math.min(children.length - 1, offset))];
  if (candidate instanceof HTMLElement && candidate.matches(".zion-inspector-markdown-source-text")) return candidate;
  if (candidate instanceof Element) {
    const leaves = candidate.querySelectorAll<HTMLElement>(".zion-inspector-markdown-source-text");
    return preferEnd ? leaves[leaves.length - 1] || null : leaves[0] || null;
  }
  return null;
}

function markdownSourceOffset(node: Node, offset: number, preferEnd: boolean): number | null {
  const leaf = findMarkdownSourceLeaf(node, offset, preferEnd);
  if (!leaf) return null;
  const from = Number(leaf.dataset.sourceFrom);
  const to = Number(leaf.dataset.sourceTo);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (node instanceof Text && node.parentElement === leaf) {
    const localOffset = Math.max(0, Math.min(node.data.length, offset));
    return Math.min(to, from + localOffset);
  }
  return preferEnd ? to : from;
}

export type InspectorMarkdownSelection = {
  from: number;
  to: number;
  selectionText: string;
  rect: DOMRect;
};

export function getInspectorMarkdownSelection(
  article: HTMLElement,
  content: string,
  selection: Selection | null = document.getSelection()
): InspectorMarkdownSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount < 1) return null;
  const range = selection.getRangeAt(0);
  if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) return null;
  const start = markdownSourceOffset(range.startContainer, range.startOffset, false);
  const end = markdownSourceOffset(range.endContainer, range.endOffset, true);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const from = Math.max(0, Math.min(content.length, Math.min(start!, end!)));
  const to = Math.max(from, Math.min(content.length, Math.max(start!, end!)));
  const selectionText = content.slice(from, to);
  if (to <= from || !selectionText.trim()) return null;
  return { from, to, selectionText, rect: range.getBoundingClientRect() };
}

export type InspectorMarkdownCommentRange = {
  id: string;
  from: number;
  to: number;
  active?: boolean;
};

export function applyInspectorMarkdownCommentRanges(
  article: HTMLElement,
  ranges: InspectorMarkdownCommentRange[],
  onActivate?: (id: string) => void
): void {
  const sourceSpans = Array.from(article.querySelectorAll<HTMLElement>(".zion-inspector-markdown-source-text"));
  for (const span of sourceSpans) {
    const sourceFrom = Number(span.dataset.sourceFrom);
    const sourceTo = Number(span.dataset.sourceTo);
    if (!Number.isFinite(sourceFrom) || !Number.isFinite(sourceTo) || sourceTo <= sourceFrom) continue;
    const text = span.textContent || "";
    const matching = ranges.filter((range) => range.to > sourceFrom && range.from < sourceTo);
    if (!matching.length) {
      span.classList.remove("zion-comment-range", "is-active");
      span.removeAttribute("data-comment-id");
      span.onclick = null;
      continue;
    }
    const boundaries = new Set([sourceFrom, sourceTo]);
    for (const range of matching) {
      boundaries.add(Math.max(sourceFrom, Math.min(sourceTo, range.from)));
      boundaries.add(Math.max(sourceFrom, Math.min(sourceTo, range.to)));
    }
    const points = Array.from(boundaries).sort((a, b) => a - b);
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < points.length - 1; index += 1) {
      const from = points[index];
      const to = points[index + 1];
      if (to <= from) continue;
      const segment = document.createElement("span");
      segment.className = "zion-inspector-markdown-source-text";
      segment.dataset.sourceFrom = String(from);
      segment.dataset.sourceTo = String(to);
      segment.textContent = text.slice(from - sourceFrom, to - sourceFrom);
      const comments = matching.filter((range) => range.to > from && range.from < to);
      if (comments.length) {
        const primary = comments.find((range) => range.active) || comments[0];
        segment.classList.add("zion-comment-range");
        if (comments.some((range) => range.active)) segment.classList.add("is-active");
        segment.dataset.commentId = primary.id;
        segment.title = "打开评论";
        segment.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          onActivate?.(primary.id);
        };
      }
      fragment.appendChild(segment);
    }
    span.replaceWith(fragment);
  }
}

export function createInspectorMarkdownPreviewView(
  article: HTMLElement,
  scroller: HTMLElement,
  content: string
): any {
  let state = EditorState.create({ doc: String(content || "") });
  const getSourceSpans = () =>
    Array.from(article.querySelectorAll<HTMLElement>(".zion-inspector-markdown-source-text[data-source-from][data-source-to]"));
  const getSpanAt = (position: number) => {
    const spans = getSourceSpans();
    const pos = Math.max(0, Math.min(state.doc.length, Number(position) || 0));
    return spans.find((span) => Number(span.dataset.sourceFrom) <= pos && Number(span.dataset.sourceTo) >= pos)
      || spans.find((span) => Number(span.dataset.sourceFrom) >= pos)
      || spans[spans.length - 1]
      || null;
  };
  const getBlockAt = (position: number) => {
    const span = getSpanAt(position);
    if (!span) return null;
    const rect = span.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const top = Number(rect.top) - Number(scrollerRect.top) + Number(scroller.scrollTop || 0);
    const height = Math.max(1, Number(rect.height) || 1);
    return { from: position, to: position, top, bottom: top + height, height };
  };
  const view = {
    sourceViewKind: "preview",
    dom: article,
    contentDOM: article,
    scrollDOM: scroller,
    get state() {
      return state;
    },
    get viewport() {
      const spans = getSourceSpans();
      if (!spans.length) return { from: 0, to: state.doc.length };
      const scrollerRect = scroller.getBoundingClientRect();
      const visible = spans.filter((span) => {
        const rect = span.getBoundingClientRect();
        return rect.bottom >= scrollerRect.top && rect.top <= scrollerRect.bottom;
      });
      const first = visible[0] || spans[0];
      const last = visible[visible.length - 1] || spans[spans.length - 1];
      return {
        from: Math.max(0, Number(first.dataset.sourceFrom) || 0),
        to: Math.max(0, Number(last.dataset.sourceTo) || state.doc.length)
      };
    },
    lineBlockAt(position: number) {
      return getBlockAt(position);
    },
    coordsAtPos(position: number) {
      const span = getSpanAt(position);
      return span?.getBoundingClientRect?.() || null;
    },
    dispatch(spec: any) {
      try { state = state.update(spec).state; } catch {}
      if (!spec?.scrollIntoView) return;
      const block = getBlockAt(state.selection.main.head);
      if (!block) return;
      const targetTop = Math.max(0, block.top - Math.max(24, Math.floor((scroller.clientHeight || 0) * 0.22)));
      if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top: targetTop, behavior: "auto" });
      else scroller.scrollTop = targetTop;
    },
    focus() {
      article.focus?.({ preventScroll: true });
    }
  };
  return view;
}

export function renderInspectorMarkdown(parent: HTMLElement, content: string): HTMLElement {
  const article = document.createElement("article");
  article.className = "zion-inspector-markdown";
  article.tabIndex = -1;
  const tree = fromMarkdown(String(content || ""), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()]
  });
  article.appendChild(renderMarkdownNode(tree));
  annotateInspectorMarkdownText(article, String(content || ""));
  article.addEventListener("click", (event) => {
    const anchor = (event.target as HTMLElement | null)?.closest?.("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href") || "";
    if (href === "#") event.preventDefault();
  });
  parent.appendChild(article);
  return article;
}
