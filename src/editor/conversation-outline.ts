import { zionIconHtml } from "../ui/icons";
import type { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

export type OutlineHeading = { level: number; title: string; line: number };
export type OutlineBlock = { role: string; startLine?: number; endLine?: number; from?: number; to?: number; preview?: string };
type OutlineNode = OutlineHeading & { id: string; children: OutlineNode[] };
export function emptyConversationDraftStart(state: EditorState, blocks: OutlineBlock[]) {
  const last = blocks.at(-1);
  if (!last || last.role !== "user") return null;
  const start = state.doc.line((last.startLine ?? 0) + 1).from;
  const body = state.doc.sliceString(start).replace(/^user /, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  return body ? null : start;
}
export const cleanOutlineTitle = (title: string) => title
  .replace(/\*\*(.*?)\*\*/g, "$1").replace(/_(.*?)_/g, "$1")
  .replace(/~~(.*?)~~/g, "$1").replace(/`(.*?)`/g, "$1");
export const outlineSlug = (title: string) => title.trim().toLowerCase()
  .replace(/[\s]+/g, "-").replace(/[^a-z0-9\u4e00-\u9fa5\-_]/g, "");

export function parseOutlineHeadings(lines: string[], startLine = 0, endLine = lines.length - 1): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  let fence: { token: string; length: number } | null = null;
  // Scan from the document start so a requested range inside a fence remains excluded.
  for (let i = 0; i <= Math.min(lines.length - 1, endLine); i++) {
    const text = String(lines[i] ?? "").replace(/^(?:user|assistant|system) /, "")
      .replace(/<!--[\s\S]*?-->/g, "").trimEnd();
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(text);
    if (marker) {
      if (!fence) fence = { token: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.token && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (fence || i < Math.max(0, startLine)) continue;
    const match = /^(#{1,6})\s+(.+)\s*$/.exec(text);
    if (match) headings.push({ level: match[1].length, title: cleanOutlineTitle(match[2].trim()), line: i });
  }
  return headings;
}

export function parseOutlineRoleBlocks(text: string, prefixes = ["user", "assistant", "system"]): OutlineBlock[] {
  const lines = text.split(/\r?\n/), blocks: OutlineBlock[] = [];
  let current: OutlineBlock | null = null, fence: { token: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const role = !fence ? prefixes.find(prefix => line.startsWith(prefix + " ")) : undefined;
    if (role || !current) {
      if (current) { current.endLine = i - 1; blocks.push(current); }
      current = { role: role || "user", startLine: i, endLine: i, preview: "" };
    }
    const body = (role ? line.slice(role.length + 1) : line).replace(/<!--[\s\S]*?-->/g, "").trim();
    current.endLine = i;
    if (!current.preview && body) current.preview = body.slice(0, 160);
    const marker = /^(`{3,}|~{3,})(.*)$/.exec(body);
    if (marker) {
      if (!fence) fence = { token: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.token && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

export function getConversationOutlineActiveIds(text: string, line: number, groupByRole: boolean, blocks: OutlineBlock[]) {
  const block = groupByRole ? blocks.find(block => line >= (block.startLine ?? 0) && line <= (block.endLine ?? block.startLine ?? 0)) : undefined;
  const headings = parseOutlineHeadings(text.split(/\r?\n/));
  const heading = headings.filter(heading => heading.line <= line && (!block ||
    heading.line >= (block.startLine ?? 0) && heading.line <= (block.endLine ?? block.startLine ?? 0))).at(-1);
  return {
    activeBlockId: block ? `role::${block.role.toLowerCase()}::${block.startLine ?? 0}` : null,
    activeHeadingId: heading ? `${outlineSlug(heading.title)}::L${heading.level}::${heading.line}${block ? `::B${block.startLine ?? 0}` : ""}` : null
  };
}

export function getConversationOutlineVisiblePosition(view: EditorView) {
  const doc = view.state.doc, cursorPos = view.state.selection.main.head;
  const cursorLine = doc.lineAt(cursorPos).number - 1;
  const topLine = doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number - 1;
  const bottomLine = doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop + view.scrollDOM.clientHeight).from).number - 1;
  const inView = cursorLine >= topLine && cursorLine <= bottomLine;
  const usedLine = inView ? cursorLine : topLine;
  return { usedLine, usedPos: inView ? cursorPos : doc.line(usedLine + 1).from, mode: inView ? "cursor" : "viewport" };
}

/** Native TOC rows shared by the workbench extension and the public reader. */
export function renderConversationOutline(list: HTMLElement, options: {
  text: string; blocks?: OutlineBlock[]; groupByRole: boolean;
  collapsed: Set<string>; allCollapsibleIds: Set<string>;
  activeHeadingId?: string | null; activeBlockId?: string | null;
  generatingBlockId?: string | null; lastGeneratedBlockId?: string | null;
  emptyText?: string; hideEmptyDraft?: boolean;
  onToggle: () => void; onNavigate: (line: number, id: string, kind: "heading" | "block") => void;
}) {
  const { collapsed, allCollapsibleIds } = options;
  list.replaceChildren(); allCollapsibleIds.clear();
  const lines = options.text.split(/\r?\n/);
  const headings = parseOutlineHeadings(lines);
  const buildTree = (headings: OutlineHeading[], blockStart?: number) => {
    const roots: OutlineNode[] = [], stack: OutlineNode[] = [];
    headings.forEach(heading => {
      const id = `${outlineSlug(heading.title)}::L${heading.level}::${heading.line}${blockStart == null ? "" : `::B${blockStart}`}`;
      const node = { ...heading, id, children: [] as OutlineNode[] };
      while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
      (stack.length ? stack[stack.length - 1].children : roots).push(node); stack.push(node);
    });
    const index = (nodes: OutlineNode[]) => nodes.forEach(node => {
      if (node.children.length) { allCollapsibleIds.add(node.id); index(node.children); }
    });
    index(roots);
    return roots;
  };
  const createRow = (id: string, kind: "heading" | "block", line: number, hasChildren: boolean, level = 0) => {
    const row = document.createElement("div");
    row.className = "toc-row"; row.dataset.tocId = id; row.dataset.tocKind = kind;
    row.style.cssText = `display:flex;align-items:center;padding:${kind === "block" ? 6 : 5}px 4px;gap:4px;cursor:pointer;`;
    if (kind === "heading") row.style.paddingLeft = `${level * 10}px`;
    row.tabIndex = 0; row.setAttribute("role", "button");
    const navigate = () => options.onNavigate(line, id, kind);
    row.onclick = navigate;
    row.onkeydown = event => {
      if (event.target === row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); navigate(); }
    };
    const left = document.createElement("div");
    left.style.cssText = "display:flex;align-items:center;justify-content:center;flex:0 0 12px;width:12px;";
    if (hasChildren) {
      const button = document.createElement("button"), folded = collapsed.has(id);
      button.type = "button"; button.innerHTML = zionIconHtml(folded ? "chevron-right" : "chevron-down", "", 14);
      button.style.cssText = "color:var(--ext-toc-fg,var(--fg));background:transparent;border:none;width:16px;height:18px;padding:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;opacity:0;transition:opacity 120ms ease;";
      button.title = folded ? "展开" : "收起";
      button.setAttribute("aria-label", folded ? "展开子目录" : "收起子目录");
      button.setAttribute("aria-expanded", String(!folded));
      button.onclick = event => {
        event.stopPropagation();
        if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
        options.onToggle();
      };
      row.onmouseenter = () => { button.style.opacity = "1"; };
      row.onmouseleave = () => { if (!row.contains(document.activeElement)) button.style.opacity = "0"; };
      row.addEventListener("focusin", () => { button.style.opacity = "1"; });
      left.appendChild(button);
    }
    const label = document.createElement("span");
    label.className = "toc-label";
    label.style.cssText = "font-size:13px;line-height:1.5;letter-spacing:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;margin-left:0;";
    const active = kind === "heading" ? options.activeHeadingId === id
      : options.activeBlockId === id && !options.activeHeadingId;
    if (active) {
      row.setAttribute("aria-current", "location");
      label.style.fontWeight = "600"; label.style.color = "var(--ext-toc-active-fg,var(--accent))";
    }
    row.append(left, label); list.appendChild(row);
    return label;
  };
  const renderNodes = (nodes: OutlineNode[], baseOffset = 0) => nodes.forEach(node => {
    createRow(node.id, "heading", node.line, !!node.children.length, node.level - 1 + baseOffset).textContent = node.title;
    if (!collapsed.has(node.id)) renderNodes(node.children, baseOffset);
  });
  const blocks = options.blocks || parseOutlineRoleBlocks(options.text);
  if (!options.groupByRole || !blocks.length) renderNodes(buildTree(headings));
  else blocks.forEach(block => {
    const start = block.startLine ?? 0, end = block.endLine ?? start;
    const body = lines.slice(start, end + 1).join("\n").replace(new RegExp(`^${block.role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `), "")
      .replace(/<!--[\s\S]*?-->/g, "").trim();
    const previewText = body.split("\n").map(line => line.trim()).find(Boolean)?.slice(0, 160) || "";
    if (options.hideEmptyDraft && block.role === "user" && !previewText && start === blocks.at(-1)?.startLine) return;
    const nodes = buildTree(headings.filter(heading => heading.line >= start && heading.line <= end), start);
    const id = `role::${block.role.toLowerCase()}::${start}`;
    if (nodes.length) allCollapsibleIds.add(id);
    const label = createRow(id, "block", start, !!nodes.length);
    label.style.display = "flex"; label.style.alignItems = "center"; label.style.justifyContent = "flex-start";
    label.title = `${block.role}: ${previewText || "(empty)"}`;
    const dotContainer = document.createElement("span");
    dotContainer.style.cssText = "display:inline-flex;align-items:center;justify-content:center;width:12px;height:16px;flex-shrink:0;margin-right:5px;";
    const generating = options.generatingBlockId === id;
    if (options.lastGeneratedBlockId === id) {
      dotContainer.innerHTML = zionIconHtml("chevron-right", "", 12);
      dotContainer.style.color = "var(--ext-toc-active-fg,var(--accent))"; dotContainer.title = "New answer here";
    } else {
      const dot = document.createElement("span");
      const colors: Record<string, string> = {
        user: "var(--ext-toc-role-user,var(--role-user-fg,#4caf50))",
        assistant: "var(--ext-toc-role-assistant,var(--role-assistant-fg,#2196f3))",
        system: "var(--ext-toc-role-system,var(--role-system-fg,#9e9e9e))"
      };
      dot.style.cssText = `display:inline-block;width:6px;height:6px;border-radius:50%;background:${colors[block.role.toLowerCase()] || colors.user};opacity:${generating ? .8 : .6};transition:opacity 120ms ease;`;
      if (generating) dot.style.animation = "toc-pulse 1.5s ease-in-out infinite";
      dotContainer.appendChild(dot);
    }
    if (generating) { label.style.color = "var(--ext-toc-active-fg,var(--accent))"; label.style.fontWeight = "500"; }
    const preview = document.createElement("span");
    preview.textContent = previewText || "(empty)";
    preview.style.cssText = "font-size:13px;line-height:1.5;letter-spacing:0;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;flex:1;";
    label.append(dotContainer, preview);
    if (!collapsed.has(id)) renderNodes(nodes, 1);
  });
  if (!list.children.length) {
    const empty = document.createElement("div");
    empty.textContent = options.emptyText || "未找到标题 (使用 #、##、### ...)";
    empty.style.cssText = "opacity:.8;font-size:13px;padding:8px 10px;"; list.appendChild(empty);
  }
}
