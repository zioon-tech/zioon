import { EditorView } from "@codemirror/view";

export const autocompleteTheme = EditorView.theme({
  "@keyframes cmAutocompleteFadeIn": {
    "from": { opacity: "0", transform: "translateY(4px)" },
    "to": { opacity: "1", transform: "translateY(0)" }
  },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    "&": {
      backgroundColor: "var(--panel, var(--bg, #1e1e1e))",
      border: "1px solid var(--border, #3c3c3c)",
      borderRadius: "var(--radius-lg, 8px)",
      boxShadow: "var(--elevation-3, 0 8px 24px rgba(0,0,0,0.32))",
      padding: "4px",
      fontFamily: "var(--font-sans, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)",
      fontSize: "13px",
      animation: "cmAutocompleteFadeIn 0.1s ease-out"
    },
    "& > ul": {
      fontFamily: "inherit",
      gap: "2px",
      maxHeight: "300px",
      overflowY: "auto",
      scrollbarColor: "var(--scrollbar-thumb, var(--border, #44475a)) transparent",
      scrollbarWidth: "thin"
    },
    "& > ul::-webkit-scrollbar": {
      width: "10px",
      height: "10px"
    },
    "& > ul::-webkit-scrollbar-track": {
      background: "transparent"
    },
    "& > ul::-webkit-scrollbar-thumb": {
      background: "transparent",
      borderRadius: "6px",
      border: "2px solid transparent",
      backgroundClip: "content-box",
      transition: "background .15s ease"
    },
    "& > ul:hover::-webkit-scrollbar-thumb": {
      background: "var(--scrollbar-thumb, var(--border, #44475a))",
      backgroundClip: "content-box"
    }
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "6px 8px",
    borderRadius: "var(--radius-md, 6px)",
    cursor: "pointer",
    color: "var(--fg, #cccccc)",
    transition: "background-color .1s ease",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    lineHeight: "1.4"
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li:hover": {
    backgroundColor: "var(--hover-bg, rgba(98,114,164,0.10))"
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--role-user-bg, rgba(98,114,164,0.18)) !important",
    color: "var(--fg, #cccccc)"
  },
  ":root[data-theme='light'] .cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--role-user-bg, rgba(59,130,246,0.15)) !important"
  },
  ".cm-completionLabel": {
    flex: "1",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis"
  },
  ".cm-completionDetail": {
    fontSize: "11px",
    opacity: "0.6",
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)",
    flex: "0 0 auto",
    marginLeft: "auto"
  },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    color: "var(--accent, #50fa7b)",
    fontWeight: "bold"
  },
  ":root[data-theme='light'] .cm-completionMatchedText": {
    color: "var(--accent, #007acc)"
  },
  ".cm-completionIcon": {
    display: "none" // Hide default icons for cleaner look, or style them if needed
  },
  // Info tooltip (docs)
  ".cm-tooltip.cm-completionInfo": {
    backgroundColor: "var(--panel, var(--bg, #1e1e1e))",
    border: "1px solid var(--border, #3c3c3c)",
    borderRadius: "var(--radius-lg, 8px)",
    padding: "8px 12px",
    boxShadow: "var(--elevation-3, 0 8px 24px rgba(0,0,0,0.32))",
    maxWidth: "300px",
    fontSize: "12px",
    lineHeight: "1.5",
    color: "var(--fg, #cccccc)",
    marginTop: "0",
    marginLeft: "8px"
  }
}, { dark: false }); // Applies to both, but we handle themes with selectors
