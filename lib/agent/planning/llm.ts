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
      thesis: parsed.thesis || "",
      confidence: {
        factor_alignment: parsed.confidence_breakdown?.factor_alignment ?? 0,
        historical_match: parsed.confidence_breakdown?.historical_match ?? 0,
        signal_strength: parsed.confidence_breakdown?.signal_strength ?? 0,
      },
      confidenceScore: parsed.confidence_score ?? 0,
      direction: parsed.direction ?? "long",
      reasoning: parsed.reasoning || "",
    }
  } catch {
    return null
  }
}
