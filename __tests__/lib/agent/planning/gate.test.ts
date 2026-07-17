import { describe, it, expect } from "vitest"
import { autonomyGate } from "@/lib/agent/planning/gate"
import type { RiskThresholds } from "@/lib/agent/types"

type TestCase = {
  name: string
  confidence: number
  positionSizeUsdc: number
  thresholds: RiskThresholds
  expected: "auto" | "approve"
}

const cases: TestCase[] = [
  {
    name: "both conditions met → auto",
    confidence: 80,
    positionSizeUsdc: 50,
    thresholds: { confidenceThreshold: 70, maxPositionUsdc: 100, maxLeverage: 10, riskPerTradePercent: 2 },
    expected: "auto",
  },
  {
    name: "confidence too low → approve",
    confidence: 60,
    positionSizeUsdc: 50,
    thresholds: { confidenceThreshold: 70, maxPositionUsdc: 100, maxLeverage: 10, riskPerTradePercent: 2 },
    expected: "approve",
  },
  {
    name: "size too large → approve",
    confidence: 80,
    positionSizeUsdc: 150,
    thresholds: { confidenceThreshold: 70, maxPositionUsdc: 100, maxLeverage: 10, riskPerTradePercent: 2 },
    expected: "approve",
  },
  {
    name: "both fail → approve",
    confidence: 60,
    positionSizeUsdc: 150,
    thresholds: { confidenceThreshold: 70, maxPositionUsdc: 100, maxLeverage: 10, riskPerTradePercent: 2 },
    expected: "approve",
  },
  {
    name: "exactly at boundaries → auto",
    confidence: 70,
    positionSizeUsdc: 100,
    thresholds: { confidenceThreshold: 70, maxPositionUsdc: 100, maxLeverage: 10, riskPerTradePercent: 2 },
    expected: "auto",
  },
  {
    name: "one below boundary → approve",
    confidence: 69,
    positionSizeUsdc: 100,
    thresholds: { confidenceThreshold: 70, maxPositionUsdc: 100, maxLeverage: 10, riskPerTradePercent: 2 },
    expected: "approve",
  },
]

describe("autonomyGate", () => {
  cases.forEach(({ name, confidence, positionSizeUsdc, thresholds, expected }) => {
    it(name, () => {
      expect(autonomyGate(confidence, positionSizeUsdc, thresholds)).toBe(expected)
    })
  })
})
