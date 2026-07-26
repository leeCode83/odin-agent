"use client";

import { useState, useCallback } from "react";

export function useTrade() {
  const [result, setResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const runTrade = useCallback(async (asset: string, userId: string, walletAddress: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/agent/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset, userId, walletAddress }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResult(data);
      return data;
    } catch (err) {
      console.error("Trade error:", err);
      setResult(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { result, loading, runTrade };
}
