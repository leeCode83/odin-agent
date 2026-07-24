"use client";

import { useState, useCallback } from "react";
import type { DDReport } from "@/lib/agent/types";

export function useDD() {
  const [ddReport, setDDReport] = useState<DDReport | null>(null);
  const [loading, setLoading] = useState(false);

  const runDD = useCallback(async (asset: string, userId: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/agent/dd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asset, userId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDDReport(data);
      return data as DDReport;
    } catch (err) {
      console.error("DD error:", err);
      setDDReport(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { ddReport, loading, runDD, setDDReport };
}
