import { describe, it, expect, vi } from "vitest"
import { Cached } from "@/lib/cache"

describe("Cached", () => {
  it("stores and retrieves a value", () => {
    const cache = new Cached<number>()
    cache.set("key1", 42, 60000)
    expect(cache.get("key1")).toBe(42)
  })

  it("returns null for expired entries", () => {
    vi.useFakeTimers()
    const cache = new Cached<string>()
    cache.set("expires", "value", 100)
    vi.advanceTimersByTime(101)
    expect(cache.get("expires")).toBeNull()
    vi.useRealTimers()
  })

  it("returns null for non-existent keys", () => {
    const cache = new Cached<number>()
    expect(cache.get("nope")).toBeNull()
  })

  it("overwrites existing key", () => {
    const cache = new Cached<string>()
    cache.set("k", "old", 60000)
    cache.set("k", "new", 60000)
    expect(cache.get("k")).toBe("new")
  })

  it("has() returns correct status", () => {
    const cache = new Cached<number>()
    expect(cache.has("x")).toBe(false)
    cache.set("x", 1, 60000)
    expect(cache.has("x")).toBe(true)
  })
})
