/**
 * @file log.test.ts
 * @description Tests for the leveled logger: JSON structured output via shared logger.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { log } from "@/lib/agent/planning/log"

describe("log", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("info always emitted via console.info", () => {
    log("info", "planning.started", { runId: "r1" })
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(consoleInfoSpy.mock.calls[0][0])
    expect(parsed.event).toBe("planning.started")
    expect(parsed.runId).toBe("r1")
    expect(parsed.ts).toBeDefined()
  })

  it("warn routed to console.warn", () => {
    log("warn", "planning.redeploy", { perspective: "conservative" })
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(consoleWarnSpy.mock.calls[0][0])
    expect(parsed.event).toBe("planning.redeploy")
    expect(parsed.perspective).toBe("conservative")
  })

  it("error routed to console.error", () => {
    log("error", "llm.failure", { phase: "aggregate" })
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0])
    expect(parsed.event).toBe("llm.failure")
    expect(parsed.phase).toBe("aggregate")
  })

  it("emits without a data payload", () => {
    log("info", "planning.completed")
    expect(consoleInfoSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(consoleInfoSpy.mock.calls[0][0])
    expect(parsed.event).toBe("planning.completed")
  })
})
