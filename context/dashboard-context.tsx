"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type { DDReport, TradePlan } from "@/lib/agent/types";

interface DashboardState {
  walletAddress: string;
  setWalletAddress: (addr: string) => void;
  asset: string;
  setAsset: (asset: string) => void;
  ddReport: DDReport | null;
  setDDReport: (report: DDReport | null) => void;
  tradePlan: TradePlan | null;
  setTradePlan: (plan: TradePlan | null) => void;
}

const DashboardContext = createContext<DashboardState | null>(null);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [walletAddress, setWalletAddress] = useState("");
  const [asset, setAsset] = useState("BTC");
  const [ddReport, setDDReport] = useState<DDReport | null>(null);
  const [tradePlan, setTradePlan] = useState<TradePlan | null>(null);

  return (
    <DashboardContext.Provider
      value={{
        walletAddress, setWalletAddress,
        asset, setAsset,
        ddReport, setDDReport,
        tradePlan, setTradePlan,
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboard must be used within DashboardProvider");
  return ctx;
}
