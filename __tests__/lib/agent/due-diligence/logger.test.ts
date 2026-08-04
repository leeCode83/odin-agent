import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ddLog, createDdLogger } from "@/lib/agent/due-diligence/logger"

describe("logger", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {})
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
  })

  it("createDdLogger binds context correctly", () => {
    const logger = createDdLogger({ runId: "r123", phase: "think" })
    logger("error", "parse_failed", { reason: "invalid json" })

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0])
    expect(parsed.runId).toBe("r123")
    expect(parsed.phase).toBe("think")
    expect(parsed.event).toBe("parse_failed")
    expect(parsed.reason).toBe("invalid json")
  })
})
