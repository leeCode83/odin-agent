"use client";

import { useState, useCallback } from "react";
import type { DDReport, TradePlan } from "@/lib/agent/types";

export function useExecution() {
  const [executing, setExecuting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [closing, setClosing] = useState(false);

  const executePlan = useCallback(async (tradePlan: TradePlan, walletAddress: string, userId: string, ddReport?: DDReport) => {
    setExecuting(true);
    try {
      const res = await fetch("/api/agent/execution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tradePlan, walletAddress, userId, ddReport }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error("Execution error:", err);
      return null;
    } finally {
      setExecuting(false);
    }
  }, []);

  const cancelAll = useCallback(async () => {
    setCancelling(true);
    try {
      const res = await fetch("/api/agent/execution/cancel", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error("Cancel error:", err);
      return null;
    } finally {
      setCancelling(false);
    }
  }, []);

  const closeAll = useCallback(async (walletAddress?: string) => {
    setClosing(true);
    try {
      const res = await fetch("/api/agent/execution/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error("Close all error:", err);
      return null;
    } finally {
      setClosing(false);
    }
  }, []);

  const closeCoin = useCallback(async (coin: string, walletAddress?: string) => {
    setClosing(true);
    try {
      const res = await fetch(`/api/agent/execution/close/${coin}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error(`Close ${coin} error:`, err);
      return null;
    } finally {
      setClosing(false);
    }
  }, []);

  return { executePlan, cancelAll, closeAll, closeCoin, executing, cancelling, closing };
}
