# ADR-2024-08-08 — WYSIWYG Diagram Blocks: Expand/Collapse Interaction

Status: Accepted
Authors: Zion Team
Context date: 2024-08-08

Decision
- For fenced diagram blocks (```mermaid / ```uml), only render the diagram widget at the block's first visible line.
- Visually collapse subsequent lines in the same block to avoid fake blank lines.
- Clicking the diagram expands the block into raw code (edit mode) and moves cursor to the block start; while editing, diagrams are not rendered.

Rationale
- Replacing every line with hidden inline widgets leaves line boxes in the DOM, creating apparent empty lines.
- Line decorations with a "collapse" class keep text positions stable while removing visual height.
- Edit toggling must be stateful per block and trigger a redraw; selection change is used to trigger the plugin update.

Implementation Notes
- A Set(openFrom) tracks expanded diagram blocks inside the WYSIWYG ViewPlugin.
- buildDecorations(view, activeLines, isDiagramExpanded, expandDiagram): if not expanded and not active, render widget on the first line; apply a line decoration (.cm-md-diagram-hiddenline) to subsequent lines; otherwise fall through to normal code-fence styling.
- DiagramWidget takes an onToggleExpand callback; on click, it marks the block expanded and dispatches a selection to the block start to trigger selectionSet -> re-render.

Consequences
- No cross-line replacements; stable editing.
- Improved UX: no fake blanks; click-to-edit reveals the code.

Migration
- None for extensions; behavior is internal to core WYSIWYG.