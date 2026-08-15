import type { Text } from "@codemirror/state";
import type { EditorProxy } from "../types/zion";
import type { AssistantAnchor, ChatDocFinalizeResult, ChatDocInsertResult, ChatMessage, ChatMessagePart } from "./types";
import {
  assistantBlockHeaderText,
  getAssistantBlockIdFromHeader,
  sanitizeCardMarkerId,
  stripAssistantBlockIdComment
} from "./restore";

const ASSISTANT_ROLE_RE = /^\s*assistant\s+/;
const ANY_ROLE_RE = /^\s*(system|user|assistant|tool)\s+/;
const MESSAGE_ROLE_RE = /^(system|user|assistant)\s+(.*)$/;
const IMAGE_LINE_RE = /^!\[.*\]\((.*)\)$/;
const WIDGET_STUB_RE = /^(思考|Thinking)\s*<!--\s*zion-thinking:id=[^>\s]+\s*-->$/i;
const TOOL_WIDGET_STUB_RE = /^(?:调用|Call)\s+[^\n<]+(?:\s*<!--\s*zion-tool:id=[^>\s]+\s*-->)?$/i;

type StateLike = {
  set<T = unknown>(key: string, value: T): void;
};

type InsertAssistantBlockOptions = {
  sessionId: string;
  assistantBlockId: string;
  state?: StateLike;
  cursor?: { line: number; ch: number };
};

type AppendAssistantTokenOptions = {
  token: string;
  anchor?: AssistantAnchor | null;
  startLineHint?: number;
  moveSelectionToAssistant?: boolean;
};

type FinalizeAssistantBlockOptions = {
  anchor?: AssistantAnchor | null;
  startLineHint?: number;
  autoInsertUserPrompt?: boolean;
  autoFocusUserPrompt?: boolean;
};

type EnsureTrailingUserPromptOptions = {
  startLineHint?: number;
  autoInsertUserPrompt?: boolean;
};

function findAssistantHeadLine(lines: string[], startLineHint = 0, assistantBlockId?: string | null): number {
  const expectedId = sanitizeCardMarkerId(assistantBlockId);
  if (expectedId) {
    for (let i = 0; i < lines.length; i++) {
      if (getAssistantBlockIdFromHeader(lines[i]) === expectedId) return i;
    }
    return -1;
  }
  for (let i = Math.max(0, startLineHint); i < lines.length; i++) {
    if (ASSISTANT_ROLE_RE.test(lines[i])) return i;
  }
  for (let i = 0; i < lines.length; i++) {
    if (ASSISTANT_ROLE_RE.test(lines[i])) return i;
  }
  return -1;
}

function findAssistantBlockEndLine(lines: string[], assistantLine: number): number {
  if (assistantLine < 0) return -1;
  let endLine = assistantLine;
  for (let i = assistantLine + 1; i < lines.length; i++) {
    if (ANY_ROLE_RE.test(lines[i])) break;
    endLine = i;
  }
  return endLine;
}

function findAssistantHeadLineInDoc(
  doc: Text,
  startLineHint = 0,
  assistantBlockId?: string | null
): number {
  const expectedId = sanitizeCardMarkerId(assistantBlockId);
  const hintedLine = Math.max(0, Math.min(doc.lines - 1, startLineHint));
  const matches = (lineIndex: number): boolean => {
    const text = doc.line(lineIndex + 1).text;
    return expectedId
      ? getAssistantBlockIdFromHeader(text) === expectedId
      : ASSISTANT_ROLE_RE.test(text);
  };

  if (matches(hintedLine)) return hintedLine;
  if (expectedId) {
    for (let i = 0; i < doc.lines; i++) {
      if (i !== hintedLine && matches(i)) return i;
    }
    return -1;
  }
  for (let i = hintedLine + 1; i < doc.lines; i++) {
    if (matches(i)) return i;
  }
  for (let i = 0; i < hintedLine; i++) {
    if (matches(i)) return i;
  }
  return -1;
}

