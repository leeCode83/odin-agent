import OpenAI from "openai"
import type { Perspective, PerspectiveResult, AggregatedReasoning } from "./types"
import { PerspectiveResultSchema } from "./types"
import type { DDReport, GraphPattern } from "@/lib/agent/types"
import {
  PERSPECTIVE_SYSTEM_PROMPTS,
  AGGREGATOR_SYSTEM_PROMPT,
  PERSPECTIVE_USER_PROMPT,
  AGGREGATOR_USER_PROMPT,
} from "./prompts"
import { withTimeout } from "@/lib/utils"

type ThinkingParams = { thinking: { type: string }; reasoning_effort: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function thinkingParams(): ThinkingParams & Record<string, any> {
  return { thinking: { type: "enabled" }, reasoning_effort: DEEPSEEK_REASONING_EFFORT }
}

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"
const DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || "high"

let client: OpenAI | null = null

/**
 * @function getClient
 * @description Creates or returns cached OpenAI client configured for DeepSeek.
 * Reads DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL from env.
 * @returns {OpenAI | null} OpenAI client or null if no API key configured.
 */
function getClient(): OpenAI | null {
  if (!process.env.DEEPSEEK_API_KEY) return null
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: DEEPSEEK_BASE_URL,
    })
  }
  return client
}

/**
 * @function generatePerspective
 * @description Generates a specific trading perspective (conservative, balanced, aggressive) using the DeepSeek LLM.
 * @param {Perspective} perspective - The perspective to adopt.
 * @param {DDReport} ddReport - The due diligence report to base the analysis on.
 * @param {GraphPattern[]} graphPatterns - Historical graph patterns related to the asset.
 * @returns {Promise<PerspectiveResult | null>} The generated perspective result or null if it fails.
 */
export async function generatePerspective(
  perspective: Perspective,
  ddReport: DDReport,
  graphPatterns: GraphPattern[]
): Promise<PerspectiveResult | null> {
  const c = getClient()
  if (!c) return null

  const attempt = async (): Promise<PerspectiveResult> => {
    const response = await withTimeout(
      c.chat.completions.create({
        model: DEEPSEEK_MODEL,
        max_tokens: 4096,
        ...thinkingParams(),
        messages: [
          { role: "system", content: PERSPECTIVE_SYSTEM_PROMPTS[perspective] },
          { role: "user", content: PERSPECTIVE_USER_PROMPT(ddReport, graphPatterns) },
        ],
      } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming),
      30000
    )

    const content = response.choices?.[0]?.message?.content || ""
    const reasoning = (response.choices?.[0]?.message as unknown as Record<string, unknown>)?.reasoning_content as string | undefined || ""

    const parsed = PerspectiveResultSchema.omit({ perspective: true, reasoningContent: true }).parse(
      JSON.parse(content)
    )

    return { ...parsed, perspective, reasoningContent: reasoning }
  }

  try {
    return await attempt()
  } catch {
    try {
      return await attempt()
    } catch {
      return null
    }
  }
}

/**
 * @function aggregatePerspectives
 * @description Aggregates multiple trading perspectives into a unified trade thesis using the DeepSeek LLM.
 * @param {PerspectiveResult[]} results - The generated perspective results.
 * @param {DDReport} _ddReport - The due diligence report (currently unused).
 * @returns {Promise<AggregatedReasoning | null>} The aggregated reasoning or null if it fails.
 */
export async function aggregatePerspectives(
  results: PerspectiveResult[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ddReport: DDReport
): Promise<AggregatedReasoning | null> {
  const c = getClient()
  if (!c) return null

  try {
    const response = await withTimeout(
      c.chat.completions.create({
        model: DEEPSEEK_MODEL,
        max_tokens: 4096,
        ...thinkingParams(),
        messages: [
          { role: "system", content: AGGREGATOR_SYSTEM_PROMPT },
          { role: "user", content: AGGREGATOR_USER_PROMPT(results) },
        ],
      } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming),
      30000
    )

    const content = response.choices?.[0]?.message?.content || ""
    const parsed = JSON.parse(content)

    return {
      side: parsed.side ?? "long",
      thesis: parsed.thesis || "",
      reasoning: parsed.reasoning || "",
      confidence_score: parsed.confidence_score ?? 0,
      confidence_breakdown: {
        factor_alignment: parsed.confidence_breakdown?.factor_alignment ?? 0,
        historical_match: parsed.confidence_breakdown?.historical_match ?? 0,
        signal_strength: parsed.confidence_breakdown?.signal_strength ?? 0,
      },
      leverage_suggested: parsed.leverage_suggested ?? 1,
      risk_flags: parsed.risk_flags ?? [],
    }
  } catch {
    return null
  }
}
