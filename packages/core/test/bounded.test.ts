import { describe, expect, it } from 'vitest';
import { BoundedMap, BoundedSet } from '../src/index.js';

describe('BoundedMap', () => {
  it('forgets the oldest entries past its limit and reports each one', () => {
    const evicted: [string, number][] = [];
    const map = new BoundedMap<string, number>(2, (key, value) => evicted.push([key, value]));
    map.set('a', 1).set('b', 2).set('c', 3);
    expect([...map]).toEqual([['b', 2], ['c', 3]]);
    expect(evicted).toEqual([['a', 1]]);
  });

  it('keeps an updated key in place, and does not report delete or clear', () => {
    const evicted: string[] = [];
    const map = new BoundedMap<string, number>(2, (key) => evicted.push(key));
    map.set('a', 1).set('b', 2).set('a', 10).set('c', 3);
    expect([...map]).toEqual([['b', 2], ['c', 3]]);
    map.delete('b');
    map.clear();
    expect(evicted).toEqual(['a']);
  });

  it('is a Map', () => {
    const map = new BoundedMap<string, number>(4);
    map.set('a', 1);
    expect(map).toBeInstanceOf(Map);
    expect(map.get('a')).toBe(1);
    expect(map.limit).toBe(4);
  });
});

describe('BoundedSet', () => {
  it('forgets the oldest values past its limit', () => {
    const set = new BoundedSet<string>(2).add('a').add('b').add('a').add('c');
    expect([...set]).toEqual(['b', 'c']);
    expect(set).toBeInstanceOf(Set);
  });

  it('reports each value it forgets, but not delete or clear', () => {
    const evicted: string[] = [];
    const set = new BoundedSet<string>(2, (value) => evicted.push(value));
    set.add('a').add('b').add('c');
    set.delete('b');
    set.clear();
    expect(evicted).toEqual(['a']);
  });
});
