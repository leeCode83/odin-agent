/**
 * @file logger.test.ts
 * @description Tests for shared structured logger with JSON output and level gating.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createLogger, ddLog } from "@/lib/agent/shared/logger"

describe("shared/logger", () => {
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

  it("ddLog writes valid JSON to the correct console level", () => {
    ddLog("info", "test_event", { asset: "BTC", custom: 123 })

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1)
    const logString = consoleInfoSpy.mock.calls[0][0]
    expect(typeof logString).toBe("string")

    const parsed = JSON.parse(logString)
    expect(parsed.event).toBe("test_event")
    expect(parsed.asset).toBe("BTC")
    expect(parsed.custom).toBe(123)
    expect(parsed.ts).toBeDefined()
    expect(typeof parsed.ts).toBe("number")
    expect(parsed.level).toBe("info")
  })

  it("createLogger binds base context correctly", () => {
    const logger = createLogger({ module: "agent", runId: "r123" })
    logger("error", "parse_failed", { reason: "invalid json" })

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0])
    expect(parsed.event).toBe("parse_failed")
    expect(parsed.level).toBe("error")
    expect(parsed.module).toBe("agent")
    expect(parsed.runId).toBe("r123")
    expect(parsed.reason).toBe("invalid json")
    expect(parsed.ts).toBeDefined()
  })

  it("warn level routes to console.warn", () => {
    ddLog("warn", "test_warn", {})
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1)
    expect(consoleInfoSpy).not.toHaveBeenCalled()
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it("error level routes to console.error", () => {
    ddLog("error", "test_error", {})
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    expect(consoleInfoSpy).not.toHaveBeenCalled()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it("createLogger without base context works", () => {
    const logger = createLogger({})
    logger("info", "minimal_event")

    expect(consoleInfoSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(consoleInfoSpy.mock.calls[0][0])
    expect(parsed.event).toBe("minimal_event")
    expect(parsed.level).toBe("info")
  })
})
