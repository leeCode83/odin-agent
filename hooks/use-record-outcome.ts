"use client";

import { useState, useCallback } from "react";

export function useRecordOutcome() {
  const [loading, setLoading] = useState(false);

  const recordOutcome = useCallback(async (
    decisionKey: string,
    result: "profit" | "loss" | "breakeven" | "cancelled",
    details?: { pnlUsdc?: number; pnlPercent?: number; exitPrice?: number; exitReason?: string }
  ) => {
    setLoading(true);
    try {
      const res = await fetch("/api/agent/execution/outcome", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionKey, result, ...details }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error("Outcome error:", err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { recordOutcome, loading };
}