function findAssistantBlockEndLineInDoc(doc: Text, assistantLine: number): number {
  if (assistantLine < 0) return -1;
  let endLine = assistantLine;
  for (let i = assistantLine + 1; i < doc.lines; i++) {
    if (ANY_ROLE_RE.test(doc.line(i + 1).text)) break;
    endLine = i;
  }
  return endLine;
}

type TrailingUserPromptPlan =
  | { kind: "none"; userLine: null; focusCh: null }
  | { kind: "existing-user"; userLine: number; focusCh: number }
  | { kind: "replace-line"; userLine: number; focusCh: number; text: string }
  | { kind: "insert-before-line"; userLine: number; focusCh: number; text: string };

function planTrailingUserPrompt(
  lines: string[],
  blockEndLine: number,
  autoInsertUserPrompt: boolean
): TrailingUserPromptPlan {
  if (
    blockEndLine === lines.length - 1
    && blockEndLine >= 0
    && !String(lines[blockEndLine] || "").trim()
  ) {
    return { kind: "replace-line", userLine: blockEndLine, focusCh: 5, text: "user " };
  }
  const targetLine = blockEndLine + 1;
  const targetLineText = targetLine < lines.length ? String(lines[targetLine] || "") : "";
  const userMatch = /^\s*user\s+/.exec(targetLineText);
  if (userMatch) {
    return { kind: "existing-user", userLine: targetLine, focusCh: userMatch[0].length };
  }
  if (!autoInsertUserPrompt) {
    return { kind: "none", userLine: null, focusCh: null };
  }
  if (/^\s*(system|assistant|tool)\s+/.test(targetLineText)) {
    return { kind: "insert-before-line", userLine: targetLine, focusCh: 5, text: "user " };
  }
  const bareBody = targetLineText.replace(/^\s+/, "");
  if (!bareBody.trim()) {
    return { kind: "replace-line", userLine: targetLine, focusCh: 5, text: "user " };
  }
  const nextText = `user ${bareBody}`;
  return { kind: "replace-line", userLine: targetLine, focusCh: nextText.length, text: nextText };
}

export function ensureTrailingUserPromptInDocText(
  docText: string,
  opts: EnsureTrailingUserPromptOptions = {}
): { text: string; userLine: number | null; changed: boolean } {
  const lines = String(docText || "").split("\n");
  const assistantLine = findAssistantHeadLine(lines, Math.max(0, opts.startLineHint ?? 0));
  if (assistantLine === -1) {
    return { text: String(docText || ""), userLine: null, changed: false };
  }

  const blockEndLine = findAssistantBlockEndLine(lines, assistantLine);
  if (blockEndLine === -1) {
    return { text: String(docText || ""), userLine: null, changed: false };
  }

  let changed = false;
  const lastLineText = String(lines[blockEndLine] || "");
  if (blockEndLine === lines.length - 1 && lastLineText.trim() !== "") {
    lines.push("");
    changed = true;
  }

  const plan = planTrailingUserPrompt(lines, blockEndLine, !!opts.autoInsertUserPrompt);
  if (plan.kind === "none") {
    return { text: lines.join("\n"), userLine: null, changed };
  }
  if (plan.kind === "existing-user") {
    return { text: lines.join("\n"), userLine: plan.userLine, changed };
  }
  if (plan.kind === "insert-before-line") {
    lines.splice(plan.userLine, 0, plan.text);
    return { text: lines.join("\n"), userLine: plan.userLine, changed: true };
  }
  lines[plan.userLine] = plan.text;
  return { text: lines.join("\n"), userLine: plan.userLine, changed: true };
}

function buildMessageContent(textLines: string[], images: string[]): string | ChatMessagePart[] {
  const content: ChatMessagePart[] = [];
  if (textLines.length > 0) {
    content.push({ type: "text", text: textLines.join("\n").trim() });
  }
  for (const img of images) {
    if (img.startsWith("http") || img.startsWith("app://")) {
      content.push({ type: "image_url", image_url: { url: img } });
    }
  }
  if (content.length === 1 && content[0]?.type === "text") {
    return (content[0] as { type: "text"; text: string }).text;
  }
  return content;
}

