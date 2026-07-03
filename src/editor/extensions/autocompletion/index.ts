import { autocompletion, startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { completeChineseAndWords } from "./chinese-completion";
import { completeObsidianTags, completeObsidianWikiLinks } from "../obsidian/completion";
import { autocompleteTheme } from "./AutocompleteTheme";
import { Extension } from "@codemirror/state";

function shouldStartObsidianCompletion(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;

  const line = view.state.doc.lineAt(selection.head);
  const beforeCursor = line.text.slice(0, selection.head - line.from);

  if (/\[\[[^\]\n]{0,80}$/.test(beforeCursor)) {
    return true;
  }
  if (/^\s{0,3}#{1,6}\s/.test(line.text)) return false;
  return /(?:^|[\s([{])#[\p{L}\p{N}_/-]*$/u.test(beforeCursor);
}

const obsidianCompletionTrigger = EditorView.updateListener.of(update => {
  if (!update.docChanged) return;
  if (!shouldStartObsidianCompletion(update.view)) return;
  requestAnimationFrame(() => {
    if (shouldStartObsidianCompletion(update.view)) {
      startCompletion(update.view);
    }
  });
});

export function getAutocompletionExtension(options: { includeWordCompletion?: boolean } = {}): Extension {
  const includeWordCompletion = options.includeWordCompletion !== false;

  return [
    obsidianCompletionTrigger,
    autocompletion({
      defaultKeymap: false,
      closeOnBlur: true,
      activateOnTyping: true,
      activateOnTypingDelay: 0,
      maxRenderedOptions: 50,
      override: includeWordCompletion
        ? [completeObsidianWikiLinks, completeObsidianTags, completeChineseAndWords]
        : [completeObsidianWikiLinks, completeObsidianTags],
      icons: false
    }),
    autocompleteTheme
  ];
}
