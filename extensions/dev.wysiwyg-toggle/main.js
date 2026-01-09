export async function activate(ctx) {
  // Command to toggle core WYSIWYG mode
  const d1 = window.zion.commands.registerCommand("dev.wysiwyg.toggle", () => {
    window.zion.commands.executeCommand("zion.toggleWysiwyg");
  });
  ctx.subscriptions.push(d1);

  // Keybinding: Mod-Shift-w
  const d2 = window.zion.keybindings.register({
    command: "dev.wysiwyg.toggle",
    key: "Mod-Shift-w",
    when: "editorFocus"
  });
  ctx.subscriptions.push(d2);
}