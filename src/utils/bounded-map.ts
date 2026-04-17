/**
 * A Map with a maximum size. When the capacity is reached, the oldest
 * entry (by insertion order) is evicted to make room for the new one.
 * Uses the native Map insertion-order guarantee for LRU-like behavior.
 */
export class BoundedMap<K, V> {
  private readonly _map = new Map<K, V>();
  private readonly _cap: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError('BoundedMap capacity must be >= 1');
    this._cap = capacity;
  }

  get size(): number { return this._map.size; }

  get(key: K): V | undefined { return this._map.get(key); }

  has(key: K): boolean { return this._map.has(key); }

  set(key: K, value: V): this {
    // If key already exists, delete first to reset insertion order
    if (this._map.has(key)) this._map.delete(key);
    // Evict oldest if at capacity. Use IteratorResult.done so `undefined` is
    // a valid key value (BoundedMap<undefined | X, Y>) and still evicts.
    if (this._map.size >= this._cap) {
      const next = this._map.keys().next();
      if (!next.done) this._map.delete(next.value);
    }
    this._map.set(key, value);
    return this;
  }

  delete(key: K): boolean { return this._map.delete(key); }

  clear(): void { this._map.clear(); }

  keys(): IterableIterator<K> { return this._map.keys(); }
  values(): IterableIterator<V> { return this._map.values(); }
  entries(): IterableIterator<[K, V]> { return this._map.entries(); }

  forEach(fn: (value: V, key: K) => void): void {
    this._map.forEach(fn);
  }
}
