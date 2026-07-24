"use client";

import { useState, useCallback } from "react";
import type { DDReport, TradePlan } from "@/lib/agent/types";

export function useTradeDecision() {
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const approveTrade = useCallback(async (tradePlan: TradePlan, walletAddress: string, userId: string, ddReport?: DDReport) => {
    setApproving(true);
    try {
      const res = await fetch("/api/agent/trade/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tradePlan, walletAddress, userId, ddReport }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error("Approve error:", err);
      return null;
    } finally {
      setApproving(false);
    }
  }, []);

  const rejectTrade = useCallback(async (tradePlan: TradePlan, userId: string, reason?: string) => {
    setRejecting(true);
    try {
      const res = await fetch("/api/agent/trade/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tradePlan, userId, reason }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error("Reject error:", err);
      return null;
    } finally {
      setRejecting(false);
    }
  }, []);

  return { approveTrade, rejectTrade, approving, rejecting };
}
