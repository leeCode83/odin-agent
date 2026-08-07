import { describe, it, expect } from "vitest"
import { normalizeThought, formatZodErrors } from "@/lib/agent/shared/llm-helpers"
import { z } from "zod"

describe("normalizeThought()", () => {
  it("normalizes tool_call with missing reasoning to empty string", () => {
    const raw = {
      action: "tool_call",
      toolName: "get_price",
      params: { asset: "BTC" }
    }
    const result = normalizeThought(raw) as Record<string, unknown>
    expect(result.action).toBe("tool_call")
    expect(result.reasoning).toBe("")
  })

  it("does not overwrite existing reasoning in tool_call", () => {
    const raw = {
      action: "tool_call",
      toolName: "get_price",
      params: { asset: "BTC" },
      reasoning: "I need to check the price."
    }
    const result = normalizeThought(raw) as Record<string, unknown>
    expect(result.reasoning).toBe("I need to check the price.")
  })

  it("normalizes missing action to return", () => {
    const raw = { score: 50 }
    const result = normalizeThought(raw) as Record<string, unknown>
    expect(result.action).toBe("return")
    expect(result.reasoning).toBe("No reasoning provided — LLM returned incomplete response")
  })

  it("passes through primitives unchanged", () => {
    expect(normalizeThought(null)).toBeNull()
    expect(normalizeThought("hello")).toBe("hello")
    expect(normalizeThought(42)).toBe(42)
  })
})

describe("formatZodErrors()", () => {
  it("returns empty string for empty issues array", () => {
    expect(formatZodErrors([])).toBe("")
  })

  it("formats standard field requirement error", () => {
    const issues: z.ZodIssue[] = [
      {
        code: z.ZodIssueCode.invalid_type,
        expected: "string",
        received: "undefined",
        path: ["reasoning"],
        message: "Required",
      } as z.ZodIssue
    ]
    const result = formatZodErrors(issues)
    expect(result).toContain('Your previous response had 1 validation error')
    expect(result).toContain('1. Field "reasoning"')
    expect(result).toContain('Required')
  })

  it("formats nested array field error nicely", () => {
    const issues: z.ZodIssue[] = [
      {
        code: z.ZodIssueCode.invalid_type,
        expected: "number",
        received: "string",
        path: ["signals", 0, "strength"],
        message: "Expected number, received string",
      } as z.ZodIssue
    ]
    const result = formatZodErrors(issues)
    expect(result).toContain('1. Field "signals[0].strength"')
    expect(result).toContain('Expected number, received string')
  })

  it("handles multiple errors", () => {
    const issues: z.ZodIssue[] = [
      { code: z.ZodIssueCode.invalid_type, expected: "string", received: "undefined", path: ["toolName"], message: "Required" } as z.ZodIssue,
      { code: z.ZodIssueCode.invalid_type, expected: "string", received: "undefined", path: ["reasoning"], message: "Required" } as z.ZodIssue
    ]
    const result = formatZodErrors(issues)
    expect(result).toContain('Your previous response had 2 validation errors:')
    expect(result).toContain('1. Field "toolName"')
    expect(result).toContain('2. Field "reasoning"')
    expect(result).toContain('Please return corrected JSON only.')
  })
})
