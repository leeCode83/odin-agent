"use client"

import { useRef } from "react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { DashboardProvider } from "@/context/dashboard-context"
import { NavBar } from "@/components/dashboard/nav-bar"
import { DDSection } from "@/components/dashboard/dd-section"
import { PlanSection } from "@/components/dashboard/plan-section"

function DashboardInner() {
  const containerRef = useRef<HTMLDivElement>(null)

  useGSAP(() => {
    gsap.fromTo(containerRef.current, {
      opacity: 0,
      y: 40,
    }, {
      opacity: 1,
      y: 0,
      duration: 0.8,
      ease: "cubic-bezier(0.32, 0.72, 0, 1)",
      stagger: 0.08,
    })
  }, { scope: containerRef })

  return (
    <>
      <NavBar />

      <main
        ref={containerRef}
        className="relative pt-28 pb-20 px-4 sm:px-6 lg:px-8 max-w-6xl mx-auto w-full"
      >
        {/* Hero */}
        <div className="text-center mb-16 space-y-4">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight bg-gradient-to-r from-violet-400 via-white to-emerald-400 bg-clip-text text-transparent">
            Odin Agent
          </h1>
          <p className="text-zinc-500 text-sm max-w-md mx-auto">
            AI-powered trading intelligence on Hyperliquid. Analyze. Plan.
          </p>
        </div>

        {/* Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Row 1: DD Section (full width) */}
          <div className="lg:col-span-3">
            <DDSection />
          </div>

          {/* Row 2: Plan (full width) */}
          <div className="lg:col-span-3">
            <PlanSection />
          </div>
        </div>
      </main>
    </>
  )
}

export default function DashboardPage() {
  return (
    <DashboardProvider>
      <DashboardInner />
    </DashboardProvider>
  )
}
