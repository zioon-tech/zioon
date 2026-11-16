import { Transaction } from "@codemirror/state";
import { appendUserMessageText, conversationLineRanges } from "./session-document-format.js";

// Legacy history may lack a next input row. Live documents append it through
// their durable completion projection, without moving the caret or viewport.
export function appendConversationDraft(view) {
  if (!view?.state?.doc || !view.dispatch) return null;
  const source = view.state.doc.toString();
  const lastRole = conversationLineRanges(source).filter(
    item => !item.literal && /^(system|user|assistant|tool)(?:\s|$)/.test(item.line)
  ).at(-1);
  if (!lastRole || /^user(?:\s|$)/.test(lastRole.line)) return null;
  if (!source.slice(lastRole.start)
    .replace(/^(system|assistant|tool)\s*/, "")
    .replace(/^<!--\s*zion-assistant:id=[^>]*-->\s*/, "").trim()) return null;
  const insert = appendUserMessageText(source, "");
  view.dispatch({
    changes: { from: source.length, insert },
    annotations: Transaction.addToHistory.of(false)
  });
  return true;
}
