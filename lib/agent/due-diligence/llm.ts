import OpenAI from "openai"
import { FACTOR_SYSTEM_PROMPTS, AGGREGATION_PROMPT } from "@/lib/agent/due-diligence/prompts"

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
 * @function analyzeSection
 * @description Analyzes a specific due diligence factor using the DeepSeek LLM.
 * @param {string} factor - The due diligence factor (e.g., technical, onchain).
 * @param {unknown} rawData - The raw data to be analyzed.
 * @returns {Promise<{ score: number | null; summary: string | null; signals: string[] }>} Analysis results containing score, summary, and signals.
 */
export async function analyzeSection(factor: string, rawData: unknown): Promise<{ score: number | null; summary: string | null; signals: string[] }> {
  const c = getClient()
  if (!c) return { score: null, summary: null, signals: [] }

  try {
    const response = await c.chat.completions.create(
      {
        model: DEEPSEEK_MODEL,
        temperature: 0.3,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: FACTOR_SYSTEM_PROMPTS[factor] || "" },
          { role: "user", content: JSON.stringify(rawData) },
        ],
      },
      { timeout: 30_000, maxRetries: 2 }
    )
    const content = response.choices?.[0]?.message?.content || ""
    return JSON.parse(content)
  } catch {
    try {
      const response = await c.chat.completions.create(
        {
          model: DEEPSEEK_MODEL,
          temperature: 0.3,
          max_tokens: 1024,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: (FACTOR_SYSTEM_PROMPTS[factor] || "") + "\nOutput ONLY valid JSON." },
            { role: "user", content: JSON.stringify(rawData) },
          ],
        },
        { timeout: 30_000, maxRetries: 2 }
      )
      const content = response.choices?.[0]?.message?.content || ""
      return JSON.parse(content)
    } catch {
      return { score: null, summary: "LLM analysis failed", signals: [] }
    }
  }
}

/**
 * @function synthesizeSections
 * @description Synthesizes multiple section analyses into a unified due diligence report using the DeepSeek LLM.
 * @param {string} asset - The asset ticker.
 * @param {string} category - The category of the asset.
 * @param {Record<string, { score: number | null; summary: string | null; signals: string[] }>} sections - The analyzed sections.
 * @returns {Promise<{ thesis: string; confidence: number; flags: string[]; errors: string[] }>} The synthesized thesis, confidence score, risk flags, and any errors.
 */
export async function synthesizeSections(
  asset: string,
  category: string,
  sections: Record<string, { score: number | null; summary: string | null; signals: string[] }>
): Promise<{ thesis: string; confidence: number; flags: string[]; errors: string[] }> {
  const c = getClient()
  if (!c) return { thesis: "LLM unavailable", confidence: 0, flags: ["DeepSeek API key not configured"], errors: ["No API key"] }

  try {
    const response = await c.chat.completions.create(
      {
        model: DEEPSEEK_MODEL,
        temperature: 0.3,
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: AGGREGATION_PROMPT },
          { role: "user", content: JSON.stringify({ asset, category, sections }) },
        ],
      },
      { timeout: 30_000, maxRetries: 2 }
    )
    const content = response.choices?.[0]?.message?.content || ""
    const parsed = JSON.parse(content)
    return {
      thesis: parsed.aggregated_thesis || "",
      confidence: parsed.confidence_score || 0,
      flags: parsed.risk_flags || [],
      errors: parsed.errors || [],
    }
  } catch {
    return { thesis: "Aggregation failed", confidence: 0, flags: ["LLM aggregation failed"], errors: ["Synthesis error"] }
  }
}