function focusUserPromptNoScroll(editor: EditorProxy, line: number, ch: number): boolean {
  try {
    const view = editor.getView?.();
    const doc = view?.state?.doc;
    if (view && doc) {
      const ln = doc.line(Math.max(1, Math.min(doc.lines, line + 1)));
      const pos = ln.from + Math.max(0, Math.min(ln.length, ch));
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
      return true;
    }
  } catch {}
  try { editor.setCursor?.({ line, ch }); } catch {}
  try { editor.focus?.(); } catch {}
  return true;
}

function shouldRestoreFocusToEditor(editor: EditorProxy): boolean {
  try {
    const active = document.activeElement as HTMLElement | null;
    const view = editor.getView?.();
    const editorDom = view?.dom as HTMLElement | null;
    const panelId = (editor as any)?.panelId ? String((editor as any).panelId) : null;
    const panelRoot = panelId
      ? (document.querySelector(`[data-panel-id="${CSS.escape(panelId)}"]`) as HTMLElement | null)
      : null;
    if (!active || active === document.body || active === document.documentElement) return true;
    if (editorDom && editorDom.contains(active)) return true;
    if (panelRoot && panelRoot.contains(active)) return true;
    if (
      active.closest(".zion-bottompanel")
      || active.closest(".zion-auxbar")
      || active.closest(".zion-sidebar")
      || active.closest(".xterm")
      || active.closest(".xterm-screen")
      || active.closest("[data-workbench-location='bottompanel']")
      || active.closest("[data-workbench-location='auxiliary']")
      || active.closest("[data-workbench-location='sidebar']")
    ) {
      return false;
    }
    return false;
  } catch {
    return true;
  }
}

export function parseMessages(content: string): ChatMessage[] {
  const lines = String(content || "").split("\n");
  const messages: Array<{ role: string; content: string | ChatMessagePart[] }> = [];
  let currentRole = "user";
  let currentContent: string[] = [];
  let currentImages: string[] = [];

  for (const line of lines) {
    const roleMatch = line.match(MESSAGE_ROLE_RE);
    const imageMatch = line.match(IMAGE_LINE_RE);
    const trimmed = line.trim();

    if (WIDGET_STUB_RE.test(trimmed)) continue;
    if (TOOL_WIDGET_STUB_RE.test(trimmed)) continue;

    if (roleMatch) {
      const contentPart = roleMatch[1] === "assistant"
        ? stripAssistantBlockIdComment(roleMatch[2])
        : roleMatch[2];
      const body = contentPart.trim();
      if (/^(思考|Thinking)\s*<!--\s*zion-thinking:id=[^>\s]+\s*-->\s*$/i.test(body)) continue;
      if (/^(?:调用|Call)\s+[^\n<]+(?:\s*<!--\s*zion-tool:id=[^>\s]+\s*-->)?\s*$/i.test(body)) continue;
      if (currentContent.length > 0 || currentImages.length > 0) {
        messages.push({
          role: currentRole,
          content: buildMessageContent(currentContent, currentImages)
        });
        currentContent = [];
        currentImages = [];
      }
      currentRole = roleMatch[1];
      if (contentPart.trim()) currentContent.push(contentPart);
      continue;
    }

    if (imageMatch) {
      currentImages.push(imageMatch[1]);
      continue;
    }

    currentContent.push(line);
  }

  if (currentContent.length > 0 || currentImages.length > 0) {
    messages.push({
      role: currentRole,
      content: buildMessageContent(currentContent, currentImages)
    });
  }

  return messages;
}

