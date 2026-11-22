/** Original editor-config header contributions; no ambient Workbench host. */
export function editorCoreMenuItems(host) {
  return [
    { id: "core.wysiwyg.headerMenu", title: "WYSIWYG", section: "Editor", order: 16, kind: "toggle",
      getChecked: () => !!host.state.get("ui.wysiwyg"), onClick: () => host.commands.executeCommand("zion.toggleWysiwyg") },
    { id: "core.wysiwyg.keepActiveLineRendered.headerMenu", title: "Keep Focused Line Rendered", section: "Editor", order: 16.1, kind: "toggle",
      getChecked: () => !!host.state.get("ui.wysiwyg.keepActiveLineRendered"), onClick: () => host.commands.executeCommand("zion.toggleWysiwygKeepActiveLineRendered") },
    { id: "core.vimMode.headerMenu", title: "Vim Mode", section: "Editor", order: 17, kind: "toggle",
      getChecked: () => !!host.state.get("ui.editor.vimMode"), onClick: () => host.commands.executeCommand("zion.toggleVimMode") }
  ];
}
export function editorConfigurationMenuItems(host) {
  return [
{ id: "dev.editor.menu.lineNumbers", title: "Line Numbers", section: "Editor", kind: "toggle", order: 41, getChecked: () => !!host.state.get("ui.lineNumbers"), onClick: () => host.commands.executeCommand("dev.editor.toggleLineNumbers") },
{ id: "dev.editor.menu.activeLineHighlight", title: "Active Line Highlight", section: "Editor", kind: "toggle", order: 42, getChecked: () => !!host.state.get("ui.activeLineHighlight"), onClick: () => host.commands.executeCommand("dev.editor.toggleActiveLineHighlight") },
{ id: "dev.editor.menu.syntaxHighlight", title: "Syntax Highlight", section: "Editor", kind: "toggle", order: 43, getChecked: () => !!host.state.get("ui.syntaxHighlight"), onClick: () => host.commands.executeCommand("dev.editor.toggleSyntaxHighlight") },
{ id: "dev.editor.menu.autoIndent", title: "Auto Indent", section: "Editor", kind: "toggle", order: 44, getChecked: () => !!host.state.get("ui.autoIndent"), onClick: () => host.commands.executeCommand("dev.editor.toggleAutoIndent") },
{ id: "dev.editor.menu.folding", title: "Folding", section: "Editor", kind: "toggle", order: 45, getChecked: () => !!host.state.get("ui.folding"), onClick: () => host.commands.executeCommand("dev.editor.toggleFolding") },
{ id: "dev.editor.menu.lineWrap", title: "Line Wrap", section: "Editor", kind: "toggle", order: 46, getChecked: () => !!host.state.get("ui.lineWrap"), onClick: () => host.commands.executeCommand("dev.editor.toggleLineWrap") },
{ id: "dev.editor.menu.minimap", title: "Minimap", section: "Editor", kind: "toggle", order: 47, getChecked: () => !!host.state.get("ui.minimapEnabled"), onClick: () => host.commands.executeCommand("dev.editor.toggleMinimap") },
{ id: "dev.editor.menu.width.standard", title: "Width: Standard", section: "Layout", kind: "toggle", order: 50, getChecked: () => (host.state.get("ui.editorWidthMode") || "standard") === "standard", onClick: () => host.commands.executeCommand("dev.editor.setWidthStandard") },
{ id: "dev.editor.menu.width.wide", title: "Width: Wide", section: "Layout", kind: "toggle", order: 51, getChecked: () => (host.state.get("ui.editorWidthMode") || "standard") === "wide", onClick: () => host.commands.executeCommand("dev.editor.setWidthWide") },
{ id: "dev.editor.menu.width.full", title: "Width: Full", section: "Layout", kind: "toggle", order: 52, getChecked: () => (host.state.get("ui.editorWidthMode") || "standard") === "full", onClick: () => host.commands.executeCommand("dev.editor.setWidthFull") },
{ id: "dev.editor.menu.heading.medium", title: "Heading: Medium", section: "Layout", kind: "toggle", order: 60, getChecked: () => String(host.state.get("ui.headingSize") || "xsmall") === "medium", onClick: () => host.commands.executeCommand("dev.editor.setHeadingSizeMedium") },
{ id: "dev.editor.menu.heading.small", title: "Heading: Small", section: "Layout", kind: "toggle", order: 61, getChecked: () => String(host.state.get("ui.headingSize") || "xsmall") === "small", onClick: () => host.commands.executeCommand("dev.editor.setHeadingSizeSmall") },
{ id: "dev.editor.menu.heading.xsmall", title: "Heading: XSmall", section: "Layout", kind: "toggle", order: 62, getChecked: () => String(host.state.get("ui.headingSize") || "xsmall") === "xsmall", onClick: () => host.commands.executeCommand("dev.editor.setHeadingSizeXSmall") },
  ];
}
