import { withTimeout, withRetry } from "@/lib/utils"
import type { FearGreedData } from "@/lib/data/fetch-utils"

const BASE = process.env.ALTERNATIVE_ME_BASE_URL || "https://api.alternative.me/fng/"

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
