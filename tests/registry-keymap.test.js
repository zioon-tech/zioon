import { describe, it, expect, vi } from 'vitest';
import { attachEditor } from '../src/ext/registry';
import { EditorCore } from '../src/editor/EditorCore';

describe('Registry Keymap', () => {
  it('applies keybindings with when condition', () => {
    const parent = document.createElement('div');
    const core = new EditorCore(parent);
    attachEditor(core);

    // 注册一个需要 hasSelection 的快捷键
    const d = window.zion.keybindings.register({
      command: 'test.cmd',
      key: 'Ctrl-Shift-T',
      when: 'hasSelection'
    });

    // 模拟无选区
    core.view.dispatch({
      selection: { anchor: 0, head: 0 }
    });
    const r1 = window.zion.commands.executeCommand('test.cmd');
    expect(r1).toBeUndefined(); // 未命中 when，命令未注册

    // 模拟有选区
    core.view.dispatch({
      selection: { anchor: 0, head: 5 }
    });
    let executed = false;
    window.zion.commands.registerCommand('test.cmd', () => {
      executed = true;
    });
    window.zion.commands.executeCommand('test.cmd');
    expect(executed).toBe(true);

    d.dispose();
  });
});