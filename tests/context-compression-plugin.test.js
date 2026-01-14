import { describe, it, expect } from 'vitest';
import { EditorCore } from '../src/editor/EditorCore';
import { attachEditor } from '../src/ext/registry';

describe('Context compression plugin', () => {
  it('activates and can manually compress editor conversation', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const core = new EditorCore(
      host,
      [
        'system You are a helpful assistant.',
        '',
        'user Please summarize the following:',
        'A'.repeat(2000),
        '',
        'assistant Sure. Here are the points:',
        'B'.repeat(2000)
      ].join('\n')
    );
    attachEditor(core);

    const mod = await import('../extensions/dev.context-compression/main.js');
    const ctx = { subscriptions: [] };
    await mod.activate(ctx);

    const before = window.zion.window.activeEditor.getValue();
    await window.zion.commands.executeCommand('compression.manual');
    const after = window.zion.window.activeEditor.getValue();

    expect(typeof after).toBe('string');
    expect(after.length).toBeLessThanOrEqual(before.length);

    for (const d of ctx.subscriptions) {
      try {
        d.dispose?.();
      } catch {}
    }
    core.view.destroy();
    document.body.removeChild(host);
  });
});

