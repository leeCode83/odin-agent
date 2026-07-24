"use client";

import { useState, useCallback } from "react";

interface InitResult {
  agentAddress: string;
  agentPrivateKey: string;
  approved: boolean;
  message: string;
}

export function useInitWallet() {
  const [result, setResult] = useState<InitResult | null>(null);
  const [loading, setLoading] = useState(false);

  const initWallet = useCallback(async (agentName?: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/agent/execution/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentName }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setResult(data);
      return data as InitResult;
    } catch (err) {
      console.error("Init wallet error:", err);
      setResult(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { result, loading, initWallet };
}
