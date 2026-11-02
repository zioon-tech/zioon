import { afterEach, describe, it, expect } from 'vitest';
import { EditorCore } from '../src/editor/EditorCore';
import { attachEditor } from '../src/ext/registry';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Registry menus submenu exclusive', () => {
  it('shows only one submenu at a time on the same menu level', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const core = new EditorCore(parent, 'hello world');
    attachEditor(core);
    core.focus();

    window.zion.commands.registerCommand('test.a', () => true);
    window.zion.commands.registerCommand('test.b', () => true);
    window.zion.commands.registerCommand('test.a1', () => true);
    window.zion.commands.registerCommand('test.b1', () => true);

    const d1 = window.zion.menus.register('editor/context', {
      command: 'test.a',
      title: 'A',
      when: 'editorFocus',
      submenu: [{ command: 'test.a1', title: 'A1', when: 'editorFocus' }]
    });
    const d2 = window.zion.menus.register('editor/context', {
      command: 'test.b',
      title: 'B',
      when: 'editorFocus',
      submenu: [{ command: 'test.b1', title: 'B1', when: 'editorFocus' }]
    });

    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    core.view.dom.dispatchEvent(e);

    const btnA = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'A');
    const btnB = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'B');
    expect(btnA).toBeDefined();
    expect(btnB).toBeDefined();

    const rowA = btnA.parentElement;
    const rowB = btnB.parentElement;
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();

    const subA = rowA.querySelector('.zion-context-submenu');
    const subB = rowB.querySelector('.zion-context-submenu');
    expect(subA).toBeDefined();
    expect(subB).toBeDefined();

    rowA.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await wait(170);
    expect(subA.style.display).toBe('block');

    rowB.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await wait(170);
    expect(subA.style.display).toBe('none');
    expect(subB.style.display).toBe('block');

    d1.dispose();
    d2.dispose();
    core.view.destroy();
    document.body.removeChild(parent);
  });
});
