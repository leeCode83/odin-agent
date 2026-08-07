import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  makePlanningSystemPrompt,
  PLAN_PROMPT,
  AGGREGATE_PROMPT,
  REPLAN_PROMPT,
} from "@/lib/agent/planning/prompts"
import type { ToolRegistry } from "@/lib/agent/due-diligence/tools/types"

describe("makePlanningSystemPrompt", () => {
  const tools: ToolRegistry = {
    compute_atr: {
      name: "compute_atr",
      description: "Average True Range from candle data",
      parameters: z.object({ asset: z.string(), period: z.number().default(14) }),
      execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
    },
    web_search: {
      name: "web_search",
      description: "Search the web for recent news and sentiment",
      parameters: z.object({ query: z.string() }),
      execute: async () => ({ success: true, data: {}, metadata: { source: "test", latencyMs: 0 } }),
    },
  }

  it("returns a function that renders the perspective persona", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Validate")
    expect(prompt).toContain("conservative trading analyst")
  })

  it("renders targetProfitPercent and instructs not to re-analyze indicators", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("balance", tools, "Validate")
    expect(prompt).toContain("100%")
    expect(prompt).toContain("do NOT re-analyze technical indicators")
    expect(prompt).toContain("the DDReport already did that")
  })

  it("lists the four tasks from spec 7.2", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 50 })("aggressive", tools, "Validate")
    expect(prompt).toContain("Validating the DDReport's conclusions against current market data")
    expect(prompt).toContain("Computing risk parameters")
    expect(prompt).toContain("external factors")
    expect(prompt).toContain("50%")
  })

  it("renders tool descriptions with parameter schemas via describeZodSchema", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Validate")
    expect(prompt).toContain("compute_atr({asset, period})")
    expect(prompt).toContain("Average True Range from candle data")
    expect(prompt).toContain("web_search({query})")
    expect(prompt).toContain("Search the web for recent news and sentiment")
  })

  it("requires at least 2 tools before returning", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Validate")
    expect(prompt).toContain("Use at least 2 tools before returning")
  })

  it("describes the return format with planning fields", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Validate")
    expect(prompt).toContain('set "action" to "return"')
    expect(prompt).toContain('"side": "long" | "short" | "no_trade"')
    expect(prompt).toContain('"entry_price"')
    expect(prompt).toContain('"suggested_stop_loss"')
    expect(prompt).toContain('"suggested_take_profit"')
    expect(prompt).toContain('"suggested_leverage"')
    expect(prompt).toContain('"suggested_position_size_usdc"')
    expect(prompt).toContain('"risk_flags"')
  })

  it("describes the tool_call return format", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Validate")
    expect(prompt).toContain('"action": "tool_call"')
    expect(prompt).toContain('"toolName"')
    expect(prompt).toContain('"params"')
  })

  it("includes the instruction", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Focus on funding regime")
    expect(prompt).toContain("Focus on funding regime")
  })

  it("includes CoT ordering and negative constraints", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Validate")
    expect(prompt).toContain('"reasoning": "...", // ALWAYS REQUIRED')
    expect(prompt).toContain('Think step by step in the reasoning field before deciding on an action.')
    expect(prompt).toContain('Do NOT invent price levels.')
  })

  it("appends the degraded-DD note when degradedFactors provided", () => {
    const prompt = makePlanningSystemPrompt({
      targetProfitPercent: 100,
      degradedFactors: ["technical"],
    })("conservative", tools, "Validate")

    expect(prompt).toContain(
      "Note: DD analysis incomplete — factors technical failed. Account for missing data explicitly."
    )
  })

  it("joins multiple failed factors with comma in the degraded note", () => {
    const prompt = makePlanningSystemPrompt({
      targetProfitPercent: 100,
      degradedFactors: ["technical", "sentiment"],
    })("balance", tools, "Validate")

    expect(prompt).toContain("factors technical, sentiment failed.")
  })

  it("omits the degraded-DD note when no factors failed", () => {
    const prompt = makePlanningSystemPrompt({ targetProfitPercent: 100 })("conservative", tools, "Validate")

    expect(prompt).not.toContain("Note: DD analysis incomplete")
  })
})

