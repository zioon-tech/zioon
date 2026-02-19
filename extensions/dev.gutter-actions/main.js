export async function activate(ctx) {
  const STATE_KEY = "ui.gutterActionsEnabled";
  const CSS_DISABLED_CLASS = "zion-gutter-actions-disabled";

  const readPersisted = () => {
    try {
      const v = localStorage.getItem("zion.gutterActions");
      if (v === "0" || v === "false") return false;
      if (v === "1" || v === "true") return true;
      return true; // default ON
    } catch {
      return true;
    }
  };

  const applyEnabled = (enabled) => {
    try { localStorage.setItem("zion.gutterActions", enabled ? "1" : "0"); } catch {}
    window.zion.state.set(STATE_KEY, Boolean(enabled));
    if (enabled) {
      document.body.classList.remove(CSS_DISABLED_CLASS);
    } else {
      document.body.classList.add(CSS_DISABLED_CLASS);
    }
  };

  // init state
  const initialEnabled = readPersisted();
  window.zion.state.set(STATE_KEY, initialEnabled);
  applyEnabled(initialEnabled);

  // command: toggle
  const dispToggle = window.zion.commands.registerCommand("dev.gutter-actions.toggle", () => {
    const cur = !!window.zion.state.get(STATE_KEY);
    applyEnabled(!cur);
  });
  ctx.subscriptions.push(dispToggle);

  // reflect external state changes (if any)
  const sub = window.zion.state.onDidChange(STATE_KEY, (nv) => {
    const enabled = !!nv;
    try { localStorage.setItem("zion.gutterActions", enabled ? "1" : "0"); } catch {}
    if (enabled) document.body.classList.remove(CSS_DISABLED_CLASS);
    else document.body.classList.add(CSS_DISABLED_CLASS);
  });
  ctx.subscriptions.push({ dispose() { try { sub.dispose?.(); } catch {} } });

  try {
    const reg = window.zion?.__editorHeaderMenuRegistry;
    const disp = reg?.register?.({
      id: "dev.gutter-actions.headerMenu",
      title: "Gutter Actions",
      section: "Editor",
      order: 10,
      kind: "toggle",
      getChecked: () => !!window.zion.state.get(STATE_KEY),
      onClick: () => window.zion.commands.executeCommand("dev.gutter-actions.toggle")
    });
    if (disp) ctx.subscriptions.push(disp);
  } catch {}

  // inject visual extension (custom gutter)
  const { gutterActions } = await import('./gutter-actions.js');
  const d = window.zion.editor.registerDecorator({
    id: "dev.gutter-actions.decorator",
    apply(editor) {
      try {
        editor.addVisualExtension(gutterActions());
      } catch (e) {
        console.error("[dev.gutter-actions] failed to add visual extension", e);
      }
      return { dispose() {} };
    }
  });
  ctx.subscriptions.push(d);

  // ensure body class matches current state on load
  if (!initialEnabled) {
    document.body.classList.add(CSS_DISABLED_CLASS);
  } else {
    document.body.classList.remove(CSS_DISABLED_CLASS);
  }
}
