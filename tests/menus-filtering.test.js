import { describe, it, expect } from 'vitest';
import { EditorCore } from '../src/editor/EditorCore';
import { attachEditor } from '../src/ext/registry';

describe('Registry menus filtering (when conditions)', () => {
  it('filters items by hasSelection and editorFocus', async () => {
    // setup editor in DOM
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const core = new EditorCore(parent, 'hello world');
    attachEditor(core);

    // register two menu items with explicit titles
    const m1 = window.zion.menus.register('editor/context', {
      command: 'test.cmd1',
      when: 'hasSelection',
      title: 'Cmd1'
    });
    const m2 = window.zion.menus.register('editor/context', {
      command: 'test.cmd2',
      when: 'editorFocus',
      title: 'Cmd2'
    });

    let ran1 = false;
    let ran2 = false;
    window.zion.commands.registerCommand('test.cmd1', () => { ran1 = true; });
    window.zion.commands.registerCommand('test.cmd2', () => { ran2 = true; });

    // case 1: no focus, no selection -> no menu
    // ensure no focus
    const e1 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    core.view.dom.dispatchEvent(e1);
    // no buttons with our titles should exist
    let btn1 = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Cmd1');
    let btn2 = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Cmd2');
    expect(btn1).toBeUndefined();
    expect(btn2).toBeUndefined();

    // case 2: focus editor and select some text -> both items visible
    core.focus();
    // select "hello"
    core.view.dispatch({ selection: { anchor: 0, head: 5 } });

    const e2 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    core.view.dom.dispatchEvent(e2);

    // both buttons should be rendered now
    btn1 = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Cmd1');
    btn2 = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Cmd2');
    expect(btn1).toBeDefined();
    expect(btn2).toBeDefined();

    // click them to trigger commands
    btn1.click();
    btn2.click();
    expect(ran1).toBe(true);
    expect(ran2).toBe(true);

    // cleanup
    m1.dispose();
    m2.dispose();
    core.view.destroy();
    document.body.removeChild(parent);
  });
});