import { describe, it, expect } from 'vitest';
import { EditorCore } from '../src/editor/EditorCore';
import { attachEditor } from '../src/ext/registry';

describe('Registry decorators lifecycle', () => {
  it('applies decorator on attach and disposes on unregister', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const core = new EditorCore(host, 'abc');
    attachEditor(core);

    let applied = 0;
    let disposed = false;

    const disp = window.zion.editor.registerDecorator({
      id: 'test.decorator',
      apply: (editor) => {
        applied += 1;
        // return disposable
        return {
          dispose() {
            disposed = true;
          }
        };
      }
    });

    // applied exactly once
    expect(applied).toBe(1);
    expect(disposed).toBe(false);

    // unregister -> should call dispose
    disp.dispose();
    expect(disposed).toBe(true);

    core.view.destroy();
    document.body.removeChild(host);
  });
});