describe("PLAN_PROMPT", () => {
  it("describes orchestrating 3 perspectives with instructions and priorities", () => {
    expect(PLAN_PROMPT).toContain("conservative")
    expect(PLAN_PROMPT).toContain("balance")
    expect(PLAN_PROMPT).toContain("aggressive")
    expect(PLAN_PROMPT).toContain("instruction")
    expect(PLAN_PROMPT).toContain("priority")
    expect(PLAN_PROMPT).toContain("DDReport")
  })

  it("returns a JSON object with a subagents array", () => {
    expect(PLAN_PROMPT).toContain("subagents")
  })

  it("includes few-shot examples for perspectives", () => {
    expect(PLAN_PROMPT).toContain("Example for conservative (bullish):")
    expect(PLAN_PROMPT).toContain("Example for aggressive (bullish):")
  })
})

describe("AGGREGATE_PROMPT", () => {
  it("includes the 2+ no_trade consensus rule", () => {
    expect(AGGREGATE_PROMPT).toContain("If 2+ perspectives conclude no_trade, final action is no_trade")
  })

  it("includes profit_feasible and no_trade_reason fields", () => {
    expect(AGGREGATE_PROMPT).toContain("profit_feasible")
    expect(AGGREGATE_PROMPT).toContain("no_trade_reason")
  })

  it("includes consensus and contradiction fields", () => {
    expect(AGGREGATE_PROMPT).toContain("consensus_alignment")
    expect(AGGREGATE_PROMPT).toContain("contradictions")
  })

  it("includes final plan parameters", () => {
    expect(AGGREGATE_PROMPT).toContain("entry_price")
    expect(AGGREGATE_PROMPT).toContain("stop_loss")
    expect(AGGREGATE_PROMPT).toContain("take_profit")
    expect(AGGREGATE_PROMPT).toContain("position_size_usdc")
    expect(AGGREGATE_PROMPT).toContain("leverage_suggested")
  })

  it("includes CoT instructions and negative constraints", () => {
    expect(AGGREGATE_PROMPT).toContain("Work through each step below before writing the final JSON.")
    expect(AGGREGATE_PROMPT).toContain("Do NOT omit contradictions.")
  })
})

describe("REPLAN_PROMPT", () => {
  it("targets low-consensus perspectives with past reports", () => {
    expect(REPLAN_PROMPT).toMatch(/low-consensus|low consensus/i)
    expect(REPLAN_PROMPT).toMatch(/previous reports|past reports/i)
  })

  it("asks for targeted new instructions with priorities", () => {
    expect(REPLAN_PROMPT).toContain("instruction")
    expect(REPLAN_PROMPT).toContain("priority")
    expect(REPLAN_PROMPT).toContain("perspective")
  })

  it("includes specific instruction for tool and example", () => {
    expect(REPLAN_PROMPT).toContain("Specify which tool the perspective must call first")
    expect(REPLAN_PROMPT).toContain("Example instruction:")
  })
})

describe("orchestrator prompts — DeepSeek json_object requirement", () => {
  // reason: DeepSeek rejects response_format json_object with HTTP 400 unless
  // the prompt mentions the word "json" somewhere. PLAN/REPLAN/AGGREGATE all
  // use json_object, so every prompt must carry the keyword.
  it("PLAN_PROMPT contains the JSON keyword", () => {
    expect(PLAN_PROMPT).toMatch(/\bJSON\b/i)
  })

  it("REPLAN_PROMPT contains the JSON keyword", () => {
    expect(REPLAN_PROMPT).toMatch(/\bJSON\b/i)
  })

  it("AGGREGATE_PROMPT contains the JSON keyword", () => {
    expect(AGGREGATE_PROMPT).toMatch(/\bJSON\b/i)
  })
})
