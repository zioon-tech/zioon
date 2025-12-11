# ADR-2024-08-08 — WYSIWYG Diagrams (Mermaid/UML)

Status: Accepted
Authors: Zion Team
Context date: 2024-08-08

1) Decision
- Implement Mermaid/UML fenced-code diagram rendering inside core WYSIWYG (src/editor/wysiwyg.ts) as a block widget.
- Detect ```mermaid and ```uml fences; when not actively editing lines in the block, replace the block with a diagram widget.
- Keep code-fence styling for other languages; do not cross-line replace; respect active-line editing stability.

2) Rationale
- Current extension API (editor.registerDecorator) intentionally does not expose CM6 internals. Heavy visual rendering requires a ViewPlugin/DecorationSet to remain performant and stable.
- Diagrams are part of the Markdown live preview hot path; making them core avoids fragile DOM manipulations from extensions.
- We expect frequent renderer changes; core implementation is modular via a dedicated DiagramWidget and fence pre-scan. Future switch to alternative renderers is localized and low-risk.

3) Consequences
- Add dependency: mermaid.
- Theme-aware rendering based on data-theme (light/dark).
- Active-line safety: if any line in the block is active, do not render; keep raw text visible for editing.
- Future work: consider opening a registerVisualExtension(ext: CM6 Extension) hook once stability/perf permits, allowing third-party visual modules to plug in.

4) Implementation notes
- Pre-scan fences with info string to build blocks (open/close positions, content, hasActive).
- For mermaid/uml, replace first visible line with DiagramWidget, hide the rest; otherwise apply code-fence line styling.
- DiagramWidget uses mermaid.render asynchronously; errors fall back to plain text.

5) Migration & Docs
- Changelog: Unreleased → Added: WYSIWYG supports Mermaid/UML fenced diagrams.
- Extensions.md/Development.md: mention that core WYSIWYG handles diagrams; extensions should avoid DOM-heavy replacements and use commands/decorators for light UI.
