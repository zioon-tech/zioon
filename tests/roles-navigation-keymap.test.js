import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachEditor } from '../src/ext/registry';
import { EditorCore } from '../src/editor/EditorCore';
import { roles } from '../extensions/dev.roles/roles.js';

function dispatchKey(target, { key, code, shiftKey, ctrlKey, metaKey, altKey }) {
  const ev = new window.KeyboardEvent('keydown', {
    key,
    code,
    ctrlKey: !!ctrlKey,
    metaKey: !!metaKey,
    altKey: !!altKey,
    shiftKey: !!shiftKey,
    bubbles: true,
    cancelable: true
  });
  target.dispatchEvent(ev);
  return ev;
}

function setNavigatorPlatform(platform) {
  Object.defineProperty(window.navigator, 'platform', {
    value: platform,
    configurable: true
  });
}

describe('Roles navigation keymap', () => {
  let originalPlatform = null;

  beforeEach(() => {
    originalPlatform = window.navigator.platform;
    setNavigatorPlatform('Win32');
    if (typeof window.Range !== 'undefined' && !window.Range.prototype.getClientRects) {
      window.Range.prototype.getClientRects = () => ({ length: 0, item: () => null });
    }
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    if (originalPlatform != null) setNavigatorPlatform(originalPlatform);
    vi.useRealTimers();
  });

  it('Mod-ArrowUp jumps to previous role start; double jumps to doc top', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const text = ['user hello', 'u2', 'assistant hi', 'a2', 'system ok'].join('\n');
    const core = new EditorCore(parent, text);
    attachEditor(core);
    core.addExternalExtension(roles());

    const assistantBodyLine = core.view.state.doc.line(4);
    core.view.dispatch({ selection: { anchor: assistantBodyLine.from + 1 } });
    core.view.focus();

    dispatchKey(core.view.contentDOM, { key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true });
    const pos1 = core.view.state.selection.main.head;
    expect(pos1).toBe(core.view.state.doc.line(3).from);

    vi.advanceTimersByTime(200);
    dispatchKey(core.view.contentDOM, { key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true });
    const pos2 = core.view.state.selection.main.head;
    expect(pos2).toBe(core.view.state.doc.line(1).from);

    parent.remove();
  });

  it('Mod-ArrowDown jumps to next role start; double jumps to doc bottom', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const text = ['user hello', 'u2', 'assistant hi', 'a2', 'system ok'].join('\n');
    const core = new EditorCore(parent, text);
    attachEditor(core);
    core.addExternalExtension(roles());

    const userSecondLine = core.view.state.doc.line(2);
    core.view.dispatch({ selection: { anchor: userSecondLine.from + 1 } });
    core.view.focus();

    dispatchKey(core.view.contentDOM, { key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true });
    const pos1 = core.view.state.selection.main.head;
    expect(pos1).toBe(core.view.state.doc.line(1).from);

    vi.advanceTimersByTime(200);
    dispatchKey(core.view.contentDOM, { key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true });
    const pos2 = core.view.state.selection.main.head;
    expect(pos2).toBe(core.view.state.doc.line(3).from);

    vi.advanceTimersByTime(200);
    dispatchKey(core.view.contentDOM, { key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true });
    const pos3 = core.view.state.selection.main.head;
    expect(pos3).toBe(core.view.state.doc.length);

    parent.remove();
  });

  it('Mod-ArrowDown in last block jumps to doc bottom (not current block start)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const text = ['user hello', 'assistant hi', 'system ok', 'tail line'].join('\n');
    const core = new EditorCore(parent, text);
    attachEditor(core);
    core.addExternalExtension(roles());

    const lastLine = core.view.state.doc.line(4);
    core.view.dispatch({ selection: { anchor: lastLine.from + 2 } });
    core.view.focus();

    dispatchKey(core.view.contentDOM, { key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true });
    const pos1 = core.view.state.selection.main.head;
    expect(pos1).toBe(core.view.state.doc.length);

    parent.remove();
  });

  it('Mod-Shift-ArrowUp selects to role start; continues to previous role; double selects to doc top', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const text = ['user hello', 'u2', 'assistant hi', 'a2', 'system ok', 's2'].join('\n');
    const core = new EditorCore(parent, text);
    attachEditor(core);
    core.addExternalExtension(roles());

    const posInAssistantBody = core.view.state.doc.line(4).from + 1;
    core.view.dispatch({ selection: { anchor: posInAssistantBody } });
    core.view.focus();

    dispatchKey(core.view.contentDOM, { key: 'ArrowUp', code: 'ArrowUp', shiftKey: true, ctrlKey: true });
    const sel1 = core.view.state.selection.main;
    expect(sel1.anchor).toBe(posInAssistantBody);
    expect(sel1.head).toBe(core.view.state.doc.line(3).from);

    vi.advanceTimersByTime(200);
    dispatchKey(core.view.contentDOM, { key: 'ArrowUp', code: 'ArrowUp', shiftKey: true, ctrlKey: true });
    const sel2 = core.view.state.selection.main;
    expect(sel2.anchor).toBe(posInAssistantBody);
    expect(sel2.head).toBe(core.view.state.doc.line(1).from);

    vi.advanceTimersByTime(200);
    dispatchKey(core.view.contentDOM, { key: 'ArrowUp', code: 'ArrowUp', shiftKey: true, ctrlKey: true });
    const sel3 = core.view.state.selection.main;
    expect(sel3.anchor).toBe(posInAssistantBody);
    expect(sel3.head).toBe(0);

    parent.remove();
  });

  it('Mod-Shift-ArrowDown selects to role start, then next role; double selects to doc bottom', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const text = ['user hello', 'u2', 'assistant hi', 'a2', 'system ok', 's2'].join('\n');
    const core = new EditorCore(parent, text);
    attachEditor(core);
    core.addExternalExtension(roles());

    const posInUserBody = core.view.state.doc.line(2).from + 1;
    core.view.dispatch({ selection: { anchor: posInUserBody } });
    core.view.focus();

    dispatchKey(core.view.contentDOM, { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true, ctrlKey: true });
    const sel1 = core.view.state.selection.main;
    expect(sel1.anchor).toBe(posInUserBody);
    expect(sel1.head).toBe(core.view.state.doc.line(1).from);

    vi.advanceTimersByTime(200);
    dispatchKey(core.view.contentDOM, { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true, ctrlKey: true });
    const sel2 = core.view.state.selection.main;
    expect(sel2.anchor).toBe(posInUserBody);
    expect(sel2.head).toBe(core.view.state.doc.line(3).from);

    vi.advanceTimersByTime(200);
    dispatchKey(core.view.contentDOM, { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true, ctrlKey: true });
    const sel3 = core.view.state.selection.main;
    expect(sel3.anchor).toBe(posInUserBody);
    expect(sel3.head).toBe(core.view.state.doc.length);

    parent.remove();
  });

  it('On mac: Alt-ArrowUp jumps roles; Mod-ArrowUp does not jump to role start', () => {
    setNavigatorPlatform('MacIntel');
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const text = ['user hello', 'u2', 'assistant hi', 'a2', 'system ok'].join('\n');
    const core = new EditorCore(parent, text);
    attachEditor(core);
    core.addExternalExtension(roles());

    const assistantBodyLine = core.view.state.doc.line(4);
    core.view.dispatch({ selection: { anchor: assistantBodyLine.from + 1 } });
    core.view.focus();

    dispatchKey(core.view.contentDOM, { key: 'ArrowUp', code: 'ArrowUp', altKey: true });
    const pos1 = core.view.state.selection.main.head;
    expect(pos1).toBe(core.view.state.doc.line(3).from);

    core.view.dispatch({ selection: { anchor: assistantBodyLine.from + 1 } });
    dispatchKey(core.view.contentDOM, { key: 'ArrowUp', code: 'ArrowUp', metaKey: true });
    const pos2 = core.view.state.selection.main.head;
    expect(pos2).not.toBe(core.view.state.doc.line(3).from);

    parent.remove();
  });
});
