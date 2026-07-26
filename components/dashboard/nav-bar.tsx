"use client"

import { useRef } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { Shield, Bot } from "lucide-react"
import { useDashboard } from "@/context/dashboard-context"

export function NavBar() {
  const navRef = useRef<HTMLElement>(null)

  useGSAP(() => {
    gsap.fromTo(navRef.current, {
      y: -40,
      opacity: 0,
      filter: "blur(8px)",
    }, {
      y: 0,
      opacity: 1,
      filter: "blur(0px)",
      duration: 0.8,
      ease: "cubic-bezier(0.32, 0.72, 0, 1)",
    })
  }, { scope: navRef })

  const { walletAddress, ddReport, tradePlan } = useDashboard()

  const status = ddReport
    ? tradePlan
      ? "Trading"
      : "Analyzing"
    : walletAddress
      ? "Ready"
      : "Offline"

  const statusColor = ddReport
    ? tradePlan
      ? "text-emerald-400"
      : "text-violet-400"
    : walletAddress
      ? "text-amber-400"
      : "text-zinc-500"

  return (
    <nav
      ref={navRef}
      className="fixed top-0 left-0 right-0 z-50 flex justify-center mt-6 px-4"
    >
      <div className="glass-strong rounded-full px-6 py-3 flex items-center gap-6">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-violet-500 to-emerald-500 flex items-center justify-center">
            <Bot className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-white text-sm tracking-wide">ODIN</span>
        </div>

        <div className="w-px h-5 bg-white/10" />

        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <Shield className="w-3.5 h-3.5" />
          <span className="font-mono">
            {walletAddress
              ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
              : "No wallet"}
          </span>
        </div>

        <div className="w-px h-5 bg-white/10" />

        <div className="flex items-center gap-2 text-xs">
          <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${
            status === "Trading" ? "bg-emerald-400" :
            status === "Analyzing" ? "bg-violet-400" :
            status === "Ready" ? "bg-amber-400" : "bg-zinc-500"
          }`} />
          <span className={statusColor}>{status}</span>
        </div>
      </div>
    </nav>
  )
}
