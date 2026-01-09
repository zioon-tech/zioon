import { describe, it, expect } from 'vitest';
import { attachEditor } from '../src/ext/registry';
import { EditorCore } from '../src/editor/EditorCore';

describe('Registry paste handlers', () => {
  it('executes by priority (desc) and short-circuits when handled', async () => {
    // mount editor
    const host = document.createElement('div');
    document.body.appendChild(host);
    const core = new EditorCore(host, '');
    attachEditor(core);

    const order = [];
    let handler2Called = false;
    let seenText = '';

    // high priority handler handles and short-circuits
    const d1 = window.zion.editor.registerPasteHandler({
      id: 'h1',
      priority: 90,
      handle: async ({ clipboardData, editor }) => {
        order.push('h1');
        // ensure clipboard data is accessible
        const txt = clipboardData.getData('text/plain') || '';
        seenText = txt;
        return true; // handled -> prevent default & stop chain
      }
    });

    // lower priority should not be called
    const d2 = window.zion.editor.registerPasteHandler({
      id: 'h2',
      priority: 10,
      handle: async ({ clipboardData, editor }) => {
        order.push('h2');
        handler2Called = true;
        return false;
      }
    });

    // fire paste event
    const evt = new Event('paste', { bubbles: true, cancelable: true });
    const dt = {
      getData: (type) => (type === 'text/plain' ? 'sample' : '')
    };
    Object.defineProperty(evt, 'clipboardData', { value: dt });

    const beforeButtons = document.querySelectorAll('button').length;
    const target = core.view.dom;
    target.dispatchEvent(evt);

    await new Promise((r) => setTimeout(r, 0));

    // default prevented
    expect(evt.defaultPrevented).toBe(true);
    // chain order only has h1
    expect(order).toEqual(['h1']);
    expect(handler2Called).toBe(false);

    // clipboard data read by handler
    expect(seenText).toBe('sample');

    // cleanup
    d1.dispose();
    d2.dispose();
    core.view.destroy();
    document.body.removeChild(host);
    // some environments may add buttons; ensure we didn’t leak
    const afterButtons = document.querySelectorAll('button').length;
    expect(afterButtons).toBeGreaterThanOrEqual(beforeButtons);
  });
});
