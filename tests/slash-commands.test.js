import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorCore } from '../src/editor/EditorCore';
import { attachEditor } from '../src/ext/registry';
import { activate as activateSlash } from '../extensions/dev.slash-commands/main.js';

const RangeCtor = globalThis.Range;
if (typeof RangeCtor !== 'undefined' && RangeCtor?.prototype) {
  if (!RangeCtor.prototype.getClientRects) {
    RangeCtor.prototype.getClientRects = () => [];
  }
  if (!RangeCtor.prototype.getBoundingClientRect) {
    RangeCtor.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0
    });
  }
}

describe('Slash commands plugin', () => {
  let parent;
  let core;
  let ctx;

  beforeEach(async () => {
    parent = document.createElement('div');
    parent.style.height = '600px';
    parent.style.width = '800px';
    document.body.appendChild(parent);

    core = new EditorCore(parent, '');
    attachEditor(core);
    core.view.coordsAtPos = () => ({ left: 10, top: 10, right: 10, bottom: 10 });

    ctx = { subscriptions: [] };
    await activateSlash(ctx);
  });

  afterEach(() => {
    for (const s of ctx?.subscriptions || []) {
      try {
        s.dispose?.();
      } catch {}
    }
    ctx = null;

    try {
      core?.view?.destroy?.();
    } catch {}

    const panel = document.getElementById('zion-slash-panel');
    if (panel) panel.remove();

    parent?.remove();
    parent = null;
    core = null;
  });

  it('shows panel when typing / at line start', async () => {
    core.replaceSelection('/');

    const panel = document.getElementById('zion-slash-panel');
    expect(panel).toBeTruthy();
    expect(panel.style.display).toBe('block');
  });

  it('shows panel when typing / after whitespace', async () => {
    core.setValue('- ');
    core.setCursor({ line: 0, ch: 2 });
    core.replaceSelection('/');

    const panel = document.getElementById('zion-slash-panel');
    expect(panel).toBeTruthy();
    expect(panel.style.display).toBe('block');
  });

  it('executes command without leaving slash trigger text', async () => {
    core.replaceSelection('/');

    const panel = document.getElementById('zion-slash-panel');
    expect(panel).toBeTruthy();

    const items = Array.from(document.querySelectorAll('.zion-slash-item'));
    const boldItem = items.find((n) => (n.textContent || '').includes('粗体'));
    expect(boldItem).toBeTruthy();

    boldItem.click();

    expect(core.getValue()).toBe('****');
  });
});
