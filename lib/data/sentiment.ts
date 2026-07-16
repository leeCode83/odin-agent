import { withTimeout, withRetry } from "@/lib/utils"

const BASE = process.env.ALTERNATIVE_ME_BASE_URL || "https://api.alternative.me/fng/"

export interface FearGreedData {
  value: number | null
  classification: string | null
}

/**
 * @function fetchFearGreedIndex
 * @description Fetches Fear & Greed Index from alternative.me with 15s timeout and up to 2 retries.
 * @returns {Promise<FearGreedData>} Index value + classification, or nulls on all failures.
 */
export async function fetchFearGreedIndex(): Promise<FearGreedData> {
  return withRetry(
    async () => {
      const res = await withTimeout(fetch(BASE), 15_000)
      if (!res.ok) return { value: null, classification: null }
      const json = await res.json() as { data?: Array<{ value: string; value_classification: string }> }
      if (!json.data || json.data.length === 0) return { value: null, classification: null }
      const entry = json.data[0]
      return { value: Number(entry.value), classification: entry.value_classification }
    },
    { retries: 2 }
  ).catch(() => ({ value: null, classification: null }))
}