export function insertAssistantBlock(editor: EditorProxy, opts: InsertAssistantBlockOptions): ChatDocInsertResult {
  const assistantBlockId = sanitizeCardMarkerId(opts.assistantBlockId);
  if (!assistantBlockId) return { anchor: null, insertLine: (opts.cursor || editor.getCursor()).line + 1 };
  const assistantHeader = assistantBlockHeaderText(assistantBlockId);
  const cursor = opts.cursor || editor.getCursor();
  const fullDoc = editor.getValue();
  const lines = fullDoc.split("\n");
  const insertLine = cursor.line + 1;
  let expectedHeadLine = insertLine;

  if (insertLine >= lines.length) {
    let targetLine = lines.length - 1;
    if (fullDoc.length > 0 && !fullDoc.endsWith("\n")) {
      editor.replaceRange("\n", { line: lines.length - 1, ch: lines[lines.length - 1].length });
      targetLine = lines.length;
    } else {
      targetLine = Math.max(0, lines.length - 1);
    }
    expectedHeadLine = targetLine;
    editor.replaceRange(assistantHeader, { line: targetLine, ch: 0 });
  } else {
    let hasContentBelow = false;
    for (let k = insertLine; k < lines.length; k++) {
      const t = lines[k].trim();
      if (!t) continue;
      if (/^(system|user|assistant|tool)\b/.test(t)) break;
      hasContentBelow = true;
      break;
    }

    const currentLineLength = lines[cursor.line].length;
    if (hasContentBelow) {
      editor.replaceRange(`\n${assistantHeader}\n\nuser `, { line: cursor.line, ch: currentLineLength });
    } else {
      editor.replaceRange(`\n${assistantHeader}`, { line: cursor.line, ch: currentLineLength });
    }
  }

  const docAfter = editor.getValue();
  const afterLines = docAfter.split("\n");
  const headLine = findAssistantHeadLine(afterLines, expectedHeadLine, assistantBlockId);
  if (headLine < 0) {
    return { anchor: null, insertLine };
  }

  let anchorPos = 0;
  for (let i = 0; i < headLine; i++) anchorPos += afterLines[i].length + 1;
  try {
    opts.state?.set(`chat.answerHeadLine.${opts.sessionId}`, headLine);
    opts.state?.set(`chat.answerAnchorPos.${opts.sessionId}`, anchorPos);
    opts.state?.set(`chat.assistantBlockId.${opts.sessionId}`, assistantBlockId);
  } catch {}

  return {
    anchor: {
      sessionId: opts.sessionId,
      assistantBlockId,
      headLine,
      anchorPos
    },
    insertLine
  };
}

export function appendAssistantToken(editor: EditorProxy, opts: AppendAssistantTokenOptions): boolean {
  try {
    const view = editor.getView?.();
    const doc = view?.state?.doc;
    if (view && doc) {
      const assistantLine = findAssistantHeadLineInDoc(
        doc,
        typeof opts.anchor?.headLine === "number"
          ? opts.anchor.headLine
          : Math.max(0, (opts.startLineHint ?? 0) - 1),
        opts.anchor?.assistantBlockId
      );
      if (assistantLine === -1) return false;
      const endLine = findAssistantBlockEndLineInDoc(doc, assistantLine);
      if (endLine === -1) return false;

      const headLine = doc.line(assistantLine + 1);
      const line = doc.line(endLine + 1);
      const from = line.to;
      const nextHead = from + opts.token.length;
      let followLatest = true;
      try {
        const sid = opts.anchor?.sessionId;
        if (sid) followLatest = (window as any).zion?.state?.get?.(`chat.followLatest.${sid}`) !== false;
      } catch {}
      const userHasSelection = !view.state.selection.main.empty;
      let userSelectionGestureActive = false;
      try {
        const selectionGestureUntil = Number((window as any).zion?.state?.get?.("editor.selectionGestureUntil") || 0);
        userSelectionGestureActive = selectionGestureUntil > Date.now();
      } catch {}
      const selectionAtAppendPoint = !userHasSelection && view.state.selection.main.head === from;
      const shouldPreserveUserSelection = userHasSelection || userSelectionGestureActive || !selectionAtAppendPoint;
      if (opts.anchor) {
        opts.anchor.headLine = assistantLine;
        opts.anchor.anchorPos = headLine.from;
      }
      view.dispatch({
        changes: { from, insert: opts.token },
          ...(followLatest && opts.moveSelectionToAssistant !== false && !shouldPreserveUserSelection
            ? { selection: { anchor: nextHead } }
            : {})
      });
      return true;
    }
  } catch {}

  const currentDoc = editor.getValue();
  const currentLines = currentDoc.split("\n");
  const assistantLine = findAssistantHeadLine(
    currentLines,
    typeof opts.anchor?.headLine === "number"
      ? opts.anchor.headLine
      : Math.max(0, (opts.startLineHint ?? 0) - 1),
    opts.anchor?.assistantBlockId
  );
  if (assistantLine === -1) return false;

  const endLine = findAssistantBlockEndLine(currentLines, assistantLine);
  if (endLine === -1) return false;
  const lastLineText = currentLines[endLine] || "";
  editor.replaceRange(opts.token, { line: endLine, ch: lastLineText.length });
  return true;
}

