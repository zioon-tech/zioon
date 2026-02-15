import { describe, it, expect, beforeEach } from 'vitest';
import { attachEditor } from '../src/ext/registry';
import { EditorCore } from '../src/editor/EditorCore';
import { activate } from '../extensions/dev.roles/main.js';

describe('Roles toggle user', () => {
  beforeEach(() => {
    if (typeof window.Range !== 'undefined' && !window.Range.prototype.getClientRects) {
      window.Range.prototype.getClientRects = () => ({ length: 0, item: () => null });
    }
  });

  it('toggles user prefix on current line and registers Mod-u', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const core = new EditorCore(parent, 'hello\nassistant hi');
    attachEditor(core);

    const ctx = { subscriptions: [] };
    await activate(ctx);

    const kbs = window.zion.keybindings.list();
    expect(kbs.some(kb => kb.command === 'roles.toggleUser' && kb.key === 'Mod-u')).toBe(true);

    window.zion.window.activeEditor.setCursor({ line: 0, ch: 0 });
    window.zion.commands.executeCommand('roles.toggleUser');
    expect(window.zion.window.activeEditor.getValue().split('\n')[0]).toBe('user hello');

    window.zion.commands.executeCommand('roles.toggleUser');
    expect(window.zion.window.activeEditor.getValue().split('\n')[0]).toBe('hello');

    window.zion.window.activeEditor.setCursor({ line: 1, ch: 0 });
    window.zion.commands.executeCommand('roles.toggleUser');
    expect(window.zion.window.activeEditor.getValue().split('\n')[1]).toBe('user hi');

    try { core.view?.destroy?.(); } catch {}
    parent.remove();
  });
});
