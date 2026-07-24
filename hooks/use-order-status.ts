"use client";

import { useState, useCallback } from "react";

interface OrderStatus {
  oid: number;
  status: string;
  fillAmount: number | null;
  fillPrice: number | null;
}

export function useOrderStatus() {
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const checkStatus = useCallback(async (oid: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/agent/execution/status?oid=${oid}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(data);
      return data as OrderStatus;
    } catch (err) {
      console.error("Status check error:", err);
      setStatus(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { status, loading, checkStatus };
}
