import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { findAssistantBlockEndOffsetById } from "../../../src/chat/restore";
import { renderMarkdownInto } from "../../../src/chat/markdown-dom.js";
import {
  isContinuationBoundaryLine
} from "../../../src/chat/session-document-format.js";

export const setPendingAssistant = StateEffect.define();
export const clearPendingAssistant = StateEffect.define();

function continuationBoundaryDecorations(doc) {
  const ranges = [];
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber);
    if (!isContinuationBoundaryLine(line.text)) continue;
    ranges.push(Decoration.replace({}).range(line.from, line.to));
  }
  return Decoration.set(ranges, true);
}

export const continuationBoundaryField = StateField.define({
  create(state) {
    return continuationBoundaryDecorations(state.doc);
  },
  update(value, transaction) {
    return transaction.docChanged
      ? continuationBoundaryDecorations(transaction.state.doc)
      : value.map(transaction.changes);
  },
  provide(field) {
    return EditorView.decorations.from(field);
  }
});

function renderPendingContent(element, text, status = "", plainText = false) {
  const content = element.querySelector(".zion-pending-assistant-markdown");
  if (!(content instanceof HTMLElement)) return false;
  element.classList.toggle("is-status", !!status);
  element.classList.toggle("is-plain-stream", plainText && !status);
  content.classList.toggle("is-status-indicator", !!status);
  if (status) {
    element.setAttribute("role", "status");
    element.setAttribute("aria-label", status);
    content.textContent = "…";
    return true;
  }
  element.removeAttribute("role");
  element.removeAttribute("aria-label");
  if (plainText) {
    content.textContent = String(text || "");
    return true;
  }
  try {
    renderMarkdownInto(content, text);
  } catch {
    content.textContent = String(text || "");
  }
  return true;
}

function isCollapsedOriginRect(rect) {
  if (!rect) return true;
  const top = Number(rect.top);
  const bottom = Number(rect.bottom);
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return true;
  const left = Number.isFinite(Number(rect.left)) ? Number(rect.left) : 0;
  const right = Number.isFinite(Number(rect.right)) ? Number(rect.right) : 0;
  const width = Number.isFinite(Number(rect.width)) ? Number(rect.width) : Math.abs(right - left);
  const height = Number.isFinite(Number(rect.height)) ? Number(rect.height) : Math.abs(bottom - top);
  return top === 0
    && bottom === 0
    && left === 0
    && right === 0
    && width === 0
    && height === 0;
}

class PendingAssistantWidget extends WidgetType {
  constructor(entry) {
    super();
    this.entry = entry;
  }

  eq(other) {
    return other.entry.runId === this.entry.runId
      && other.entry.text === this.entry.text
      && other.entry.status === this.entry.status
      && other.entry.plainText === this.entry.plainText;
  }

  toDOM() {
    const element = document.createElement("span");
    element.className = "zion-pending-assistant-output";
    element.dataset.runId = this.entry.runId;
    const content = document.createElement("span");
    content.className = "zion-pending-assistant-markdown";
    const tail = document.createElement("span");
    tail.className = "zion-pending-assistant-tail";
    tail.setAttribute("aria-hidden", "true");
    element.append(content, tail);
    renderPendingContent(element, this.entry.text, this.entry.status, this.entry.plainText);
    return element;
  }

  updateDOM(element) {
    if (!(element instanceof HTMLElement)) return false;
    element.dataset.runId = this.entry.runId;
    return renderPendingContent(element, this.entry.text, this.entry.status, this.entry.plainText);
  }

  ignoreEvent() {
    return false;
  }
}

export function revealPendingAssistantInView(view, {
  runId = "",
  sessionId = "",
  margin = 24,
  preserveVisible = false
} = {}) {
  const pending = Array.from(
    view?.dom?.querySelectorAll?.(".zion-pending-assistant-output") || []
  ).filter((element) =>
    !runId || String(element?.dataset?.runId || "") === String(runId)
  ).at(-1);
  const target = pending?.querySelector?.(".zion-pending-assistant-tail")
    || pending;
  const scrollDOM = view?.scrollDOM;
  let targetRect = target?.getBoundingClientRect?.();
  const pendingRect = target !== pending
    ? pending?.getBoundingClientRect?.()
    : null;
  const tailRectCollapsedAtOrigin = isCollapsedOriginRect(targetRect);
  if (tailRectCollapsedAtOrigin && !isCollapsedOriginRect(pendingRect)) {
    targetRect = pendingRect;
  }
  const rawViewportRect = scrollDOM?.getBoundingClientRect?.();
  if (!scrollDOM || !targetRect) {
    return false;
  }
  const viewportRect = rawViewportRect
    && rawViewportRect.bottom > rawViewportRect.top
    ? rawViewportRect
    : {
        top: 0,
        bottom: Math.max(0, Number(scrollDOM.clientHeight) || 0)
      };
  const safeMargin = Math.max(0, Number(margin) || 0);
  if (preserveVisible && isCollapsedOriginRect(targetRect)) {
    // The empty tail can report a synthetic 0,0 rect before layout catches up.
    // Treat that as "not measurable yet" during submit preservation, not as
    // a real target above the viewport.
    return true;
  }
  if (
    preserveVisible
    && targetRect.top >= viewportRect.top
    && targetRect.bottom <= viewportRect.bottom
  ) {
    return true;
  }
  let nextScrollTop = null;
  if (targetRect.bottom > viewportRect.bottom - safeMargin) {
    nextScrollTop = scrollDOM.scrollTop
      + targetRect.bottom
      - (viewportRect.bottom - safeMargin);
  } else if (targetRect.top < viewportRect.top + safeMargin) {
    nextScrollTop = scrollDOM.scrollTop
      + targetRect.top
      - (viewportRect.top + safeMargin);
  }
  if (nextScrollTop == null) return true;
  const maxScrollTop = Math.max(
    0,
    Number(scrollDOM.scrollHeight || 0) - Number(scrollDOM.clientHeight || 0)
  );
  const bounded = Math.max(
    0,
    maxScrollTop > 0 ? Math.min(maxScrollTop, nextScrollTop) : nextScrollTop
  );
  if (Math.abs(Number(scrollDOM.scrollTop || 0) - bounded) < 1) return true;
  try {
    if (sessionId) {
      window.zion?.state?.set?.(
        `chat.followSuppressUntil.${sessionId}`,
        Date.now() + 160
      );
    }
    scrollDOM.__zionProgrammaticScrollUntil = Math.max(
      Number(scrollDOM.__zionProgrammaticScrollUntil) || 0,
      Date.now() + 160
    );
  } catch {}
  scrollDOM.scrollTop = bounded;
  return true;
}

