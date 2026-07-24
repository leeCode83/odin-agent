"use client";

import { useState, useCallback } from "react";
import type { DDReport, TradePlan } from "@/lib/agent/types";

export function usePlanning() {
  const [tradePlan, setTradePlan] = useState<TradePlan | null>(null);
  const [loading, setLoading] = useState(false);

  const generatePlan = useCallback(async (ddReport: DDReport, userId: string, walletAddress: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/agent/planning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ddReport, userId, walletAddress }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTradePlan(data);
      return data as TradePlan;
    } catch (err) {
      console.error("Planning error:", err);
      setTradePlan(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { tradePlan, loading, generatePlan, setTradePlan };
}
