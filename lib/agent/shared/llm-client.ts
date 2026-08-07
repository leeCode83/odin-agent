/**
 * @file shared/llm-client.ts
 * @description Singleton OpenAI client for DeepSeek API and model constants.
 *   Shared across DD and Planning agents to eliminate duplication.
 * @module shared
 * @layer util
 */

import OpenAI from "openai"

/** @constant {string} DEEPSEEK_BASE_URL - DeepSeek API base URL */
export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"

/** @constant {string} DEEPSEEK_MODEL - Standard DeepSeek model for non-thinking calls */
export const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"

/** @constant {string} DEEPSEEK_THINK_MODEL - DeepSeek reasoning/thinking model */
export const DEEPSEEK_THINK_MODEL = process.env.DEEPSEEK_THINK_MODEL || "deepseek-v4-pro"

let client: OpenAI | null = null

/**
 * @function getClient
 * @description Returns a singleton OpenAI client configured for DeepSeek API.
 *   Reads DEEPSEEK_API_KEY from environment. Returns null when key is missing.
 * @returns {OpenAI | null} The OpenAI client or null if API key is not set.
 */
export function getClient(): OpenAI | null {
  if (client) return client
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return null
  client = new OpenAI({
    apiKey,
    baseURL: DEEPSEEK_BASE_URL,
  })
  return client
}
