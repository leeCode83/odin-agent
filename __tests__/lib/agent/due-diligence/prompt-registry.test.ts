import { describe, it, expect, vi, afterEach } from "vitest"
import { getPrompt, registerPrompt } from "@/lib/agent/due-diligence/prompt-registry"

describe("prompt-registry", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("returns registered prompt if no override", () => {
    registerPrompt("TEST_PROMPT", "base prompt content v1.0")
    expect(getPrompt("TEST_PROMPT")).toBe("base prompt content v1.0")
  })

  it("returns env override if set", () => {
    registerPrompt("TEST_OVERRIDE", "base prompt")
    vi.stubEnv("DD_PROMPT_OVERRIDE_TEST_OVERRIDE", "overridden content")
    
    expect(getPrompt("TEST_OVERRIDE")).toBe("overridden content")
  })

  it("throws if prompt is not registered", () => {
    expect(() => getPrompt("NON_EXISTENT")).toThrow(/Prompt NON_EXISTENT is not registered/)
  })
})
