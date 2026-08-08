import { describe, it, expect } from "vitest"
import { REACT_SYSTEM_PROMPT, PLAN_PROMPT, AGGREGATE_PROMPT, REPLAN_PROMPT, DEPLOYMENT_RULES } from "@/lib/agent/due-diligence/prompts"

describe("REACT_SYSTEM_PROMPT", () => {
  it("includes specific context for technical factor", () => {
    const prompt = REACT_SYSTEM_PROMPT("technical", {}, "Analyze this.")
    expect(prompt).toContain("Focus on price action, volume, momentum indicators")
  })

  it("includes specific context for onchain factor", () => {
    const prompt = REACT_SYSTEM_PROMPT("onchain", {}, "Analyze this.")
    expect(prompt).toContain("Focus on network activity, wallet balances")
  })

  it("includes specific context for sentiment factor", () => {
    const prompt = REACT_SYSTEM_PROMPT("sentiment", {}, "Analyze this.")
    expect(prompt).toContain("Focus on social media trends, news sentiment")
  })

  it("includes specific context for fundamental factor", () => {
    const prompt = REACT_SYSTEM_PROMPT("fundamental", {}, "Analyze this.")
    expect(prompt).toContain("Focus on tokenomics, protocol revenue")
  })

  it("includes default context for unknown factor", () => {
    const prompt = REACT_SYSTEM_PROMPT("unknown_factor", {}, "Analyze this.")
    expect(prompt).toContain("Analyze relevant data points for this factor.")
  })

  it("includes CoT ordering and negative constraints", () => {
    const prompt = REACT_SYSTEM_PROMPT("technical", {}, "Analyze this.")
    expect(prompt).toContain('"reasoning": "...",  // ALWAYS REQUIRED for BOTH actions')
    expect(prompt).toContain('Think step by step in the reasoning field before deciding on an action.')
    expect(prompt).toContain('Do NOT fabricate data.')
  })
})

describe("DEPLOYMENT_RULES", () => {
  it("defines the four valid factors and the mandatory/optional split", () => {
    expect(DEPLOYMENT_RULES).toContain("Only 4 factors exist: technical, onchain, sentiment, fundamental")
    expect(DEPLOYMENT_RULES).toContain("technical and onchain are MANDATORY")
    expect(DEPLOYMENT_RULES).toContain("sentiment is OPTIONAL")
    expect(DEPLOYMENT_RULES).toContain("fundamental is OPTIONAL")
  })
})

describe("PLAN_PROMPT", () => {
  it("includes few-shot examples", () => {
    expect(PLAN_PROMPT).toContain('Example instruction for technical factor:')
    expect(PLAN_PROMPT).toContain('Example instruction for onchain factor:')
  })

  it("embeds DEPLOYMENT_RULES and the conditional examples", () => {
    expect(PLAN_PROMPT).toContain(DEPLOYMENT_RULES)
    expect(PLAN_PROMPT).toContain('only if technical and onchain tool calls failed')
    expect(PLAN_PROMPT).toContain('only if you have zero knowledge of the asset')
  })
})

describe("REPLAN_PROMPT", () => {
  it("includes specific instruction for tool and example", () => {
    expect(REPLAN_PROMPT).toContain('Your new instruction must explicitly name which tool to call first')
    expect(REPLAN_PROMPT).toContain('Example instruction:')
  })

  it("embeds DEPLOYMENT_RULES and keeps mandatory factors on re-deploy", () => {
    expect(REPLAN_PROMPT).toContain(DEPLOYMENT_RULES)
    expect(REPLAN_PROMPT).toContain('technical and onchain remain mandatory when re-deploying')
  })
})

describe("AGGREGATE_PROMPT", () => {
  it("includes negative constraint for contradictions", () => {
    expect(AGGREGATE_PROMPT).toContain('If factors show contradictory signals, you MUST list them in the contradictions array.')
    expect(AGGREGATE_PROMPT).toContain('Do NOT ignore contradictions.')
  })
})
