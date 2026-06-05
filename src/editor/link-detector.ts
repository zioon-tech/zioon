import {
  EditorView,
  ViewPlugin,
  Decoration,
  DecorationSet,
  ViewUpdate,
  MatchDecorator
} from "@codemirror/view";

// Regex to find web URLs and common local file paths.
// Keep this conservative to avoid turning ordinary markdown fragments into links.
const linkRegex = /(?:https?:\/\/[^\s<>"'`]+|file:\/\/\/[^\s<>"'`]+|\/(?:Users|Volumes|private|tmp|var|opt|Applications|home|workspace)\/[^\s<>"'`]+)/g;

const linkDecoration = Decoration.mark({
  class: "cm-detected-link",
  attributes: {
    // We add a data attribute to identify it easily if needed, 
    // though the class is usually enough.
    "data-link-target": "true"
  }
});

const linkMatcher = new MatchDecorator({
  regexp: linkRegex,
  decoration: () => linkDecoration,
});

function stripTrailingPunctuation(value: string): string {
  return String(value || "")
    .replace(/#L\d+(?:-L?\d+)?$/i, "")
    .replace(/[.,:;"')\]}]+$/g, "");
}

function localPathFromLink(value: string): string | null {
  const text = stripTrailingPunctuation(value).trim();
  if (!text) return null;
  if (text.startsWith("file:///")) {
    try {
      return decodeURIComponent(text.replace(/^file:\/\//, ""));
    } catch {
      return text.replace(/^file:\/\//, "");
    }
  }
  return text.startsWith("/") ? text : null;
}

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
      mousedown: (e) => {
        // Requirement: Cmd+Click (or Ctrl+Click on non-Mac)
        const isModifierDown = e.metaKey || e.ctrlKey;
        if (!isModifierDown) return;
        
        // Only left click
        if (e.button !== 0) return;

        const target = e.target as HTMLElement;
        const linkElement = target.closest(".cm-detected-link");
        
        if (linkElement) {
          e.preventDefault();
          const raw = linkElement.textContent || "";
          const localPath = localPathFromLink(raw);
          if (localPath) {
            try {
              window.zion?.commands?.executeCommand?.("tools.files.revealPath", {
                path: localPath,
                open: true
              });
            } catch {}
            return;
          }
          const url = stripTrailingPunctuation(raw);
          if (url) {
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
    textDecoration: "none",
    cursor: "pointer"
  }
});
