import { describe, it, expect } from "vitest"
import { REACT_SYSTEM_PROMPT } from "@/lib/agent/due-diligence/prompts"

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
})
