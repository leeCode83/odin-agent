"use client";

import { useState, useCallback } from "react";
import type { UserBalance } from "@/lib/data/hyperliquid";

export function useBalance(walletAddress: string) {
  const [balance, setBalance] = useState<UserBalance | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchBalance = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/agent/balance?walletAddress=${walletAddress}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBalance(data);
    } catch (err) {
      console.error("Balance fetch error:", err);
      setBalance(null);
    } finally {
      setLoading(false);
    }
  }, [walletAddress]);

  return { balance, loading, fetchBalance };
}
