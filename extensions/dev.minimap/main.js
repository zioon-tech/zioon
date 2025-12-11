export async function activate(ctx) {
  const { minimapPlugin } = await import('./minimap.js');

  // init enabled state from localStorage
  let enabled = true;
  try {
    const v = localStorage.getItem('zion.minimap');
    if (v === '0' || v === 'false') enabled = false;
    if (v === '1' || v === 'true') enabled = true;
  } catch {}

  // init minimap width from localStorage (persist user-resized width)
  let minimapWidth = 120;
  try {
    const w = localStorage.getItem('zion.minimap.width');
    if (w !== null) {
      const n = Number(w);
      if (!Number.isNaN(n) && n > 0) minimapWidth = n;
    }
  } catch {}

  // publish initial state
  window.zion.state.set('ui.minimapEnabled', enabled);

  // register command to toggle minimap
  const cmdDisp = window.zion.commands.registerCommand('dev.minimap.toggle', () => {
    enabled = !enabled;
    try { localStorage.setItem('zion.minimap', enabled ? '1' : '0'); } catch {}
    window.zion.state.set('ui.minimapEnabled', enabled);
    // update status item
    window.zion.statusBar.registerItem({
      id: 'ext.minimap',
      text: `Minimap: ${enabled ? 'On' : 'Off'}`,
      tooltip: 'Toggle minimap',
      onClick: () => window.zion.commands.executeCommand('dev.minimap.toggle')
    });
  });
  ctx.subscriptions.push(cmdDisp);

  // status bar item
  const statusDisp = window.zion.statusBar.registerItem({
    id: 'ext.minimap',
    text: `Minimap: ${enabled ? 'On' : 'Off'}`,
    tooltip: 'Toggle minimap',
    onClick: () => window.zion.commands.executeCommand('dev.minimap.toggle')
  });
  ctx.subscriptions.push(statusDisp);

  // inject visual plugin via decorator
  const decDisp = window.zion.editor.registerDecorator({
    id: 'dev.minimap.decorator',
    apply(editor) {
      // add the minimap ViewPlugin / theme extension
      // use persisted width if available (minimapWidth initialized above)
      editor.addVisualExtension(minimapPlugin({ width: minimapWidth }));
      return { dispose() { /* plugin cleanup handled by CM6 on editor dispose */ } };
    }
  });
  ctx.subscriptions.push(decDisp);
}