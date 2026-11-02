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
const absoluteLocalPathRoot = String.raw`\/(?:Users|Volumes|Applications|Library|System|private|tmp|var|opt|home|workspace)\/`;
const localPathRoot = `(?:${absoluteLocalPathRoot}|~\\/)`;
const unquotedLocalPath = `${localPathRoot}[^\\s<>"'\`]+`;
const quotedLocalPath = `(?:"(?:file:\\/\\/\\/[^"\\r\\n]+|${localPathRoot}[^"\\r\\n]+)"|'(?:file:\\/\\/\\/[^'\\r\\n]+|${localPathRoot}[^'\\r\\n]+)'|\`(?:file:\\/\\/\\/[^\`\\r\\n]+|${localPathRoot}[^\`\\r\\n]+)\`)`;
const linkRegex = new RegExp(`(?:${quotedLocalPath}|https?:\\/\\/[^\\s<>"'\`]+|file:\\/\\/\\/[^\\s<>"'\`]+|${unquotedLocalPath})`, "g");

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
  const text = String(value || "").trim();
  const quote = text[0];
  const unwrapped = text.length >= 2
    && ((quote === `"` && text.endsWith(`"`)) || (quote === `'` && text.endsWith(`'`)) || (quote === "`" && text.endsWith("`")))
    ? text.slice(1, -1)
    : text;
  return unwrapped
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
  return text.startsWith("/") || text.startsWith("~/") ? text : null;
}

function getLinkContextPayload(target: HTMLElement): { sessionId?: string; panelId?: string } {
  const host = target.closest("[data-session-id], [data-panel-id]") as HTMLElement | null;
  const panelHost = target.closest("[data-panel-id]") as HTMLElement | null;
  const sessionId = host?.getAttribute("data-session-id") || "";
  const panelId = host?.getAttribute("data-panel-id") || panelHost?.getAttribute("data-panel-id") || "";
  return {
    sessionId: sessionId || undefined,
    panelId: panelId || undefined
  };
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
          const contextPayload = getLinkContextPayload(target);
          if (localPath) {
            let handled = false;
            try {
              const result = window.zion?.commands?.executeCommand?.("tools.context.openFilePreview", {
                path: localPath,
                  ...contextPayload
              });
              handled = result !== false;
            } catch {}
            if (!handled) {
              try {
                window.zion?.commands?.executeCommand?.("tools.files.revealPath", {
                  path: localPath,
                    open: true
                });
              } catch {}
            }
            return;
          }
          const url = stripTrailingPunctuation(raw);
          if (url) {
            try {
              window.zion?.commands?.executeCommand?.("tools.context.addResource", {
                kind: "url",
                url,
                label: url,
                source: "link-click",
                ...contextPayload
              });
            } catch {}
              let handled = false;
              try {
                const result = window.zion?.commands?.executeCommand?.("tools.context.openUrlPreview", {
                  url,
                  ...contextPayload
                });
                handled = result === true;
              } catch {}
              if (!handled) window.open(url, "_blank", "noopener,noreferrer");
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
