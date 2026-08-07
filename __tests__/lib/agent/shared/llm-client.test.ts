/**
 * @file llm-client.test.ts
 * @description Tests for shared DeepSeek OpenAI client singleton and model constants.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

describe("shared/llm-client", () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_BASE_URL
    delete process.env.DEEPSEEK_MODEL
    delete process.env.DEEPSEEK_THINK_MODEL
  })

  afterEach(() => {
    process.env = originalEnv
  })

  async function loadModule() {
    return await import("@/lib/agent/shared/llm-client")
  }

  it("DEEPSEEK_BASE_URL defaults to https://api.deepseek.com", async () => {
    const { DEEPSEEK_BASE_URL } = await loadModule()
    expect(DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com")
  })

  it("DEEPSEEK_MODEL defaults to deepseek-v4-flash", async () => {
    const { DEEPSEEK_MODEL } = await loadModule()
    expect(DEEPSEEK_MODEL).toBe("deepseek-v4-flash")
  })

  it("DEEPSEEK_THINK_MODEL defaults to deepseek-v4-pro", async () => {
    const { DEEPSEEK_THINK_MODEL } = await loadModule()
    expect(DEEPSEEK_THINK_MODEL).toBe("deepseek-v4-pro")
  })

  it("getClient returns null when DEEPSEEK_API_KEY is missing", async () => {
    const { getClient } = await loadModule()
    expect(getClient()).toBeNull()
  })

  it("getClient returns same instance on repeated calls (singleton)", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key"
    const { getClient } = await loadModule()
    const a = getClient()
    const b = getClient()
    expect(a).toBe(b)
    expect(a).not.toBeNull()
  })
})
