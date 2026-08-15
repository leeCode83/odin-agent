/**
 * @file lib/agent/planning/fixed-planner.ts
 * @description Deterministic fixed planner (SA5) — replaces the LLM PLAN /
 *   RE-PLAN step. Always deploys exactly 3 perspectives (conservative,
 *   balance, aggressive) using static instruction templates from prompts.ts
 *   parameterized by the DDReport. Pure function: no LLM, no IO.
 * @module planning
 * @layer service
 */

import {
  CONSERVATIVE_INSTRUCTION_TEMPLATE,
  BALANCE_INSTRUCTION_TEMPLATE,
  AGGRESSIVE_INSTRUCTION_TEMPLATE,
} from "./prompts"
import type { FixedPerspectiveFacts } from "./prompts"
import type { DDReport } from "@/lib/agent/types"
import type { Perspective } from "./types"

/**
 * @interface FixedPerspectivePlan
 * @description A single fixed-perspective deployment: which perspective to
 *   emulate and the instruction string rendered from its static template.
 */
export interface FixedPerspectivePlan {
  perspective: Perspective
  instructions: string
}

/**
 * @function buildFacts
 * @description Renders DDReport facts into interpolation strings safe for the
 *   static templates — never throws on optional/missing fields. Numeric
 *   section scores are listed as "name score" (null scores skipped); risk
 *   highlights combine risk_flags strings with risk-entry descriptions;
 *   empty/missing sets fall back to placeholder phrases.
 * @param {DDReport} ddReport - Due diligence report from the DD agent.
 * @returns {FixedPerspectiveFacts} Interpolation-safe fact strings.
 */
function buildFacts(ddReport: DDReport): FixedPerspectiveFacts {
  const sections = ddReport.sections ?? {}
  const scores = Object.entries(sections)
    .flatMap(([name, section]) =>
      typeof section !== "undefined" && typeof section.score === "number"
        ? [`${name} ${section.score}`]
        : []
    )
    .join(", ")

  const riskHighlights = [
    ...(ddReport.risk_flags ?? []),
    ...(ddReport.risks ?? []).map(
      (risk) => `${risk.description}${risk.severity ? ` (${risk.severity})` : ""}`
    ),
  ].join(", ")

  return {
    asset: ddReport.asset || "this asset",
    category: ddReport.category || "unknown",
    scores: scores || "no factor scores available",
    riskHighlights: riskHighlights || "none noted",
  }
}

/**
 * @function buildFixedPerspectives
 * @description Builds the deterministic deployment plan for the 3 perspective
 *   subagents (SA5). Always length 3, order fixed (conservative, balance,
 *   aggressive), instructions rendered from the static templates parameterized
 *   by the DDReport. No LLM PLAN/RE-PLAN call — replaces the orchestrator
 *   planning step, not the subagent execution.
 * @param {DDReport} ddReport - Due diligence report from the DD agent.
 * @returns {FixedPerspectivePlan[]} Three perspective plans in fixed order.
 */
export function buildFixedPerspectives(ddReport: DDReport): FixedPerspectivePlan[] {
  const facts = buildFacts(ddReport)
  return [
    { perspective: "conservative", instructions: CONSERVATIVE_INSTRUCTION_TEMPLATE(facts) },
    { perspective: "balance", instructions: BALANCE_INSTRUCTION_TEMPLATE(facts) },
    { perspective: "aggressive", instructions: AGGRESSIVE_INSTRUCTION_TEMPLATE(facts) },
  ]
}
