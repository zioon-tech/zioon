import {
  EditorView,
  ViewPlugin,
  Decoration,
  DecorationSet,
  ViewUpdate,
  MatchDecorator
} from "@codemirror/view";

// Regex to find URLs.
// Using a regex with negative lookbehind to exclude trailing punctuation.
// This matches http/https URLs but avoids including characters like . , ) ] at the end.
const urlRegex = /https?:\/\/[^\s]+(?<![.,:;"'\])])/g;

const linkDecoration = Decoration.mark({
  class: "cm-detected-link",
  attributes: {
    // We add a data attribute to identify it easily if needed, 
    // though the class is usually enough.
    "data-link-target": "true"
  }
});

const linkMatcher = new MatchDecorator({
  regexp: urlRegex,
  decoration: (match) => linkDecoration,
});

export const linkDetector = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = linkMatcher.createDeco(view);
    }

    update(update: ViewUpdate) {
      this.decorations = linkMatcher.updateDeco(update, this.decorations);
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown: (e, view) => {
        // Requirement: Cmd+Click (or Ctrl+Click on non-Mac)
        const isModifierDown = e.metaKey || e.ctrlKey;
        if (!isModifierDown) return;
        
        // Only left click
        if (e.button !== 0) return;

        const target = e.target as HTMLElement;
        const linkElement = target.closest(".cm-detected-link");
        
        if (linkElement) {
          e.preventDefault();
          const url = linkElement.textContent;
          if (url) {
            // Valid click on a link
            window.open(url, "_blank");
          }
        }
      }
    }
  }
);

// Add some basic styles for the link
export const linkStyles = EditorView.baseTheme({
  ".cm-detected-link": {
    textDecoration: "underline",
    cursor: "pointer"
  }
});