function decorationsFor(state, entries) {
  const source = state.doc.toString();
  const ranges = [];
  for (const entry of entries.values()) {
    if (!entry.text && !entry.status) continue;
    const blockEnd = findAssistantBlockEndOffsetById(
      source,
      entry.assistantBlockId
    );
    const fallbackOffset = entry.fallbackOffset != null
      && entry.fallbackOffset !== ""
      && Number.isFinite(Number(entry.fallbackOffset))
      ? Number(entry.fallbackOffset)
      : state.doc.length;
    const position = blockEnd == null ? fallbackOffset : blockEnd;
    ranges.push(Decoration.widget({
      widget: new PendingAssistantWidget(entry),
      side: 1
    }).range(Math.max(0, Math.min(state.doc.length, position))));
  }
  ranges.sort((left, right) => left.from - right.from);
  return Decoration.set(ranges, true);
}

export const pendingAssistantField = StateField.define({
  create() {
    return {
      entries: new Map(),
      decorations: Decoration.none
    };
  },
  update(value, transaction) {
    let entries = value.entries;
    let changed = transaction.docChanged;
    for (const effect of transaction.effects) {
      if (effect.is(setPendingAssistant)) {
        if (entries === value.entries) entries = new Map(entries);
        entries.set(effect.value.runId, effect.value);
        changed = true;
      }
      if (effect.is(clearPendingAssistant)) {
        if (entries === value.entries) entries = new Map(entries);
        entries.delete(effect.value);
        changed = true;
      }
    }
    return {
      entries,
      decorations: changed
        ? decorationsFor(transaction.state, entries)
        : value.decorations.map(transaction.changes)
    };
  },
  provide(field) {
    return EditorView.decorations.from(field, (value) => value.decorations);
  }
});

export const pendingAssistantTheme = EditorView.baseTheme({
  ".zion-pending-assistant-output": {
    whiteSpace: "normal",
    overflowWrap: "anywhere"
  },
  ".zion-pending-assistant-output.is-status": {
    display: "inline-block",
    padding: "0 2px",
    color: "var(--muted, #687078)",
    fontSize: "15px",
    fontStyle: "normal",
    lineHeight: "1"
  },
  ".zion-pending-assistant-output.is-status .zion-pending-assistant-tail": {
    display: "none"
  },
  ".zion-pending-assistant-output.is-plain-stream .zion-pending-assistant-markdown": {
    whiteSpace: "pre-wrap"
  },
  ".zion-pending-assistant-markdown": {
    display: "inline"
  },
  ".zion-pending-markdown-paragraph": {
    display: "block",
    margin: "0 0 0.7em"
  },
  ".zion-pending-markdown-paragraph:first-child": {
    display: "inline",
    margin: "0"
  },
  ".zion-pending-markdown-heading": {
    display: "block",
    margin: "0.65em 0 0.3em",
    fontWeight: "650"
  },
  ".zion-pending-markdown-heading.is-h1": {
    fontSize: "1.35em"
  },
  ".zion-pending-markdown-heading.is-h2": {
    fontSize: "1.2em"
  },
  ".zion-pending-markdown-heading.is-h3": {
    fontSize: "1.08em"
  },
  ".zion-pending-assistant-markdown pre": {
    display: "block",
    margin: "0.6em 0",
    padding: "8px 10px",
    overflowX: "auto",
    borderRadius: "6px",
    background: "color-mix(in srgb, var(--fg) 7%, transparent)"
  },
  ".zion-pending-assistant-markdown code": {
    fontFamily: "var(--font-mono)"
  },
  ".zion-pending-assistant-markdown :not(pre) > code": {
    padding: "1px 4px",
    borderRadius: "3px",
    background: "color-mix(in srgb, var(--fg) 8%, transparent)"
  },
  ".zion-pending-assistant-markdown ul, .zion-pending-assistant-markdown ol": {
    margin: "0.5em 0",
    paddingLeft: "1.5em"
  },
  ".zion-pending-assistant-markdown blockquote": {
    display: "block",
    margin: "0.5em 0",
    paddingLeft: "0.8em",
    borderLeft: "3px solid var(--border)"
  },
  ".zion-pending-assistant-markdown a": {
    color: "var(--accent)"
  },
  ".zion-pending-assistant-tail": {
    display: "inline-block",
    width: "1px",
    height: "1em",
    verticalAlign: "text-bottom",
    pointerEvents: "none"
  }
});

export function pendingAssistantExtension() {
  return [
    continuationBoundaryField,
    pendingAssistantField,
    pendingAssistantTheme
  ];
}
