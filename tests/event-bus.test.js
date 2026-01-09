import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/core/event-bus';

describe('EventBus', () => {
  it('should emit and receive', () => {
    const bus = new EventBus();
    let payload = null;
    bus.on('test', (p) => (payload = p));
    bus.emit('test', { foo: 1 });
    expect(payload).toEqual({ foo: 1 });
  });

  it('should dispose listener', () => {
    const bus = new EventBus();
    let count = 0;
    const d = bus.on('test', () => count++);
    bus.emit('test');
    expect(count).toBe(1);
    d.dispose();
    bus.emit('test');
    expect(count).toBe(1);
  });
});