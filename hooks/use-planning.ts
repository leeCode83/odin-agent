"use client";

/**
 * @file hooks/use-planning.ts
 * @description Client hook for the planning API. Posts { asset, userId,
 *   walletAddress, targetProfitPercent } (the route auto-runs DD internally)
 *   and holds the returned TradePlan plus the target-profit setting.
 * @module hooks
 */

import { useState, useCallback } from "react";
import type { TradePlan } from "@/lib/agent/types";

/**
 * @interface PlanningResponse
 * @description Response shape of POST /api/agent/planning: the validated
 *   TradePlan under `report`, plus run metadata.
 */
interface PlanningResponse {
  report: TradePlan;
  timing?: { totalMs: number; agentMs: number };
  iterations?: number;
  status?: string;
}

/**
 * @function usePlanning
 * @description Manages planning API calls and the target-profit input state.
 * @returns {object} { tradePlan, loading, targetProfitPercent, setTargetProfitPercent, generatePlan, setTradePlan }
 */
export function usePlanning() {
  const [tradePlan, setTradePlan] = useState<TradePlan | null>(null);
  const [targetProfitPercent, setTargetProfitPercent] = useState(100);
  const [loading, setLoading] = useState(false);

  /**
   * @function generatePlan
   * @description Requests a trade plan for an asset. The server runs DD
   *   internally, so no ddReport is sent.
   * @param {string} asset - Asset ticker to plan (from the DD section's analyzed asset).
   * @param {string} userId - User identifier.
   * @param {string} walletAddress - User's wallet address.
   * @returns {Promise<TradePlan | null>} The generated plan, or null on failure.
   */
  const generatePlan = useCallback(async (asset: string, userId: string, walletAddress: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/agent/planning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset, userId, walletAddress, targetProfitPercent }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PlanningResponse;
      setTradePlan(data.report);
      return data.report;
    } catch (err) {
      console.error("Planning error:", err);
      setTradePlan(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [targetProfitPercent]);

  return { tradePlan, loading, targetProfitPercent, setTargetProfitPercent, generatePlan, setTradePlan };
}
