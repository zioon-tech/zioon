import { autocompletion } from "@codemirror/autocomplete";
import { completeChineseAndWords } from "./chinese-completion";
import { autocompleteTheme } from "./AutocompleteTheme";
import { Extension } from "@codemirror/state";

export function getAutocompletionExtension(): Extension {
  return [
    autocompletion({
      defaultKeymap: false,
      closeOnBlur: true,
      maxRenderedOptions: 10,
      override: [completeChineseAndWords],
      icons: false
    }),
    autocompleteTheme
  ];
}
