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

  it('shows panel when typing Chinese punctuation from slash key', async () => {
    core.replaceSelection('。');

    const panel = document.getElementById('zion-slash-panel');
    expect(panel).toBeTruthy();
    expect(panel.style.display).toBe('block');
  });

  it('hides panel when typing non-command characters after trigger', async () => {
    core.replaceSelection('/');
    let panel = document.getElementById('zion-slash-panel');
    expect(panel).toBeTruthy();
    expect(panel.style.display).toBe('block');

    core.replaceSelection('你');
    await new Promise((r) => setTimeout(r, 0));
    panel = document.getElementById('zion-slash-panel');
    expect(panel).toBeTruthy();
    expect(panel.style.display).toBe('none');

    core.setValue('');
    core.setCursor({ line: 0, ch: 0 });
    core.replaceSelection('。');
    panel = document.getElementById('zion-slash-panel');
    expect(panel).toBeTruthy();
    expect(panel.style.display).toBe('block');

    core.replaceSelection('好');
    await new Promise((r) => setTimeout(r, 0));
    panel = document.getElementById('zion-slash-panel');
    expect(panel).toBeTruthy();
    expect(panel.style.display).toBe('none');
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

  it('injects styles and marks the first item active', async () => {
    const style = document.getElementById('zion-slash-commands-style');
    expect(style).toBeTruthy();

    core.replaceSelection('/');

    const items = Array.from(document.querySelectorAll('.zion-slash-item'));
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].classList.contains('is-active')).toBe(true);
  });

  it('supports nested submenu navigation inside slash dropdown', async () => {
    window.zion.slash.registerCommand({
      id: 'test.models',
      trigger: ['models'],
      title: 'Models',
      description: 'Pick provider then model',
      category: 'test',
      icon: '🧠',
      submenu: async () => [
        {
          title: 'Provider A',
          description: 'Select provider',
          icon: '🧩',
          submenu: async () => [
            {
              title: 'Model 1',
              description: 'Select model',
              icon: '🧠',
              execute: () => {
                window.zion.window.activeEditor.replaceSelection('MODEL1');
              }
            }
          ]
        }
      ],
      execute: () => {}
    });

    core.replaceSelection('/');

    const panel = document.getElementById('zion-slash-panel');
    expect(panel).toBeTruthy();

    let items = Array.from(document.querySelectorAll('.zion-slash-item'));
    const modelsItem = items.find((n) => (n.textContent || '').includes('Models'));
    expect(modelsItem).toBeTruthy();
    modelsItem.click();

    await new Promise((r) => setTimeout(r, 0));

    items = Array.from(document.querySelectorAll('.zion-slash-item'));
    const providerItem = items.find((n) => (n.textContent || '').includes('Provider A'));
    expect(providerItem).toBeTruthy();
    providerItem.click();

    await new Promise((r) => setTimeout(r, 0));

    items = Array.from(document.querySelectorAll('.zion-slash-item'));
    const modelItem = items.find((n) => (n.textContent || '').includes('Model 1'));
    expect(modelItem).toBeTruthy();
    modelItem.click();

    await new Promise((r) => setTimeout(r, 0));

    expect(core.getValue()).toBe('MODEL1');
  });

  it('does not let hover override active item while typing filters', async () => {
    window.zion.slash.registerCommand({
      id: 'test.flicker.one',
      trigger: ['zzflicker-one'],
      title: 'ZZ Flicker One',
      description: 'flicker test',
      category: 'test',
      priority: 100,
      icon: '🧪',
      execute: () => {}
    });

    window.zion.slash.registerCommand({
      id: 'test.flicker.two',
      trigger: ['zzflicker-two'],
      title: 'ZZ Flicker Two',
      description: 'flicker test',
      category: 'test',
      priority: 90,
      icon: '🧪',
      execute: () => {}
    });

    core.replaceSelection('/');
    core.replaceSelection('zzf');
    await new Promise((r) => setTimeout(r, 0));

    let items = Array.from(document.querySelectorAll('.zion-slash-item'));
    expect(items.length).toBeGreaterThanOrEqual(2);

    items[1].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    expect(items[1].classList.contains('is-active')).toBe(true);

    await new Promise((r) => setTimeout(r, 150));

    core.replaceSelection('l');
    await new Promise((r) => setTimeout(r, 0));

    items = Array.from(document.querySelectorAll('.zion-slash-item'));
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0].classList.contains('is-active')).toBe(true);

    items[1].dispatchEvent(new MouseEvent('mouseenter'));
    expect(items[0].classList.contains('is-active')).toBe(true);
    expect(items[1].classList.contains('is-active')).toBe(false);
  });
});
