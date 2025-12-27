import { describe, it, expect, vi } from 'vitest';
import { StateBus } from '../src/core/state-bus';

describe('StateBus', () => {
  it('get/set should work and notify listeners', () => {
    const bus = new StateBus();
    const spy = vi.fn();

    // before set -> undefined
    expect(bus.get('foo')).toBeUndefined();

    // subscribe
    const disp = bus.onDidChange('foo', spy);

    // set value
    bus.set('foo', 1);
    expect(bus.get('foo')).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(1, undefined);

    // set again
    bus.set('foo', 2);
    expect(bus.get('foo')).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(2, 1);

    // dispose listener
    disp.dispose();
    bus.set('foo', 3);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(bus.get('foo')).toBe(3);
  });

  it('update should read oldVal and write newVal atomically', () => {
    const bus = new StateBus();
    const calls = [];
    bus.onDidChange('counter', (nv, ov) => calls.push([nv, ov]));

    bus.update('counter', (oldVal) => (oldVal ?? 0) + 1);
    expect(bus.get('counter')).toBe(1);

    bus.update('counter', (oldVal) => (oldVal ?? 0) + 5);
    expect(bus.get('counter')).toBe(6);

    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual([1, undefined]);
    expect(calls[1]).toEqual([6, 1]);
  });
});
