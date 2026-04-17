import { describe, it, expect } from 'vitest';
import { BoundedMap } from '../src/utils/bounded-map.js';

describe('BoundedMap', () => {
  it('stores and retrieves values', () => {
    const m = new BoundedMap<string, number>(3);
    m.set('a', 1);
    m.set('b', 2);
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(2);
    expect(m.size).toBe(2);
  });

  it('evicts oldest when at capacity', () => {
    const m = new BoundedMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3); // 'a' should be evicted
    expect(m.has('a')).toBe(false);
    expect(m.get('b')).toBe(2);
    expect(m.get('c')).toBe(3);
    expect(m.size).toBe(2);
  });

  it('updating existing key does not increase size', () => {
    const m = new BoundedMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('a', 10); // update, not new
    expect(m.size).toBe(2);
    expect(m.get('a')).toBe(10);
  });

  it('updating existing key moves it to end (not evicted next)', () => {
    const m = new BoundedMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('a', 10); // 'a' moves to end
    m.set('c', 3);  // 'b' should be evicted (oldest)
    expect(m.has('b')).toBe(false);
    expect(m.has('a')).toBe(true);
    expect(m.has('c')).toBe(true);
  });

  it('delete removes entry', () => {
    const m = new BoundedMap<string, number>(3);
    m.set('a', 1);
    expect(m.delete('a')).toBe(true);
    expect(m.has('a')).toBe(false);
    expect(m.size).toBe(0);
  });

  it('clear empties the map', () => {
    const m = new BoundedMap<string, number>(3);
    m.set('a', 1);
    m.set('b', 2);
    m.clear();
    expect(m.size).toBe(0);
  });

  it('throws on capacity < 1', () => {
    expect(() => new BoundedMap(0)).toThrow('capacity must be >= 1');
    expect(() => new BoundedMap(-1)).toThrow('capacity must be >= 1');
  });

  it('capacity 1 always holds only the latest', () => {
    const m = new BoundedMap<string, number>(1);
    m.set('a', 1);
    m.set('b', 2);
    expect(m.size).toBe(1);
    expect(m.has('a')).toBe(false);
    expect(m.get('b')).toBe(2);
  });

  it('evicts even when oldest key is undefined', () => {
    const m = new BoundedMap<string | undefined, number>(2);
    m.set(undefined, 1);
    m.set('b', 2);
    m.set('c', 3); // undefined should be evicted as oldest
    expect(m.has(undefined)).toBe(false);
    expect(m.get('b')).toBe(2);
    expect(m.get('c')).toBe(3);
    expect(m.size).toBe(2);
  });
});
