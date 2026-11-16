import { parseMessages } from "./doc";
import { conversationLineRanges } from "./session-document-format.js";

type InputEditor = {
  getValue(): string;
  getCursor(): { line: number; ch: number };
  getSelection?(): string;
  getView?(): { state?: { selection?: { main?: { from: number; to: number } } } } | null;
};

function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown) => {
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}

/**
 * Capture the user's input synchronously, before any configuration/save await.
 * Positions belong to this adapter only; Runtime receives compiled messages.
 * The cursor line or exact selection determines this turn's boundary.
 */
export function captureDocumentInput(editor: InputEditor, {
  useSelection = false,
  contextMessages = [],
  annotations = {},
  submissionId = ""
}: {
  useSelection?: boolean;
  contextMessages?: any[];
  annotations?: Record<string, unknown>;
  submissionId?: string;
} = {}) {
  const documentText = String(editor.getValue());
  const lines = documentText.split("\n");
  const cursor = editor.getCursor();
  const line = Math.max(0, Math.min(lines.length - 1, Number(cursor.line) || 0));
  const lineStart = lines.slice(0, line).reduce((offset, text) => offset + text.length + 1, 0);
  let from = 0;
  let to = lineStart + lines[line].length;
  let content = documentText.slice(from, to);
  if (useSelection) {
    const range = editor.getView?.()?.state?.selection?.main;
    if (range && range.to > range.from) {
      from = Math.max(0, Math.min(documentText.length, range.from));
      to = Math.max(from, Math.min(documentText.length, range.to));
      content = documentText.slice(from, to);
    } else {
      const selected = String(editor.getSelection?.() || "");
      if (!selected) throw new Error("请先选中要发送的内容。");
      const cursorOffset = lineStart + Math.max(0, Math.min(lines[line].length, cursor.ch || 0));
      from = documentText.lastIndexOf(selected, cursorOffset);
      if (from < 0) throw new Error("选区已变化，请重新选择后发送。");
      to = from + selected.length;
      content = selected;
    }
  }
  const messages = [...contextMessages, ...parseMessages(content)];
  if (!messages.length || !content.trim()) throw new Error("没有可发送的内容。");
  if (!useSelection) {
    const lastRole = conversationLineRanges(content).filter(
      item => !item.literal && /^(system|user|assistant|tool)(?:\s|$)/.test(item.line)
    ).at(-1);
    const lastContent = lastRole
      ? content.slice(lastRole.start).replace(/^(system|user|assistant|tool)\s*/, "")
      : content;
    if (lastRole && /^user(?:\s|$)/.test(lastRole.line) && !lastContent.trim()) {
      throw new Error("请在当前位置输入消息后发送。");
    }
  }
  const insertionLine = documentText.slice(0, to).split("\n").length - 1;
  return frozenCopy({
    schemaVersion: 1,
    submissionId,
    scope: useSelection ? "selection" : "prefix",
    documentText,
    content,
    from,
    to,
    insertionOffset: to,
    cursor: { line: insertionLine, ch: to - (documentText.lastIndexOf("\n", to - 1) + 1) },
    messages,
    annotations
  });
}
