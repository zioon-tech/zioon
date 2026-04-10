import type { EditorProxy } from "../types/zion";
import type { AssistantAnchor, ChatDocInsertResult, ChatMessage, ChatMessagePart } from "./types";

const ASSISTANT_ROLE_RE = /^\s*assistant\s+/;
const ANY_ROLE_RE = /^\s*(system|user|assistant|tool)\s+/;
const MESSAGE_ROLE_RE = /^(system|user|assistant)\s+(.*)$/;
const IMAGE_LINE_RE = /^!\[.*\]\((.*)\)$/;
const WIDGET_STUB_RE = /^(思考|Thinking)$/i;
const TOOL_WIDGET_STUB_RE = /^(调用|Call)\s+\S+$/i;

type StateLike = {
  set<T = unknown>(key: string, value: T): void;
};

type InsertAssistantBlockOptions = {
  sessionId: string;
  state?: StateLike;
  cursor?: { line: number; ch: number };
};

type AppendAssistantTokenOptions = {
  token: string;
  anchor?: AssistantAnchor | null;
  startLineHint?: number;
};

type FinalizeAssistantBlockOptions = {
  anchor?: AssistantAnchor | null;
  startLineHint?: number;
  autoInsertUserPrompt?: boolean;
  autoFocusUserPrompt?: boolean;
};

function findAssistantHeadLine(lines: string[], startLineHint = 0): number {
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
      const body = roleMatch[2].trim();
      if (/^(思考|Thinking|调用|Call)\s*/i.test(body)) continue;
      if (currentContent.length > 0 || currentImages.length > 0) {
        messages.push({
          role: currentRole,
          content: buildMessageContent(currentContent, currentImages)
        });
        currentContent = [];
        currentImages = [];
      }
      currentRole = roleMatch[1];
      const contentPart = roleMatch[2];
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
  const cursor = opts.cursor || editor.getCursor();
  const fullDoc = editor.getValue();
  const lines = fullDoc.split("\n");
  const insertLine = cursor.line + 1;

  if (insertLine >= lines.length) {
    let targetLine = lines.length - 1;
    if (fullDoc.length > 0 && !fullDoc.endsWith("\n")) {
      editor.replaceRange("\n", { line: lines.length - 1, ch: lines[lines.length - 1].length });
      targetLine = lines.length;
    } else {
      targetLine = Math.max(0, lines.length - 1);
    }
    editor.replaceRange("assistant ", { line: targetLine, ch: 0 });
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
      editor.replaceRange("\nassistant \n\nuser ", { line: cursor.line, ch: currentLineLength });
    } else {
      editor.replaceRange("\nassistant ", { line: cursor.line, ch: currentLineLength });
    }
  }

  const docAfter = editor.getValue();
  const afterLines = docAfter.split("\n");
  const headLine = findAssistantHeadLine(afterLines, insertLine);
  if (headLine < 0) {
    return { anchor: null, insertLine };
  }

  let anchorPos = 0;
  for (let i = 0; i < headLine; i++) anchorPos += afterLines[i].length + 1;
  try {
    opts.state?.set(`chat.answerHeadLine.${opts.sessionId}`, headLine);
    opts.state?.set(`chat.answerAnchorPos.${opts.sessionId}`, anchorPos);
  } catch {}

  return {
    anchor: {
      sessionId: opts.sessionId,
      headLine,
      anchorPos
    },
    insertLine
  };
}

export function appendAssistantToken(editor: EditorProxy, opts: AppendAssistantTokenOptions): boolean {
  const currentDoc = editor.getValue();
  const currentLines = currentDoc.split("\n");
  const assistantLine = findAssistantHeadLine(
    currentLines,
    typeof opts.anchor?.headLine === "number"
      ? opts.anchor.headLine
      : Math.max(0, (opts.startLineHint ?? 0) - 1)
  );
  if (assistantLine === -1) return false;

  const endLine = findAssistantBlockEndLine(currentLines, assistantLine);
  if (endLine === -1) return false;

  const lastLineText = currentLines[endLine] || "";
  editor.replaceRange(opts.token, { line: endLine, ch: lastLineText.length });
  return true;
}

export function finalizeAssistantBlock(editor: EditorProxy, opts: FinalizeAssistantBlockOptions): boolean {
  const currentDoc = editor.getValue();
  const currentLines = currentDoc.split("\n");
  const assistantLine = findAssistantHeadLine(
    currentLines,
    typeof opts.anchor?.headLine === "number"
      ? opts.anchor.headLine
      : Math.max(0, (opts.startLineHint ?? 0) - 1)
  );
  if (assistantLine === -1) return false;

  const endLine = findAssistantBlockEndLine(currentLines, assistantLine);
  if (endLine === -1) return false;

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
      : Math.max(0, (opts.startLineHint ?? 0) - 1)
  );
  if (newAssistantLine === -1) return true;

  const blockEndLine = findAssistantBlockEndLine(linesNow, newAssistantLine);
  if (blockEndLine === -1) return true;

  const targetLine = blockEndLine + 1;
  const targetLineText = targetLine < linesNow.length ? linesNow[targetLine] : "";
  const isUser = /^\s*user\s+/.test(targetLineText);
  const isOtherRole = /^\s*(system|assistant|tool)\s+/.test(targetLineText);

  if (isUser) {
    if (opts.autoFocusUserPrompt) {
      const m = /^\s*user\s+/.exec(targetLineText);
      const ch = m ? m[0].length : 5;
      focusUserPromptNoScroll(editor, targetLine, ch);
    }
    return true;
  }

  if (isOtherRole || !opts.autoInsertUserPrompt) {
    return true;
  }

  if (targetLine >= linesNow.length) {
    const last = String(linesNow[blockEndLine] || "");
    if (last.trim() !== "") {
      try {
        editor.replaceRange("\n", { line: blockEndLine, ch: last.length });
      } catch {}
    }
  }

  try {
    editor.replaceRange(
      "user ",
      { line: targetLine, ch: 0 },
      { line: targetLine, ch: String(linesNow[targetLine] || "").length }
    );
    if (opts.autoFocusUserPrompt) {
      focusUserPromptNoScroll(editor, targetLine, 5);
    }
  } catch {}

  return true;
}
