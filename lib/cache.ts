/**
 * @interface CacheEntry
 * @description Represents a cached item with an expiration timestamp.
 * @template T
 */
interface CacheEntry<T> {
  value: T
  expiresAt: number
}

/**
 * @class Cached
 * @description A simple generic in-memory key-value cache with TTL expiration.
 * @template T
 */
export class Cached<T> {
  private store = new Map<string, CacheEntry<T>>()

  get(key: string): T | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key)
      return null
    }
    return entry.value
  }

  set(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs })
  }

  has(key: string): boolean {
    return this.get(key) !== null
  }
}
