import { describe, it, expect } from 'vitest';
import { EditorCore } from '../src/editor/EditorCore';
import { attachEditor } from '../src/ext/registry';

describe('Registry menus submenu click', () => {
  it('clicking parent item with submenu runs its command', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const core = new EditorCore(parent, 'hello world');
    attachEditor(core);

    let ran = false;
    window.zion.commands.registerCommand('test.parent', () => {
      ran = true;
    });
    window.zion.commands.registerCommand('test.child', () => true);

    const disp = window.zion.menus.register('editor/context', {
      command: 'test.parent',
      title: 'Parent',
      when: 'editorFocus',
      submenu: [{ command: 'test.child', title: 'Child', when: 'editorFocus' }]
    });

    core.focus();
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    core.view.dom.dispatchEvent(e);

    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Parent');
    expect(btn).toBeDefined();
    btn.click();
    expect(ran).toBe(true);

    disp.dispose();
    core.view.destroy();
    document.body.removeChild(parent);
  });
});