export function finalizeAssistantBlock(editor: EditorProxy, opts: FinalizeAssistantBlockOptions): ChatDocFinalizeResult {
  const currentDoc = editor.getValue();
  const currentLines = currentDoc.split("\n");
  const assistantLine = findAssistantHeadLine(
    currentLines,
    typeof opts.anchor?.headLine === "number"
      ? opts.anchor.headLine
      : Math.max(0, (opts.startLineHint ?? 0) - 1),
    opts.anchor?.assistantBlockId
  );
  if (assistantLine === -1) return { ok: false, userLine: null };

  const endLine = findAssistantBlockEndLine(currentLines, assistantLine);
  if (endLine === -1) return { ok: false, userLine: null };

  const nextLineText = currentLines[endLine + 1];
  const lastLineText = currentLines[endLine] || "";
  const shouldAddTrailingBlankLine = nextLineText === undefined && lastLineText.trim() !== "";
  if (shouldAddTrailingBlankLine) {
    try {
      editor.replaceRange("\n", { line: endLine, ch: lastLineText.length });
    } catch {}
  }

  const docNow = String(editor.getValue() || "");
  const linesNow = docNow.split("\n");
  const newAssistantLine = findAssistantHeadLine(
    linesNow,
    typeof opts.anchor?.headLine === "number"
      ? opts.anchor.headLine
      : Math.max(0, (opts.startLineHint ?? 0) - 1),
    opts.anchor?.assistantBlockId
  );
  if (newAssistantLine === -1) return { ok: true, userLine: null };

  const blockEndLine = findAssistantBlockEndLine(linesNow, newAssistantLine);
  if (blockEndLine === -1) return { ok: true, userLine: null };

  const plan = planTrailingUserPrompt(linesNow, blockEndLine, !!opts.autoInsertUserPrompt);
  if (plan.kind === "existing-user") {
    if (opts.autoFocusUserPrompt && shouldRestoreFocusToEditor(editor)) {
      focusUserPromptNoScroll(editor, plan.userLine, plan.focusCh);
    }
    return { ok: true, userLine: plan.userLine };
  }
  if (plan.kind === "none") {
    return { ok: true, userLine: null };
  }

  try {
    if (plan.kind === "insert-before-line") {
      editor.replaceRange(`${plan.text}\n`, { line: plan.userLine, ch: 0 }, { line: plan.userLine, ch: 0 });
    } else {
      editor.replaceRange(
        plan.text,
        { line: plan.userLine, ch: 0 },
        { line: plan.userLine, ch: String(linesNow[plan.userLine] || "").length }
      );
    }
    if (opts.autoFocusUserPrompt && shouldRestoreFocusToEditor(editor)) {
      focusUserPromptNoScroll(editor, plan.userLine, plan.focusCh);
    }
  } catch {}

  return { ok: true, userLine: plan.userLine };
}
