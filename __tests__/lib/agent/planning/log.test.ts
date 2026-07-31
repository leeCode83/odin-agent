/**
 * @file log.test.ts
 * @description Tests for the leveled logger (spec §9.8): DEBUG gated behind
 * NODE_ENV === "development", info/warn/error always emitted, console routing,
 * and payload forwarding. Spies on console.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { log } from "@/lib/agent/planning/log"

/**
 * @function setNodeEnv
 * @description Sets process.env.NODE_ENV for a test and returns a restore fn.
 * @param {string} env - Value to set.
 * @returns {() => void} Restore function returning NODE_ENV to its prior value.
 */
function setNodeEnv(env: string): () => void {
  const original = process.env.NODE_ENV
  // reason: NODE_ENV is typed read-only on process.env; tests need to toggle it.
  ;(process.env as Record<string, string | undefined>).NODE_ENV = env
  return () => {
    ;(process.env as Record<string, string | undefined>).NODE_ENV = original
  }
}

describe("log", () => {
  let restoreEnv: () => void

  beforeEach(() => {
    vi.restoreAllMocks()
    restoreEnv = setNodeEnv("test")
  })

  afterEach(() => {
    restoreEnv()
    vi.restoreAllMocks()
  })

  it("info always emitted via console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    log("info", "planning.started", { runId: "r1" })
    expect(spy).toHaveBeenCalledWith("[info] planning.started", { runId: "r1" })
  })

  it("warn routed to console.warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    log("warn", "planning.redeploy", { perspective: "conservative" })
    expect(spy).toHaveBeenCalledWith("[warn] planning.redeploy", { perspective: "conservative" })
  })

  it("error routed to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    log("error", "llm.failure", { phase: "aggregate" })
    expect(spy).toHaveBeenCalledWith("[error] llm.failure", { phase: "aggregate" })
  })

  it("debug suppressed when NODE_ENV !== development", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    log("debug", "perspective.step", { perspective: "balance" })
    expect(spy).not.toHaveBeenCalled()
  })

  it("debug emitted via console.log when NODE_ENV === development", () => {
    const restore = setNodeEnv("development")
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    log("debug", "perspective.step", { toolName: "web_search", success: true })
    expect(spy).toHaveBeenCalledWith("[debug] perspective.step", { toolName: "web_search", success: true })
    restore()
  })

  it("emits without a data payload", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    log("info", "planning.completed")
    expect(spy).toHaveBeenCalledWith("[info] planning.completed")
  })

  it("debug gating applies regardless of payload", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    log("debug", "perspective.step")
    expect(spy).not.toHaveBeenCalled()
  })
})
