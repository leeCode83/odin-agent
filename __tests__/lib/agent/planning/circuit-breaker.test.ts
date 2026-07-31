/**
 * @file circuit-breaker.test.ts
 * @description Tests for the in-memory PlanningCircuitBreaker (spec §9.7):
 * sliding-window failure counting, panic thresholds, and cooldown expiry.
 * Uses vi.useFakeTimers so windows are deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PlanningCircuitBreaker, planningCircuitBreaker } from "@/lib/agent/planning/circuit-breaker"

describe("PlanningCircuitBreaker", () => {
  let cb: PlanningCircuitBreaker

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    cb = new PlanningCircuitBreaker()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms)
  }

  describe("DD failures (3 in 5 min → reject 60s)", () => {
    it("no panic before threshold", () => {
      expect(cb.isDDPanicked()).toBe(false)
      cb.recordDDFailure()
      cb.recordDDFailure()
      expect(cb.isDDPanicked()).toBe(false)
    })

    it("3rd failure within 5 min → panicked, clears after 60s", () => {
      cb.recordDDFailure() // t=0
      advance(120_000) // t=2min
      cb.recordDDFailure()
      advance(120_000) // t=4min
      cb.recordDDFailure()

      expect(cb.isDDPanicked()).toBe(true)
      advance(59_000)
      expect(cb.isDDPanicked()).toBe(true)
      advance(2_000) // t=5:01 — 60s cooldown elapsed
      expect(cb.isDDPanicked()).toBe(false)
    })

    it("failures older than 5 min slide out of the window", () => {
      cb.recordDDFailure() // t=0
      advance(300_000) // t=5min — first failure now out of window
      cb.recordDDFailure()
      advance(10_000) // t=5:10
      cb.recordDDFailure()

      // Only 2 failures within the 5-min window (5:00 and 5:10) → no panic
      expect(cb.isDDPanicked()).toBe(false)
    })

    it("a failure exactly 5 min old slides out (window is strictly < 5 min)", () => {
      cb.recordDDFailure() // t=0
      advance(300_000) // t=5min — first failure exactly at window edge, out
      cb.recordDDFailure()
      advance(10_000) // t=5:10
      cb.recordDDFailure()

      expect(cb.isDDPanicked()).toBe(false)
    })

    it("reset clears panic state", () => {
      cb.recordDDFailure()
      advance(60_000)
      cb.recordDDFailure()
      advance(60_000)
      cb.recordDDFailure()
      expect(cb.isDDPanicked()).toBe(true)

      cb.reset()
      expect(cb.isDDPanicked()).toBe(false)
    })
  })

  describe("LLM failures (5 in 10 min → reject 120s)", () => {
    it("no panic below threshold", () => {
      for (let i = 0; i < 4; i++) cb.recordLLMFailure()
      expect(cb.isLLMPanicked()).toBe(false)
    })

    it("5th failure within 10 min → panicked, clears after 120s", () => {
      for (let i = 0; i < 5; i++) cb.recordLLMFailure()
      expect(cb.isLLMPanicked()).toBe(true)

      advance(119_000)
      expect(cb.isLLMPanicked()).toBe(true)
      advance(2_000) // t=2:01
      expect(cb.isLLMPanicked()).toBe(false)
    })

    it("LLM and DD panics are independent", () => {
      for (let i = 0; i < 5; i++) cb.recordLLMFailure()
      expect(cb.isLLMPanicked()).toBe(true)
      expect(cb.isDDPanicked()).toBe(false)

      cb.reset()
      for (let i = 0; i < 3; i++) cb.recordDDFailure()
      expect(cb.isDDPanicked()).toBe(true)
      expect(cb.isLLMPanicked()).toBe(false)
    })
  })

  describe("module singleton", () => {
    it("planningCircuitBreaker is a shared PlanningCircuitBreaker instance", () => {
      expect(planningCircuitBreaker).toBeInstanceOf(PlanningCircuitBreaker)
      planningCircuitBreaker.reset()
      expect(planningCircuitBreaker.isDDPanicked()).toBe(false)
      expect(planningCircuitBreaker.isLLMPanicked()).toBe(false)
    })
  })
})
