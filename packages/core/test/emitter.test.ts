import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/emitter.js';

type E = { type: 'a'; n: number } | { type: 'b'; s: string };

describe('Emitter', () => {
  it('dispatches synchronously to typed listeners', () => {
    const emitter = new Emitter<E>();
    const seen: number[] = [];
    emitter.on('a', (event) => seen.push(event.n));
    emitter.emit({ type: 'a', n: 1 });
    emitter.emit({ type: 'b', s: 'x' });
    expect(seen).toEqual([1]);
  });

  it('on() returns an idempotent unsubscribe', () => {
    const emitter = new Emitter<E>();
    const listener = vi.fn();
    const off = emitter.on('a', listener);
    off();
    off();
    emitter.emit({ type: 'a', n: 1 });
    expect(listener).not.toHaveBeenCalled();
    expect(emitter.has('a')).toBe(false);
  });

  it('unsubscribing one copy of a listener keeps the others', () => {
    const emitter = new Emitter<E>();
    const listener = vi.fn();
    const off = emitter.on('a', listener);
    emitter.on('a', listener);
    off();
    emitter.emit({ type: 'a', n: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispatches a stable snapshot when listeners change mid-emit', () => {
    const emitter = new Emitter<E>();
    const calls: string[] = [];
    let offSecond = () => {};
    emitter.on('a', () => {
      calls.push('first');
      offSecond();
      emitter.on('a', () => calls.push('late'));
    });
    offSecond = emitter.on('a', () => calls.push('second'));
    emitter.emit({ type: 'a', n: 1 });
    expect(calls).toEqual(['first', 'second']);
  });

  it('keeps dispatching when a listener throws', () => {
    const errors: unknown[] = [];
    const emitter = new Emitter<E>((error) => errors.push(error));
    const after = vi.fn();
    emitter.on('a', () => { throw new Error('boom'); });
    emitter.on('a', after);
    emitter.emit({ type: 'a', n: 1 });
    expect(after).toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });
});
