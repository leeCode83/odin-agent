import type { RiskThresholds } from "@/lib/agent/types"
import { RiskThresholdsDocSchema } from "@/lib/db/arango-types"
import { getDb } from "@/lib/db/arango-client"

/**
 * @function envDefaults
 * @description Provides default risk thresholds based on environment variables.
 * @returns {RiskThresholds} Default risk settings.
 */
function envDefaults(): RiskThresholds {
  return {
    confidence_threshold: Number(process.env.RISK_CONFIDENCE_THRESHOLD) || 70,
    max_position_usdc: Number(process.env.RISK_MAX_POSITION_USDC) || 100,
    max_leverage: Number(process.env.RISK_MAX_LEVERAGE) || 10,
    risk_per_trade_percent: Number(process.env.RISK_PER_TRADE_PERCENT) || 1,
  }
}

/**
 * @function getRiskThresholds
 * @description Retrieves user-specific risk thresholds from the database, falling back to defaults.
 * @param {string} userId - The ID of the user.
 * @returns {Promise<RiskThresholds>} The active risk thresholds.
 */
export async function getRiskThresholds(userId: string): Promise<RiskThresholds> {
  try {
    const db = getDb()
    if (!db) return envDefaults()

    const cursor = await db.query(
      "FOR doc IN risk_thresholds FILTER doc.userId == @userId LIMIT 1 RETURN doc",
      { userId }
    )
    const doc = await cursor.next()

    if (!doc) return envDefaults()

    const parsed = RiskThresholdsDocSchema.parse(doc)
    return {
      confidence_threshold: parsed.confidence_threshold,
      max_position_usdc: parsed.max_position_usdc,
      max_leverage: parsed.max_leverage,
      risk_per_trade_percent: parsed.risk_per_trade_percent,
    }
  } catch {
    return envDefaults()
  }
}
